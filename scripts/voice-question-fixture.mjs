// Disposable local fixture for voice-questions-browser-smoke.mjs. No model calls.
// Run after npm run build; stop with Ctrl-C to delete the temporary database.
import { serve } from '@hono/node-server';
import { TeamDatabase } from '../packages/database/dist/index.js';
import { createApp } from '../apps/server/dist/app.js';
import { createRepository } from '../apps/server/dist/repository.js';
import { agentRoles } from '../packages/contracts/dist/index.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = mkdtempSync(join(tmpdir(), 'builder-voice-questions-'));
const database = new TeamDatabase(root + '/team.sqlite');
const projectId = randomUUID(), repositoryId = randomUUID();
createRepository(root, 'backend');
database.createProject({ id: projectId, name: 'Voice control test', repository: { id: repositoryId, name: 'backend', relativePath: 'backend', defaultBranch: 'main' } });
database.createCodingHarness(projectId, 'harness', { name: 'Codex fixture', adapter: 'codex', executable: 'codex', supportedProtocols: ['openai-responses'], capabilities: ['planning', 'coding', 'testing'] });
database.createModelBackend(projectId, 'backend', { name: 'Model fixture', provider: 'openai', protocol: 'openai-responses', model: 'test', authMode: 'chatgpt' });
for (const role of agentRoles) database.assignAgentRuntime(projectId, role, 'harness', 'backend');
const taskId = randomUUID(), runId = randomUUID(), attemptId = randomUUID();
const plan = database.createPlan({ projectId, approvalId: randomUUID(), objective: { id: randomUUID(), title: 'Build', description: 'Keep working' }, tasks: [{ id: taskId, key: 'build', title: 'Build the backend', description: 'Keep working', assignedRole: 'backend_developer', repositoryIds: [repositoryId], acceptanceCriteria: ['Works'], requiredChecks: { qa: false, codeReview: false, security: false }, dependsOn: [] }] });
database.decideApproval(projectId, plan.approval.id, 'approved', null);
database.updateTaskStatus(projectId, taskId, 'in_progress');
const profile = database.createBrainProfile({ id: randomUUID(), projectId, name: 'Task fixture', provider: 'openai', harness: 'codex', modelClass: 'coding', credentialRef: 'FIXTURE', configuration: {} });
database.createAgentRun(profile.id, { schemaVersion: 1, runId, projectId, taskId, agentRole: 'backend_developer', runPurpose: 'implementation', brainProfile: { provider: 'openai', harness: 'codex', modelClass: 'coding', credentialRef: 'FIXTURE' }, repositories: [{ repositoryId, checkoutPath: '/workspace/repos/01-backend', baseCommit: 'unborn' }], objective: 'Keep working', taskDescription: 'Implement', acceptanceCriteria: ['Works'], upstreamArtifacts: [], permissions: { filesystem: 'workspace-write', networkPolicy: 'model-provider-only', allowedTools: ['run_tests'] }, limits: { timeoutSeconds: 900, retries: 0 } });
database.createRunAttempt({ id: attemptId, runId, attemptNumber: 1 });
database.markRunAttemptRunning(attemptId, 'fixture', 'sha256:fixture');
database.acquireTaskLease({ taskId, runId, leaseToken: randomUUID(), acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' });
const app = createApp(database, { workspaceRoot: root, staticRoot: fileURLToPath(new URL('../apps/web/dist', import.meta.url)), planningExecutor: {
  async execute() { return { workerId: 'planner-fixture', imageDigest: 'test', providerThreadId: null, proposal: {
    intent: 'plan', assistantMessage: 'Proposed the requested work.', directiveActions: [], consultationRequests: [], contextUpdates: [],
    objective: { title: 'Voice requested work', description: 'Test the normal approval flow' },
    tasks: [{ key: 'new', title: 'Add requested feature', description: 'Implement the requested feature', assignedRole: 'frontend_developer', repositoryIds: [repositoryId], acceptanceCriteria: ['Feature works'], requiredChecks: { qa: true, codeReview: true, security: true }, dependsOn: [] }],
  } }; },
  async consult(request) { await new Promise(resolve => setTimeout(resolve, 3000)); return { workerId: 'fixture', imageDigest: 'sha256:fixture', providerThreadId: null, response: 'Answer from ' + request.run.agentRole + ': the backend task is still running.', directiveActions: [], contextUpdates: [] }; },
  async stopAgentWorker() {},
}, taskExecutor: {
  async stopTaskWorker() {},
  async applyTask() { throw new Error('Integration must remain an explicit approval'); },
  async executeTask(request) {
    const implementation = ['implementation', 'repair'].includes(request.run.runPurpose || 'implementation');
    const sha = 'a'.repeat(40);
    return { workerId: 'task-fixture', imageDigest: 'test', providerThreadId: null, branches: implementation ? [{ repositoryId, branch: 'agent/fixture', sha }] : [],
      result: { schemaVersion: 1, status: 'completed', summary: 'Fixture task completed.', changedFiles: implementation ? ['backend/api.ts'] : [], commits: implementation ? [{ repositoryId, sha }] : [],
        checks: [{ command: 'fixture check', status: 'passed' }], acceptanceCriteria: request.run.acceptanceCriteria.map(criterion => ({ criterion, satisfied: true, evidence: 'Fixture check passed' })), questions: [], risks: [], artifacts: [] },
    };
  },
} });
const port = Number(process.env.VOICE_TEST_PORT || 14318);
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => console.log(`Voice test fixture: http://127.0.0.1:${port}`));
function stop() {
  server.close(); server.closeAllConnections();
  database.close(); rmSync(root, { force: true, recursive: true });
  process.exit(0);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
