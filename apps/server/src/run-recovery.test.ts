import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentRunStatus, RunSpec } from "@engineering-team/contracts";
import { TeamDatabase } from "@engineering-team/database";
import { createRepository } from "./repository.js";
import { createRunRecovery } from "./run-recovery.js";
import { appendCompletedHistory } from "./test-history.js";

const quiet = { info() {}, warn() {} };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "builder-recovery-"));
  createRepository(root, "backend");
  const dbPath = join(root, "team.db");
  let database = new TeamDatabase(dbPath);
  t.after(() => { if (database.connection.open) database.close(); rmSync(root, { recursive: true, force: true }); });
  const projectId = randomUUID(), repositoryId = randomUUID(), taskId = randomUUID();
  database.createProject({ id: projectId, name: "Recovery", repository: { id: repositoryId, name: "backend", relativePath: "backend", defaultBranch: "main" } });
  database.updateProjectSettings(projectId, { planningNetworkPolicy: "model-provider-only", defaultRunRetries: 0 });
  database.createBrainProfile({ id: "profile", projectId, name: "Fixture", provider: "openai", harness: "codex", modelClass: "planning", credentialRef: "DUMMY", configuration: {} });
  database.createCodingHarness(projectId, "harness", { name: "Codex", adapter: "codex", executable: "codex", supportedProtocols: ["openai-responses"], capabilities: ["coding", "planning", "testing"] });
  database.createModelBackend(projectId, "backend", { name: "Fixture", provider: "openai", protocol: "openai-responses", model: "gpt-test", authMode: "api-key", credentialRef: "DUMMY" });
  for (const role of ["project_manager", "architect"] as const) database.assignAgentRuntime(projectId, role, "harness", "backend");
  const plan = database.createPlan({ projectId, approvalId: randomUUID(), objective: { id: randomUUID(), title: "Recover", description: "Preserve work" }, tasks: [
    { id: taskId, key: "build", title: "Build", description: "Implement", assignedRole: "backend_developer", repositoryIds: [repositoryId], acceptanceCriteria: ["Works"], requiredChecks: { qa: false, codeReview: false, security: false }, dependsOn: [] },
  ] });
  database.decideApproval(projectId, plan.approval.id, "approved", null);
  database.updateTaskStatus(projectId, taskId, "in_progress");
  function seed(status: AgentRunStatus, patch: Partial<RunSpec> = {}) {
    const spec: RunSpec = { schemaVersion: 1, runId: randomUUID(), projectId, agentRole: "architect",
      brainProfile: { provider: "openai", harness: "codex", modelClass: "planning", credentialRef: "DUMMY" },
      repositories: [{ repositoryId, checkoutPath: "/workspace/repos/backend", baseCommit: "unborn" }],
      objective: "Recover", taskDescription: "Inspect", acceptanceCriteria: ["Works"], upstreamArtifacts: [],
      permissions: { filesystem: "read-only", networkPolicy: "model-provider-only", allowedTools: [] }, limits: { timeoutSeconds: 30, retries: 0 }, ...patch };
    database.createAgentRun("profile", spec);
    const attemptId = status === "queued" ? null : randomUUID();
    if (attemptId) {
      database.createRunAttempt({ id: attemptId, runId: spec.runId, attemptNumber: 1 });
      if (status !== "provisioning") database.markRunAttemptRunning(attemptId, `worker-${spec.runId}`, "fixture", "preserved-thread");
      if (["waiting", "completed", "failed", "cancelled"].includes(status)) database.completeAgentRun(spec.runId, attemptId, {
        schemaVersion: 1, status: status === "waiting" ? "needs_input" : status as "completed" | "failed" | "cancelled", summary: "Preserved response",
        changedFiles: [], commits: [], checks: [{ command: "inspect", status: "passed" }],
        acceptanceCriteria: [{ criterion: "Works", satisfied: true, evidence: "Preserved evidence" }], questions: ["Clarify scope"], risks: [], artifacts: [],
      });
    }
    database.appendRunEvent({ schemaVersion: 1, id: randomUUID(), runId: spec.runId, attemptId, sequence: 1, type: "agent.message", message: "Preserved progress", payload: {}, createdAt: new Date().toISOString() });
    return database.getAgentRun(spec.runId)!;
  }
  return { root, dbPath, projectId, taskId, seed, get database() { return database; }, reopen() { database.close(); database = new TeamDatabase(dbPath); return database; } };
}

for (const role of ["project_manager", "architect"] as const) {
  for (const status of ["queued", "provisioning", "running", "waiting"] as const) {
    test(`startup recovers a ${status} ${role} outside recent history without deleting evidence`, async t => {
      const f = fixture(t);
      const run = f.seed(status, { agentRole: role });
      appendCompletedHistory(f.database, run);
      const events = f.database.listRunEvents(run.id);
      const attempts = f.database.listRunAttempts(run.id);
      const stopped: string[] = [];
      const recover = createRunRecovery(f.database, { async stopTaskWorker(id) { stopped.push(id); } }, quiet);
      await recover(true);
      const recovered = f.database.getAgentRun(run.id)!;
      assert.equal(recovered.status, "timed_out");
      assert(recovered.completedAt);
      assert.deepEqual(recovered.result, run.result);
      assert.equal(recovered.providerThreadId, run.providerThreadId);
      assert.deepEqual(f.database.listRunEvents(run.id).slice(0, -1), events);
      assert.equal(f.database.listRunEvents(run.id).at(-1)?.type, "run.timed_out");
      assert.deepEqual(f.database.listRunAttempts(run.id).map(attempt => attempt.status), attempts.map(attempt => attempt.status === "completed" ? "completed" : "timed_out"));
      assert.deepEqual(stopped, [run.id]);
      assert.deepEqual(f.database.listActiveAgentRuns(f.projectId), []);
      assert.deepEqual(f.database.listTaskWorkflowRecoveries(f.projectId), []);
      const messages = f.database.getOrchestrationState(f.projectId)!.messages;
      assert.equal(messages.filter(message => message.body.includes("send a new message")).length, 1);
      await recover(true);
      assert.deepEqual(stopped, [run.id]);
      assert.deepEqual(f.database.getOrchestrationState(f.projectId)!.messages, messages);
      assert.equal(f.database.listAgentRuns(f.projectId, 100).filter(item => item.status === "completed").length, 30);
    });
  }
}

test("periodic recovery leaves live taskless turns alone while expired task workflows remain resumable", async t => {
  const f = fixture(t);
  const live = [f.seed("running", { agentRole: "project_manager" }), f.seed("provisioning"), f.seed("waiting")];
  const task = f.seed("running", { taskId: f.taskId, runPurpose: "verification", agentRole: "qa_engineer", verificationCheck: "qa" });
  f.database.acquireTaskLease({ taskId: f.taskId, runId: task.id, leaseToken: "expired", acquiredAt: "2026-01-01T00:00:00.000Z", heartbeatAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:01:00.000Z" });
  const stopped: string[] = [];
  await createRunRecovery(f.database, { async stopTaskWorker(id) { stopped.push(id); } }, quiet)();
  for (const run of live) assert.deepEqual(f.database.getAgentRun(run.id), run);
  assert.deepEqual(stopped, [task.id]);
  assert.equal(f.database.getTaskWorkflowRecovery(f.projectId, f.taskId)?.stage, "verification");
});

test("startup stops every interrupted task worker while retaining only the newest recovery stage", async t => {
  const f = fixture(t);
  const implementation = f.seed("running", { taskId: f.taskId, runPurpose: "implementation" });
  const verification = f.seed("running", { taskId: f.taskId, runPurpose: "verification", verificationCheck: "qa" });
  const stopped: string[] = [];
  await createRunRecovery(f.database, { async stopTaskWorker(id) { stopped.push(id); } }, quiet)(true);
  assert.deepEqual(new Set(stopped), new Set([implementation.id, verification.id]));
  assert.equal(f.database.getTaskWorkflowRecovery(f.projectId, f.taskId)?.interruptedRunId, verification.id);
  assert.deepEqual(f.database.listActiveAgentRuns(f.projectId), []);
});

test("failed worker cleanup survives a database reopen and retries without interrupting new turns", async t => {
  const f = fixture(t);
  const interrupted = f.seed("running");
  const completed = [f.seed("completed"), f.seed("failed"), f.seed("cancelled")];
  let tries = 0;
  await createRunRecovery(f.database, { async stopTaskWorker() { tries++; throw new Error("Controller unavailable"); } }, quiet)(true);
  assert.deepEqual(f.database.listPendingWorkerCleanups(), [interrupted.id]);
  const events = f.database.listRunEvents(interrupted.id);
  const messages = f.database.getOrchestrationState(f.projectId)!.messages;
  f.reopen();
  const active = f.seed("running");
  await createRunRecovery(f.database, { async stopTaskWorker(id) { tries++; assert.equal(id, interrupted.id); } }, quiet)();
  assert.equal(tries, 2);
  assert.deepEqual(f.database.listPendingWorkerCleanups(), []);
  assert.deepEqual(f.database.getAgentRun(active.id), active);
  assert.deepEqual(f.database.listRunEvents(interrupted.id), events);
  assert.deepEqual(f.database.getOrchestrationState(f.projectId)!.messages, messages);
  for (const run of completed) assert.deepEqual(f.database.getAgentRun(run.id), run);
});

test("an unconfigured controller preserves cleanup work and concurrent sweeps do not stop workers twice", async t => {
  const f = fixture(t);
  const run = f.seed("running");
  await createRunRecovery(f.database, null, quiet)(true);
  assert.deepEqual(f.database.listPendingWorkerCleanups(), [run.id]);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let stops = 0;
  const recover = createRunRecovery(f.database, { async stopTaskWorker() { stops++; await blocked; } }, quiet);
  const first = recover(), second = recover();
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  assert.equal(stops, 1);
  assert.deepEqual(f.database.listPendingWorkerCleanups(), []);
});

test("upgrading an existing database preserves interrupted turns and creates durable cleanup records", async t => {
  const f = fixture(t);
  const run = f.seed("running");
  f.database.connection.exec("DROP TABLE interrupted_worker_cleanups; DELETE FROM schema_migrations WHERE version = 26");
  f.reopen();
  await createRunRecovery(f.database, null, quiet)(true);
  assert.equal(f.database.getAgentRun(run.id)?.status, "timed_out");
  assert.deepEqual(f.database.listPendingWorkerCleanups(), [run.id]);
  assert.equal(f.database.listRunEvents(run.id)[0]?.message, "Preserved progress");
});

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert(check(), message);
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

for (const role of ["project_manager", "architect"] as const) {
  test(`an actual API restart interrupts ${role}, stops its worker, and accepts a new message`, { timeout: 30_000 }, async t => {
    const children: ChildProcess[] = [];
    let controller: ReturnType<typeof createServer>;
    t.after(async () => {
      for (const child of children) await kill(child);
      if (controller) { controller.closeAllConnections(); await new Promise<void>(resolve => controller.close(() => resolve())); }
    });
    const f = fixture(t);
    let hold = true;
    const requests: RunSpec[] = [], stops: string[] = [];
    const pending = new Map<string, ServerResponse>();
    controller = createServer(async (request, response) => {
      const json = (body: unknown) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)); };
      if (request.method === "DELETE") {
        const id = request.url!.split("/").at(-1)!;
        stops.push(id);
        pending.get(id)?.destroy();
        pending.delete(id);
        return json({ stopped: true });
      }
      if (request.method === "GET") return json({ events: [] });
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const { run } = JSON.parse(Buffer.concat(chunks).toString()) as { run: RunSpec };
      requests.push(run);
      if (hold) { pending.set(run.runId, response); return; }
      const metadata = { workerId: `worker-${run.runId}`, imageDigest: "fixture", providerThreadId: "new-thread" };
      return json(request.url === "/runs" ? { ...metadata, proposal: {
        assistantMessage: "Continued after restart", intent: "conversation", directiveActions: [], consultationRequests: [], contextUpdates: [], objective: null, tasks: [],
      } } : { ...metadata, response: "Continued after restart", contextUpdates: [], directiveActions: [] });
    });
    await new Promise<void>(resolve => controller.listen(0, "127.0.0.1", resolve));
    const address = controller.address();
    assert(address && typeof address !== "string");
    const controllerUrl = `http://127.0.0.1:${address.port}`;
    async function start() {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./main.js", import.meta.url))], { env: {
        PATH: process.env.PATH, ENGINEERING_TEAM_DATABASE: f.dbPath, ENGINEERING_TEAM_WORKSPACE_ROOT: f.root,
        ENGINEERING_TEAM_HOST: "127.0.0.1", ENGINEERING_TEAM_PORT: "0", ENGINEERING_TEAM_CONTROLLER_URL: controllerUrl,
      }, stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      let output = "";
      child.stdout!.on("data", chunk => { output += chunk.toString(); });
      child.stderr!.on("data", chunk => { output += chunk.toString(); });
      await waitFor(() => /listening at http:\/\/127\.0\.0\.1:\d+/.test(output), `API failed to start: ${output}`);
      return { child, url: output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/)![1]! };
    }
    const post = (url: string, body: string) => fetch(`${url}/api/projects/${f.projectId}/agents/${role}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }),
    });
    const first = await start();
    const sent = await post(first.url, "Preserve this request through restart");
    assert.equal(sent.status, 202, await sent.text());
    await waitFor(() => requests.length === 1, "Worker did not receive the first message");
    const oldRunId = requests[0]!.runId;
    const events = f.database.listRunEvents(oldRunId);
    assert.equal((await post(first.url, "Duplicate")).status, 409);
    await kill(first.child);
    assert.equal(f.database.getAgentRun(oldRunId)?.status, "running");
    hold = false;
    const restarted = await start();
    assert.deepEqual(stops, [oldRunId]);
    assert.equal(f.database.getAgentRun(oldRunId)?.status, "timed_out");
    assert.equal(f.database.listRunAttempts(oldRunId)[0]?.status, "timed_out");
    assert.deepEqual(f.database.listRunEvents(oldRunId).slice(0, -1), events);
    assert.deepEqual(f.database.listActiveAgentRuns(f.projectId), []);
    assert.deepEqual(f.database.listPendingWorkerCleanups(), []);
    assert(f.database.getOrchestrationState(f.projectId)!.messages.some(message => message.body === "Preserve this request through restart"));
    const continued = await post(restarted.url, "Continue from the preserved request");
    assert.equal(continued.status, 202, await continued.text());
    await waitFor(() => requests.length === 2 && f.database.getAgentRun(requests[1]!.runId)?.status === "completed", "New turn did not complete after restart");
    assert.equal(f.database.getAgentRun(oldRunId)?.status, "timed_out");
    assert(f.database.getOrchestrationState(f.projectId)!.messages.some(message => message.body === "Continued after restart"));
  });
}
