import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { CodingRunRequest, ConsultationRunRequest, PlanningRunRequest } from "@engineering-team/contracts";
import { TeamDatabase } from "@engineering-team/database";
import { createApp } from "./app.js";
import { HttpPlanningExecutor } from "./planning.js";
import { runCaptureGit } from "./worker-checkout.js";

interface RepositoryInvocation { name: string; checkoutHead: string; workerHead: string; before: string; after: string }
interface WorkerInvocation extends RepositoryInvocation { args: string[]; repositories: RepositoryInvocation[] }

// Exercise the real HTTP controller, Git capture, and application workflow.
// Only Docker/model execution is replaced: inspect the exact Docker arguments
// and deliberately alter even a read-only clone from the host side to check
// that the controller cannot publish assessment output as source changes.
async function controllerFixture(t: TestContext, { releasePasses = true, commitWorkerChanges = false,
  secondRepository = "none", scenario = "partial", failInitialQa = false,
}: { releasePasses?: boolean; commitWorkerChanges?: boolean; secondRepository?: "none" | "populated" | "unborn";
  scenario?: "partial" | "split-repair" | "no-changes" | "capture-failure" | "publish-failure"; failInitialQa?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "builder-controller-"));
  const workspaceRoot = join(root, "workspaces");
  const worktreeRoot = join(root, "worktrees");
  const bin = join(root, "bin");
  const source = join(workspaceRoot, "backend");
  const invocationFile = join(root, "invocations.jsonl");
  const reportOverrideFile = join(root, "report-override.json");
  await Promise.all([mkdir(source, { recursive: true }), mkdir(worktreeRoot), mkdir(bin)]);
  await writeFile(invocationFile, "");
  await writeFile(reportOverrideFile, "{}");
  await runCaptureGit(["init", "--quiet", "--initial-branch=main", source]);
  await writeFile(join(source, "code.txt"), "original\n");
  await runCaptureGit(["-C", source, "add", "."]);
  await runCaptureGit(["-C", source, "commit", "--quiet", "-m", "Initial"]);
  const baseCommit = (await runCaptureGit(["-C", source, "rev-parse", "HEAD"])).trim();
  const repositories = [{ repositoryId: randomUUID(), name: "backend", sourcePath: source, baseCommit }];
  if (secondRepository !== "none") {
    const sourcePath = join(workspaceRoot, "frontend");
    await mkdir(sourcePath);
    await runCaptureGit(["init", "--quiet", "--initial-branch=main", sourcePath]);
    if (secondRepository === "populated") {
      await writeFile(join(sourcePath, "code.txt"), "frontend original\n");
      await runCaptureGit(["-C", sourcePath, "add", "."]);
      await runCaptureGit(["-C", sourcePath, "commit", "--quiet", "-m", "Initial frontend"]);
    }
    repositories.push({ repositoryId: randomUUID(), name: "frontend", sourcePath,
      baseCommit: secondRepository === "unborn" ? "unborn" : (await runCaptureGit(["-C", sourcePath, "rev-parse", "HEAD"])).trim() });
  }
  await writeFile(join(bin, "docker"), String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'volume' && args[1] === 'inspect') console.log(process.env.ENGINEERING_TEAM_WORKTREE_ROOT);
else if (args[0] === 'image' && args[1] === 'inspect') console.log('sha256:fixture');
else if (args[0] === 'run') {
  const mount = args.find(arg => arg.startsWith('type=bind,') && arg.split(',').includes('dst=/workspace'));
  if (!mount) throw new Error('Missing workspace mount');
  const root = mount.split(',').find(part => part.startsWith('src=')).slice(4);
  const workdir = args[args.indexOf('--workdir') + 1];
  const directories = workdir === '/workspace' ? fs.readdirSync(path.join(root, 'repos')).sort().map(name => path.join(root, 'repos', name)) : [path.join(root, path.relative('/workspace', workdir))];
  const readOnly = mount.split(',').includes('readonly');
  const repair = args.at(-1).includes('This is a repair pass.');
  const scenario = process.env.FIXTURE_SCENARIO;
  const repositories = directories.map(directory => {
    const name = path.basename(directory).replace(/^\d+-/, '');
    const git = command => execFileSync('git', ['-c', 'safe.directory=' + directory, '-c', 'user.name=Fixture worker', '-c', 'user.email=fixture@example.test', '-C', directory, ...command], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    const head = () => { try { return git(['rev-parse', '--verify', 'HEAD']).trim(); } catch { return 'unborn'; } };
    const checkoutHead = head();
    const before = fs.existsSync(path.join(directory, 'code.txt')) ? fs.readFileSync(path.join(directory, 'code.txt'), 'utf8') : '';
    const edit = scenario !== 'no-changes' && (readOnly || scenario.endsWith('-failure') || name === (scenario === 'split-repair' && repair ? 'frontend' : 'backend'));
    const after = edit ? (readOnly ? 'unauthorized assessment edit\n' : repair ? 'repaired\n' : 'implemented\n') : before;
    if (edit) fs.writeFileSync(path.join(directory, 'code.txt'), after);
    if (edit && process.env.FIXTURE_COMMIT_WORKER_CHANGES === 'true') {
      git(['add', 'code.txt']);
      git(['commit', '--quiet', '-m', 'Untrusted worker commit']);
    }
    return {name, checkoutHead, workerHead: head(), before, after};
  });
  if (scenario === 'capture-failure') fs.rmSync(directories[1], {recursive: true});
  if (scenario === 'publish-failure') {
    const runId = args[args.indexOf('--name') + 1].replace('engineering-team-task-', '');
    const lastRepository = path.basename(directories[1]).replace(/^\d+-/, '');
    const refDirectory = path.join(process.env.ENGINEERING_TEAM_WORKSPACE_ROOT, lastRepository, '.git', 'refs', 'heads', 'agent');
    fs.mkdirSync(refDirectory, {recursive: true});
    // Simulate another process holding the second repository's ref lock.
    const taskId = process.env.FIXTURE_TASK_ID;
    fs.writeFileSync(path.join(refDirectory, taskId.slice(0, 8) + '-' + runId.slice(0, 8) + '.lock'), 'fixture lock');
  }
  fs.appendFileSync(process.env.FIXTURE_INVOCATIONS, JSON.stringify({args, ...repositories[0], repositories}) + '\n');
  const consultation = args.includes('/opt/engineering-team/consultation-schema.json');
  const planning = args.includes('/opt/engineering-team/plan-schema.json');
  const initialQa = args.at(-1).includes('This is the qa gate.') && args.at(-1).includes('Verification round: 0');
  const passed = (!readOnly || process.env.FIXTURE_RELEASE_PASSES === 'true') && !(initialQa && process.env.FIXTURE_FAIL_INITIAL_QA === 'true');
  const criteria = consultation || planning ? [] : args.at(-1).split('Acceptance criteria:\n')[1].split('\n\nReturn ')[0].split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2));
  const report = planning ? { intent: 'conversation', assistantMessage: 'Please clarify the desired feature.', directiveActions: [], consultationRequests: [], contextUpdates: [], objective: null, tasks: [] } : consultation ? { response: 'The task is still running.', directiveActions: [], contextUpdates: [] } : {
    summary: readOnly ? (passed ? 'Ready to integrate.' : 'Release evidence is incomplete.') : 'Implemented.',
    checks: [{command: 'fixture inspection', status: passed ? 'passed' : 'failed'}],
    acceptanceCriteria: criteria.map(criterion => ({criterion, satisfied: passed, evidence: 'Fixture evidence'})),
    questions: [], risks: [],
  };
  const override = JSON.parse(fs.readFileSync(process.env.FIXTURE_REPORT_OVERRIDE, 'utf8'));
  if (override.stage === 'all' || (override.stage === 'initial-qa' && initialQa) || (override.stage === 'release' && args.at(-1).includes('This is a Release Manager integration assessment.'))) Object.assign(report, override.report);
  console.log(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: JSON.stringify(report)}}));
} else throw new Error('Unexpected Docker invocation: ' + JSON.stringify(args));
`, { mode: 0o755 });

  const listener = createServer();
  const taskId = randomUUID();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./controller-main.js", import.meta.url))], {
    env: {
      PATH: `${bin}:${process.env.PATH}`, LANG: "C.UTF-8", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      ENGINEERING_TEAM_CONTROLLER_HOST: "127.0.0.1", ENGINEERING_TEAM_CONTROLLER_PORT: String(address.port),
      ENGINEERING_TEAM_WORKSPACE_ROOT: workspaceRoot, ENGINEERING_TEAM_WORKTREE_ROOT: worktreeRoot,
      ENGINEERING_TEAM_WORKTREE_VOLUME: "fixture-volume", ENGINEERING_TEAM_CODEX_AUTH_FILE: join(root, "no-auth.json"),
      FIXTURE_API_KEY: "dummy-key", FIXTURE_INVOCATIONS: invocationFile, FIXTURE_RELEASE_PASSES: String(releasePasses),
      FIXTURE_COMMIT_WORKER_CHANGES: String(commitWorkerChanges),
      FIXTURE_SCENARIO: scenario, FIXTURE_FAIL_INITIAL_QA: String(failInitialQa), FIXTURE_TASK_ID: taskId,
      FIXTURE_REPORT_OVERRIDE: reportOverrideFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Controller did not start: ${output}`)), 10_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", () => { clearTimeout(timeout); reject(new Error(`Controller exited: ${output}`)); });
    child.stdout.on("data", () => { if (output.includes("listening at")) { clearTimeout(timeout); resolve(); } });
  });
  const request: CodingRunRequest = {
    run: {
      schemaVersion: 1, runId: randomUUID(), projectId: randomUUID(), taskId, agentRole: "backend_developer",
      brainProfile: { provider: "openai", harness: "codex", modelClass: "coding", credentialRef: "FIXTURE_API_KEY", model: "gpt-test" },
      repositories: repositories.map(({ repositoryId, name, baseCommit }) => ({ repositoryId, checkoutPath: `/workspace/repos/${name}`, baseCommit })),
      objective: "Inspect the supplied commit", taskDescription: "Assess the current implementation.", acceptanceCriteria: ["Evidence is complete"], upstreamArtifacts: [],
      permissions: { filesystem: "read-only", networkPolicy: "model-provider-only", allowedTools: ["inspect_repository"] },
      limits: { timeoutSeconds: 30, retries: 0 },
    },
    repositorySources: [],
  };
  request.repositorySources = repositories.map(({ repositoryId, name, sourcePath }) => ({ repositoryId, name, sourcePath }));
  return {
    workspaceRoot, worktreeRoot, source, baseCommit, request, url, repositories,
    executor: new HttpPlanningExecutor(url),
    async setReportOverride(report: Record<string, unknown>, stage: "all" | "initial-qa" | "release" = "all") {
      await writeFile(reportOverrideFile, JSON.stringify({ report, stage }));
    },
    async invocations(): Promise<WorkerInvocation[]> {
      return (await readFile(invocationFile, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as WorkerInvocation);
    },
  };
}

function workspaceMount(invocation: WorkerInvocation) {
  const mount = invocation.args.find(arg => arg.startsWith("type=bind,") && arg.split(",").includes("dst=/workspace"));
  assert(mount);
  return mount.split(",");
}

test("a stale rerun gets a new HTTP release assessment and approval for the newer source base", { skip: process.getuid?.() !== 0, timeout: 30_000 }, async t => {
  const fixture = await controllerFixture(t);
  const database = new TeamDatabase(":memory:");
  t.after(() => database.close());
  const projectId = fixture.request.run.projectId, taskId = fixture.request.run.taskId!, repositoryId = fixture.request.run.repositories[0]!.repositoryId;
  database.createProject({ id: projectId, name: "Rerun", repository: { id: repositoryId, name: "backend", relativePath: "backend", defaultBranch: "main" } });
  database.createCodingHarness(projectId, "harness", { name: "Codex", adapter: "codex", executable: "codex", supportedProtocols: ["openai-responses"], capabilities: ["coding", "testing"] });
  database.createModelBackend(projectId, "backend", { name: "Fixture", provider: "openai", protocol: "openai-responses", model: "gpt-test", authMode: "api-key", credentialRef: "FIXTURE_API_KEY" });
  for (const role of ["backend_developer", "release_manager"] as const) database.assignAgentRuntime(projectId, role, "harness", "backend");
  const plan = database.createPlan({ projectId, approvalId: randomUUID(), objective: { id: randomUUID(), title: "Rerun", description: "Deliver on the current base" },
    tasks: [{ id: taskId, key: "build", title: "Build", description: "Implement", assignedRole: "backend_developer", repositoryIds: [repositoryId], acceptanceCriteria: ["Works"], requiredChecks: { qa: false, codeReview: false, security: false }, dependsOn: [] }] });
  database.decideApproval(projectId, plan.approval.id, "approved", null);
  let applied = 0;
  const app = createApp(database, { workspaceRoot: fixture.workspaceRoot, taskExecutor: {
    executeTask: fixture.executor.executeTask.bind(fixture.executor),
    async applyTask(request) { applied++; return fixture.executor.applyTask(request); },
  } });
  const approve = (id: string) => app.request(`/api/projects/${projectId}/approvals/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approved" }) });
  async function runToReview() {
    const started = await app.request(`/api/projects/${projectId}/tasks/${taskId}/runs`, { method: "POST" });
    assert.equal(started.status, 202, await started.text());
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && database.getOrchestrationState(projectId)?.tasks[0]?.status !== "review") await new Promise(resolve => setTimeout(resolve, 25));
    const state = database.getOrchestrationState(projectId)!;
    assert.equal(state.tasks[0]?.status, "review", JSON.stringify(state.messages.slice(-3)));
    return state.integrationProposals[0]!;
  }
  const original = await runToReview();
  await writeFile(join(fixture.source, "code.txt"), "new source base\n");
  await writeFile(join(fixture.source, "concurrent.txt"), "Preserve newer source work\n");
  await runCaptureGit(["-C", fixture.source, "add", "."]);
  await runCaptureGit(["-C", fixture.source, "commit", "--quiet", "-m", "Advance source base"]);
  const newerBase = (await runCaptureGit(["-C", fixture.source, "rev-parse", "HEAD"])).trim();
  const rerun = await app.request(`/api/projects/${projectId}/tasks/${taskId}/rerun`, { method: "POST" });
  assert.equal(rerun.status, 200, await rerun.text());
  assert.equal(database.getApproval(projectId, original.approvalId)?.status, "superseded");
  assert.equal(database.getIntegrationProposal(projectId, original.approvalId)?.status, "superseded");
  assert.equal((await approve(original.approvalId)).status, 409);
  const replacement = await runToReview();
  assert.notEqual(replacement.approvalId, original.approvalId);
  assert.notEqual(replacement.changeRunId, original.changeRunId);
  assert.notEqual(replacement.releaseRunId, original.releaseRunId);
  const implementation = database.getAgentRun(replacement.changeRunId)!;
  const release = database.getAgentRun(replacement.releaseRunId)!;
  const sha = implementation.result!.commits[0]!.sha;
  assert.equal(implementation.spec.runPurpose, "implementation");
  assert.equal(implementation.spec.repositories[0]!.baseCommit, newerBase);
  assert.equal((await runCaptureGit(["-C", fixture.source, "rev-parse", `${sha}^`])).trim(), newerBase);
  assert.equal(release.spec.repositories[0]!.baseCommit, sha);
  assert(release.spec.upstreamArtifacts.includes(`implementation-run:${implementation.id}`));
  assert(!release.spec.upstreamArtifacts.includes(`implementation-run:${original.changeRunId}`));
  const invocations = await fixture.invocations();
  assert.equal(invocations.length, 4);
  assert.equal(invocations[2]!.checkoutHead, newerBase);
  assert.equal(invocations[3]!.checkoutHead, sha);
  assert.equal((await approve(original.approvalId)).status, 409);
  assert.equal(applied, 0);
  const result = await approve(replacement.approvalId);
  assert.equal(result.status, 200, await result.text());
  assert.equal(applied, 1);
  assert.equal((await runCaptureGit(["-C", fixture.source, "rev-parse", "HEAD"])).trim(), sha);
  assert.equal(await readFile(join(fixture.source, "concurrent.txt"), "utf8"), "Preserve newer source work\n");
  assert.equal(database.getOrchestrationState(projectId)?.tasks[0]?.status, "completed");
});

const controllerTest = { skip: process.getuid?.() !== 0, timeout: 30_000 };

for (const purpose of ["implementation", "repair", "verification", "release"] as const) {
  test(`${purpose} rejects partial or invalid acceptance evidence through the HTTP controller`, controllerTest, async t => {
    const f = await controllerFixture(t);
    const criteria = ["Feature works", "Regression covered"];
    const valid = criteria.map(criterion => ({ criterion, satisfied: true, evidence: "Checked the required behavior" }));
    const invalid = [
      [valid[0]!],
      [],
      [valid[0]!, valid[0]!],
      [...valid, valid[0]!],
      [valid[0]!, { ...valid[1]!, criterion: "Unrelated behavior" }],
      [...valid, { ...valid[0]!, criterion: "Unrelated behavior" }],
      [valid[0]!, { ...valid[1]!, satisfied: false }],
      [valid[0]!, { ...valid[1]!, evidence: " \n\t" }],
    ];
    for (const acceptanceCriteria of [...invalid, [...valid].reverse()]) {
      await f.setReportOverride({ acceptanceCriteria });
      const request = structuredClone(f.request);
      request.run.runId = randomUUID();
      request.run.runPurpose = purpose;
      request.run.permissions.filesystem = "workspace-write";
      request.run.acceptanceCriteria = criteria;
      const response = await f.executor.executeTask(request);
      const passes = acceptanceCriteria[0]?.criterion === criteria[1] && acceptanceCriteria.length === 2;
      assert.equal(response.result.status, passes ? "completed" : "failed", JSON.stringify(acceptanceCriteria));
      assert.deepEqual(response.result.acceptanceCriteria.map(item => item.criterion), criteria);
      if (!passes) assert(response.result.checks.some(check => check.status === "failed"));
      if (purpose === "verification" || purpose === "release") assert.deepEqual(response.result.commits, []);
    }
    assert.equal((await runCaptureGit(["-C", f.source, "rev-parse", "HEAD"])).trim(), f.baseCommit);
  });
}

test("malformed worker evidence is rejected before publishing source changes", controllerTest, async t => {
  const f = await controllerFixture(t);
  await f.setReportOverride({ acceptanceCriteria: [{ criterion: "Evidence is complete", satisfied: "true", evidence: "Claimed pass" }] });
  const request = structuredClone(f.request);
  request.run.permissions.filesystem = "workspace-write";
  request.run.runPurpose = "implementation";
  await assert.rejects(f.executor.executeTask(request), /invalid structured task report.*satisfied/);
  assert.equal(await runCaptureGit(["-C", f.source, "for-each-ref", "--format=%(refname)", "refs/heads/agent"]), "");
  assert.equal((await runCaptureGit(["-C", f.source, "rev-parse", "HEAD"])).trim(), f.baseCommit);
});

test("ambiguous or blank required criteria are rejected before starting a worker", controllerTest, async t => {
  const f = await controllerFixture(t);
  for (const acceptanceCriteria of [[], [" "], ["Works", "Works"], ["Works", " Works "]]) {
    const response = await fetch(`${f.url}/task-runs`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...f.request, run: { ...f.request.run, acceptanceCriteria } }),
    });
    assert.equal(response.status, 400, JSON.stringify(acceptanceCriteria));
  }
  assert.deepEqual(await f.invocations(), []);
});

async function startMultiRepositoryWorkflow(t: TestContext, fixture: Awaited<ReturnType<typeof controllerFixture>>) {
  const database = new TeamDatabase(":memory:");
  t.after(() => database.close());
  const { projectId, taskId } = fixture.request.run;
  const [first, ...rest] = fixture.repositories;
  database.createProject({ id: projectId, name: "Multiple repositories", repository: { id: first!.repositoryId, name: first!.name, relativePath: first!.name, defaultBranch: "main" } });
  for (const repo of rest) database.addRepository(projectId, { id: repo.repositoryId, name: repo.name, relativePath: repo.name, defaultBranch: "main" });
  database.updateProjectSettings(projectId, { defaultRunRetries: 1 });
  database.createCodingHarness(projectId, "harness", { name: "Codex", adapter: "codex", executable: "codex", supportedProtocols: ["openai-responses"], capabilities: ["coding", "testing"] });
  database.createModelBackend(projectId, "backend", { name: "Fixture", provider: "openai", protocol: "openai-responses", model: "gpt-test", authMode: "api-key", credentialRef: "FIXTURE_API_KEY" });
  for (const role of ["backend_developer", "qa_engineer", "release_manager"] as const) database.assignAgentRuntime(projectId, role, "harness", "backend");
  const plan = database.createPlan({ projectId, approvalId: randomUUID(), objective: { id: randomUUID(), title: "Deliver", description: "Change only the necessary repositories" },
    tasks: [{ id: taskId!, key: "build", title: "Build", description: "Implement", assignedRole: "backend_developer", repositoryIds: fixture.repositories.map(repo => repo.repositoryId), acceptanceCriteria: fixture.request.run.acceptanceCriteria, requiredChecks: { qa: true, codeReview: false, security: false }, dependsOn: [] }] });
  database.decideApproval(projectId, plan.approval.id, "approved", null);
  const app = createApp(database, { workspaceRoot: fixture.workspaceRoot, taskExecutor: fixture.executor });
  const started = await app.request(`/api/projects/${projectId}/tasks/${taskId}/runs`, { method: "POST" });
  assert.equal(started.status, 202, await started.text());
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = database.getOrchestrationState(projectId)!;
    if (state.tasks[0]?.status === "review" || state.runs.some(run => ["implementation", "release"].includes(run.spec.runPurpose ?? "") && run.status === "failed")) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return { database, app, projectId, taskId: taskId!, approve: (id: string) => app.request(`/api/projects/${projectId}/approvals/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approved" }),
  }) };
}

test("partial QA evidence triggers repair and a fresh complete assessment before review", controllerTest, async t => {
  const f = await controllerFixture(t);
  f.request.run.acceptanceCriteria = ["Feature works", "Regression covered"];
  await f.setReportOverride({ acceptanceCriteria: [{ criterion: "Feature works", satisfied: true, evidence: "Feature test passed" }] }, "initial-qa");
  const workflow = await startMultiRepositoryWorkflow(t, f);
  const state = workflow.database.getOrchestrationState(workflow.projectId)!;
  assert.equal(state.tasks[0]?.status, "review", JSON.stringify(state.messages.slice(-3)));
  const runs = workflow.database.listAgentRunsForTask(workflow.projectId, workflow.taskId);
  const initialQa = runs.find(run => run.spec.runPurpose === "verification" && run.spec.verificationRound === 0)!;
  assert.equal(initialQa.status, "failed");
  assert.equal(initialQa.result!.acceptanceCriteria[1]?.criterion, "Regression covered");
  assert.equal(initialQa.result!.acceptanceCriteria[1]?.satisfied, false);
  const repair = runs.find(run => run.spec.runPurpose === "repair")!;
  assert.match(repair.spec.taskDescription, /Regression covered/);
  const newQa = runs.find(run => run.spec.runPurpose === "verification" && run.spec.verificationRound === 1)!;
  assert.equal(newQa.status, "completed");
  assert(newQa.result!.acceptanceCriteria.every(item => item.satisfied));
  assert.equal(state.integrationProposals[0]?.changeRunId, repair.id);
});

for (const stage of ["implementation", "release"] as const) {
  test(`partial ${stage} evidence cannot create an integration proposal`, controllerTest, async t => {
    const f = await controllerFixture(t);
    f.request.run.acceptanceCriteria = ["Feature works", "Regression covered"];
    const criterion = stage === "implementation" ? "Feature works" : "All required QA, code-review, and security evidence is complete for the proposed commit";
    await f.setReportOverride({ acceptanceCriteria: [{ criterion, satisfied: true, evidence: "First check passed" }] }, stage === "implementation" ? "all" : "release");
    const workflow = await startMultiRepositoryWorkflow(t, f);
    const state = workflow.database.getOrchestrationState(workflow.projectId)!;
    const failed = state.runs.find(run => run.spec.runPurpose === stage)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.result!.acceptanceCriteria[1]?.satisfied, false);
    assert.equal(state.tasks[0]?.status, "in_progress");
    assert.deepEqual(state.integrationProposals, []);
    if (stage === "implementation") assert(!state.runs.some(run => run.spec.runPurpose === "verification"));
  });
}

for (const secondRepository of ["populated", "unborn"] as const) {
  test(`a two-repository task and repair can leave the ${secondRepository} second repository unchanged`, controllerTest, async t => {
    const f = await controllerFixture(t, { secondRepository, failInitialQa: true });
    const workflow = await startMultiRepositoryWorkflow(t, f);
    const state = workflow.database.getOrchestrationState(workflow.projectId)!;
    assert.equal(state.tasks[0]?.status, "review", JSON.stringify(state.messages.slice(-3)));
    const runs = workflow.database.listAgentRunsForTask(workflow.projectId, workflow.taskId);
    const implementation = runs.find(run => run.spec.runPurpose === "implementation")!;
    const repair = runs.find(run => run.spec.runPurpose === "repair")!;
    const release = runs.find(run => run.spec.runPurpose === "release")!;
    const [backend, frontend] = f.repositories;
    for (const run of [implementation, repair]) {
      assert.equal(run.result?.status, "completed");
      assert.equal(run.result.commits.length, 1);
      assert.equal(run.result.commits[0]?.repositoryId, backend!.repositoryId);
      assert.deepEqual(run.result.changedFiles, ["backend/code.txt"]);
      assert.equal(run.spec.repositories.find(repo => repo.repositoryId === frontend!.repositoryId)?.baseCommit, frontend!.baseCommit);
    }
    const finalSha = repair.result!.commits[0]!.sha;
    assert.equal(repair.spec.repositories.find(repo => repo.repositoryId === backend!.repositoryId)?.baseCommit, implementation.result!.commits[0]!.sha);
    assert.equal(repair.spec.repositories.find(repo => repo.repositoryId === backend!.repositoryId)?.integrationBaseCommit, backend!.baseCommit);
    for (const assessment of runs.filter(run => run.spec.runPurpose === "verification" || run.spec.runPurpose === "release")) {
      const baseline = assessment.spec.upstreamArtifacts.includes(`implementation-run:${repair.id}`) ? repair : implementation;
      assert.equal(assessment.spec.repositories.find(repo => repo.repositoryId === backend!.repositoryId)?.baseCommit, baseline.result!.commits[0]!.sha);
      assert.equal(assessment.spec.repositories.find(repo => repo.repositoryId === frontend!.repositoryId)?.baseCommit, frontend!.baseCommit);
      assert.deepEqual(assessment.result?.commits, []);
    }
    assert.equal(release.spec.repositories.find(repo => repo.repositoryId === backend!.repositoryId)?.baseCommit, finalSha);
    const approved = await workflow.approve(state.integrationProposals[0]!.approvalId);
    assert.equal(approved.status, 200, await approved.text());
    assert.equal(workflow.database.getOrchestrationState(workflow.projectId)?.tasks[0]?.status, "completed");
    assert.equal((await runCaptureGit(["-C", backend!.sourcePath, "rev-parse", "HEAD"])).trim(), finalSha);
    assert.equal(await runCaptureGit(["-C", frontend!.sourcePath, "for-each-ref", "--format=%(refname)", "refs/heads/agent"]), "");
    if (secondRepository === "unborn") {
      await assert.rejects(runCaptureGit(["-C", frontend!.sourcePath, "rev-parse", "--verify", "HEAD"]));
    } else {
      assert.equal((await runCaptureGit(["-C", frontend!.sourcePath, "rev-parse", "HEAD"])).trim(), frontend!.baseCommit);
    }
  });
}

test("a repair in the second repository carries the first repository's earlier commit through verification and integration", controllerTest, async t => {
  const f = await controllerFixture(t, { secondRepository: "populated", scenario: "split-repair", failInitialQa: true });
  const workflow = await startMultiRepositoryWorkflow(t, f);
  const state = workflow.database.getOrchestrationState(workflow.projectId)!;
  assert.equal(state.tasks[0]?.status, "review", JSON.stringify(state.messages.slice(-3)));
  const runs = workflow.database.listAgentRunsForTask(workflow.projectId, workflow.taskId);
  const implementation = runs.find(run => run.spec.runPurpose === "implementation")!;
  const repair = runs.find(run => run.spec.runPurpose === "repair")!;
  assert.equal(implementation.result?.commits.length, 1);
  assert.equal(repair.result?.commits.length, 2);
  assert.equal(repair.result.commits.find(commit => commit.repositoryId === f.repositories[0]!.repositoryId)?.sha, implementation.result!.commits[0]!.sha);
  assert.deepEqual([...repair.result.changedFiles].sort(), ["backend/code.txt", "frontend/code.txt"]);
  const branch = `agent/${workflow.taskId.slice(0, 8)}-${repair.id.slice(0, 8)}`;
  for (const repo of f.repositories) {
    const sha: string = repair.result.commits.find(commit => commit.repositoryId === repo.repositoryId)!.sha;
    assert.equal((await runCaptureGit(["-C", repo.sourcePath, "rev-parse", branch])).trim(), sha);
    assert.equal((await runCaptureGit(["-C", repo.sourcePath, "rev-parse", "HEAD"])).trim(), repo.baseCommit);
    for (const assessment of runs.filter(run => ["verification", "release"].includes(run.spec.runPurpose ?? "") && run.spec.upstreamArtifacts.includes(`implementation-run:${repair.id}`))) {
      assert.equal(assessment.spec.repositories.find(item => item.repositoryId === repo.repositoryId)?.baseCommit, sha);
    }
  }
  const response = await workflow.approve(state.integrationProposals[0]!.approvalId);
  assert.equal(response.status, 200, await response.text());
  for (const repo of f.repositories) assert.equal((await runCaptureGit(["-C", repo.sourcePath, "rev-parse", "HEAD"])).trim(), repair.result.commits.find(commit => commit.repositoryId === repo.repositoryId)!.sha);
  assert.equal(workflow.database.getOrchestrationState(workflow.projectId)?.tasks[0]?.status, "completed");
});

for (const scenario of ["capture-failure", "publish-failure"] as const) {
  test(`${scenario} records an accurate failed run without hiding published branches`, controllerTest, async t => {
    const f = await controllerFixture(t, { secondRepository: "populated", scenario });
    const workflow = await startMultiRepositoryWorkflow(t, f);
    const state = workflow.database.getOrchestrationState(workflow.projectId)!;
    const run = state.runs.find(run => run.taskId === workflow.taskId)!;
    assert.equal(run.status, "failed");
    assert.equal(run.result?.status, "failed");
    assert.match(run.result.summary, /Repository persistence failed/);
    assert.equal(run.result.commits.length, scenario === "capture-failure" ? 0 : 1);
    assert.equal(state.integrationProposals.length, 0);
    assert.equal(state.tasks[0]?.status, "in_progress");
    const branch = `agent/${workflow.taskId.slice(0, 8)}-${run.id.slice(0, 8)}`;
    for (const repo of f.repositories) {
      const refs = (await runCaptureGit(["-C", repo.sourcePath, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`])).trim();
      assert.equal(refs, run.result.commits.find(commit => commit.repositoryId === repo.repositoryId)?.sha ?? "");
      assert.equal((await runCaptureGit(["-C", repo.sourcePath, "rev-parse", "HEAD"])).trim(), repo.baseCommit);
    }
    assert.equal(run.result.artifacts.length, run.result.commits.length);
  });
}

test("a code task with no changes still fails while a specialist report can complete without commits", controllerTest, async t => {
  const f = await controllerFixture(t, { secondRepository: "populated", scenario: "no-changes" });
  for (const role of ["backend_developer", "qa_engineer"] as const) {
    const request = structuredClone(f.request);
    request.run.runId = randomUUID();
    request.run.agentRole = role;
    request.run.runPurpose = "implementation";
    request.run.permissions.filesystem = "workspace-write";
    const response = await f.executor.executeTask(request);
    assert.equal(response.result.status, role === "backend_developer" ? "failed" : "completed");
    assert.deepEqual(response.result.commits, []);
    assert.deepEqual(response.branches, []);
  }
});

test("integration refuses a changed base in an assigned repository that the task left untouched", controllerTest, async t => {
  const f = await controllerFixture(t, { secondRepository: "populated" });
  const workflow = await startMultiRepositoryWorkflow(t, f);
  const state = workflow.database.getOrchestrationState(workflow.projectId)!;
  assert.equal(state.tasks[0]?.status, "review");
  const frontend = f.repositories[1]!;
  await writeFile(join(frontend.sourcePath, "code.txt"), "Concurrent change\n");
  await runCaptureGit(["-C", frontend.sourcePath, "commit", "--quiet", "-am", "Advance untouched repository"]);
  const response = await workflow.approve(state.integrationProposals[0]!.approvalId);
  assert.equal(response.status, 409);
  assert.match(await response.text(), /frontend changed/);
  assert.equal((await runCaptureGit(["-C", f.source, "rev-parse", "HEAD"])).trim(), f.baseCommit);
});

test("task metadata rejects invalid purposes, checks, and rounds before starting a worker", controllerTest, async t => {
  const fixture = await controllerFixture(t);
  for (const metadata of [
    { runPurpose: "unknown" }, { runPurpose: 1 },
    { verificationCheck: "lint" }, { verificationCheck: null },
    { verificationRound: -1 }, { verificationRound: 0.5 }, { verificationRound: 21 },
    { verificationRound: "1" }, { verificationRound: null },
    { runPurpos: "verification" }, { verificationRoud: 1 },
  ]) {
    const body = { ...fixture.request, run: { ...fixture.request.run, ...metadata } };
    const response = await fetch(`${fixture.url}/task-runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 400, JSON.stringify(metadata));
    assert.equal((await response.json() as { error: string }).error, "invalid_task_run_request");
  }
  assert.deepEqual(await fixture.invocations(), []);
  assert.deepEqual(await readdir(fixture.worktreeRoot), []);
});

test("implementation and repair metadata survive HTTP validation and publish the intended commits", controllerTest, async t => {
  const fixture = await controllerFixture(t);
  let baseCommit = fixture.baseCommit;
  for (const [round, purpose] of (["implementation", "repair"] as const).entries()) {
    const request = structuredClone(fixture.request);
    request.run.runId = randomUUID();
    request.run.runPurpose = purpose;
    request.run.verificationRound = round;
    request.run.permissions.filesystem = "workspace-write";
    request.run.repositories[0]!.baseCommit = baseCommit;
    const response = await fixture.executor.executeTask(request);
    assert.equal(response.result.status, "completed");
    assert.equal(response.branches.length, 1);
    const sha = response.branches[0]!.sha;
    assert.notEqual(sha, baseCommit);
    assert.deepEqual(response.result.commits, [{ repositoryId: request.run.repositories[0]!.repositoryId, sha }]);
    assert.deepEqual(response.result.changedFiles, ["backend/code.txt"]);
    assert.equal((await runCaptureGit(["-C", fixture.source, "rev-parse", `${sha}^`])).trim(), baseCommit);
    assert.equal(await runCaptureGit(["-C", fixture.source, "show", `${sha}:code.txt`]), purpose === "repair" ? "repaired\n" : "implemented\n");
    const invocation = (await fixture.invocations()).at(-1)!;
    assert.equal(invocation.checkoutHead, baseCommit);
    assert(!workspaceMount(invocation).includes("readonly"));
    assert.match(invocation.args.at(-1)!, purpose === "repair" ? /This is a repair pass\./ : /This is an implementation role\./);
    assert.match(invocation.args.at(-1)!, new RegExp(`Verification round: ${round}\\b`));
    baseCommit = sha;
  }
  assert.equal((await runCaptureGit(["-C", fixture.source, "rev-parse", "HEAD"])).trim(), fixture.baseCommit);
  assert.equal(await readFile(join(fixture.source, "code.txt"), "utf8"), "original\n");
});

test("verification and release metadata select assessments of the supplied commit without publishing worker edits or commits", controllerTest, async t => {
  const fixture = await controllerFixture(t, { commitWorkerChanges: true });
  // The requested snapshot differs from the source's latest commit. Checking
  // only repository HEAD would assess the wrong implementation.
  await writeFile(join(fixture.source, "code.txt"), "newer source commit\n");
  await runCaptureGit(["-C", fixture.source, "add", "code.txt"]);
  await runCaptureGit(["-C", fixture.source, "commit", "--quiet", "-m", "Newer source commit"]);
  const sourceHead = (await runCaptureGit(["-C", fixture.source, "rev-parse", "HEAD"])).trim();
  for (const metadata of [
    { runPurpose: "verification", verificationCheck: "qa", verificationRound: 0 },
    { runPurpose: "verification", verificationCheck: "code_review", verificationRound: 2 },
    { runPurpose: "verification", verificationCheck: "security", verificationRound: 20 },
    { runPurpose: "release", verificationRound: 2 },
  ] as const) {
    const request = structuredClone(fixture.request);
    Object.assign(request.run, metadata, { runId: randomUUID() });
    // The purpose must protect publication independently of filesystem access
    // and role: these are writable runs assigned to an implementation role.
    request.run.permissions.filesystem = "workspace-write";
    const response = await fixture.executor.executeTask(request);
    assert.equal(response.result.status, "completed");
    assert.deepEqual(response.branches, []);
    assert.deepEqual(response.result.commits, []);
    assert.deepEqual(response.result.changedFiles, []);
    assert.deepEqual(response.result.artifacts, []);
    const invocation = (await fixture.invocations()).at(-1)!;
    assert.equal(invocation.checkoutHead, fixture.baseCommit);
    assert.notEqual(invocation.checkoutHead, sourceHead);
    assert.equal(invocation.before, "original\n");
    assert.notEqual(invocation.after, invocation.before);
    assert.notEqual(invocation.workerHead, invocation.checkoutHead);
    assert(!workspaceMount(invocation).includes("readonly"));
    const prompt = invocation.args.at(-1)!;
    assert.match(prompt, metadata.runPurpose === "verification"
      ? new RegExp(`This is the ${metadata.verificationCheck.replaceAll("_", " ")} gate\\.`)
      : /This is a Release Manager integration assessment\./);
    assert.match(prompt, new RegExp(`Verification round: ${metadata.verificationRound}\\b`));
    assert.doesNotMatch(prompt, /Implement the task completely|Make the code changes required/);
    assert.equal((await runCaptureGit(["-C", fixture.source, "rev-parse", "HEAD"])).trim(), sourceHead);
    assert.equal((await runCaptureGit(["-C", fixture.source, "branch", "--format=%(refname:short)"])).trim(), "main");
    assert.equal(await readFile(join(fixture.source, "code.txt"), "utf8"), "newer source commit\n");
    assert.deepEqual(await readdir(fixture.worktreeRoot), []);
  }
});

test("read-only task requests cross HTTP validation and cannot publish changes, regardless of agent role", controllerTest, async t => {
  const fixture = await controllerFixture(t);
  const invalid = structuredClone(fixture.request) as unknown as { run: { permissions: { filesystem: string } } };
  invalid.run.permissions.filesystem = "full-access";
  const rejected = await fetch(`${fixture.url}/task-runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(invalid) });
  assert.equal(rejected.status, 400);
  assert.deepEqual(await fixture.invocations(), []);

  const response = await fixture.executor.executeTask(fixture.request);
  assert.equal(response.result.status, "completed");
  assert.deepEqual(response.branches, []);
  assert.deepEqual(response.result.commits, []);
  assert.deepEqual(response.result.changedFiles, []);
  assert.deepEqual(response.result.artifacts, []);
  const [invocation] = await fixture.invocations();
  assert(invocation);
  assert(workspaceMount(invocation).includes("readonly"));
  assert.equal(invocation.checkoutHead, fixture.baseCommit);
  assert.equal(invocation.before, "original\n");
  assert.equal(invocation.after, "unauthorized assessment edit\n");
  assert.match(invocation.args.at(-1)!, /repository snapshots are mounted read-only/);
  assert.doesNotMatch(invocation.args.at(-1)!, /Make the code changes required/);
  assert.equal(await readFile(join(fixture.source, "code.txt"), "utf8"), "original\n");
  assert.equal((await runCaptureGit(["-C", fixture.source, "branch", "--format=%(refname:short)"])).trim(), "main");
  assert.deepEqual(await readdir(fixture.worktreeRoot), []);
});

for (const releasePasses of [true, false]) {
  test(`Release Manager through the HTTP controller ${releasePasses ? "prepares a proposal for the implementation commit" : "blocks integration when its assessment fails"}`, controllerTest, async t => {
    const fixture = await controllerFixture(t, { releasePasses });
    const database = new TeamDatabase(":memory:");
    t.after(() => database.close());
    const projectId = fixture.request.run.projectId;
    const repositoryId = fixture.request.run.repositories[0]!.repositoryId;
    database.createProject({ id: projectId, name: "Release test", repository: { id: repositoryId, name: "backend", relativePath: "backend", defaultBranch: "main" } });
    database.createCodingHarness(projectId, "harness-test", { name: "Codex", adapter: "codex", executable: "codex", supportedProtocols: ["openai-responses"], capabilities: ["coding", "testing"] });
    database.createModelBackend(projectId, "backend-test", { name: "Fixture", provider: "openai", protocol: "openai-responses", model: "gpt-test", authMode: "api-key", credentialRef: "FIXTURE_API_KEY" });
    for (const role of ["backend_developer", "release_manager"] as const) database.assignAgentRuntime(projectId, role, "harness-test", "backend-test");
    const taskId = fixture.request.run.taskId!;
    const plan = database.createPlan({
      projectId, approvalId: randomUUID(), objective: { id: randomUUID(), title: "Delivery", description: "Deliver the change." },
      tasks: [{ id: taskId, key: "build", title: "Build", description: "Implement the feature.", assignedRole: "backend_developer", repositoryIds: [repositoryId], acceptanceCriteria: ["Feature works"], requiredChecks: { qa: false, codeReview: false, security: false }, dependsOn: [] }],
    });
    database.decideApproval(projectId, plan.approval.id, "approved", null);
    const app = createApp(database, { workspaceRoot: fixture.workspaceRoot, taskExecutor: fixture.executor });
    const started = await app.request(`/api/projects/${projectId}/tasks/${taskId}/runs`, { method: "POST" });
    assert.equal(started.status, 202, await started.text());
    let state = database.getOrchestrationState(projectId)!;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && state.tasks[0]?.status === "in_progress" && !state.runs.some(run => run.spec.runPurpose === "release" && run.status === "failed")) {
      await new Promise(resolve => setTimeout(resolve, 25));
      state = database.getOrchestrationState(projectId)!;
    }
    const release = state.runs.find(run => run.spec.runPurpose === "release");
    const implementation = state.runs.find(run => run.spec.runPurpose === "implementation");
    assert(release, JSON.stringify(state.runs));
    assert.equal(release.spec.permissions.filesystem, "read-only");
    assert.equal(release.result?.status, releasePasses ? "completed" : "failed", JSON.stringify(release));
    assert.deepEqual(release.result.commits, []);
    assert.deepEqual(release.result.changedFiles, []);
    const sha = implementation?.result?.commits[0]?.sha;
    assert(sha);
    assert.equal(release.spec.repositories[0]?.baseCommit, sha);
    assert.equal(await runCaptureGit(["-C", fixture.source, "show", `${sha}:code.txt`]), "implemented\n");
    assert.equal(await readFile(join(fixture.source, "code.txt"), "utf8"), "original\n");
    assert.equal((await runCaptureGit(["-C", fixture.source, "rev-parse", "HEAD"])).trim(), fixture.baseCommit);
    const invocations = await fixture.invocations();
    assert.equal(invocations.length, 2);
    assert(!workspaceMount(invocations[0]!).includes("readonly"));
    assert(workspaceMount(invocations[1]!).includes("readonly"));
    assert.equal(invocations[1]!.checkoutHead, sha);
    assert.equal(invocations[1]!.before, "implemented\n");
    assert.equal(invocations[1]!.after, "unauthorized assessment edit\n");
    assert.match(invocations[1]!.args.at(-1)!, /This is a Release Manager integration assessment\./);
    assert.match(invocations[1]!.args.at(-1)!, /Verification round: 0/);
    const refs = (await runCaptureGit(["-C", fixture.source, "for-each-ref", "--format=%(objectname)", "refs/heads/agent/"])).trim().split("\n");
    assert.deepEqual(refs, [sha]);
    assert.deepEqual(await readdir(fixture.worktreeRoot), []);
    if (releasePasses) {
      assert.equal(state.tasks[0]?.status, "review");
      assert.equal(state.integrationProposals.length, 1);
      assert.equal(state.integrationProposals[0]?.changeRunId, implementation!.id);
      assert.equal(state.integrationProposals[0]?.releaseRunId, release.id);
      assert.equal(state.integrationProposals[0]?.status, "pending");
      assert.equal(state.approvals.find(approval => approval.type === "integration")?.status, "pending");
      let applyCalls = 0;
      const applyingApp = createApp(database, {
        workspaceRoot: fixture.workspaceRoot,
        taskExecutor: {
          executeTask: fixture.executor.executeTask.bind(fixture.executor),
          async applyTask(request) {
            applyCalls++;
            assert.equal(database.getApproval(projectId, request.approvalId)?.status, "approved");
            const result = await fixture.executor.applyTask(request);
            if (applyCalls === 1) throw new Error("Lost response from the HTTP controller");
            return result;
          },
        },
      });
      const approve = () => applyingApp.request(`/api/projects/${projectId}/approvals/${state.integrationProposals[0]!.approvalId}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approved" }),
      });
      const interrupted = await approve();
      assert.equal(interrupted.status, 409, await interrupted.text());
      assert.equal((await runCaptureGit(["-C", fixture.source, "rev-parse", "HEAD"])).trim(), sha);
      assert.equal(database.getIntegrationProposal(projectId, state.integrationProposals[0]!.approvalId)?.application?.status, "retryable");
      const resumed = await approve();
      assert.equal(resumed.status, 200, await resumed.text());
      assert.equal((await approve()).status, 200);
      assert.equal(applyCalls, 2);
      assert.equal(database.getOrchestrationState(projectId)?.tasks[0]?.status, "completed");
      assert.equal(await readFile(join(fixture.source, "code.txt"), "utf8"), "implemented\n");
    } else {
      assert.equal(state.tasks[0]?.status, "in_progress");
      assert.equal(state.integrationProposals.length, 0);
      assert.equal(state.approvals.some(approval => approval.type === "integration"), false);
    }
  });
}


test("question-only consultations preserve the policy and activity snapshot through the HTTP controller", { skip: process.getuid?.() !== 0, timeout: 30_000 }, async t => {
  const fixture = await controllerFixture(t);
  const { taskId: _task, ...run } = fixture.request.run;
  const request: ConsultationRunRequest = {
    run: { ...run, agentRole: "project_manager", runPurpose: "consultation", permissions: { ...run.permissions, allowedTools: ["inspect_repository", "respond_to_request"] } },
    requestingRole: "engineering_director", question: "What is blocking progress?", questionOnly: true,
    activityContext: JSON.stringify({ tasks: [{ title: "Backend migration", status: "blocked" }] }),
    directives: [], conversation: [{ author: "director", body: "What is blocking progress?" }], projectContext: "",
    repositoryContexts: [], repositorySources: fixture.request.repositorySources,
  };
  const result = await fixture.executor.consult(request);
  assert.equal(result.response, "The task is still running.");
  const invocations = await fixture.invocations();
  assert.equal(invocations.length, 1);
  const invocation = invocations[0]!;
  assert(workspaceMount(invocation).includes("readonly"));
  const prompt = invocation.args.at(-1)!;
  assert.match(prompt, /question-only conversation/);
  assert.match(prompt, /directiveActions and contextUpdates MUST both be empty/);
  assert.match(prompt, /Backend migration/);
  assert.doesNotMatch(prompt, /return an add directive action/);
  assert.equal(await readFile(join(fixture.source, "code.txt"), "utf8"), "original\n");
});


test("standing instructions reach a task worker through the HTTP controller", { skip: process.getuid?.() !== 0, timeout: 30_000 }, async t => {
  const fixture = await controllerFixture(t);
  fixture.request.run.standingDirectives = ["Always check backwards compatibility."];
  await fixture.executor.executeTask(fixture.request);
  const invocation = (await fixture.invocations())[0]!;
  assert.match(invocation.args.at(-1)!, /Always check backwards compatibility/);
  assert(workspaceMount(invocation).includes("readonly"));
});

test("voice new-work policy reaches the planner without directive-update instructions", { skip: process.getuid?.() !== 0, timeout: 30_000 }, async t => {
  const fixture = await controllerFixture(t);
  const { taskId: _taskId, ...run } = fixture.request.run;
  const request: PlanningRunRequest = {
    run: { ...run, agentRole: "project_manager", runPurpose: "planning", brainProfile: { ...run.brainProfile, modelClass: "planning" },
      permissions: { ...run.permissions, allowedTools: ["inspect_repository", "respond_to_director"] } },
    planningOnly: true, directorMessageId: randomUUID(), directives: [], conversation: [], availableConsultants: [], consultationResults: [],
    projectContext: "", repositoryContexts: [], repositorySources: fixture.request.repositorySources,
  };
  const response = await fixture.executor.execute(request);
  assert.equal(response.proposal.intent, "conversation");
  const prompt = (await fixture.invocations())[0]!.args.at(-1)!;
  assert.match(prompt, /directiveActions MUST be empty/);
  assert.doesNotMatch(prompt, /- directive_update:/);
  assert.equal(await readFile(join(fixture.source, "code.txt"), "utf8"), "original\n");
});
