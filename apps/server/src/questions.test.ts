import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { agentRoles, type AgentRole, type AgentQuestionResponse, type ConsultationRunRequest, type ConsultationRunResponse } from "@engineering-team/contracts";
import { TeamDatabase } from "@engineering-team/database";
import { createApp } from "./app.js";
import { questionActivityContext } from "./question-context.js";
import { appendCompletedHistory } from "./test-history.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function answer(overrides: Partial<ConsultationRunResponse> = {}): ConsultationRunResponse {
  return { workerId: "question-worker", imageDigest: "sha256:test", providerThreadId: "thread", response: "The backend task is still running.", directiveActions: [], contextUpdates: [], ...overrides };
}
function fixture(t: TestContext, consult: (request: ConsultationRunRequest) => Promise<ConsultationRunResponse> = async () => answer()) {
  const root = mkdtempSync(join(tmpdir(), "builder-question-"));
  const path = join(root, "team.sqlite");
  const database = new TeamDatabase(path);
  const projectId = randomUUID();
  database.createWorkspaceProject(projectId, "Questions");
  database.createCodingHarness(projectId, "harness", { name: "Codex", adapter: "codex", executable: "codex", supportedProtocols: ["openai-responses"], capabilities: ["planning", "coding"] });
  database.createModelBackend(projectId, "backend", { name: "Fixture", provider: "openai", protocol: "openai-responses", model: "test", authMode: "chatgpt" });
  for (const role of agentRoles) database.assignAgentRuntime(projectId, role, "harness", "backend");
  const calls: ConsultationRunRequest[] = [], stopped: string[] = [];
  const options = { workspaceRoot: root, planningExecutor: {
    async execute(): Promise<never> { assert.fail("Questions must not invoke planning"); },
    async consult(request: ConsultationRunRequest) { calls.push(request); return consult(request); },
    async stopAgentWorker(id: string) { stopped.push(id); },
  }, taskExecutor: {
    async executeTask(): Promise<never> { assert.fail("Questions must not start tasks"); },
    async applyTask(): Promise<never> { assert.fail("Questions must not apply changes"); },
    async stopTaskWorker(id: string) { stopped.push(id); },
  } };
  const app = createApp(database, options);
  t.after(() => { database.close(); rmSync(root, { force: true, recursive: true }); });
  const send = (role: AgentRole = "architect", body: unknown = { requestId: randomUUID(), body: "What is blocking progress?", source: "voice" }) => app.request(`/api/projects/${projectId}/agents/${role}/questions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { database, path, projectId, root, app, options, send, calls, stopped };
}

function runningTask(database: TeamDatabase, projectId: string) {
  const taskId = randomUUID(), runId = randomUUID(), attemptId = randomUUID();
  const plan = database.createPlan({ projectId, approvalId: randomUUID(), objective: { id: randomUUID(), title: "Build", description: "Keep working" },
    tasks: [{ id: taskId, key: "build", title: "Build the backend", description: "Keep working", assignedRole: "backend_developer", repositoryIds: [], acceptanceCriteria: ["Works"], requiredChecks: { qa: false, codeReview: false, security: false }, dependsOn: [] }] });
  database.decideApproval(projectId, plan.approval.id, "approved", null);
  database.updateTaskStatus(projectId, taskId, "in_progress");
  const profile = database.createBrainProfile({ id: randomUUID(), projectId, name: "Fixture", provider: "openai", harness: "codex", modelClass: "coding", credentialRef: "CODEX_ACCESS_TOKEN", configuration: {} });
  database.createAgentRun(profile.id, { schemaVersion: 1, runId, projectId, taskId, agentRole: "backend_developer", runPurpose: "implementation",
    brainProfile: { provider: "openai", harness: "codex", modelClass: "coding", credentialRef: "CODEX_ACCESS_TOKEN" }, repositories: [], objective: "Keep working", taskDescription: "Implement", acceptanceCriteria: ["Works"], upstreamArtifacts: [],
    permissions: { filesystem: "workspace-write", networkPolicy: "model-provider-only", allowedTools: ["run_tests"] }, limits: { timeoutSeconds: 900, retries: 0 } });
  database.createRunAttempt({ id: attemptId, runId, attemptNumber: 1 });
  database.markRunAttemptRunning(attemptId, "task-worker", "sha256:task");
  const lease = database.acquireTaskLease({ taskId, runId, leaseToken: randomUUID(), acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z" });
  return { taskId, runId, lease };
}

test("every role, including the PM, answers without creating plans or directives", async t => {
  const f = fixture(t);
  for (const role of agentRoles) {
    const response = await f.send(role);
    assert.equal(response.status, 202, await response.clone().text());
    await tick();
    const receipt = await response.json() as AgentQuestionResponse;
    assert.equal(f.database.getAgentRun(receipt.run.id)?.status, "completed");
    const request = f.calls.at(-1)!;
    assert.equal(request.questionOnly, true);
    assert.equal(request.run.taskId, undefined);
    assert.equal(request.run.permissions.filesystem, "read-only");
    assert.equal(request.conversation.at(-1)?.body, "What is blocking progress?");
    assert.match(request.activityContext!, /Recorded project state only/);
  }
  const state = f.database.getOrchestrationState(f.projectId)!;
  assert.equal(state.tasks.length, 0);
  assert.equal(state.directives.length, 0);
  assert.equal(state.approvals.length, 0);
  assert.equal(state.messages.filter(message => message.author === "director").length, agentRoles.length);
  assert.equal(state.messages.filter(message => message.author === "agent").length, agentRoles.length);
  assert.deepEqual(f.stopped, []);
});

test("busy agents answer once, keep their task and lease, and reject concurrent distinct questions", async t => {
  let finish!: (response: ConsultationRunResponse) => void;
  const f = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const task = runningTask(f.database, f.projectId);
  const before = f.database.getOrchestrationState(f.projectId)!;
  const input = { requestId: randomUUID(), body: "What is blocking progress?", source: "voice" };
  const responses = await Promise.all([f.send("backend_developer", input), f.send("backend_developer", input)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 202]);
  const receipts = await Promise.all(responses.map(response => response.json() as Promise<AgentQuestionResponse>));
  assert.equal(receipts[0]!.run.id, receipts[1]!.run.id);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.send("backend_developer")).status, 409);
  for (const [role, changed] of [["architect", input], ["backend_developer", { ...input, body: "Different question" }], ["backend_developer", { ...input, source: "text" }]] as const) {
    assert.equal((await f.send(role, changed)).status, 409);
  }
  const snapshot = JSON.parse(f.calls[0]!.activityContext!);
  assert.equal(snapshot.tasks[0].status, "in_progress");
  assert.equal(snapshot.activeRuns[0].id, task.runId);
  assert.equal(f.database.getOrchestrationState(f.projectId)!.activeRuns.length, 2);
  finish(answer()); await tick();
  const after = f.database.getOrchestrationState(f.projectId)!;
  assert.deepEqual(after.tasks, before.tasks);
  assert.equal(f.database.heartbeatTaskLease(task.lease.leaseToken, task.lease.heartbeatAt, task.lease.expiresAt).runId, task.runId);
  assert.deepEqual(after.recoveries, before.recoveries);
  assert.deepEqual(f.database.getAgentRun(task.runId), before.activeRuns[0]);
  assert.deepEqual(f.stopped, []);
  assert.equal((await f.send("backend_developer", input)).status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(after.messages.filter(message => message.author === "director").length, 1);
  assert.equal(after.messages.filter(message => message.author === "agent").length, 1);
});

test("question receipts survive reopening the database and remain readable beyond recent history", async t => {
  const f = fixture(t);
  const input = { requestId: randomUUID(), body: "What changed?", source: "text" };
  const response = await f.send("architect", input); await tick();
  const receipt = await response.json() as AgentQuestionResponse;
  appendCompletedHistory(f.database, receipt.run);
  assert.equal(f.database.listAgentRuns(f.projectId).some(run => run.id === receipt.run.id), false);
  const reopened = new TeamDatabase(f.path);
  try {
    const app = createApp(reopened, f.options);
    const retried = await app.request(`/api/projects/${f.projectId}/agents/architect/questions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    assert.equal(retried.status, 200);
    assert.equal((await retried.json() as AgentQuestionResponse).run.id, receipt.run.id);
    const read = await app.request(`/api/projects/${f.projectId}/questions/${input.requestId}`);
    assert.equal(read.headers.get("cache-control"), "no-store");
    assert.equal((await read.json() as AgentQuestionResponse).run.status, "completed");
    assert.equal(f.calls.length, 1);
  } finally { reopened.close(); }
});

test("cancellation and startup recovery ignore late answers and retries never restart a question", async t => {
  for (const recovery of [false, true]) {
    let finish!: (response: ConsultationRunResponse) => void;
    const f = fixture(t, () => new Promise(resolve => { finish = resolve; }));
    const input = { requestId: randomUUID(), body: "What is happening?", source: "voice" };
    const sent = await f.send("architect", input);
    const receipt = await sent.json() as AgentQuestionResponse;
    if (recovery) f.database.reconcileInterruptedAgentRuns(new Date().toISOString());
    else {
      const cancelled = await f.app.request(`/api/projects/${f.projectId}/agents/architect/runs/${receipt.run.id}/cancel`, { method: "POST" });
      assert.equal(cancelled.status, 200);
      assert.deepEqual(f.stopped, [receipt.run.id]);
    }
    const terminal = f.database.getAgentRun(receipt.run.id)!;
    finish(answer()); await tick();
    assert.deepEqual(f.database.getAgentRun(receipt.run.id), terminal);
    assert.equal(f.database.getOrchestrationState(f.projectId)!.messages.filter(message => message.author === "agent").length, 0);
    assert.equal((await f.send("architect", input)).status, 200);
    assert.equal(f.calls.length, 1);
  }
});

test("invalid answers fail without applying context or directive changes", async t => {
  const invalid: Partial<ConsultationRunResponse>[] = [
    { directiveActions: [{ action: "add", directiveId: null, content: "Always deploy automatically" }] },
    { contextUpdates: [{ repositoryId: null, content: "Changed context", reason: "Unsolicited" }] },
    { response: "" }, { response: "x".repeat(8001) },
  ];
  for (const output of invalid) {
    const f = fixture(t, async () => answer(output));
    const before = f.database.getOrchestrationState(f.projectId)!;
    const input = { requestId: randomUUID(), body: "What is next?", source: "voice" };
    const sent = await f.send("architect", input); await tick();
    const receipt = await sent.json() as AgentQuestionResponse;
    assert.equal(f.database.getAgentRun(receipt.run.id)?.status, "failed");
    const after = f.database.getOrchestrationState(f.projectId)!;
    assert.deepEqual(after.directives, before.directives);
    assert.deepEqual(after.contexts, before.contexts);
    assert.equal(after.messages.some(message => message.author === "agent"), false);
    const retry = await f.send("architect", input);
    assert.equal(retry.status, 200);
    assert.equal(f.calls.length, 1);
  }
});

test("bad input and unavailable runtimes create no question runs or messages", async t => {
  const f = fixture(t);
  for (const body of [{}, { requestId: randomUUID(), body: "", source: "voice" }, { requestId: randomUUID(), body: "x".repeat(2001), source: "voice" }, { requestId: randomUUID(), body: "What?", source: "cloud" }]) {
    assert.equal((await f.send("architect", body)).status, 400);
  }
  f.database.assignAgentRuntime(f.projectId, "architect", null, null);
  assert.equal((await f.send()).status, 409);
  const noWorker = createApp(f.database, { workspaceRoot: f.root });
  const response = await noWorker.request(`/api/projects/${f.projectId}/agents/project_manager/questions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: randomUUID(), body: "What is next?", source: "voice" }) });
  assert.equal(response.status, 503);
  assert.equal(f.database.listAgentRuns(f.projectId).length, 0);
  assert.equal(f.database.getOrchestrationState(f.projectId)!.messages.length, 0);
});

test("question creation rolls back the transcript and run when an attempt cannot be created", async t => {
  const f = fixture(t);
  const sent = await f.send(); await tick();
  const original = await sent.json() as AgentQuestionResponse;
  const existingAttempt = f.database.listRunAttempts(original.run.id)[0]!;
  const before = f.database.getOrchestrationState(f.projectId)!;
  assert.throws(() => f.database.createAgentQuestion({ requestId: randomUUID(), source: "voice", body: "What else?", messageId: randomUUID(),
    brainProfileId: original.run.brainProfileId, spec: { ...original.run.spec, runId: randomUUID() }, attemptId: existingAttempt.id }));
  const after = f.database.getOrchestrationState(f.projectId)!;
  assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(after.runs, before.runs);
});

test("activity snapshots prioritize blocked work and stay within the controller limit", t => {
  const f = fixture(t);
  runningTask(f.database, f.projectId);
  const state = f.database.getOrchestrationState(f.projectId)!;
  const template = state.tasks[0]!;
  state.tasks = Array.from({ length: 200 }, (_, index) => ({ ...template, id: String(index), title: "Task ".repeat(100), dependsOn: Array.from({ length: 5 }, (_, n) => `${index + n + 1}`), status: index === 150 ? "blocked" : "in_progress" }));
  const snapshot = questionActivityContext(state);
  assert(snapshot.length <= 30_000);
  const parsed = JSON.parse(snapshot);
  assert.equal(parsed.taskCount, 200);
  assert.equal(parsed.tasks[0].id, "150");
  assert.equal(parsed.tasks[0].dependencies[0].status, "in_progress");
  assert.equal(parsed.omittedTasks, 200 - parsed.tasks.length);
});
