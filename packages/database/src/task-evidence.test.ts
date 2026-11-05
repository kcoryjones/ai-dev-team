import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { AgentRole, AgentRunSummary, ApplyCodingRunRequest, RunResult, RunSpec, TaskRequiredChecks, VerificationCheck } from "@engineering-team/contracts";
import { TeamDatabase } from "./index.js";

function fixture(t: TestContext, assignedRole: AgentRole = "backend_developer", requiredChecks: TaskRequiredChecks = { qa: true, codeReview: true, security: true }) {
  const db = new TeamDatabase(":memory:");
  t.after(() => db.close());
  db.createProject({ id: "project", name: "Evidence", repository: { id: "repository", name: "backend", relativePath: "backend", defaultBranch: "main" } });
  const criteria = ["Feature works", "Regression covered"];
  const plan = db.createPlan({ projectId: "project", approvalId: "plan", objective: { id: "objective", title: "Deliver", description: "Evidence gates" }, tasks: [
    { id: "task", key: "build", title: "Build", description: "Implement", assignedRole, repositoryIds: ["repository"], acceptanceCriteria: criteria, requiredChecks, dependsOn: [] },
    { id: "dependent", key: "review", title: "Review", description: "Review delivery", assignedRole: "code_reviewer", repositoryIds: ["repository"], acceptanceCriteria: criteria, requiredChecks: { qa: false, codeReview: false, security: false }, dependsOn: ["build"] },
  ] });
  db.decideApproval("project", plan.approval.id, "approved", null);
  db.updateTaskStatus("project", "task", "in_progress");
  const brainProfile = { provider: "test", harness: "fake", modelClass: "test", credentialRef: "DUMMY" };
  db.createBrainProfile({ ...brainProfile, id: "profile", projectId: "project", name: "Fixture", configuration: {} });
  function run(patch: Partial<RunSpec> = {}, resultPatch: Partial<RunResult> = {}) {
    const spec: RunSpec = {
      schemaVersion: 1, runId: randomUUID(), projectId: "project", taskId: "task", agentRole: assignedRole, runPurpose: "implementation",
      brainProfile, repositories: [{ repositoryId: "repository", checkoutPath: "/workspace/backend", baseCommit: "base" }],
      objective: "Deliver", taskDescription: "Implement", acceptanceCriteria: criteria, upstreamArtifacts: [],
      permissions: { filesystem: "workspace-write", networkPolicy: "offline", allowedTools: [] }, limits: { timeoutSeconds: 30, retries: 0 }, ...patch,
    };
    db.createAgentRun("profile", spec);
    const attempt = randomUUID();
    db.createRunAttempt({ id: attempt, runId: spec.runId, attemptNumber: 1 });
    return db.completeAgentRun(spec.runId, attempt, {
      schemaVersion: 1, status: "completed", summary: "Evidence recorded", changedFiles: [], commits: [],
      checks: [{ command: "Check the acceptance criteria", status: "passed" }],
      acceptanceCriteria: spec.acceptanceCriteria.map(criterion => ({ criterion, satisfied: true, evidence: "Verified by the recorded check" })),
      questions: [], risks: [], artifacts: [], ...resultPatch,
    });
  }
  const implement = (patch: Partial<RunResult> = {}) => run({}, { commits: [{ repositoryId: "repository", sha: "reviewed" }], changedFiles: ["code.ts"], ...patch });
  function assess(implementation: AgentRunSummary, check: VerificationCheck | "release", specPatch: Partial<RunSpec> = {}, resultPatch: Partial<RunResult> = {}) {
    const role: AgentRole = { qa: "qa_engineer", code_review: "code_reviewer", security: "security_reviewer", release: "release_manager" }[check] as AgentRole;
    return run({
      runPurpose: check === "release" ? "release" : "verification", agentRole: role,
      ...(check === "release" ? {} : { verificationCheck: check }),
      upstreamArtifacts: [`implementation-run:${implementation.id}`],
      repositories: implementation.spec.repositories.map(repo => ({ ...repo, baseCommit: implementation.result?.commits.find(commit => commit.repositoryId === repo.repositoryId)?.sha ?? repo.baseCommit })),
      ...specPatch,
    }, resultPatch);
  }
  function verified(implementation = implement()) {
    if (requiredChecks.qa) assess(implementation, "qa");
    if (requiredChecks.codeReview) assess(implementation, "code_review");
    if (requiredChecks.security) assess(implementation, "security");
    return { implementation, release: implementation.result!.commits.length ? assess(implementation, "release") : null };
  }
  function integrate(evidence = verified()) {
    assert(evidence.release);
    db.updateTaskStatus("project", "task", "review");
    const approvalId = randomUUID();
    db.createIntegrationProposal({ approvalId, projectId: "project", taskId: "task", changeRunId: evidence.implementation.id, releaseRunId: evidence.release.id, title: "Integrate", details: "Verified" });
    const request: ApplyCodingRunRequest = { approvalId, runId: evidence.implementation.id, taskId: "task", repositories: [{ repositoryId: "repository", sourcePath: "/fixture/backend", name: "backend", branch: "agent/reviewed", baseCommit: "base", sha: "reviewed", targetBranch: "main" }] };
    db.claimIntegrationApplication("project", approvalId, null, () => request, "lease", "2099-01-01T00:00:00.000Z");
    db.completeIntegrationApplication("project", approvalId, "lease", { applied: request.repositories.map(({ repositoryId, branch, sha, targetBranch }) => ({ repositoryId, branch, sha, targetBranch })) });
    return request;
  }
  function blocked(pattern: RegExp) {
    const eventCount = () => (db.connection.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count;
    const before = eventCount();
    assert.throws(() => db.updateTaskStatus("project", "task", "review"), pattern);
    assert.equal(eventCount(), before);
    // Old databases may already contain a review state reached without evidence.
    db.connection.prepare("UPDATE tasks SET status = 'review' WHERE id = 'task'").run();
    assert.throws(() => db.updateTaskStatus("project", "task", "completed"), pattern);
    assert.equal(eventCount(), before);
    const state = db.getOrchestrationState("project")!;
    assert.equal(state.tasks.find(task => task.id === "dependent")?.status, "blocked");
    assert.equal(state.objectives[0]?.status, "active");
  }
  return { db, run, implement, assess, verified, integrate, blocked, criteria };
}

test("review and completion require execution evidence even with specialist checks disabled", t => {
  fixture(t, "backend_developer", { qa: false, codeReview: false, security: false }).blocked(/requires a successful completed run/);
});

test("repair evidence cannot silently drop an earlier repository commit", t => {
  const f = fixture(t, "qa_engineer", { qa: false, codeReview: false, security: false });
  f.run({ runPurpose: "repair", repositories: [{ repositoryId: "repository", checkoutPath: "/workspace/backend", baseCommit: "earlier-change", integrationBaseCommit: "base" }] });
  f.blocked(/retain carried-forward repository commits/);
});

for (const check of ["qa", "code_review", "security"] as const) {
  for (const failure of ["missing", "failed", "wrong snapshot", "wrong role", "older implementation"] as const) {
    test(`${check} ${failure} evidence cannot satisfy the current task`, t => {
      const f = fixture(t);
      const implementation = f.implement();
      for (const candidate of ["qa", "code_review", "security"] as const) {
        if (candidate !== check) f.assess(implementation, candidate);
      }
      if (failure === "failed") f.assess(implementation, check, {}, { status: "failed" });
      if (failure === "wrong snapshot") f.assess(implementation, check, { repositories: [{ repositoryId: "repository", checkoutPath: "/workspace/backend", baseCommit: "other" }] });
      if (failure === "wrong role") f.assess(implementation, check, { agentRole: "backend_developer" });
      if (failure === "older implementation") f.assess(implementation, check, { upstreamArtifacts: ["implementation-run:obsolete"] });
      f.assess(implementation, "release");
      f.blocked(/Required .* verification/);
    });
  }
}

test("newer failed implementation and specialist runs supersede older successes", async t => {
  for (const kind of ["implementation", "verification"] as const) await t.test(kind, t => {
    const f = fixture(t);
    const { implementation } = f.verified();
    if (kind === "implementation") f.implement({ status: "failed" });
    else f.assess(implementation, "qa", {}, { status: "failed" });
    f.blocked(/requires a successful completed run/);
  });
});

for (const failure of ["missing", "failed", "wrong snapshot"] as const) {
  test(`release assessment ${failure} blocks review and completion`, t => {
    const f = fixture(t, "backend_developer", { qa: false, codeReview: false, security: false });
    const implementation = f.implement();
    if (failure === "failed") f.assess(implementation, "release", {}, { status: "failed" });
    if (failure === "wrong snapshot") f.assess(implementation, "release", { repositories: [{ repositoryId: "repository", checkoutPath: "/workspace/backend", baseCommit: "other" }] });
    f.blocked(/Release assessment/);
  });
}

test("active task work blocks advancement even when previous evidence passed", t => {
  const f = fixture(t);
  const { implementation } = f.verified();
  f.db.createAgentRun("profile", { ...implementation.spec, runId: randomUUID(), runPurpose: "verification" });
  f.blocked(/agent run is active/);
});

test("applied artifact strings and approval alone cannot replace durable integration evidence", t => {
  const f = fixture(t);
  const { implementation, release } = f.verified();
  f.db.updateTaskStatus("project", "task", "review");
  f.db.markRunBranchesApplied(implementation.id, ["agent/pretend-applied"]);
  f.db.createIntegrationProposal({ approvalId: "integration", projectId: "project", taskId: "task", changeRunId: implementation.id, releaseRunId: release!.id, title: "Integrate", details: "Verified" });
  f.db.decideApproval("project", "integration", "approved", null);
  assert.throws(() => f.db.updateTaskStatus("project", "task", "completed"), /approved, applied integration/);
  assert.equal(f.db.getOrchestrationState("project")?.tasks.find(task => task.id === "dependent")?.status, "blocked");
});

test("legacy review state cannot bypass missing checks through integration approval", t => {
  const f = fixture(t);
  const implementation = f.implement(), release = f.assess(implementation, "release");
  f.db.connection.prepare("UPDATE tasks SET status = 'review' WHERE id = 'task'").run();
  f.db.createIntegrationProposal({ approvalId: "integration", projectId: "project", taskId: "task", changeRunId: implementation.id, releaseRunId: release.id, title: "Integrate", details: "Incomplete checks" });
  assert.throws(() => f.db.claimIntegrationApplication("project", "integration", null, () => { throw new Error("Request must never be built"); }, "lease", "2099-01-01T00:00:00.000Z"), /Required qa verification/);
  assert.equal(f.db.getApproval("project", "integration")?.status, "pending");
});

test("integration must use the current release assessment before any controller request", t => {
  const f = fixture(t);
  const { implementation, release } = f.verified();
  f.db.updateTaskStatus("project", "task", "review");
  f.db.createIntegrationProposal({ approvalId: "integration", projectId: "project", taskId: "task", changeRunId: implementation.id, releaseRunId: release!.id, title: "Integrate", details: "Older release" });
  f.assess(implementation, "release");
  assert.throws(() => f.db.claimIntegrationApplication("project", "integration", null, () => { throw new Error("Request must never be built"); }, "lease", "2099-01-01T00:00:00.000Z"), /already been decided/);
  assert.equal(f.db.getApproval("project", "integration")?.status, "superseded");
});

for (const failure of ["missing criterion", "empty evidence", "unsatisfied", "duplicate criterion", "no checks", "failed check", "source changes", "wrong role"] as const) {
  test(`report completion rejects ${failure}`, t => {
    const f = fixture(t, "code_reviewer", { qa: false, codeReview: false, security: false });
    const evidence = f.criteria.map(criterion => ({ criterion, satisfied: true, evidence: "Checked" }));
    if (failure === "missing criterion") evidence.pop();
    if (failure === "empty evidence") evidence[0]!.evidence = " ";
    if (failure === "unsatisfied") evidence[0]!.satisfied = false;
    if (failure === "duplicate criterion") evidence[1]!.criterion = evidence[0]!.criterion;
    f.run(failure === "wrong role" ? { agentRole: "qa_engineer" } : {}, {
      acceptanceCriteria: evidence,
      ...(failure === "no checks" ? { checks: [] } : {}),
      ...(failure === "failed check" ? { checks: [{ command: "test", status: "failed" as const }] } : {}),
      ...(failure === "source changes" ? { changedFiles: ["code.ts"] } : {}),
    });
    f.blocked(/evidence|passing checks|without source changes|assigned agent role/);
  });
}

test("report tasks also require their configured specialist checks", t => {
  const f = fixture(t, "code_reviewer");
  f.run();
  f.blocked(/Required qa verification/);
});

test("verified reports complete without integration and release dependents", t => {
  const f = fixture(t, "code_reviewer");
  f.verified(f.run());
  f.db.updateTaskStatus("project", "task", "review");
  f.db.updateTaskStatus("project", "task", "completed");
  assert.equal(f.db.getOrchestrationState("project")?.tasks.find(task => task.id === "dependent")?.status, "ready");
  assert.deepEqual(f.db.listIntegrationProposals("project"), []);
  f.db.requeueTask("project", "task");
  f.db.updateTaskStatus("project", "task", "in_progress");
  assert.throws(() => f.db.updateTaskStatus("project", "task", "review"), /rerun requires new/);
});

test("verified integration completes atomically using evidence older than the displayed run page", t => {
  const f = fixture(t);
  const evidence = f.verified();
  for (let index = 0; index < 30; index++) f.run({ taskId: "dependent", agentRole: "code_reviewer", runPurpose: "verification" });
  assert(!f.db.listAgentRuns("project").some(run => run.id === evidence.implementation.id));
  f.integrate(evidence);
  assert.equal(f.db.getOrchestrationState("project")?.tasks.find(task => task.id === "dependent")?.status, "ready");
  f.db.updateTaskStatus("project", "dependent", "in_progress");
  f.run({ taskId: "dependent", agentRole: "code_reviewer" });
  f.db.updateTaskStatus("project", "dependent", "review");
  f.db.updateTaskStatus("project", "dependent", "completed");
  assert.equal(f.db.getOrchestrationState("project")?.objectives[0]?.status, "completed");
});
