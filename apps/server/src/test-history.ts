import { randomUUID } from "node:crypto";
import type { AgentRunSummary } from "@engineering-team/contracts";
import type { TeamDatabase } from "@engineering-team/database";

export function appendCompletedHistory(database: TeamDatabase, template: AgentRunSummary, count = 30): void {
  const { taskId: _taskId, ...spec } = template.spec;
  for (let index = 0; index < count; index++) {
    const runId = randomUUID(), attemptId = randomUUID();
    database.createAgentRun(template.brainProfileId, { ...spec, runId, runPurpose: "consultation", upstreamArtifacts: [] });
    database.createRunAttempt({ id: attemptId, runId, attemptNumber: 1 });
    database.completeAgentRun(runId, attemptId, {
      schemaVersion: 1, status: "completed", summary: "Unrelated completed work", changedFiles: [], commits: [],
      checks: [{ command: "inspect", status: "passed" }],
      acceptanceCriteria: spec.acceptanceCriteria.map(criterion => ({ criterion, satisfied: true, evidence: "Recorded evidence" })),
      questions: [], risks: [], artifacts: [],
    });
  }
}
