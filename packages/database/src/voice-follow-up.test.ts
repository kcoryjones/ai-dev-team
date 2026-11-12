import assert from "node:assert/strict";
import test from "node:test";
import { TeamDatabase } from "./index.js";
import { migrate } from "./migrations.js";

test("version 30 preserves legacy question receipts and defaults their follow-up link to null", () => {
  const database = new TeamDatabase(":memory:");
  try {
    database.createWorkspaceProject("project", "Migration test");
    const profile = database.createBrainProfile({ id: "profile", projectId: "project", name: "Fixture", provider: "openai", harness: "codex", modelClass: "coding", credentialRef: "FIXTURE", configuration: {} });
    database.createAgentQuestion({ requestId: "question", source: "voice", body: "Why?", messageId: "message", brainProfileId: profile.id, attemptId: "attempt", spec: {
      schemaVersion: 1, runId: "run", projectId: "project", agentRole: "architect", runPurpose: "consultation",
      brainProfile: { provider: "openai", harness: "codex", modelClass: "coding", credentialRef: "FIXTURE" }, repositories: [],
      objective: "Question", taskDescription: "Answer", acceptanceCriteria: [], upstreamArtifacts: [],
      permissions: { filesystem: "read-only", networkPolicy: "model-provider-only", allowedTools: ["respond_to_request"] }, limits: { timeoutSeconds: 900, retries: 0 },
    } });
    const original = database.getAgentQuestionRequest("project", "question");
    database.connection.exec("ALTER TABLE agent_question_requests DROP COLUMN follow_up_to; DELETE FROM schema_migrations WHERE version = 30;");
    migrate(database.connection); migrate(database.connection);
    assert.deepEqual(database.getAgentQuestionRequest("project", "question"), original);
    assert.equal(database.getAgentQuestionRequest("project", "question")!.followUpTo, null);
    assert.equal(database.connection.pragma("quick_check", { simple: true }), "ok");
  } finally { database.close(); }
});
