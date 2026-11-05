import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, chown, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { captureWorkerCheckout, prepareWorkerCheckout, publishCapturedCheckout, runCaptureGit, type WorkerCheckout } from "./worker-checkout.js";

const execFileAsync = promisify(execFile);
const fixtures: string[] = [];

afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(unborn = false): Promise<WorkerCheckout & { root: string }> {
  const root = await mkdtemp(join(tmpdir(), "engineering-team-capture-"));
  fixtures.push(root);
  const sourcePath = join(root, "source");
  const workerRoot = join(root, "worker");
  await mkdir(sourcePath);
  await mkdir(join(workerRoot, "repos"), { recursive: true });
  await mkdir(join(root, "private"), { mode: 0o700 });
  await runCaptureGit(["init", "--quiet", "--initial-branch=main", sourcePath]);
  if (!unborn) {
    await writeFile(join(sourcePath, "code.txt"), "original\n");
    await writeFile(join(sourcePath, "delete-me.txt"), "old\n");
    await writeFile(join(sourcePath, ".gitignore"), "ignored/\n");
    await runCaptureGit(["-C", sourcePath, "add", "--all"]);
    await runCaptureGit(["-C", sourcePath, "commit", "--quiet", "-m", "Initial"]);
  }
  const checkout = {
    root, sourcePath, workerRoot,
    workerPath: join(workerRoot, "repos", "repo"),
    capturePath: join(root, "private", "capture"),
    baseCommit: unborn ? "unborn" : (await runCaptureGit(["-C", sourcePath, "rev-parse", "HEAD"])).trim(),
    branch: "agent/security-test",
  };
  await prepareWorkerCheckout(checkout);
  return checkout;
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

async function writeHook(path: string, marker: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o755 });
}

describe("worker checkout capture boundary", () => {
  it("captures additions, deletions, executable bits, binary files, and symlinks without changing source HEAD", async () => {
    const checkout = await fixture();
    await writeFile(join(checkout.workerPath, "code.txt"), "updated\n");
    await rm(join(checkout.workerPath, "delete-me.txt"));
    await writeFile(join(checkout.workerPath, "binary.bin"), Buffer.from([0, 255, 128, 10]));
    await writeFile(join(checkout.workerPath, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await mkdir(join(checkout.workerPath, "ignored"));
    await writeFile(join(checkout.workerPath, "ignored", "output"), "generated\n");
    await symlink("code.txt", join(checkout.workerPath, "code-link"));
    await writeFile(join(checkout.workerPath, "name\nwith-newline"), "content");

    const captured = await captureWorkerCheckout(checkout, "Approved task", true);
    assert.ok(captured.sha);
    assert.deepEqual(captured.changedFiles.sort(), ["binary.bin", "code-link", "code.txt", "delete-me.txt", "name\nwith-newline", "run.sh"].sort());
    assert.deepEqual(await readFile(join(checkout.capturePath, "binary.bin")), Buffer.from([0, 255, 128, 10]));
    assert.equal(await readlink(join(checkout.capturePath, "code-link")), "code.txt");
    await assertMissing(join(checkout.capturePath, "ignored"));
    assert.match(await runCaptureGit(["-C", checkout.capturePath, "ls-tree", "HEAD", "run.sh"]), /^100755 /);
    await publishCapturedCheckout(checkout);
    assert.equal((await runCaptureGit(["-C", checkout.sourcePath, "rev-parse", checkout.branch])).trim(), captured.sha);
    assert.equal((await runCaptureGit(["-C", checkout.sourcePath, "rev-parse", "HEAD"])).trim(), checkout.baseCommit);
    assert.equal(await readFile(join(checkout.sourcePath, "code.txt"), "utf8"), "original\n");
  });

  it("ignores worker hooks, fsmonitor, filters, includes, indexes, and replacement refs", async () => {
    const checkout = await fixture();
    const marker = join(checkout.root, "executed");
    const hook = join(checkout.workerPath, ".git", "hooks", "pre-commit");
    await writeHook(hook, marker);
    await writeHook(join(checkout.workerPath, ".git", "hooks", "pre-push"), marker);
    await writeHook(join(checkout.workerPath, "nested", ".git", "hooks", "pre-commit"), marker);
    await appendFile(join(checkout.workerPath, ".git", "config"), `\n[core]\n fsmonitor = ${hook}\n[filter "attack"]\n clean = ${hook}\n required = true\n[include]\n path = ${join(checkout.root, "bad-config")}\n`);
    await writeFile(join(checkout.root, "bad-config"), "invalid config that must never be read\n");
    await writeFile(join(checkout.workerPath, ".git", "index"), "invalid worker index");
    await mkdir(join(checkout.workerPath, ".git", "refs", "replace"), { recursive: true });
    await writeFile(join(checkout.workerPath, ".git", "refs", "replace", checkout.baseCommit), "f".repeat(40));
    await writeFile(join(checkout.workerPath, ".gitattributes"), "*.txt filter=attack\n");
    await writeFile(join(checkout.workerPath, "code.txt"), "updated\n");

    const captured = await captureWorkerCheckout(checkout, "Safe capture", true);
    assert.ok(captured.sha);
    await publishCapturedCheckout(checkout);
    await assertMissing(marker);
    await assertMissing(join(checkout.capturePath, "nested", ".git"));
    assert.equal(await runCaptureGit(["-C", checkout.capturePath, "show", "HEAD:code.txt"]), "updated\n");
    assert.equal((await runCaptureGit(["-C", checkout.capturePath, "rev-parse", "HEAD^"])).trim(), checkout.baseCommit);
  });

  it("ignores a worker .git file or symlink pointing into another repository", async () => {
    for (const kind of ["file", "symlink"] as const) {
      const checkout = await fixture();
      const sourceMetadata = join(checkout.sourcePath, ".git");
      const before = await readFile(join(sourceMetadata, "config"));
      await rm(join(checkout.workerPath, ".git"), { recursive: true });
      if (kind === "file") await writeFile(join(checkout.workerPath, ".git"), `gitdir: ${sourceMetadata}\n`);
      else await symlink(sourceMetadata, join(checkout.workerPath, ".git"));
      await writeFile(join(checkout.workerPath, "code.txt"), "captured safely\n");
      assert.ok((await captureWorkerCheckout(checkout, "Safe capture", true)).sha);
      assert.deepEqual(await readFile(join(sourceMetadata, "config")), before);
      assert.equal((await runCaptureGit(["-C", checkout.sourcePath, "rev-parse", "HEAD"])).trim(), checkout.baseCommit);
    }
  });

  it("rejects checkout and ancestor directory substitutions before reading host files", async () => {
    for (const ancestor of [false, true]) {
      const checkout = await fixture();
      const target = ancestor ? dirname(checkout.workerPath) : checkout.workerPath;
      await rm(target, { recursive: true });
      await symlink(checkout.sourcePath, target);
      await assert.rejects(captureWorkerCheckout(checkout, "Must fail", true), /replaced an assigned checkout directory/);
      assert.equal((await runCaptureGit(["-C", checkout.capturePath, "rev-parse", "HEAD"])).trim(), checkout.baseCommit);
    }
  });

  it("copies outward symlinks as link text and rejects special files", async () => {
    const checkout = await fixture();
    const outside = join(checkout.root, "outside.txt");
    await writeFile(outside, "private host contents\n");
    await symlink(outside, join(checkout.workerPath, "outside-link"));
    await captureWorkerCheckout(checkout, "Add a link", true);
    assert.equal(await runCaptureGit(["-C", checkout.capturePath, "show", "HEAD:outside-link"]), outside);
    await execFileAsync("mkfifo", [join(checkout.workerPath, "pipe")]);
    await assert.rejects(captureWorkerCheckout(checkout, "Must fail", true), /only regular files/);
  });

  it("creates a first commit for an unborn repository and keeps no-change runs empty", async () => {
    const checkout = await fixture(true);
    assert.equal((await captureWorkerCheckout(checkout, "No changes", true)).sha, null);
    await writeFile(join(checkout.workerPath, "first.txt"), "first\n");
    const captured = await captureWorkerCheckout(checkout, "First commit", true);
    assert.ok(captured.sha);
    assert.deepEqual(captured.changedFiles, ["first.txt"]);
    await publishCapturedCheckout(checkout);
    assert.equal((await runCaptureGit(["-C", checkout.sourcePath, "rev-parse", checkout.branch])).trim(), captured.sha);
    const unchanged = await fixture();
    assert.equal((await captureWorkerCheckout(unchanged, "No changes", true)).sha, null);
  });

  it("ignores inherited Git configuration and source hooks during local publication", async () => {
    const checkout = await fixture();
    const marker = join(checkout.root, "receive-hook-ran");
    await writeHook(join(checkout.sourcePath, ".git", "hooks", "pre-receive"), marker);
    await writeHook(join(checkout.sourcePath, ".git", "hooks", "reference-transaction"), marker);
    const oldConfig = process.env.GIT_CONFIG_GLOBAL;
    const oldDirectory = process.env.GIT_DIR;
    process.env.GIT_CONFIG_GLOBAL = join(checkout.root, "invalid-config");
    process.env.GIT_DIR = join(checkout.workerPath, ".git");
    await writeFile(process.env.GIT_CONFIG_GLOBAL, "invalid configuration\n");
    try {
      await writeFile(join(checkout.workerPath, "code.txt"), "updated\n");
      await captureWorkerCheckout(checkout, "Safe capture", true);
      await publishCapturedCheckout(checkout);
      await assertMissing(marker);
    } finally {
      if (oldConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = oldConfig;
      if (oldDirectory === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = oldDirectory;
    }
  });

  it("keeps tracked changes when a worker adds an ignore rule for their directory", async () => {
    const checkout = await fixture();
    await mkdir(join(checkout.capturePath, "tracked"));
    await writeFile(join(checkout.capturePath, "tracked", "file.txt"), "original\n");
    await runCaptureGit(["-C", checkout.capturePath, "add", "--all"]);
    await runCaptureGit(["-C", checkout.capturePath, "commit", "--quiet", "-m", "Tracked directory"]);
    checkout.baseCommit = (await runCaptureGit(["-C", checkout.capturePath, "rev-parse", "HEAD"])).trim();
    await mkdir(join(checkout.workerPath, "tracked"));
    await writeFile(join(checkout.workerPath, "tracked", "file.txt"), "updated\n");
    await writeFile(join(checkout.workerPath, ".gitignore"), "tracked/\n");
    const captured = await captureWorkerCheckout(checkout, "Keep tracked changes", true);
    assert.ok(captured.changedFiles.includes("tracked/file.txt"));
    assert.equal(await runCaptureGit(["-C", checkout.capturePath, "show", "HEAD:tracked/file.txt"]), "updated\n");
  });

  it("refuses to put the private capture checkout inside the worker mount", async () => {
    const checkout = await fixture();
    await assert.rejects(prepareWorkerCheckout({ ...checkout, capturePath: join(checkout.workerRoot, "capture") }), /outside the worker mount/);
  });

  it("can publish into a registered repository owned by the host user", { skip: process.getuid?.() !== 0 }, async () => {
    const checkout = await fixture();
    await chown(checkout.sourcePath, 1000, 1000);
    await chown(join(checkout.sourcePath, ".git"), 1000, 1000);
    await writeFile(join(checkout.workerPath, "code.txt"), "updated\n");
    const captured = await captureWorkerCheckout(checkout, "Safe capture", true);
    await publishCapturedCheckout(checkout);
    assert.equal((await runCaptureGit(["-C", checkout.sourcePath, "rev-parse", checkout.branch], [checkout.sourcePath])).trim(), captured.sha);
  });
});
