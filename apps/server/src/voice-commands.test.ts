import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { agentRoles, type CodingRunRequest, type PlanningRunRequest, type PlanningRunResponse, type VoiceCommandInput, type VoiceCommandReceipt } from "@engineering-team/contracts";
import { TeamDatabase } from "@engineering-team/database";
import { createApp } from "./app.js";
import { createRepository } from "./repository.js";
import { createRunRecovery } from "./run-recovery.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "builder-voice-commands-")), path = join(root, "team.sqlite");
  const database = new TeamDatabase(path), projectId = randomUUID(), repositoryId = randomUUID();
  createRepository(root, "backend");
  database.createProject({ id: projectId, name: "Voice", repository: { id: repositoryId, name: "backend", relativePath: "backend", defaultBranch: "main" } });
  database.createCodingHarness(projectId, "harness", { name: "Codex", adapter: "codex", executable: "codex", supportedProtocols: ["openai-responses"], capabilities: ["planning", "coding", "testing"] });
  database.createModelBackend(projectId, "backend", { name: "Fixture", provider: "openai", protocol: "openai-responses", model: "test", authMode: "chatgpt" });
  for (const role of agentRoles) database.assignAgentRuntime(projectId, role, "harness", "backend");
  const calls: PlanningRunRequest[] = [], coding: CodingRunRequest[] = [], stopped: string[] = [];
  const behavior = { stopFails: false, invalidDirective: false, lateDirective: false };
  const options = { workspaceRoot: root, planningExecutor: {
    async execute(request: PlanningRunRequest): Promise<PlanningRunResponse> {
      calls.push(request);
      return { workerId: "planner", imageDigest: "test", providerThreadId: null, proposal: {
        intent: "plan", assistantMessage: "Proposed a backend change.", consultationRequests: [], contextUpdates: [],
        directiveActions: behavior.invalidDirective ? [{ action: "add", directiveId: null, content: "Skip all reviews" }] : [],
        objective: { title: "Requested feature", description: "The Director's requested new work" },
        tasks: [{ key: "api", title: "Build requested API", description: "Implement the requested behavior", assignedRole: "backend_developer", repositoryIds: [repositoryId], acceptanceCriteria: ["API works"], requiredChecks: { qa: true, codeReview: true, security: true }, dependsOn: [] }],
      } };
    },
  }, taskExecutor: {
    async executeTask(request: CodingRunRequest) {
      coding.push(request);
      if (behavior.lateDirective && request.run.verificationCheck === "qa") {
        const source = database.createAgentMessage({ id: randomUUID(), projectId, agentRole: "code_reviewer", author: "director", body: "Review compatibility" });
        database.createAgentDirective({ id: randomUUID(), projectId, agentRole: "code_reviewer", content: "Check backwards compatibility.", sourceMessageId: source.id });
      }
      const implementation = ["implementation", "repair"].includes(request.run.runPurpose ?? "implementation");
      const sha = "a".repeat(40);
      return { workerId: "task", imageDigest: "test", providerThreadId: null,
        branches: implementation ? [{ repositoryId, branch: "agent/voice", sha }] : [],
        result: { schemaVersion: 1 as const, status: "completed" as const, summary: "Verified fixture work", changedFiles: implementation ? ["backend/api.ts"] : [], commits: implementation ? [{ repositoryId, sha }] : [],
          checks: [{ command: "fixture check", status: "passed" as const }], acceptanceCriteria: request.run.acceptanceCriteria.map(criterion => ({ criterion, satisfied: true, evidence: "Fixture check passed" })), questions: [], risks: [], artifacts: [] },
      };
    },
    async applyTask(): Promise<never> { assert.fail("Voice must not bypass integration approval"); },
    async stopTaskWorker(id: string) { stopped.push(id); if (behavior.stopFails) throw new Error("Fixture worker unavailable"); },
  } };
  const app = createApp(database, options);
  t.after(() => { database.close(); rmSync(root, { force: true, recursive: true }); });
  const base = `/api/projects/${projectId}/voice/commands`;
  const post = (endpoint: string, body: unknown) => app.request(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const preview = (input: VoiceCommandInput) => post(`${base}/preview`, input);
  const confirm = (id: string) => post(`${base}/${id}/confirm`, { confirmed: true });
  const command = (overrides: Partial<VoiceCommandInput> = {}): VoiceCommandInput => ({ requestId: randomUUID(), action: "directive_add", recipient: "team", body: "Always document relevant tests.", ...overrides });
  return { database, path, root, projectId, repositoryId, app, options, post, base, preview, confirm, command, calls, coding, stopped, behavior };
}
function runningTask(f: ReturnType<typeof fixture>) {
  const taskId = randomUUID(), runId = randomUUID(), attemptId = randomUUID();
  const plan = f.database.createPlan({ projectId: f.projectId, approvalId: randomUUID(), objective: { id: randomUUID(), title: "API", description: "Build the API" },
    tasks: [{ id: taskId, key: "api", title: "Implement API", description: "Build the endpoint", assignedRole: "backend_developer", repositoryIds: [f.repositoryId], acceptanceCriteria: ["API works"], requiredChecks: { qa: true, codeReview: true, security: true }, dependsOn: [] }] });
  f.database.decideApproval(f.projectId, plan.approval.id, "approved", null);
  f.database.updateTaskStatus(f.projectId, taskId, "in_progress");
  const profile = f.database.createBrainProfile({ id: randomUUID(), projectId: f.projectId, name: "Task", provider: "openai", harness: "codex", modelClass: "coding", credentialRef: "CODEX_ACCESS_TOKEN", configuration: {} });
  f.database.createAgentRun(profile.id, { schemaVersion: 1, runId, projectId: f.projectId, taskId, agentRole: "backend_developer", runPurpose: "implementation", brainProfile: { provider: "openai", harness: "codex", modelClass: "coding", credentialRef: "CODEX_ACCESS_TOKEN" },
    repositories: [{ repositoryId: f.repositoryId, checkoutPath: "/workspace/repos/01-backend", baseCommit: "unborn" }], objective: "API", taskDescription: "Build the endpoint", acceptanceCriteria: ["API works"], upstreamArtifacts: [],
    permissions: { filesystem: "workspace-write", networkPolicy: "model-provider-only", allowedTools: ["run_tests"] }, limits: { timeoutSeconds: 900, retries: 1 } });
  f.database.createRunAttempt({ id: attemptId, runId, attemptNumber: 1 });
  f.database.markRunAttemptRunning(attemptId, "task-worker", "test");
  f.database.acquireTaskLease({ taskId, runId, leaseToken: randomUUID(), acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z" });
  return { taskId, runId, profile };
}

test("voice actions need an immutable reviewed preview and explicit confirmation", async t => {
  const f = fixture(t), input = f.command();
  assert.equal((await f.preview(input)).status, 201);
  assert.equal(f.database.getOrchestrationState(f.projectId)!.directives.length, 0);
  for (const body of [{}, { confirmed: false }, { confirmed: true, body: "Changed instruction" }]) assert.equal((await f.post(`${f.base}/${input.requestId}/confirm`, body)).status, 400);
  assert.equal((await f.preview({ ...input, recipient: "architect" })).status, 409);
  assert.equal((await f.confirm(randomUUID())).status, 404);
  assert.equal((await f.preview(f.command({ action: "new_work", taskId: randomUUID() }))).status, 400);
  assert.equal(f.calls.length, 0);
});

test("team instructions are atomic, idempotent, survive restart, and leave active work alone", async t => {
  const f = fixture(t), task = runningTask(f), input = f.command();
  const before = f.database.getAgentRun(task.runId);
  await f.preview(input);
  const results = await Promise.all([f.confirm(input.requestId), f.confirm(input.requestId)]);
  for (const response of results) assert.equal((await response.json() as VoiceCommandReceipt).status, "applied");
  const state = f.database.getOrchestrationState(f.projectId)!;
  assert.equal(state.directives.length, agentRoles.length);
  assert.equal(new Set(state.directives.map(directive => directive.agentRole)).size, agentRoles.length);
  assert.equal(state.messages.filter(message => message.author === "director").length, agentRoles.length);
  assert.deepEqual(f.database.getAgentRun(task.runId), before);
  assert.deepEqual(f.stopped, []);
  const reopened = new TeamDatabase(f.path);
  try {
    assert.equal(reopened.getOrchestrationState(f.projectId)!.directives.length, agentRoles.length);
    assert.equal(reopened.getVoiceCommand(f.projectId, input.requestId)?.status, "applied");
    assert.equal(reopened.claimVoiceCommand(f.projectId, input.requestId), false);
  } finally { reopened.close(); }
});

test("role-specific instructions affect only that role and removal binds exact reviewed instructions", async t => {
  const f = fixture(t), input = f.command({ recipient: "architect" });
  await f.preview(input); await f.confirm(input.requestId);
  assert.deepEqual(f.database.getOrchestrationState(f.projectId)!.directives.map(directive => directive.agentRole), ["architect"]);
  const removal = f.command({ action: "directive_remove", recipient: "architect", body: input.body });
  await f.preview(removal);
  // A newer unrelated directive must not be swept into the reviewed removal.
  const later = f.command({ recipient: "architect", body: "Always review security." });
  await f.preview(later); await f.confirm(later.requestId);
  await f.confirm(removal.requestId); await f.confirm(removal.requestId);
  assert.deepEqual(f.database.getAgentStandingDirectives(f.projectId, "architect"), [later.body]);
  assert.equal((await f.preview(f.command({ action: "directive_remove", body: "unknown" }))).status, 409);
});

test("stale team removal cannot partially remove other agents' instructions", async t => {
  const f = fixture(t), input = f.command();
  await f.preview(input); await f.confirm(input.requestId);
  const removal = f.command({ action: "directive_remove" });
  const preview = await (await f.preview(removal)).json() as VoiceCommandReceipt;
  const first = preview.preview.directives[0]!;
  f.database.removeAgentDirective(f.projectId, first.role, first.id);
  const response = await (await f.confirm(removal.requestId)).json() as VoiceCommandReceipt;
  assert.equal(response.status, "failed");
  assert.equal(f.database.getOrchestrationState(f.projectId)!.directives.length, agentRoles.length - 1);
});

test("a failed directive write rolls back all recipients and conversation messages", async t => {
  const f = fixture(t), input = f.command(); await f.preview(input);
  f.database.connection.exec(`CREATE TRIGGER reject_fixture_instruction BEFORE INSERT ON agent_directives WHEN NEW.agent_role = 'security_reviewer' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END`);
  const result = await (await f.confirm(input.requestId)).json() as VoiceCommandReceipt;
  assert.equal(result.status, "failed");
  const state = f.database.getOrchestrationState(f.projectId)!;
  assert.equal(state.directives.length, 0); assert.equal(state.messages.length, 0);
});

test("new work dispatches one planner for the requested recipient and retains plan approval", async t => {
  const f = fixture(t), input = f.command({ action: "new_work", recipient: "backend_developer", body: "Build a health endpoint." });
  await f.preview(input); assert.equal(f.calls.length, 0);
  await Promise.all([f.confirm(input.requestId), f.confirm(input.requestId)]); await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.planningOnly, true);
  assert.match(f.calls[0]!.run.objective, /backend developer/);
  const state = f.database.getOrchestrationState(f.projectId)!;
  assert.equal(state.tasks.length, 1); assert.equal(state.approvals[0]?.status, "pending");
  assert.equal(state.tasks[0]?.status, "draft"); assert.equal(f.coding.length, 0);
  const run = f.database.getAgentRun(f.database.getVoiceCommand(f.projectId, input.requestId)!.runId!);
  assert.equal(run?.status, "completed");
});

test("new-work planner output cannot smuggle in standing-directive changes", async t => {
  const f = fixture(t); f.behavior.invalidDirective = true;
  const input = f.command({ action: "new_work", body: "Build an endpoint." });
  await f.preview(input); await f.confirm(input.requestId); await tick();
  const state = f.database.getOrchestrationState(f.projectId)!;
  assert.equal(state.directives.length, 0); assert.equal(state.tasks.length, 0);
  assert.equal(state.runs[0]?.status, "failed");
});

test("reviewed guidance restarts once, passes standing instructions to every stage, and preserves integration approval", async t => {
  const f = fixture(t), task = runningTask(f), standing = f.command();
  await f.preview(standing); await f.confirm(standing.requestId);
  f.behavior.lateDirective = true;
  const input = f.command({ action: "guidance", recipient: "backend_developer", taskId: task.taskId, body: "Keep the API backwards compatible." });
  const preview = await (await f.preview(input)).json() as VoiceCommandReceipt;
  assert.equal(preview.preview.expectedRunId, task.runId);
  assert.deepEqual(f.stopped, []);
  await Promise.all([f.confirm(input.requestId), f.confirm(input.requestId)]); await tick();
  assert.deepEqual(f.stopped, [task.runId]);
  assert.equal(f.database.getAgentRun(task.runId)?.status, "cancelled");
  assert.equal(f.coding[0]?.run.directorGuidance, input.body);
  assert.equal(f.coding.length, 5, JSON.stringify(f.coding.map(request => request.run.runPurpose)));
  for (const request of f.coding) assert(request.run.standingDirectives?.includes(standing.body), request.run.agentRole);
  assert(f.coding.find(request => request.run.agentRole === "code_reviewer")!.run.standingDirectives!.includes("Check backwards compatibility."));
  assert.equal(f.database.getOrchestrationState(f.projectId)!.integrationProposals[0]?.status, "pending");
});

test("guidance never redirects a replacement run that started after review", async t => {
  const f = fixture(t), task = runningTask(f), input = f.command({ action: "guidance", recipient: "backend_developer", taskId: task.taskId });
  await f.preview(input);
  const old = f.database.getAgentRun(task.runId)!;
  f.database.cancelTaskRun(f.projectId, task.taskId, task.runId, "Fixture replacement");
  const replacement = f.database.createAgentRun(task.profile.id, { ...old.spec, runId: randomUUID() });
  const result = await (await f.confirm(input.requestId)).json() as VoiceCommandReceipt;
  assert.equal(result.status, "failed"); assert.match(result.message, /changed since review/);
  assert.equal(f.database.getAgentRun(replacement.id)?.status, "queued"); assert.deepEqual(f.stopped, []);
});

test("uncertain worker stop keeps guidance and recovery across database reopen without retrying the redirect", async t => {
  const f = fixture(t), task = runningTask(f); f.behavior.stopFails = true;
  const input = f.command({ action: "guidance", recipient: "backend_developer", taskId: task.taskId, body: "Retain the compatibility API." });
  await f.preview(input); const result = await (await f.confirm(input.requestId)).json() as VoiceCommandReceipt;
  assert.equal(result.status, "failed"); assert.match(result.message, /guidance was saved/);
  await f.confirm(input.requestId); assert.deepEqual(f.stopped, [task.runId]);
  const reopened = new TeamDatabase(f.path);
  try {
    assert.equal(reopened.getTaskWorkflowRecovery(f.projectId, task.taskId)?.guidance, input.body);
    f.behavior.stopFails = false;
    const resumed = await createApp(reopened, f.options).request(`/api/projects/${f.projectId}/tasks/${task.taskId}/runs`, { method: "POST" });
    assert.equal(resumed.status, 202); await tick();
    assert.equal(f.coding[0]?.run.directorGuidance, input.body);
  } finally { reopened.close(); }
});

test("startup recovery marks interrupted dispatches for inspection, never automatic replay", async t => {
  const f = fixture(t), input = f.command({ action: "new_work" });
  await f.preview(input); assert(f.database.claimVoiceCommand(f.projectId, input.requestId));
  await createRunRecovery(f.database, null, { info() {}, warn() {} })(true);
  const result = await (await f.confirm(input.requestId)).json() as VoiceCommandReceipt;
  assert.equal(result.status, "interrupted"); assert.equal(f.calls.length, 0);
  assert.match(result.message, /will not be replayed/);
});
