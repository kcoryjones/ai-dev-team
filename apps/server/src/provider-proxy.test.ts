import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, chown, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { BrainProfileRef } from "@engineering-team/contracts";
import { bedrockProviderConnection, CodexCredentialStore, resolveProviderConnection, type ProviderConnection } from "./provider-auth.js";
import { startProviderProxy, type ProviderTransport } from "./provider-proxy.js";
import { startWorkerRelay, workerCodexConfiguration } from "./worker-launcher.js";

const execFileAsync = promisify(execFile);
const secret = "dummy-provider-secret-must-stay-in-controller";
const profile: BrainProfileRef = { provider: "openai", harness: "codex", modelClass: "balanced", credentialRef: "TEST_API_KEY", model: "gpt-5.6-sol" };

async function temporary(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "builder-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t: TestContext, connection: ProviderConnection, handler: (req: IncomingMessage, res: ServerResponse, body: string) => void, root?: string) {
  root ??= await temporary(t);
  const urls: URL[] = [];
  const upstream = createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    handler(req, res, Buffer.concat(chunks).toString("utf8"));
  })().catch(error => { res.destroy(error as Error); }); });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const transport: ProviderTransport = (url, headers, body, method, signal) => new Promise((resolve, reject) => {
    urls.push(url);
    const req = request({ hostname: "127.0.0.1", port: address.port, path: url.pathname + url.search, method, headers, signal }, resolve);
    req.on("error", reject); req.end(body);
  });
  const proxy = await startProviderProxy(root, connection, transport);
  t.after(async () => { await proxy.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  return { proxy, urls };
}

function call(socketPath: string, path = "/v1/responses", body = JSON.stringify({ model: profile.model, input: "test" }), method = "POST", headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }>((resolve, reject) => {
    const req = request({ socketPath, path, method, headers }, res => {
      let content = "";
      res.on("data", chunk => { content += chunk; });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: content }));
    });
    req.on("error", reject); req.end(body);
  });
}

async function apiConnection(root: string) {
  return resolveProviderConnection(profile, undefined, new CodexCredentialStore(join(root, "private")), { TEST_API_KEY: secret });
}

test("provider proxy authenticates streaming requests without accepting caller credentials or exposing response headers", async t => {
  const root = await temporary(t);
  const connection = await apiConnection(root);
  const { proxy, urls } = await fixture(t, connection, (req, res, raw) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers["chatgpt-account-id"], undefined);
    assert.equal(req.headers["x-amz-security-token"], undefined);
    assert.equal(req.headers["session_id"], "session-one");
    assert.equal(req.headers["user-agent"], "codex-test-client");
    if (req.method === "POST") {
      const body = JSON.parse(raw);
      assert.equal(body.model, profile.model);
      if (req.url?.endsWith("/responses")) assert.equal(body.store, false);
    }
    res.writeHead(200, { "content-type": "text/event-stream", "authorization": secret, "set-cookie": secret });
    res.write("data: first\n\n"); res.end("data: second\n\n");
  }, root);
  for (const [path, method] of [["/v1/responses", "POST"], ["/v1/responses/compact", "POST"], ["/v1/models?client_version=0.162.1", "GET"]]) {
    const response = await call(proxy.socketPath, path, method === "POST" ? JSON.stringify({ model: profile.model, store: true }) : "", method, {
      authorization: "Bearer attacker", cookie: "attacker", "chatgpt-account-id": "attacker", "x-amz-security-token": "attacker", session_id: "session-one", "user-agent": "codex-test-client",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body, "data: first\n\ndata: second\n\n");
    assert.equal(response.headers.authorization, undefined);
    assert.equal(response.headers["set-cookie"], undefined);
  }
  assert(urls.every(url => url.origin === "https://api.openai.com"));
  assert.deepEqual(await readdir(proxy.directory), ["proxy.sock"]);
});

test("provider proxy rejects alternate hosts, paths, queries, methods, malformed bodies, and other models", async t => {
  const root = await temporary(t);
  const { proxy, urls } = await fixture(t, await apiConnection(root), (_req, res) => res.end("unexpected"), root);
  for (const path of ["/v1/responses?url=https://attacker.test", "/v1/../files", "/v1/%2e%2e/files", "https://attacker.test/v1/responses", "//attacker.test/v1/responses", "/v1/responses/", "/v1/models?client_version=x&url=evil", "/credentials", "/shutdown"]) {
    assert.equal((await call(proxy.socketPath, path)).status, 403, path);
  }
  assert.equal((await call(proxy.socketPath, "/v1/responses", "", "DELETE")).status, 403);
  for (const body of ["not-json", "null", "[]", JSON.stringify({ model: "another-model" })]) assert.equal((await call(proxy.socketPath, "/v1/responses", body)).status, 400);
  assert.equal((await call(proxy.socketPath, "/v1/responses", "x".repeat(16 * 1024 * 1024 + 1))).status, 413);
  assert.equal(urls.length, 0);
});

test("provider errors and redirects cannot disclose credentials or redirect authenticated requests", async t => {
  const root = await temporary(t);
  let status = 307;
  const { proxy, urls } = await fixture(t, await apiConnection(root), (_req, res) => {
    res.writeHead(status, { location: "https://attacker.test", authorization: secret }); res.end(secret);
  }, root);
  for (status of [307, 401, 403, 500]) {
    const response = await call(proxy.socketPath);
    assert.equal(response.status, status === 307 ? 502 : status);
    assert(!JSON.stringify(response).includes(secret));
    assert.equal(response.headers.location, undefined);
  }
  assert.equal(urls.length, 4);
});

test("ChatGPT credentials and single-flight refresh stay in controller storage across runs and restarts", async t => {
  const root = await temporary(t);
  const authFile = join(root, "auth.json");
  const original = { tokens: { access_token: secret, refresh_token: "dummy-refresh", account_id: "account-one" } };
  await writeFile(authFile, JSON.stringify(original), { mode: 0o600 });
  let refreshes = 0;
  const store = new CodexCredentialStore(join(root, "private"), async (url, options) => {
    refreshes++;
    assert.equal(url, "https://auth.openai.com/oauth/token");
    assert.equal(options?.redirect, "error");
    assert.equal(JSON.parse(String(options?.body)).refresh_token, "dummy-refresh");
    await new Promise(resolve => setTimeout(resolve, 25));
    return new Response(JSON.stringify({ access_token: "dummy-rotated-access", refresh_token: "dummy-rotated-refresh" }));
  });
  const chatProfile = { ...profile, credentialRef: "CODEX_ACCESS_TOKEN" };
  const connection = await resolveProviderConnection(chatProfile, authFile, store, {});
  const { proxy, urls } = await fixture(t, connection, (req, res) => {
    assert.equal(req.headers["chatgpt-account-id"], "account-one");
    if (req.headers.authorization === `Bearer ${secret}`) { res.writeHead(401); res.end(secret); }
    else { assert.equal(req.headers.authorization, "Bearer dummy-rotated-access"); res.end("authenticated"); }
  }, root);
  const responses = await Promise.all([call(proxy.socketPath), call(proxy.socketPath), call(proxy.socketPath)]);
  assert(responses.every(response => response.status === 200 && response.body === "authenticated"));
  assert.equal(refreshes, 1);
  assert(urls.every(url => url.href === "https://chatgpt.com/backend-api/codex/responses"));
  assert.deepEqual(JSON.parse(await readFile(authFile, "utf8")), original);
  assert.equal((await stat(join(root, "private"))).mode & 0o777, 0o700);
  const saved = (await readdir(join(root, "private")))[0]!;
  assert.equal((await stat(join(root, "private", saved))).mode & 0o777, 0o600);
  const restarted = await resolveProviderConnection(chatProfile, authFile, new CodexCredentialStore(join(root, "private")), {});
  assert.equal((await restarted.headers(new URL(restarted.baseUrl), Buffer.alloc(0), {}, "POST")).authorization, "Bearer dummy-rotated-access");
  await writeFile(authFile, JSON.stringify({ tokens: { access_token: "new-host-login" } }));
  const changed = await resolveProviderConnection(chatProfile, authFile, store, {});
  assert.equal((await changed.headers(new URL(changed.baseUrl), Buffer.alloc(0), {}, "POST")).authorization, "Bearer new-host-login");
});

test("Bedrock Runtime and Mantle requests are signed by the controller with refreshable AWS credentials", async t => {
  for (const runtime of [true, false]) {
    const root = await temporary(t);
    let generation = 1;
    const connection = bedrockProviderConnection(runtime, "us-east-1", profile.model, async () => ({ accessKeyId: `DUMMYACCESS${generation}`, secretAccessKey: secret, sessionToken: `dummy-session-${generation}` }));
    const service = runtime ? "bedrock" : "bedrock-mantle";
    const { proxy, urls } = await fixture(t, connection, (req, res, body) => {
      assert(req.headers.authorization?.includes(`Credential=DUMMYACCESS${generation}/`));
      assert(req.headers.authorization?.includes(`/us-east-1/${service}/aws4_request`));
      assert.equal(req.headers["x-amz-security-token"], `dummy-session-${generation}`);
      assert.equal(req.headers["x-amz-content-sha256"], createHash("sha256").update(body).digest("hex"));
      assert(!req.headers.authorization?.includes(secret));
      res.end("signed");
    }, root);
    assert.equal((await call(proxy.socketPath)).body, "signed");
    generation = 2;
    assert.equal((await call(proxy.socketPath)).body, "signed");
    assert.equal(urls[0]!.href, runtime ? "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses" : "https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses");
  }
});

test("OpenAI credential references and stored API keys retain the correct endpoint and account routing", async t => {
  const root = await temporary(t);
  const store = new CodexCredentialStore(join(root, "private"));
  const jwt = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "jwt-account" } })).toString("base64url")}.signature`;
  const session = await resolveProviderConnection({ ...profile, credentialRef: "CODEX_ACCESS_TOKEN" }, undefined, store, { CODEX_ACCESS_TOKEN: jwt });
  assert.equal(session.baseUrl, "https://chatgpt.com/backend-api/codex");
  assert.equal((await session.headers(new URL(session.baseUrl), Buffer.alloc(0), {}, "POST"))["chatgpt-account-id"], "jwt-account");
  const authFile = join(root, "auth.json");
  await writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: secret }));
  const api = await resolveProviderConnection({ ...profile, credentialRef: "CODEX_ACCESS_TOKEN" }, authFile, store, {});
  assert.equal(api.baseUrl, "https://api.openai.com/v1");
  assert.equal((await api.headers(new URL(api.baseUrl), Buffer.alloc(0), {}, "POST")).authorization, `Bearer ${secret}`);
  await assert.rejects(resolveProviderConnection(profile, undefined, store, {}), /not available/);
  await writeFile(authFile, "{broken");
  await assert.rejects(store.load(authFile), /not valid JSON/);
});

test("unprivileged repository commands can use the proxy but cannot read controller credentials, home files, or process environments", { skip: process.getuid?.() !== 0 }, async t => {
  const root = await temporary(t);
  await chmod(root, 0o755);
  const privateDirectory = join(root, "private");
  await mkdir(privateDirectory, { mode: 0o700 });
  const authFile = join(privateDirectory, "auth.json");
  await writeFile(authFile, JSON.stringify({ tokens: { access_token: secret } }), { mode: 0o600 });
  const home = join(root, "worker-home");
  await mkdir(home, { mode: 0o700 }); await chown(home, 65532, 65532);
  const { proxy } = await fixture(t, await apiConnection(root), (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`); res.end("authenticated");
  }, root);
  const config = workerCodexConfiguration("openai", "", "http://127.0.0.1:1/v1");
  const script = `
    const fs = require('node:fs'); const http = require('node:http');
    for (const path of [process.argv[1], '/proc/' + process.argv[2] + '/environ', process.env.HOME + '/auth.json']) {
      try { fs.readFileSync(path); throw new Error('Readable credential location: ' + path); }
      catch (error) { if (!['EACCES', 'ENOENT'].includes(error.code)) throw error; }
    }
    if (Object.keys(process.env).some(key => /TOKEN|SECRET|API_KEY|ACCESS_KEY/.test(key))) throw new Error('Credential environment inherited');
    const req = http.request({socketPath: process.argv[3], path: '/v1/responses', method: 'POST'}, res => {
      res.pipe(process.stdout); res.on('end', () => { if (res.statusCode !== 200) process.exitCode = 1; });
    }); req.on('error', error => { throw error; }); req.end(JSON.stringify({model: 'gpt-5.6-sol'}));
  `;
  const result = await execFileAsync(process.execPath, ["-e", script, authFile, String(process.pid), proxy.socketPath], {
    uid: 65532, gid: 65532, cwd: home, env: { ...config.environment, HOME: home, CODEX_HOME: home }, timeout: 15_000,
  });
  assert.equal(result.stdout, "authenticated");
});

test("closing a run revokes the provider socket and aborts active upstream streams", async t => {
  const root = await temporary(t);
  let disconnected!: () => void;
  const upstreamClosed = new Promise<void>(resolve => { disconnected = resolve; });
  const { proxy } = await fixture(t, await apiConnection(root), (_req, res) => {
    res.on("close", disconnected); res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: pending\n\n");
  }, root);
  const received = new Promise<void>((resolve, reject) => {
    const req = request({ socketPath: proxy.socketPath, path: "/v1/responses", method: "POST" }, res => {
      res.on("data", () => resolve()); res.on("error", () => undefined);
    }); req.on("error", reject); req.end(JSON.stringify({ model: profile.model }));
  });
  await received; await proxy.close(); await upstreamClosed;
  await assert.rejects(call(proxy.socketPath));
  await assert.rejects(stat(proxy.directory), { code: "ENOENT" });
});

// Opt in to the real pinned CLI without a Docker daemon or any paid model call.
// ENGINEERING_TEAM_TEST_CODEX_BINARY=/path/to/codex npm test
for (const providerId of ["openai", "amazon-bedrock-runtime", "amazon-bedrock"] as const) {
  test(`Codex CLI compatibility through the credential-free relay: ${providerId}`, { skip: !process.env.ENGINEERING_TEAM_TEST_CODEX_BINARY, timeout: 30_000 }, async t => {
    const root = await temporary(t);
    const connection = providerId === "openai" ? await apiConnection(root) : bedrockProviderConnection(providerId.endsWith("runtime"), "us-east-1", profile.model, async () => ({ accessKeyId: "DUMMY", secretAccessKey: secret }));
    let calls = 0;
    const { proxy } = await fixture(t, connection, (req, res, body) => {
      if (req.method === "GET") { res.end(JSON.stringify({ models: [], data: [] })); return; }
      assert.equal(JSON.parse(body).model, profile.model);
      calls++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const item = { id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "proxy-compatible" }] };
      for (const event of [
        { type: "response.created", response: { id: "resp_test" } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_test", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    }, root);
    const relay = await startWorkerRelay(proxy.socketPath);
    t.after(() => relay.close());
    const config = workerCodexConfiguration(providerId, connection.region, relay.baseUrl);
    const home = join(root, "worker-home"); await mkdir(home);
    const execution = execFileAsync(process.env.ENGINEERING_TEAM_TEST_CODEX_BINARY!, [
      "exec", ...config.arguments, "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--model", profile.model!, "Reply briefly.",
    ], { env: { ...config.environment, HOME: home, CODEX_HOME: home }, cwd: home, timeout: 25_000, maxBuffer: 1024 * 1024 });
    execution.child.stdin?.end();
    const result = await execution;
    assert.match(result.stdout, /proxy-compatible/);
    assert.equal(calls, 1);
  });
}
