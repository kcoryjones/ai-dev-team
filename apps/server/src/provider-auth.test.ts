import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CodexCredentialStore } from "./provider-auth.js";

const execFileAsync = promisify(execFile);
const original = { tokens: { access_token: "source-access", refresh_token: "source-refresh" } };
const migrated = { tokens: { access_token: "legacy-access", refresh_token: "legacy-refresh" } };
const cacheName = `${createHash("sha256").update(JSON.stringify(original)).digest("hex")}.json`;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "builder-auth-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authFile = join(root, "auth.json"), cache = join(root, "durable"), legacy = join(root, "legacy");
  await mkdir(legacy);
  await writeFile(authFile, JSON.stringify(original), { mode: 0o400 });
  return { root, authFile, cache, legacy };
}

test("legacy credentials migrate privately, preserve the source, and never replace a newer durable entry", async t => {
  const f = await fixture(t);
  await writeFile(join(f.legacy, cacheName), JSON.stringify(migrated));
  const fetchToken: typeof fetch = async (_url, options) => {
    assert.equal(JSON.parse(String(options?.body)).refresh_token, "legacy-refresh");
    return new Response(JSON.stringify({ access_token: "rotated-access", refresh_token: "rotated-refresh" }));
  };
  const entry = await new CodexCredentialStore(f.cache, fetchToken, [join(f.root, "missing"), f.legacy]).load(f.authFile);
  assert.deepEqual(entry.auth, migrated);
  assert.equal((await stat(f.cache)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.cache, cacheName))).mode & 0o777, 0o600);
  await entry.refresh("Bearer legacy-access");
  const restarted = await new CodexCredentialStore(f.cache, fetchToken, [f.legacy]).load(f.authFile);
  assert.equal(restarted.auth.tokens?.refresh_token, "rotated-refresh");
  assert.deepEqual(JSON.parse(await readFile(f.authFile, "utf8")), original);
  assert.deepEqual(await readdir(f.cache), [cacheName]);
});

test("migration prefers the newer temporary cache and only imports the matching source fingerprint", async t => {
  const f = await fixture(t), recent = join(f.root, "recent");
  await mkdir(recent);
  await writeFile(join(f.legacy, cacheName), JSON.stringify(original));
  await writeFile(join(recent, cacheName), JSON.stringify(migrated));
  const entry = await new CodexCredentialStore(f.cache, fetch, [recent, f.legacy]).load(f.authFile);
  assert.deepEqual(entry.auth, migrated);
  const otherFile = join(f.root, "other-auth.json");
  const other = { tokens: { access_token: "another-host-login" } };
  await writeFile(otherFile, JSON.stringify(other));
  assert.deepEqual((await new CodexCredentialStore(f.cache, fetch, [recent, f.legacy]).load(otherFile)).auth, other);
});

test("an invalid legacy cache cannot silently fall back to stale host credentials", async t => {
  const f = await fixture(t);
  await writeFile(join(f.legacy, cacheName), "invalid credential data");
  const store = new CodexCredentialStore(f.cache, fetch, [f.legacy]);
  await assert.rejects(store.load(f.authFile), /not valid JSON/);
  assert.deepEqual(await readdir(f.cache), []);
  await writeFile(join(f.legacy, cacheName), JSON.stringify(migrated));
  assert.deepEqual((await store.load(f.authFile)).auth, migrated);
});

test("the upgrade helper preserves temporary credentials for import after tmpfs disappears without printing secrets", async t => {
  const f = await fixture(t), temporaryRoot = join(f.root, "tmp"), worktrees = join(f.root, "worktrees");
  const temporaryCache = join(temporaryRoot, "engineering-team-provider-auth");
  await mkdir(temporaryCache, { recursive: true });
  await writeFile(join(temporaryCache, cacheName), JSON.stringify(migrated));
  await writeFile(join(temporaryCache, `${cacheName}.unfinished`), "incomplete temporary write");
  const result = await execFileAsync(process.execPath, [fileURLToPath(new URL("../../../scripts/preserve-controller-auth.mjs", import.meta.url))], {
    env: { ...process.env, TMPDIR: temporaryRoot, ENGINEERING_TEAM_WORKTREE_ROOT: worktrees },
  });
  assert.match(result.stdout, /Preserved 1 provider credential cache/);
  assert.doesNotMatch(result.stdout + result.stderr, /legacy-access|legacy-refresh/);
  const exported = join(worktrees, ".provider-auth");
  assert.equal((await stat(exported)).mode & 0o777, 0o700);
  assert.equal((await stat(join(exported, cacheName))).mode & 0o777, 0o600);
  await rm(temporaryRoot, { recursive: true });
  assert.deepEqual((await new CodexCredentialStore(f.cache, fetch, [temporaryCache, exported]).load(f.authFile)).auth, migrated);
});

test("rotated controller credentials survive container recreation with a private named volume and empty tmpfs", {
  skip: !process.env.ENGINEERING_TEAM_TEST_DOCKER_IMAGE, timeout: 35_000,
}, async t => {
  const f = await fixture(t), volume = `engineering-team-auth-test-${randomUUID()}`;
  const configuration = await execFileAsync("docker", ["compose", "--env-file", ".env.example", "config", "--format", "json"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: { PATH: process.env.PATH, ENGINEERING_TEAM_CONTROLLER_TOKEN: "fixture-controller-token" },
  });
  const services = JSON.parse(configuration.stdout).services as Record<string, {
    environment?: Record<string, string>; volumes?: Array<{ type: string; source: string; target: string }>;
  }>;
  assert.equal(services.controller?.environment?.ENGINEERING_TEAM_PROVIDER_AUTH_ROOT, "/provider-auth");
  assert.deepEqual(Object.entries(services).flatMap(([name, service]) =>
    (service.volumes ?? []).filter(mount => mount.source === "engineering-team-provider-auth")
      .map(mount => ({ name, type: mount.type, target: mount.target }))),
  [{ name: "controller", type: "volume", target: "/provider-auth" }]);
  await writeFile(join(f.legacy, cacheName), JSON.stringify(migrated));
  const modulePath = fileURLToPath(new URL("./provider-auth.js", import.meta.url));
  const script = `
    import assert from 'node:assert/strict';
    import { stat, writeFile } from 'node:fs/promises';
    import { createControllerCredentialStore } from '/app/apps/server/dist/provider-auth.js';
    const restart = process.argv[1] === 'restart';
    const expected = restart ? 'rotated' : 'legacy';
    const store = createControllerCredentialStore('/worktrees', async (_url, options) => {
      assert.equal(JSON.parse(options.body).refresh_token, expected + '-refresh');
      return new Response(JSON.stringify({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' }));
    });
    const entry = await store.load('/fixture/auth.json');
    assert.equal(entry.auth.tokens.access_token, expected + '-access');
    await entry.refresh('Bearer ' + expected + '-access');
    assert.equal((await stat('/provider-auth')).mode & 0o777, 0o700);
    assert.equal((await stat('/provider-auth/${cacheName}')).mode & 0o777, 0o600);
    if (restart) await assert.rejects(stat('/tmp/prior-container'), { code: 'ENOENT' });
    else await writeFile('/tmp/prior-container', 'discard on restart');
    console.log('Credential rotation and persistence verified.');
  `;
  await execFileAsync("docker", ["volume", "create", volume]);
  try {
    for (const phase of ["initial", "restart"]) {
      const name = `${volume}-${phase}`;
      try {
        const result = await execFileAsync("docker", [
          "run", "--rm", "--name", name, "--network", "none", "--read-only", "--user", "0:0",
          "--tmpfs", "/tmp:size=16m,mode=1777", "--mount", `type=volume,src=${volume},dst=/provider-auth`,
          "--mount", `type=bind,src=${f.authFile},dst=/fixture/auth.json,readonly`,
          "--mount", `type=bind,src=${modulePath},dst=/app/apps/server/dist/provider-auth.js,readonly`,
          ...(phase === "initial" ? ["--mount", `type=bind,src=${f.legacy},dst=/worktrees/.provider-auth,readonly`] : []),
          "--entrypoint", "node", process.env.ENGINEERING_TEAM_TEST_DOCKER_IMAGE!, "--input-type=module", "-e", script, phase,
        ], { timeout: 12_000, maxBuffer: 1024 * 1024 });
        assert.match(result.stdout, /Credential rotation and persistence verified/);
      } finally { await execFileAsync("docker", ["rm", "--force", name], { timeout: 3_000 }).catch(() => undefined); }
    }
  } finally { await execFileAsync("docker", ["volume", "rm", volume], { timeout: 3_000 }); }
});
