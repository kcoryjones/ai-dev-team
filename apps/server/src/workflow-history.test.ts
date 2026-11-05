import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentRunStatus, CodingRunRequest, OrchestrationState, RunSpec } from "@engineering-team/contracts";
import { TeamDatabase } from "@engineering-team/database";
import { createApp } from "./app.js";
import { createRepository } from "./repository.js";
import { appendCompletedHistory } from "./test-history.js";

function fixture(t: TestContext) {
  const database = new TeamDatabase(":memory:");
  const workspaceRoot = mkdtempSync(join(tmpdir(), "builder-history-"));
  t.after(() => { database.close(); rmSync(workspaceRoot, { recursive: true, force: true }); });
  createRepository(workspaceRoot, "backend");
  const projectId = randomUUID(), repositoryId = randomUUID(), taskId = randomUUID();
  database.createProject({ id: projectId, name: "History", repository: { id: repositoryId, name: "backend", relativePath: "backend", defaultBranch: "main" } });
  database.updateProjectSettings(projectId, { planningNetworkPolicy: "model-provider-only", defaultRunRetries: 0 });
  const plan = database.createPlan({ projectId, approvalId: randomUUID(), objective: { id: randomUUID(), title: "History", description: "Keep workflow evidence visible" }, tasks: [
    { id: taskId, key: "build", title: "Build", description: "Implement", assignedRole: "backend_developer", repositoryIds: [repositoryId], acceptanceCriteria: ["Works"], requiredChecks: { qa: false, codeReview: false, security: false }, dependsOn: [] },
  ] });
  database.decideApproval(projectId, plan.approval.id, "approved", null);
  database.updateTaskStatus(projectId, taskId, "in_progress");
  database.createCodingHarness(projectId, "harness", { name: "Codex", adapter: "codex", executable: "codex", supportedProtocols: ["openai-responses"], capabilities: ["coding", "planning", "review", "testing"] });
  database.createModelBackend(projectId, "backend", { name: "Fixture", provider: "openai", protocol: "openai-responses", model: "gpt-test", authMode: "api-key", credentialRef: "DUMMY" });
  for (const role of ["project_manager", "architect", "backend_developer", "qa_engineer", "release_manager"] as const) database.assignAgentRuntime(projectId, role, "harness", "backend");
  const profile = database.createBrainProfile({ id: "profile", projectId, name: "Fixture", provider: "openai", harness: "codex", modelClass: "coding", credentialRef: "DUMMY", configuration: {} });
  function seedRun(status: AgentRunStatus, patch: Partial<RunSpec> = {}) {
    const runId = randomUUID(), attemptId = randomUUID();
    const spec: RunSpec = { schemaVersion: 1, runId, projectId, agentRole: "architect", runPurpose: "consultation",
      brainProfile: { provider: "openai", harness: "codex", modelClass: "coding", credentialRef: "DUMMY" },
      repositories: [{ repositoryId, checkoutPath: "/workspace/backend", baseCommit: "unborn" }],
      objective: "History", taskDescription: "Inspect", acceptanceCriteria: ["Works"], upstreamArtifacts: ["director-message:fixture"],
      permissions: { filesystem: "workspace-write", networkPolicy: "model-provider-only", allowedTools: [] }, limits: { timeoutSeconds: 30, retries: 0 }, ...patch };
    database.createAgentRun(profile.id, spec);
    if (status !== "queued") {
      database.createRunAttempt({ id: attemptId, runId, attemptNumber: 1 });
      if (status === "running") database.markRunAttemptRunning(attemptId, "fixture", "fixture");
      if (status === "waiting" || status === "completed") database.completeAgentRun(runId, attemptId, {
        schemaVersion: 1, status: status === "waiting" ? "needs_input" : "completed", summary: status === "waiting" ? "Awaiting input" : "Finished",
        changedFiles: [], commits: [], checks: [{ command: "inspect", status: "passed" }],
        acceptanceCriteria: spec.acceptanceCriteria.map(criterion => ({ criterion, satisfied: true, evidence: "Inspected" })), questions: [], risks: [], artifacts: [],
      });
    }
    return database.getAgentRun(runId)!;
  }
  const stopped: string[] = [], started: CodingRunRequest[] = [];
  let conversations = 0;
  const app = createApp(database, { workspaceRoot, planningExecutor: {
    async execute() { conversations++; throw new Error("A busy agent must not start another conversation"); },
    async consult() { conversations++; throw new Error("A busy agent must not start another conversation"); },
    async stopAgentWorker(runId) { stopped.push(runId); },
  }, taskExecutor: {
    async executeTask(request) {
      started.push(request);
      return { workerId: "fixture", imageDigest: "fixture", providerThreadId: null, branches: [], result: {
        schemaVersion: 1, status: "failed", summary: "Stop after checking the restart request", changedFiles: [], commits: [],
        checks: [{ command: "fixture", status: "failed" }], acceptanceCriteria: request.run.acceptanceCriteria.map(criterion => ({ criterion, satisfied: false, evidence: "Fixture stop" })), questions: [], risks: [], artifacts: [],
      } };
    },
    async applyTask() { throw new Error("Not used"); },
    async stopTaskWorker(runId) { stopped.push(runId); },
  } });
  return { database, app, projectId, taskId, seedRun, stopped, started, conversationCount: () => conversations };
}

for (const role of ["architect", "project_manager"] as const) {
  test(`an old active ${role} remains visible, blocks duplicate messages, and can be cancelled`, async t => {
    const f = fixture(t);
    const active = f.seedRun("running", { agentRole: role });
    appendCompletedHistory(f.database, active);
    assert(!f.database.listAgentRuns(f.projectId).some(run => run.id === active.id));
    const response = await f.app.request(`/api/projects/${f.projectId}/orchestration`);
    const { state } = await response.json() as { state: OrchestrationState };
    assert.equal(state.runs.length, 25);
    assert.deepEqual(state.activeRuns.map(run => run.id), [active.id]);
    const duplicate = await f.app.request(`/api/projects/${f.projectId}/agents/${role}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "Another request" }),
    });
    assert.equal(duplicate.status, 409, await duplicate.clone().text());
    assert.equal((await duplicate.json() as { error: string }).error, "agent_busy");
    assert.equal(f.conversationCount(), 0);
    const cancelled = await f.app.request(`/api/projects/${f.projectId}/agents/${role}/runs/${active.id}/cancel`, { method: "POST" });
    assert.equal(cancelled.status, 200, await cancelled.text());
    assert.deepEqual(f.stopped, [active.id]);
    assert.deepEqual(f.database.getOrchestrationState(f.projectId)?.activeRuns, []);
  });
}

for (const status of ["queued", "provisioning", "running", "waiting"] as const) {
  test(`an old ${status} task remains visible, blocks duplicate starts, and can be cancelled`, async t => {
    const f = fixture(t);
    const active = f.seedRun(status, { taskId: f.taskId, agentRole: "backend_developer", runPurpose: "implementation" });
    appendCompletedHistory(f.database, active);
    const state = f.database.getOrchestrationState(f.projectId)!;
    assert(!state.runs.some(run => run.id === active.id));
    assert.deepEqual(state.activeRuns.map(run => run.id), [active.id]);
    assert(state.taskRuns[f.taskId]?.some(run => run.id === active.id));
    assert.deepEqual(f.database.listActiveAgentRuns(f.projectId, { agentRole: "architect" }), []);
    assert.deepEqual(f.database.listActiveAgentRuns(f.projectId, { taskId: "other-task" }), []);
    assert.deepEqual(f.database.listActiveAgentRuns("other-project"), []);
    const duplicate = await f.app.request(`/api/projects/${f.projectId}/tasks/${f.taskId}/runs`, { method: "POST" });
    assert.equal(duplicate.status, 409, await duplicate.clone().text());
    assert.equal((await duplicate.json() as { error: string }).error, "task_busy");
    assert.equal(f.started.length, 0);
    const cancelled = await f.app.request(`/api/projects/${f.projectId}/tasks/${f.taskId}/cancel`, { method: "POST" });
    assert.equal(cancelled.status, 200, await cancelled.text());
    assert.deepEqual(f.stopped, [active.id]);
    assert.equal(f.database.getTaskWorkflowRecovery(f.projectId, f.taskId)?.interruptedRunId, active.id);
    assert.deepEqual(f.database.listActiveAgentRuns(f.projectId), []);
  });
}

test("a hidden active task can be redirected and restarted with the Director's guidance", async t => {
  const f = fixture(t);
  const active = f.seedRun("running", { taskId: f.taskId, agentRole: "backend_developer", runPurpose: "implementation" });
  appendCompletedHistory(f.database, active);
  const response = await f.app.request(`/api/projects/${f.projectId}/tasks/${f.taskId}/redirect`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guidance: "Preserve backwards compatibility" }),
  });
  assert.equal(response.status, 202, await response.text());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.stopped, [active.id]);
  assert.equal(f.started.length, 1);
  assert.equal(f.started[0]?.run.directorGuidance, "Preserve backwards compatibility");
});

test("recovery refuses to start over an older active verification run", async t => {
  const f = fixture(t);
  const interrupted = f.seedRun("running", { taskId: f.taskId, agentRole: "qa_engineer", runPurpose: "verification", verificationCheck: "qa" });
  f.database.cancelTaskRun(f.projectId, f.taskId, interrupted.id, "Interrupted");
  const active = f.seedRun("running", { taskId: f.taskId, agentRole: "qa_engineer", runPurpose: "verification", verificationCheck: "qa" });
  appendCompletedHistory(f.database, active);
  const response = await f.app.request(`/api/projects/${f.projectId}/tasks/${f.taskId}/resume`, { method: "POST" });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: string }).error, "task_busy");
  assert.equal(f.database.getTaskWorkflowRecovery(f.projectId, f.taskId)?.interruptedRunId, interrupted.id);
  assert.equal(f.started.length, 0);
});

test("the active-run list remains complete with more than 25 active runs", t => {
  const f = fixture(t);
  const statuses = ["queued", "provisioning", "running", "waiting"] as const;
  const active = Array.from({ length: 32 }, (_, index) => f.seedRun(statuses[index % statuses.length]!));
  const state = f.database.getOrchestrationState(f.projectId)!;
  assert.equal(state.runs.length, 25);
  assert.deepEqual(new Set(state.activeRuns.map(run => run.id)), new Set(active.map(run => run.id)));
});

test("the live activity feed includes the latest event of an active run outside recent history", t => {
  const f = fixture(t);
  const active = f.seedRun("running");
  f.database.appendRunEvent({ schemaVersion: 1, id: randomUUID(), runId: active.id, attemptId: null, sequence: 1, type: "agent.message", message: "Still inspecting", payload: {}, createdAt: new Date().toISOString() });
  appendCompletedHistory(f.database, active);
  assert.equal(f.database.getOrchestrationState(f.projectId)?.runActivities[active.id]?.message, "Still inspecting");
});
