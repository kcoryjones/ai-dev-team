import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ApplyCodingRunRequest, CodingRunRequest, RunResult, RunSpec } from "@engineering-team/contracts";
import { TeamDatabase } from "@engineering-team/database";
import { createApp } from "./app.js";
import { runCaptureGit } from "./worker-checkout.js";
import { createIntegrationApplier } from "./worker-integration.js";
import { appendCompletedHistory } from "./test-history.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "builder-integration-"));
  const source = join(root, "backend");
  await mkdir(source);
  const git = (...args: string[]) => runCaptureGit(["-C", source, ...args]);
  await git("init", "--quiet", "--initial-branch=main");
  await writeFile(join(source, "code.txt"), "original\n");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "Initial");
  const baseCommit = (await git("rev-parse", "HEAD")).trim();
  const projectId = randomUUID(), taskId = randomUUID(), repositoryId = randomUUID(), runId = randomUUID(), approvalId = randomUUID();
  const branch = `agent/${taskId.slice(0, 8)}-${runId.slice(0, 8)}`;
  await git("checkout", "--quiet", "-b", branch);
  await writeFile(join(source, "code.txt"), "implemented\n");
  await git("commit", "--quiet", "-am", "Implementation");
  const sha = (await git("rev-parse", "HEAD")).trim();
  await git("checkout", "--quiet", "main");
  const dbPath = join(root, "team.db");
  const connections: TeamDatabase[] = [];
  const openDatabase = () => { const db = new TeamDatabase(dbPath); connections.push(db); return db; };
  const database = openDatabase();
  t.after(async () => { for (const db of connections) if (db.connection.open) db.close(); await rm(root, { recursive: true, force: true }); });
  database.createProject({ id: projectId, name: "Integration", repository: { id: repositoryId, name: "backend", relativePath: "backend", defaultBranch: "main" } });
  const plan = database.createPlan({
    projectId, approvalId: randomUUID(), objective: { id: randomUUID(), title: "Delivery", description: "Integrate safely" },
    tasks: [{ id: taskId, key: "build", title: "Build", description: "Implement", assignedRole: "backend_developer", repositoryIds: [repositoryId], acceptanceCriteria: ["Works"], requiredChecks: { qa: false, codeReview: false, security: false }, dependsOn: [] }],
  });
  database.decideApproval(projectId, plan.approval.id, "approved", null);
  database.updateTaskStatus(projectId, taskId, "in_progress");
  const profile = database.createBrainProfile({ id: randomUUID(), projectId, name: "Fixture", provider: "test", harness: "test", modelClass: "test", credentialRef: "DUMMY", configuration: {} });
  const spec: RunSpec = {
    schemaVersion: 1, runId, projectId, taskId, agentRole: "backend_developer", runPurpose: "implementation",
    brainProfile: { provider: "test", harness: "test", modelClass: "test", credentialRef: "DUMMY" },
    repositories: [{ repositoryId, checkoutPath: "/workspace/backend", baseCommit }],
    objective: "Delivery", taskDescription: "Implement", acceptanceCriteria: ["Works"], upstreamArtifacts: [],
    permissions: { filesystem: "workspace-write", networkPolicy: "offline", allowedTools: [] }, limits: { timeoutSeconds: 30, retries: 0 },
  };
  const result: RunResult = { schemaVersion: 1, status: "completed", summary: "Ready", commits: [{ repositoryId, sha }], changedFiles: ["code.txt"], checks: [{ command: "test", status: "passed" }], acceptanceCriteria: [{ criterion: "Works", satisfied: true, evidence: "Tests pass" }], questions: [], risks: [], artifacts: [`git:${branch}`] };
  function completeRun(runSpec: RunSpec, runResult = result) {
    database.createAgentRun(profile.id, runSpec);
    const attemptId = randomUUID();
    database.createRunAttempt({ id: attemptId, runId: runSpec.runId, attemptNumber: 1 });
    database.completeAgentRun(runSpec.runId, attemptId, runResult);
  }
  completeRun(spec);
  const releaseId = randomUUID();
  completeRun({ ...spec, runId: releaseId, agentRole: "release_manager", runPurpose: "release", upstreamArtifacts: [`implementation-run:${runId}`], repositories: [{ repositoryId, checkoutPath: "/workspace/backend", baseCommit: sha }] }, { ...result, commits: [], changedFiles: [] });
  database.updateTaskStatus(projectId, taskId, "review");
  database.createIntegrationProposal({ approvalId, projectId, taskId, changeRunId: runId, releaseRunId: releaseId, title: "Integrate", details: "Verified commit" });
  const request: ApplyCodingRunRequest = { approvalId, runId, taskId, repositories: [{ repositoryId, name: "backend", sourcePath: source, branch, sha, baseCommit, targetBranch: "main" }] };
  const receiptRoot = join(root, "receipts");
  const apply = createIntegrationApplier(root, receiptRoot);
  function app(db = database, applyTask = apply) {
    return createApp(db, { workspaceRoot: root, taskExecutor: { applyTask, async executeTask() { throw new Error("No new worker should start"); } } });
  }
  const endpoint = `/api/projects/${projectId}/approvals/${approvalId}`;
  const decide = (api: ReturnType<typeof app>, decision = "approved") => api.request(endpoint, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) });
  return { root, source, git, database, openDatabase, projectId, taskId, runId, approvalId, spec, profile, completeRun, request, receiptRoot, apply, app, decide };
}

function mockWorkflow(f: Awaited<ReturnType<typeof fixture>>, failFirst = false) {
  const requests: CodingRunRequest[] = [];
  f.database.createCodingHarness(f.projectId, "harness", { name: "Codex", adapter: "codex", executable: "codex", supportedProtocols: ["openai-responses"], capabilities: ["coding", "testing"] });
  f.database.createModelBackend(f.projectId, "backend", { name: "Fixture", provider: "openai", protocol: "openai-responses", model: "gpt-test", authMode: "api-key", credentialRef: "DUMMY" });
  for (const role of ["backend_developer", "release_manager"] as const) f.database.assignAgentRuntime(f.projectId, role, "harness", "backend");
  const api = createApp(f.database, { workspaceRoot: f.root, taskExecutor: {
    async executeTask(request) {
      requests.push(structuredClone(request));
      const failed = failFirst && requests.length === 1;
      const assessment = request.run.runPurpose === "release";
      const sha = request.run.runId.replaceAll("-", "").padEnd(40, "0");
      const repositoryId = request.run.repositories[0]!.repositoryId;
      const branch = `agent/${request.run.taskId!.slice(0, 8)}-${request.run.runId.slice(0, 8)}`;
      return { workerId: "fixture", imageDigest: "fixture", providerThreadId: null,
        branches: assessment || failed ? [] : [{ repositoryId, branch, sha }],
        result: {
          schemaVersion: 1, status: failed ? "failed" : "completed", summary: failed ? "Temporary failure" : "Completed",
          changedFiles: assessment || failed ? [] : ["code.txt"], commits: assessment || failed ? [] : [{ repositoryId, sha }],
          checks: [{ command: "fixture check", status: failed ? "failed" : "passed" }],
          acceptanceCriteria: request.run.acceptanceCriteria.map(criterion => ({ criterion, satisfied: !failed, evidence: failed ? "Failed check" : "Passed check" })),
          questions: [], risks: [], artifacts: assessment || failed ? [] : [`git:${branch}`],
        },
      };
    },
    async applyTask() { throw new Error("No superseded approval may reach apply"); },
  } });
  const rerun = () => api.request(`/api/projects/${f.projectId}/tasks/${f.taskId}/rerun`, { method: "POST" });
  async function start() {
    const response = await api.request(`/api/projects/${f.projectId}/tasks/${f.taskId}/runs`, { method: "POST" });
    assert.equal(response.status, 202, await response.text());
    await new Promise(resolve => setImmediate(resolve));
  }
  return { api, requests, rerun, start };
}

for (const stale of [false, true]) {
  test(`rejected work retains Director feedback and ${stale ? "uses the newer source base" : "can repair its unchanged base"}`, async t => {
    const f = await fixture(t);
    f.database.decideApproval(f.projectId, f.approvalId, "rejected", "Add the missing edge case");
    if (stale) {
      await writeFile(join(f.source, "code.txt"), "Newer source\n");
      await f.git("commit", "--quiet", "-am", "Advance base");
    }
    const sourceHead = (await f.git("rev-parse", "HEAD")).trim();
    const workflow = mockWorkflow(f);
    const rerun = await workflow.rerun();
    assert.equal(rerun.status, 200, await rerun.text());
    const oldApproval = f.database.getApproval(f.projectId, f.approvalId)!;
    assert.equal(oldApproval.status, "superseded");
    assert.equal(oldApproval.decisionNote, "Add the missing edge case");
    assert(oldApproval.supersededAt);
    assert.equal((await f.decide(workflow.api)).status, 409);
    await workflow.start();
    const request = workflow.requests[0]!;
    assert.equal(request.run.runPurpose, stale ? "implementation" : "repair");
    assert.equal(request.run.repositories[0]!.baseCommit, stale ? sourceHead : f.request.repositories[0]!.sha);
    assert.match(request.run.taskDescription, /Add the missing edge case/);
    const replacement = f.database.listIntegrationProposals(f.projectId)[0]!;
    assert.equal(replacement.status, "pending");
    assert.equal(replacement.changeRunId, request.run.runId);
    assert.equal(workflow.requests[1]!.run.repositories[0]!.baseCommit, f.database.getAgentRun(request.run.runId)!.result!.commits[0]!.sha);
    // A later stale rerun must not inherit an unrelated historical rejection.
    await writeFile(join(f.source, "code.txt"), "Another newer source\n");
    await f.git("commit", "--quiet", "-am", "Advance again");
    const nextHead = (await f.git("rev-parse", "HEAD")).trim();
    assert.equal((await workflow.rerun()).status, 200);
    await workflow.start();
    assert.equal(workflow.requests[2]!.run.runPurpose, "implementation");
    assert.equal(workflow.requests[2]!.run.repositories[0]!.baseCommit, nextHead);
    assert.doesNotMatch(workflow.requests[2]!.run.taskDescription, /Add the missing edge case/);
  });
}

test("retrying a failed stale rerun cannot revive the previous workflow's implementation", async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, "code.txt"), "Newer source\n");
  await f.git("commit", "--quiet", "-am", "Advance base");
  const head = (await f.git("rev-parse", "HEAD")).trim();
  const workflow = mockWorkflow(f, true);
  assert.equal((await workflow.rerun()).status, 200);
  await workflow.start();
  assert.equal(f.database.getOrchestrationState(f.projectId)?.tasks[0]?.status, "in_progress");
  await workflow.start();
  assert.deepEqual(workflow.requests.slice(0, 2).map(request => request.run.runPurpose), ["implementation", "implementation"]);
  assert.deepEqual(workflow.requests.slice(0, 2).map(request => request.run.repositories[0]!.baseCommit), [head, head]);
  assert.equal(f.database.getOrchestrationState(f.projectId)?.tasks[0]?.status, "review");
  assert.equal(f.database.listIntegrationProposals(f.projectId)[0]?.changeRunId, workflow.requests[1]!.run.runId);
});

test("reopening applied work preserves its receipt and requires a fresh proposal", async t => {
  const f = await fixture(t);
  assert.equal((await f.decide(f.app())).status, 200);
  const original = f.database.getIntegrationProposal(f.projectId, f.approvalId)!;
  f.database.requeueTask(f.projectId, f.taskId);
  const archived = f.database.getIntegrationProposal(f.projectId, f.approvalId)!;
  assert.equal(archived.status, "superseded");
  assert.equal(archived.appliedAt, original.appliedAt);
  assert.equal(archived.application?.status, "applied");
  assert.equal((await f.decide(f.app())).status, 409);
  const workflow = mockWorkflow(f);
  await workflow.start();
  assert.equal(workflow.requests[0]!.run.repositories[0]!.baseCommit, f.request.repositories[0]!.sha);
  assert.equal(f.database.listIntegrationProposals(f.projectId)[0]?.status, "pending");
  assert.notEqual(f.database.listIntegrationProposals(f.projectId)[0]?.approvalId, f.approvalId);
});

test("a delayed old release cannot recreate a proposal after replacement work starts", async t => {
  const f = await fixture(t);
  const oldRelease = { ...f.spec, runId: randomUUID(), agentRole: "release_manager" as const, runPurpose: "release" as const,
    upstreamArtifacts: [`implementation-run:${f.runId}`], repositories: f.spec.repositories.map(repo => ({ ...repo, baseCommit: f.request.repositories[0]!.sha })) };
  f.database.createAgentRun(f.profile.id, oldRelease);
  const attemptId = randomUUID();
  f.database.createRunAttempt({ id: attemptId, runId: oldRelease.runId, attemptNumber: 1 });
  f.completeRun({ ...f.spec, runId: randomUUID(), runPurpose: "repair" });
  f.database.completeAgentRun(oldRelease.runId, attemptId, { ...f.database.getAgentRun(f.runId)!.result!, commits: [], changedFiles: [] });
  assert.throws(() => f.database.createIntegrationProposal({ approvalId: randomUUID(), projectId: f.projectId, taskId: f.taskId,
    changeRunId: f.runId, releaseRunId: oldRelease.runId, title: "Late proposal", details: "Old work" }), /current implementation/);
  assert.equal(f.database.listIntegrationProposals(f.projectId).filter(proposal => proposal.status === "pending").length, 0);
});

for (const scenario of ["requeued", "implementation replaced", "release replaced", "interrupted apply"] as const) {
  test(`migration preserves history and reconciles ${scenario}`, async t => {
    const f = await fixture(t);
    const interrupted = scenario === "interrupted apply";
    if (interrupted) {
      f.database.claimIntegrationApplication(f.projectId, f.approvalId, "Approved exactly these commits", () => f.request, "lost-owner", "2000-01-01T00:00:00.000Z");
      await f.apply(f.request);
    } else {
      f.database.decideApproval(f.projectId, f.approvalId, "rejected", "Original feedback");
      if (scenario === "requeued") f.database.requeueTask(f.projectId, f.taskId);
      else if (scenario === "implementation replaced") f.completeRun({ ...f.spec, runId: randomUUID(), runPurpose: "repair" });
      else f.completeRun({ ...f.spec, runId: randomUUID(), runPurpose: "release", agentRole: "release_manager", upstreamArtifacts: [`implementation-run:${f.runId}`],
        repositories: f.spec.repositories.map(repo => ({ ...repo, baseCommit: f.request.repositories[0]!.sha })) },
        { ...f.database.getAgentRun(f.runId)!.result!, commits: [], changedFiles: [] });
    }
    // Restore the pre-migration schema while retaining its tasks, audit events and receipts.
    f.database.connection.exec(`ALTER TABLE task_integration_proposals DROP COLUMN superseded_at;
      ALTER TABLE approval_requests DROP COLUMN superseded_at;
      DELETE FROM schema_migrations WHERE version = 25`);
    f.database.close();
    const migrated = f.openDatabase();
    assert.deepEqual(migrated.connection.pragma("foreign_key_check"), []);
    assert.equal(migrated.getApproval(f.projectId, f.approvalId)?.status, interrupted ? "approved" : "superseded");
    assert.equal(migrated.getApproval(f.projectId, f.approvalId)?.decisionNote, interrupted ? "Approved exactly these commits" : "Original feedback");
    const response = await f.decide(f.app(migrated));
    assert.equal(response.status, interrupted ? 200 : 409, await response.text());
  });
}

test("failed requeue rolls back proposal supersession and its audit events", async t => {
  const f = await fixture(t);
  f.database.connection.exec(`CREATE TRIGGER fail_requeue BEFORE UPDATE ON tasks
    BEGIN SELECT RAISE(ABORT, 'Requeue storage failure'); END`);
  assert.throws(() => f.database.requeueTask(f.projectId, f.taskId), /Requeue storage failure/);
  assert.equal(f.database.getApproval(f.projectId, f.approvalId)?.status, "pending");
  assert.equal(f.database.getIntegrationProposal(f.projectId, f.approvalId)?.supersededAt, null);
  assert.equal(f.database.getOrchestrationState(f.projectId)?.tasks[0]?.status, "review");
  assert.equal((f.database.connection.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'integration.superseded'").get() as { count: number }).count, 0);
});

for (const scenario of ["rejected", "requeued", "superseded", "active", "stale target"] as const) {
  test(`${scenario} integration never reaches the controller`, async t => {
    const f = await fixture(t);
    if (scenario === "rejected") f.database.decideApproval(f.projectId, f.approvalId, "rejected", null);
    if (scenario === "requeued") f.database.requeueTask(f.projectId, f.taskId);
    if (scenario === "superseded") f.completeRun({ ...f.spec, runId: randomUUID(), runPurpose: "repair" });
    if (scenario === "active") f.database.createAgentRun(f.profile.id, { ...f.spec, runId: randomUUID(), runPurpose: "verification" });
    if (scenario === "stale target") {
      await writeFile(join(f.source, "code.txt"), "New target work\n");
      await f.git("commit", "--quiet", "-am", "New target work");
    }
    const initialHead = (await f.git("rev-parse", "HEAD")).trim();
    let calls = 0;
    const response = await f.decide(f.app(f.database, async request => { calls++; return f.apply(request); }));
    assert.equal(response.status, 409, await response.text());
    assert.equal(calls, 0);
    if (scenario === "requeued" || scenario === "superseded") {
      assert.equal(f.database.getApproval(f.projectId, f.approvalId)?.status, "superseded");
      assert(f.database.getIntegrationProposal(f.projectId, f.approvalId)?.supersededAt);
    }
    assert.equal(f.database.getIntegrationProposal(f.projectId, f.approvalId)?.application, null);
    assert.equal((await f.git("rev-parse", "HEAD")).trim(), initialHead);
    if (scenario === "stale target") {
      assert.equal(f.database.getApproval(f.projectId, f.approvalId)?.status, "pending");
      assert.equal(f.database.requeueTask(f.projectId, f.taskId).status, "ready");
    }
  });
}

test("concurrent decisions across database connections reserve once, and completed duplicates return the saved result", async t => {
  const f = await fixture(t);
  const secondDatabase = f.openDatabase();
  let unblock!: () => void, entered!: () => void, calls = 0;
  const waiting = new Promise<void>(resolve => { unblock = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const apply = async (request: ApplyCodingRunRequest) => { calls++; entered(); await waiting; return f.apply(request); };
  const api = f.app(f.database, apply), secondApi = f.app(secondDatabase, apply);
  const first = f.decide(api);
  try {
    await started;
    assert.equal(secondDatabase.getApproval(f.projectId, f.approvalId)?.status, "approved");
    assert.equal((await f.decide(secondApi)).status, 409);
    assert.equal((await f.decide(secondApi, "rejected")).status, 409);
    assert.throws(() => secondDatabase.requeueTask(f.projectId, f.taskId), /Resume the approved integration/);
    assert.throws(() => secondDatabase.updateTaskStatus(f.projectId, f.taskId, "completed"), /Resume the approved integration/);
    assert.throws(() => secondDatabase.createAgentRun(f.profile.id, { ...f.spec, runId: randomUUID() }), /Resume the approved integration/);
    assert.equal(secondDatabase.getIntegrationProposal(f.projectId, f.approvalId)?.supersededAt, null);
  } finally { unblock(); }
  const response = await first;
  assert.equal(response.status, 200, await response.clone().text());
  const duplicate = await f.decide(secondApi);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), await response.json());
  assert.equal(calls, 1);
  const state = secondDatabase.getOrchestrationState(f.projectId)!;
  assert.equal(state.tasks[0]?.status, "completed");
  assert.equal(state.integrationProposals[0]?.application?.status, "applied");
  assert.equal(state.messages.filter(message => message.body.startsWith("Director approved integration.")).length, 1);
});

test("lost controller response resumes the frozen request after restart without replaying Git", async t => {
  const f = await fixture(t);
  const response = await f.decide(f.app(f.database, async request => {
    await f.apply(request);
    throw new Error("Response lost after applying");
  }));
  assert.equal(response.status, 409);
  assert.equal(f.database.getApproval(f.projectId, f.approvalId)?.status, "approved");
  assert.equal(f.database.getIntegrationProposal(f.projectId, f.approvalId)?.application?.status, "retryable");
  assert.equal(f.database.getOrchestrationState(f.projectId)?.tasks[0]?.status, "review");
  f.database.close();
  // Repository state no longer matches a freshly built request. The saved receipt
  // must finish the original operation without switching branches or rebuilding it.
  await f.git("checkout", "--quiet", "-b", "later-work");
  await writeFile(join(f.source, "later.txt"), "Local work\n");
  const restarted = f.openDatabase();
  const resume = createIntegrationApplier(f.root, f.receiptRoot, async () => { throw new Error("Completed Git operation replayed"); });
  const retried = await f.decide(f.app(restarted, async request => { assert.deepEqual(request, f.request); return resume(request); }));
  assert.equal(retried.status, 200, await retried.text());
  assert.equal(restarted.getOrchestrationState(f.projectId)?.tasks[0]?.status, "completed");
  assert.equal((await f.git("symbolic-ref", "--short", "HEAD")).trim(), "later-work");
});

test("expired leases recover after restart and fence the former owner", async t => {
  const f = await fixture(t);
  f.database.claimIntegrationApplication(f.projectId, f.approvalId, null, () => f.request, "old-owner", "2000-01-01T00:00:00.000Z");
  await f.apply(f.request);
  f.database.close();
  const restarted = f.openDatabase();
  const claim = restarted.claimIntegrationApplication(f.projectId, f.approvalId, null, () => { throw new Error("Request was rebuilt"); }, "new-owner", "2099-01-01T00:00:00.000Z");
  assert.deepEqual(claim.request, f.request);
  const result = await createIntegrationApplier(f.root, f.receiptRoot)(claim.request);
  assert.throws(() => restarted.completeIntegrationApplication(f.projectId, f.approvalId, "old-owner", result), /lease/);
  restarted.failIntegrationApplication(f.approvalId, "old-owner", "Late failure");
  assert.equal(restarted.getIntegrationProposal(f.projectId, f.approvalId)?.application?.status, "applying");
  restarted.completeIntegrationApplication(f.projectId, f.approvalId, "new-owner", result);
  assert.equal((await f.decide(f.app(restarted))).status, 200);
});

test("incomplete controller evidence cannot mark an integration complete", async t => {
  const f = await fixture(t);
  const rejected = await f.decide(f.app(f.database, async () => ({ applied: [] })));
  assert.equal(rejected.status, 409);
  assert.equal(f.database.getIntegrationProposal(f.projectId, f.approvalId)?.status, "approved");
  assert.equal(f.database.getOrchestrationState(f.projectId)?.tasks[0]?.status, "review");
  assert(!f.database.getAgentRun(f.runId)?.result?.artifacts.some(item => item.startsWith("applied:")));
  assert.equal((await f.decide(f.app())).status, 200);
});

test("the status API cannot complete verified code before approved integration", async t => {
  const f = await fixture(t);
  const api = f.app();
  const complete = () => api.request(`/api/projects/${f.projectId}/tasks/${f.taskId}/status`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "completed" }),
  });
  assert.equal((await complete()).status, 409);
  f.database.markRunBranchesApplied(f.runId, [f.request.repositories[0]!.branch]);
  const forged = await complete();
  assert.equal(forged.status, 409);
  assert.match((await forged.json() as { message: string }).message, /approved, applied integration/);
  assert.equal(f.database.getOrchestrationState(f.projectId)?.tasks[0]?.status, "review");
  assert.equal((await f.decide(api)).status, 200);
  assert.equal(f.database.getOrchestrationState(f.projectId)?.tasks[0]?.status, "completed");
});

test("historical integration evidence stays on the task board after recent history fills", async t => {
  const f = await fixture(t);
  appendCompletedHistory(f.database, f.database.getAgentRun(f.runId)!);
  assert(!f.database.listAgentRuns(f.projectId).some(run => run.id === f.runId));
  const api = f.app();
  const inspect = async () => (await (await api.request(`/api/projects/${f.projectId}/orchestration`)).json()) as {
    state: { runs: Array<{ id: string }>; taskRuns: Record<string, Array<{ id: string }>> };
    reviews: Array<{ taskId: string; state: string; runId: string }>;
  };
  let body = await inspect();
  assert.equal(body.state.runs.length, 25);
  assert(body.state.taskRuns[f.taskId]?.some(run => run.id === f.runId));
  assert.equal(body.reviews.find(review => review.taskId === f.taskId)?.state, "applicable");
  const detail = await api.request(`/api/projects/${f.projectId}/tasks/${f.taskId}/workflow`);
  assert.equal(detail.status, 200);
  assert((await detail.json() as { runs: Array<{ run: { id: string } }> }).runs.some(item => item.run.id === f.runId));
  const applied = await f.decide(api);
  assert.equal(applied.status, 200, await applied.text());
  body = await inspect();
  assert.equal(body.reviews.find(review => review.taskId === f.taskId)?.state, "applied");
});

test("a stale task remains rerunnable when its implementation is outside recent history", async t => {
  const f = await fixture(t);
  appendCompletedHistory(f.database, f.database.getAgentRun(f.runId)!);
  await writeFile(join(f.source, "code.txt"), "Newer base\n");
  await f.git("commit", "--quiet", "-am", "Advance source");
  const api = f.app();
  const response = await api.request(`/api/projects/${f.projectId}/orchestration`);
  assert.equal((await response.json() as { reviews: Array<{ state: string }> }).reviews[0]?.state, "stale");
  const rerun = await api.request(`/api/projects/${f.projectId}/tasks/${f.taskId}/rerun`, { method: "POST" });
  assert.equal(rerun.status, 200, await rerun.text());
  assert.equal(f.database.getApproval(f.projectId, f.approvalId)?.status, "superseded");
});

test("failure while recording completion rolls back every workflow effect and can resume", async t => {
  const f = await fixture(t);
  f.database.connection.exec(`CREATE TRIGGER fail_integration_message BEFORE INSERT ON agent_messages
    BEGIN SELECT RAISE(ABORT, 'Simulated storage failure'); END`);
  const response = await f.decide(f.app());
  assert.equal(response.status, 409, await response.text());
  const state = f.database.getOrchestrationState(f.projectId)!;
  assert.equal(state.tasks[0]?.status, "review");
  assert.equal(state.integrationProposals[0]?.status, "approved");
  assert.equal(state.integrationProposals[0]?.application?.status, "retryable");
  assert(!f.database.getAgentRun(f.runId)?.result?.artifacts.some(item => item.startsWith("applied:")));
  assert.equal((await f.git("rev-parse", "HEAD")).trim(), f.request.repositories[0]!.sha);
  f.database.connection.exec("DROP TRIGGER fail_integration_message");
  const resumed = await f.decide(f.app());
  assert.equal(resumed.status, 200, await resumed.text());
  assert.equal(f.database.getOrchestrationState(f.projectId)?.tasks[0]?.status, "completed");
});

test("migration preserves existing pending proposals and enables durable integration", async t => {
  const f = await fixture(t);
  f.database.connection.exec("DROP TABLE integration_applications; DELETE FROM schema_migrations WHERE version = 24");
  f.database.close();
  const migrated = f.openDatabase();
  assert.equal(migrated.getApproval(f.projectId, f.approvalId)?.status, "pending");
  assert.equal(migrated.getIntegrationProposal(f.projectId, f.approvalId)?.application, null);
  const response = await f.decide(f.app(migrated));
  assert.equal(response.status, 200, await response.text());
});

async function addSecondRepository(f: Awaited<ReturnType<typeof fixture>>) {
  const sourcePath = join(f.root, "frontend");
  await runCaptureGit(["clone", "--quiet", f.source, sourcePath]);
  const original = f.request.repositories[0]!;
  await runCaptureGit(["-C", sourcePath, "update-ref", `refs/heads/${original.branch}`, original.sha]);
  f.request.repositories.push({ ...original, sourcePath, repositoryId: randomUUID(), name: "frontend" });
  return sourcePath;
}

test("controller preflight checks every repository before applying any changes", async t => {
  const f = await fixture(t);
  const second = await addSecondRepository(f);
  await writeFile(join(second, "local.txt"), "Local work\n");
  await assert.rejects(f.apply(f.request), /uncommitted or untracked/);
  assert.equal((await f.git("rev-parse", "HEAD")).trim(), f.request.repositories[0]!.baseCommit);
  await rm(join(second, "local.txt"));
  const result = await createIntegrationApplier(f.root, f.receiptRoot)(f.request);
  assert.equal(result.applied.length, 2);
});

test("partially applied integrations resume across controller restart and concurrent retries", async t => {
  const f = await fixture(t);
  const second = await addSecondRepository(f);
  let merges = 0;
  const failing = createIntegrationApplier(f.root, f.receiptRoot, async (args, safe) => {
    if (args.includes("merge")) {
      merges++;
      if (args[1] === second) throw new Error("Second repository temporarily unavailable");
    }
    return runCaptureGit(args, safe);
  });
  await assert.rejects(failing(f.request), /temporarily unavailable/);
  assert.equal((await f.git("rev-parse", "HEAD")).trim(), f.request.repositories[0]!.sha);
  assert.equal((await runCaptureGit(["-C", second, "rev-parse", "HEAD"])).trim(), f.request.repositories[1]!.baseCommit);
  // A completed repository may advance independently while the remaining one resumes.
  await f.git("checkout", "--quiet", "-b", "later-work");
  const restarted = createIntegrationApplier(f.root, f.receiptRoot, async (args, safe) => {
    if (args.includes("merge")) merges++;
    return runCaptureGit(args, safe);
  });
  const results = await Promise.all([restarted(f.request), restarted(f.request)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0]!.applied.length, 2);
  assert.equal(merges, 3); // First merge, failed second merge, successful second merge.
  await assert.rejects(restarted({ ...f.request, taskId: randomUUID() }), /different integration request/);
  assert.equal((await f.git("symbolic-ref", "--short", "HEAD")).trim(), "later-work");
});

test("a crash after Git succeeds but before saving its receipt recovers from target history", async t => {
  const f = await fixture(t);
  const crashing = createIntegrationApplier(f.root, f.receiptRoot, async (args, safe) => {
    const result = await runCaptureGit(args, safe);
    if (args.includes("merge")) throw new Error("Interrupted before receipt");
    return result;
  });
  await assert.rejects(crashing(f.request), /before receipt/);
  await writeFile(join(f.source, "later.txt"), "Later commit\n");
  await f.git("add", ".");
  await f.git("commit", "--quiet", "-m", "Later work");
  const head = (await f.git("rev-parse", "HEAD")).trim();
  const result = await createIntegrationApplier(f.root, f.receiptRoot, async (args, safe) => {
    assert(!args.includes("merge"), "Already applied changes must not be merged again");
    return runCaptureGit(args, safe);
  })(f.request);
  assert.equal(result.applied[0]?.sha, f.request.repositories[0]!.sha);
  assert.equal((await f.git("rev-parse", "HEAD")).trim(), head);
});

test("an interrupted integration cannot retarget its approved branch", async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, "local.txt"), "Local work\n");
  await assert.rejects(f.apply(f.request), /uncommitted or untracked/);
  await rm(join(f.source, "local.txt"));
  await f.git("checkout", "--quiet", "-b", "other-target");
  await assert.rejects(createIntegrationApplier(f.root, f.receiptRoot)(f.request), /approved target branch main/);
  assert.equal((await f.git("rev-parse", "HEAD")).trim(), f.request.repositories[0]!.baseCommit);
});
