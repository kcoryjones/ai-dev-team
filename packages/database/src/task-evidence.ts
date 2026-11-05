import { reportOnlyTaskAgentRoles, type AgentRole, type AgentRunSummary, type TaskRequiredChecks, type VerificationCheck } from "@engineering-team/contracts";

const reportRoles = new Set<AgentRole>(reportOnlyTaskAgentRoles);
const checkRoles: Record<VerificationCheck, AgentRole> = {
  qa: "qa_engineer", code_review: "code_reviewer", security: "security_reviewer",
};

function assertSuccessfulEvidence(run: AgentRunSummary | undefined, label: string, criteria = run?.spec.acceptanceCriteria): asserts run is AgentRunSummary & { result: NonNullable<AgentRunSummary["result"]> } {
  const result = run?.result;
  if (!run || run.status !== "completed" || result?.status !== "completed") {
    throw new Error(`${label} requires a successful completed run`);
  }
  if (!result.summary.trim() || !result.checks.length ||
      result.checks.some(check => check.status !== "passed" || !check.command.trim())) {
    throw new Error(`${label} requires recorded passing checks`);
  }
  if (!criteria?.length || result.acceptanceCriteria.length !== criteria.length ||
      result.acceptanceCriteria.some(item => !criteria.includes(item.criterion)) ||
      criteria.some(criterion => {
        const evidence = result.acceptanceCriteria.filter(item => item.criterion === criterion);
        return evidence.length !== 1 || !evidence[0]!.satisfied || !evidence[0]!.evidence.trim();
      })) throw new Error(`${label} requires satisfied, nonempty evidence for every acceptance criterion`);
}

function assertSnapshot(run: AgentRunSummary, expected: Map<string, string>, label: string): void {
  if (run.spec.repositories.length !== expected.size ||
      new Set(run.spec.repositories.map(repo => repo.repositoryId)).size !== expected.size ||
      run.spec.repositories.some(repo => repo.baseCommit !== expected.get(repo.repositoryId))) {
    throw new Error(`${label} must assess the current implementation's exact repository snapshots`);
  }
}

// Runs arrive newest first, including failures and active attempts. Never fall back
// to an older success or use the paginated run list shown in the UI for this gate.
export function assertTaskReviewEvidence(task: {
  assignedRole: AgentRole; repositoryIds: string[]; acceptanceCriteria: string[]; requiredChecks: TaskRequiredChecks;
}, runs: AgentRunSummary[]) {
  if (runs.some(run => ["queued", "provisioning", "running", "waiting"].includes(run.status))) {
    throw new Error("Task evidence is incomplete while an agent run is active");
  }
  const implementation = runs.find(run => ["implementation", "repair"].includes(run.spec.runPurpose ?? "implementation"));
  assertSuccessfulEvidence(implementation, "The current implementation or report", task.acceptanceCriteria);
  if (implementation.agentRole !== task.assignedRole) throw new Error("Task evidence must come from the assigned agent role");
  const snapshot = new Map(implementation.spec.repositories.map(repo => [repo.repositoryId, repo.baseCommit]));
  if (!snapshot.size || snapshot.size !== implementation.spec.repositories.length || snapshot.size !== task.repositoryIds.length ||
      task.repositoryIds.some(id => !snapshot.has(id))) throw new Error("Task evidence must cover all assigned repositories");
  const reportOnly = implementation.result.commits.length === 0;
  if (implementation.spec.repositories.some(repo => repo.integrationBaseCommit !== undefined &&
      repo.integrationBaseCommit !== repo.baseCommit && !implementation.result.commits.some(commit => commit.repositoryId === repo.repositoryId))) {
    throw new Error("The implementation must retain carried-forward repository commits");
  }
  if (reportOnly) {
    if (!reportRoles.has(task.assignedRole) || implementation.result.changedFiles.length > 0) {
      throw new Error("Only a completed specialist report without source changes can finish without integration");
    }
  } else {
    const commits = implementation.result.commits;
    if (new Set(commits.map(commit => commit.repositoryId)).size !== commits.length ||
        commits.some(commit => !snapshot.has(commit.repositoryId) || !commit.sha.trim())) {
      throw new Error("The implementation must identify its repository commits");
    }
    for (const commit of commits) snapshot.set(commit.repositoryId, commit.sha);
  }
  const required: VerificationCheck[] = [
    ...(task.requiredChecks.qa ? ["qa" as const] : []),
    ...(task.requiredChecks.codeReview ? ["code_review" as const] : []),
    ...(task.requiredChecks.security ? ["security" as const] : []),
  ];
  const assessesImplementation = (run: AgentRunSummary) => run.spec.upstreamArtifacts.includes(`implementation-run:${implementation.id}`);
  for (const check of required) {
    const verification = runs.find(run => run.spec.runPurpose === "verification" && run.spec.verificationCheck === check && assessesImplementation(run));
    const label = `Required ${check.replaceAll("_", " ")} verification`;
    assertSuccessfulEvidence(verification, label, check === "qa" ? task.acceptanceCriteria : verification?.spec.acceptanceCriteria);
    if (verification.agentRole !== checkRoles[check] || verification.result.commits.length || verification.result.changedFiles.length) {
      throw new Error(`${label} requires an assessment from its specialist without source changes`);
    }
    assertSnapshot(verification, snapshot, label);
  }
  if (reportOnly) return { implementation, release: null };
  const release = runs.find(run => run.spec.runPurpose === "release" && assessesImplementation(run));
  assertSuccessfulEvidence(release, "Release assessment");
  if (release.agentRole !== "release_manager" || release.result.commits.length || release.result.changedFiles.length) {
    throw new Error("Release assessment requires the Release Manager's report without source changes");
  }
  assertSnapshot(release, snapshot, "Release assessment");
  return { implementation, release };
}
