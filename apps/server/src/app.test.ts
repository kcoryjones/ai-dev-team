import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TeamDatabase } from "@engineering-team/database";
import { createApp } from "./app.js";
import { createRepository as createGitRepository } from "./repository.js";

describe("local API", () => {
  it("reports its health and database state", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    const app = createApp(database, { workspaceRoot });

    const response = await app.request("/api/health");
    const body = (await response.json()) as { status: string; database: string };

    assert.equal(response.status, 200);
    assert.deepEqual(
      { status: body.status, database: body.database },
      { status: "ok", database: "connected" },
    );
    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("reads and validates project setup and execution settings", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    const app = createApp(database, { workspaceRoot, workspaceName: "Customer Platform" });
    const createResponse = await app.request("/api/projects/workspace", { method: "POST" });
    const created = (await createResponse.json()) as { project: { id: string } };

    const defaultsResponse = await app.request(`/api/projects/${created.project.id}/settings`);
    assert.equal(defaultsResponse.status, 200);
    const defaults = (await defaultsResponse.json()) as {
      settings: {
        setupStatus: string;
        defaultRunTimeoutSeconds: number;
        planningNetworkPolicy: string;
        requirePlanApproval: boolean;
      };
    };
    assert.deepEqual(
      {
        setupStatus: defaults.settings.setupStatus,
        defaultRunTimeoutSeconds: defaults.settings.defaultRunTimeoutSeconds,
        planningNetworkPolicy: defaults.settings.planningNetworkPolicy,
        requirePlanApproval: defaults.settings.requirePlanApproval,
      },
      {
        setupStatus: "completed",
        defaultRunTimeoutSeconds: 900,
        planningNetworkPolicy: "model-provider-only",
        requirePlanApproval: true,
      },
    );

    const updateResponse = await app.request(`/api/projects/${created.project.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        setupStatus: "completed",
        defaultRunTimeoutSeconds: 1_800,
        defaultTokenBudget: 50_000,
        defaultCostBudgetCents: 250,
        planningNetworkPolicy: "restricted",
      }),
    });
    assert.equal(updateResponse.status, 200);
    const updated = (await updateResponse.json()) as {
      settings: { setupStatus: string; setupCompletedAt: string | null; defaultTokenBudget: number };
    };
    assert.equal(updated.settings.setupStatus, "completed");
    assert.ok(updated.settings.setupCompletedAt);
    assert.equal(updated.settings.defaultTokenBudget, 50_000);

    const invalidResponse = await app.request(`/api/projects/${created.project.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultRunTimeoutSeconds: 5 }),
    });
    assert.equal(invalidResponse.status, 400);

    const emptyResponse = await app.request(`/api/projects/${created.project.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(emptyResponse.status, 400);

    const missingResponse = await app.request("/api/projects/missing/settings");
    assert.equal(missingResponse.status, 404);

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("creates, updates, lists, and deletes model backends", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    const app = createApp(database, { workspaceRoot, workspaceName: "Customer Platform" });
    const createProjectResponse = await app.request("/api/projects/workspace", { method: "POST" });
    const project = (await createProjectResponse.json()) as { project: { id: string } };
    const endpoint = `/api/projects/${project.project.id}/model-backends`;

    const createResponse = await app.request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "RunPod Qwen Coder",
        provider: "runpod",
        protocol: "openai-chat-completions",
        model: "qwen-2.5-coder",
        baseUrl: "https://api.runpod.ai/v2/example/openai/v1",
        authMode: "api-key",
        credentialRef: "RUNPOD_API_KEY",
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as {
      backend: { id: string; name: string; enabled: boolean };
    };
    assert.equal(created.backend.name, "RunPod Qwen Coder");
    assert.equal(created.backend.enabled, true);

    const listResponse = await app.request(endpoint);
    assert.equal(listResponse.status, 200);
    const listed = (await listResponse.json()) as { backends: Array<{ id: string }> };
    assert.deepEqual(listed.backends.map((backend) => backend.id), [created.backend.id]);

    const updateResponse = await app.request(`${endpoint}/${created.backend.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "RunPod Qwen Coder",
        provider: "runpod",
        protocol: "openai-responses",
        model: "qwen-2.5-coder",
        baseUrl: "https://api.runpod.ai/v2/example/openai/v1",
        authMode: "api-key",
        credentialRef: "RUNPOD_API_KEY",
        enabled: false,
      }),
    });
    assert.equal(updateResponse.status, 200);
    assert.equal(((await updateResponse.json()) as { backend: { enabled: boolean } }).backend.enabled, false);

    const invalidResponse = await app.request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Broken RunPod",
        provider: "runpod",
        protocol: "openai-chat-completions",
        authMode: "api-key",
        credentialRef: "RUNPOD_API_KEY",
      }),
    });
    assert.equal(invalidResponse.status, 400);

    const chatGptResponse = await app.request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Codex Business",
        provider: "openai",
        protocol: "openai-responses",
        authMode: "chatgpt",
      }),
    });
    assert.equal(chatGptResponse.status, 201);

    const deleteResponse = await app.request(`${endpoint}/${created.backend.id}`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 204);

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("creates, updates, lists, and deletes coding harnesses", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    const app = createApp(database, { workspaceRoot, workspaceName: "Customer Platform" });
    const createProjectResponse = await app.request("/api/projects/workspace", { method: "POST" });
    const project = (await createProjectResponse.json()) as { project: { id: string } };
    const endpoint = `/api/projects/${project.project.id}/harnesses`;

    const createResponse = await app.request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "OpenCode",
        adapter: "opencode",
        executable: "opencode",
        containerImage: "local/engineering-team-opencode:latest",
        supportedProtocols: ["openai-responses", "openai-chat-completions", "anthropic-messages"],
        capabilities: ["planning", "coding", "review", "testing"],
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as {
      harness: { id: string; adapter: string; enabled: boolean };
    };
    assert.equal(created.harness.adapter, "opencode");
    assert.equal(created.harness.enabled, true);

    const listResponse = await app.request(endpoint);
    assert.equal(listResponse.status, 200);
    const listed = (await listResponse.json()) as { harnesses: Array<{ id: string }> };
    assert.deepEqual(listed.harnesses.map((harness) => harness.id), [created.harness.id]);

    const updateResponse = await app.request(`${endpoint}/${created.harness.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "OpenCode",
        adapter: "opencode",
        executable: "/usr/local/bin/opencode",
        supportedProtocols: ["openai-chat-completions"],
        capabilities: ["coding", "testing"],
        enabled: false,
      }),
    });
    assert.equal(updateResponse.status, 200);
    assert.equal(((await updateResponse.json()) as { harness: { enabled: boolean } }).harness.enabled, false);

    const invalidResponse = await app.request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Unsafe command",
        adapter: "custom",
        executable: "agent --flag; echo nope",
        supportedProtocols: ["openai-responses"],
        capabilities: ["coding"],
      }),
    });
    assert.equal(invalidResponse.status, 400);

    const deleteResponse = await app.request(`${endpoint}/${created.harness.id}`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 204);

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("reports Codex installed only when the registered harness matches the allowlisted worker", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    const app = createApp(database, {
      workspaceRoot,
      workspaceName: "Customer Platform",
      harnessInspector: {
        async getCapabilities() {
          return {
            workerImage: "local/engineering-team-controller:latest",
            imageDigest: "sha256:test",
            harnesses: [{
              adapter: "codex",
              executable: "codex",
              installed: true,
              version: "codex-cli 0.162.1",
            }],
          };
        },
        async preflightCodex() {
          return {
            adapter: "codex" as const,
            state: "ready" as const,
            version: "codex-cli 0.162.1",
            workerImage: "local/engineering-team-controller:latest",
            message: "Logged in using ChatGPT",
          };
        },
      },
    });
    const createProjectResponse = await app.request("/api/projects/workspace", { method: "POST" });
    const project = (await createProjectResponse.json()) as { project: { id: string } };
    const endpoint = `/api/projects/${project.project.id}/harnesses`;

    const codexResponse = await app.request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Codex CLI",
        adapter: "codex",
        executable: "codex",
        supportedProtocols: ["openai-responses"],
        capabilities: ["planning", "coding", "review", "testing"],
      }),
    });
    const codex = (await codexResponse.json()) as { harness: { id: string } };
    const otherResponse = await app.request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "OpenCode",
        adapter: "opencode",
        executable: "opencode",
        supportedProtocols: ["openai-responses"],
        capabilities: ["coding"],
      }),
    });
    const other = (await otherResponse.json()) as { harness: { id: string } };

    const statusResponse = await app.request(`${endpoint}/status`);
    assert.equal(statusResponse.status, 200);
    const status = (await statusResponse.json()) as {
      statuses: Array<{ harnessId: string; state: string; version: string | null }>;
    };
    assert.deepEqual(status.statuses, [
      {
        harnessId: codex.harness.id,
        state: "installed",
        version: "codex-cli 0.162.1",
        workerImage: "local/engineering-team-controller:latest",
        message: "Codex is installed in local/engineering-team-controller:latest",
      },
      {
        harnessId: other.harness.id,
        state: "missing",
        version: null,
        workerImage: "local/engineering-team-controller:latest",
        message: "This harness is not installed in the Codex-first worker image",
      },
    ]);

    const preflightResponse = await app.request(`${endpoint}/${codex.harness.id}/preflight`, { method: "POST" });
    assert.equal(preflightResponse.status, 200);
    assert.deepEqual(await preflightResponse.json(), {
      preflight: {
        harnessId: codex.harness.id,
        state: "ready",
        version: "codex-cli 0.162.1",
        workerImage: "local/engineering-team-controller:latest",
        message: "Logged in using ChatGPT",
      },
    });

    const unsupportedResponse = await app.request(`${endpoint}/${other.harness.id}/preflight`, { method: "POST" });
    assert.equal(unsupportedResponse.status, 200);
    assert.equal(((await unsupportedResponse.json()) as { preflight: { state: string } }).preflight.state, "unsupported");

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("creates only protocol-compatible runtime profiles", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    const app = createApp(database, { workspaceRoot, workspaceName: "Customer Platform" });
    const createProjectResponse = await app.request("/api/projects/workspace", { method: "POST" });
    const project = (await createProjectResponse.json()) as { project: { id: string } };
    const projectBase = `/api/projects/${project.project.id}`;

    const backendResponse = await app.request(`${projectBase}/model-backends`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "RunPod DeepSeek",
        provider: "runpod",
        protocol: "openai-chat-completions",
        model: "deepseek-v3",
        baseUrl: "https://api.runpod.ai/v2/example/openai/v1",
        authMode: "api-key",
        credentialRef: "RUNPOD_API_KEY",
      }),
    });
    const backend = (await backendResponse.json()) as { backend: { id: string } };

    const harnessResponse = await app.request(`${projectBase}/harnesses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "OpenCode",
        adapter: "opencode",
        executable: "opencode",
        supportedProtocols: ["openai-chat-completions", "anthropic-messages"],
        capabilities: ["coding", "testing"],
      }),
    });
    const harness = (await harnessResponse.json()) as { harness: { id: string } };
    const runtimeEndpoint = `${projectBase}/runtime-profiles`;

    const createResponse = await app.request(runtimeEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "OpenCode + RunPod DeepSeek",
        codingHarnessId: harness.harness.id,
        modelBackendId: backend.backend.id,
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as {
      profile: { id: string; protocol: string; status: string };
    };
    assert.equal(created.profile.protocol, "openai-chat-completions");
    assert.equal(created.profile.status, "ready");

    const listResponse = await app.request(runtimeEndpoint);
    assert.equal(listResponse.status, 200);
    assert.equal(((await listResponse.json()) as { profiles: unknown[] }).profiles.length, 1);

    const assignmentEndpoint = `${projectBase}/agents/backend_developer/runtime`;
    const assignResponse = await app.request(assignmentEndpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codingHarnessId: harness.harness.id, modelBackendId: backend.backend.id }),
    });
    assert.equal(assignResponse.status, 200);
    assert.deepEqual(
      ((await assignResponse.json()) as { assignment: { codingHarnessId: string; modelBackendId: string } }).assignment,
      {
        agentRole: "backend_developer",
        codingHarnessId: harness.harness.id,
        modelBackendId: backend.backend.id,
        assignedAt: database.listAgentRuntimeAssignments(project.project.id)[0]?.assignedAt,
      },
    );
    const assignmentsResponse = await app.request(`${projectBase}/agent-runtime-assignments`);
    assert.equal(assignmentsResponse.status, 200);
    assert.deepEqual(
      ((await assignmentsResponse.json()) as { assignments: Array<{ agentRole: string; codingHarnessId: string; modelBackendId: string }> }).assignments
        .map(({ agentRole, codingHarnessId, modelBackendId }) => ({ agentRole, codingHarnessId, modelBackendId })),
      [{ agentRole: "backend_developer", codingHarnessId: harness.harness.id, modelBackendId: backend.backend.id }],
    );

    const inUseResponse = await app.request(
      `${projectBase}/model-backends/${backend.backend.id}`,
      { method: "DELETE" },
    );
    assert.equal(inUseResponse.status, 409);

    const incompatibleHarnessResponse = await app.request(`${projectBase}/harnesses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Claude Code",
        adapter: "claude-code",
        executable: "claude",
        supportedProtocols: ["anthropic-messages"],
        capabilities: ["coding"],
      }),
    });
    const incompatibleHarness = (await incompatibleHarnessResponse.json()) as { harness: { id: string } };
    const incompatibleResponse = await app.request(runtimeEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Invalid pairing",
        codingHarnessId: incompatibleHarness.harness.id,
        modelBackendId: backend.backend.id,
      }),
    });
    assert.equal(incompatibleResponse.status, 409);

    const updateResponse = await app.request(`${runtimeEndpoint}/${created.profile.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "OpenCode + RunPod DeepSeek",
        codingHarnessId: harness.harness.id,
        modelBackendId: backend.backend.id,
        enabled: false,
      }),
    });
    assert.equal(updateResponse.status, 200);
    assert.equal(((await updateResponse.json()) as { profile: { status: string } }).profile.status, "disabled");

    const disabledAssignResponse = await app.request(`${projectBase}/agents/frontend_developer/runtime`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codingHarnessId: incompatibleHarness.harness.id, modelBackendId: backend.backend.id }),
    });
    assert.equal(disabledAssignResponse.status, 409);

    const clearResponse = await app.request(assignmentEndpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codingHarnessId: null, modelBackendId: null }),
    });
    assert.equal(clearResponse.status, 200);
    assert.equal(((await clearResponse.json()) as { assignment: null }).assignment, null);

    const harnessOnlyResponse = await app.request(assignmentEndpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codingHarnessId: harness.harness.id, modelBackendId: null }),
    });
    assert.equal(harnessOnlyResponse.status, 200);
    assert.equal(
      ((await harnessOnlyResponse.json()) as { assignment: { codingHarnessId: string; modelBackendId: null } }).assignment.modelBackendId,
      null,
    );
    const clearPartialResponse = await app.request(assignmentEndpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codingHarnessId: null, modelBackendId: null }),
    });
    assert.equal(clearPartialResponse.status, 200);

    const deleteResponse = await app.request(`${runtimeEndpoint}/${created.profile.id}`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 204);
    const clearedAssignmentsResponse = await app.request(`${projectBase}/agent-runtime-assignments`);
    assert.deepEqual(
      ((await clearedAssignmentsResponse.json()) as { assignments: unknown[] }).assignments,
      [],
    );

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("opens a workspace with every detected sibling repository already attached", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    createGitRepository(workspaceRoot, "backend");
    createGitRepository(workspaceRoot, "frontend");
    createGitRepository(workspaceRoot, "etl");
    const app = createApp(database, { workspaceRoot, workspaceName: "Customer Platform" });

    const firstResponse = await app.request("/api/projects/workspace", { method: "POST" });
    assert.equal(firstResponse.status, 201);
    const first = (await firstResponse.json()) as {
      project: { id: string; name: string; repositories: Array<{ name: string }> };
    };
    assert.equal(first.project.name, "Customer Platform");
    assert.deepEqual(
      first.project.repositories.map((repository) => repository.name),
      ["backend", "etl", "frontend"],
    );
    assert.equal(database.getProjectSettings(first.project.id)?.setupStatus, "completed");

    const secondResponse = await app.request("/api/projects/workspace", { method: "POST" });
    assert.equal(secondResponse.status, 200);
    const second = (await secondResponse.json()) as {
      project: { id: string; repositories: Array<{ name: string }> };
    };
    assert.equal(second.project.id, first.project.id);
    assert.equal(second.project.repositories.length, 3);

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("does not expose the legacy Project Manager brain API", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    const app = createApp(database, { workspaceRoot, workspaceName: "Customer Platform" });
    const createResponse = await app.request("/api/projects/workspace", { method: "POST" });
    const created = (await createResponse.json()) as { project: { id: string } };
    const endpoint = `/api/projects/${created.project.id}/agents/project_manager/brain`;

    assert.equal((await app.request(endpoint)).status, 404);
    assert.equal((await app.request(endpoint, { method: "PUT" })).status, 404);

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("turns a Project Manager message into a validated proposed plan", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    createGitRepository(workspaceRoot, "backend");
    const app = createApp(database, {
      workspaceRoot,
      workspaceName: "Customer Platform",
      planningExecutor: {
        async execute(request) {
          const repositoryId = request.run.repositories[0]?.repositoryId;
          assert.ok(repositoryId);
          return {
            workerId: `worker-${request.run.runId}`,
            imageDigest: "sha256:test-worker",
            providerThreadId: "thread-test",
            proposal: {
              assistantMessage: "I mapped the goal into a small backend delivery plan.",
              objective: {
                title: "Add customer preferences",
                description: "Allow customers to save and retrieve notification preferences.",
              },
              tasks: [{
                key: "preferences-api",
                title: "Build preferences API",
                description: "Add persistence and authenticated endpoints.",
                assignedRole: "backend_developer",
                repositoryIds: [repositoryId],
                acceptanceCriteria: ["Preferences can be saved and retrieved"],
                dependsOn: [],
              }],
            },
            usage: { inputTokens: 120, outputTokens: 80 },
          };
        },
      },
    });
    const workspaceResponse = await app.request("/api/projects/workspace", { method: "POST" });
    const workspace = (await workspaceResponse.json()) as { project: { id: string } };
    const harnessResponse = await app.request(`/api/projects/${workspace.project.id}/harnesses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Codex",
        adapter: "codex",
        executable: "codex",
        supportedProtocols: ["openai-responses"],
        capabilities: ["planning", "coding"],
      }),
    });
    assert.equal(harnessResponse.status, 201);
    const harness = (await harnessResponse.json()) as { harness: { id: string } };
    const backendResponse = await app.request(`/api/projects/${workspace.project.id}/model-backends`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "OpenAI Codex",
        provider: "openai",
        protocol: "openai-responses",
        model: "gpt-5-codex",
        authMode: "api-key",
        credentialRef: "OPENAI_API_KEY",
      }),
    });
    assert.equal(backendResponse.status, 201);
    const backend = (await backendResponse.json()) as { backend: { id: string } };
    const assignmentResponse = await app.request(`/api/projects/${workspace.project.id}/agents/project_manager/runtime`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        codingHarnessId: harness.harness.id,
        modelBackendId: backend.backend.id,
      }),
    });
    assert.equal(assignmentResponse.status, 200);

    const messageResponse = await app.request(`/api/projects/${workspace.project.id}/agents/project_manager/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Let customers manage notification preferences." }),
    });
    assert.equal(messageResponse.status, 202);

    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    const state = database.getOrchestrationState(workspace.project.id);
    assert.equal(state?.runs[0]?.status, "completed");
    assert.equal(state?.tasks[0]?.title, "Build preferences API");
    assert.equal(state?.tasks[0]?.status, "draft");
    assert.deepEqual(state?.tasks[0]?.requiredChecks, { qa: true, codeReview: true, security: true });
    assert.equal(state?.approvals[0]?.status, "pending");
    assert.equal(state?.messages.at(-1)?.author, "agent");
    assert.match(state?.messages.at(-1)?.body ?? "", /sent the plan for your approval/);
    assert.equal(database.listRunEvents(state?.runs[0]?.id ?? "").at(-1)?.type, "run.completed");

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("runs an approval-gated orchestration workflow", async () => {
    const database = new TeamDatabase(":memory:");
    database.createProject({
      id: "project-1",
      name: "Builder",
      repository: {
        id: "repository-1",
        name: "builder",
        relativePath: "builder",
        defaultBranch: "main",
      },
    });
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    const app = createApp(database, { workspaceRoot });

    const planResponse = await app.request("/api/projects/project-1/plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: {
          title: "Deliver the dashboard",
          description: "Build a durable orchestration view.",
        },
        tasks: [
          {
            key: "design",
            title: "Design it",
            description: "Define the user flow.",
            assignedRole: "architect",
            acceptanceCriteria: ["The workflow is explicit"],
            dependsOn: [],
          },
          {
            key: "build",
            title: "Build it",
            description: "Implement the flow.",
            assignedRole: "frontend_developer",
            acceptanceCriteria: ["The UI can complete the flow"],
            dependsOn: ["design"],
          },
        ],
      }),
    });
    assert.equal(planResponse.status, 201);
    const plan = (await planResponse.json()) as {
      approval: { id: string; status: string };
      tasks: Array<{ id: string; status: string }>;
    };
    assert.equal(plan.approval.status, "pending");
    assert.ok(plan.tasks.every((task) => task.status === "draft"));

    const approvalResponse = await app.request(
      `/api/projects/project-1/approvals/${plan.approval.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approved", note: "Scope accepted" }),
      },
    );
    assert.equal(approvalResponse.status, 200);

    const stateResponse = await app.request("/api/projects/project-1/orchestration");
    assert.equal(stateResponse.status, 200);
    const stateBody = (await stateResponse.json()) as {
      state: { tasks: Array<{ id: string; status: string }> };
    };
    assert.deepEqual(
      stateBody.state.tasks.map((task) => task.status),
      ["ready", "blocked"],
    );

    const firstTaskId = stateBody.state.tasks[0]?.id;
    assert.ok(firstTaskId);
    for (const status of ["in_progress", "review", "completed"]) {
      const transitionResponse = await app.request(
        `/api/projects/project-1/tasks/${firstTaskId}/status`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );
      assert.equal(transitionResponse.status, 200);
    }
    const releasedStateResponse = await app.request(
      "/api/projects/project-1/orchestration",
    );
    const releasedStateBody = (await releasedStateResponse.json()) as {
      state: { tasks: Array<{ status: string }> };
    };
    assert.deepEqual(
      releasedStateBody.state.tasks.map((task) => task.status),
      ["completed", "ready"],
    );

    const invalidPlanResponse = await app.request("/api/projects/project-1/plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: { title: "Cycle", description: "This graph is invalid." },
        tasks: [
          {
            key: "one",
            title: "One",
            description: "",
            assignedRole: "tech_lead",
            acceptanceCriteria: ["Done"],
            dependsOn: ["two"],
          },
          {
            key: "two",
            title: "Two",
            description: "",
            assignedRole: "backend_developer",
            acceptanceCriteria: ["Done"],
            dependsOn: ["one"],
          },
        ],
      }),
    });
    assert.equal(invalidPlanResponse.status, 400);

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("starts an assigned task agent and moves successful work to review", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    const projectId = "11111111-1111-4111-8111-111111111111";
    const repositoryId = "22222222-2222-4222-8222-222222222222";
    createGitRepository(workspaceRoot, "backend");
    database.createProject({
      id: projectId,
      name: "Builder",
      repository: { id: repositoryId, name: "backend", relativePath: "backend", defaultBranch: "main" },
    });
    database.createCodingHarness(projectId, "harness-1", {
      name: "Codex",
      adapter: "codex",
      executable: "codex",
      supportedProtocols: ["openai-responses"],
      capabilities: ["coding", "testing"],
    });
    database.createModelBackend(projectId, "backend-1", {
      name: "ChatGPT",
      provider: "openai",
      protocol: "openai-responses",
      model: "gpt-test",
      authMode: "chatgpt",
    });
    database.assignAgentRuntime(projectId, "backend_developer", "harness-1", "backend-1");
    let applied = false;
    const app = createApp(database, {
      workspaceRoot,
      taskExecutor: {
        async executeTask(request) {
          assert.equal(request.run.agentRole, "backend_developer");
          assert.equal(request.run.permissions.filesystem, "workspace-write");
          return {
            workerId: `engineering-team-task-${request.run.runId}`,
            imageDigest: "sha256:test",
            providerThreadId: "thread-task",
            branches: [{ repositoryId, branch: "agent/test", sha: "abc123" }],
            result: {
              schemaVersion: 1,
              status: "completed",
              summary: "Implemented and tested the backend scaffold.",
              changedFiles: ["backend/package.json"],
              commits: [{ repositoryId, sha: "abc123" }],
              checks: [{ command: "npm test", status: "passed" }],
              acceptanceCriteria: [{ criterion: "Backend works", satisfied: true, evidence: "Tests pass" }],
              questions: [],
              risks: [],
              artifacts: ["git:agent/test"],
            },
          };
        },
        async applyTask(request) {
          applied = true;
          assert.equal(request.repositories[0]?.repositoryId, repositoryId);
          assert.equal(request.repositories[0]?.branch.startsWith("agent/"), true);
          assert.equal(request.repositories[0]?.sha, "abc123");
          return {
            applied: request.repositories.map((repository) => ({
              repositoryId: repository.repositoryId,
              branch: repository.branch,
              sha: repository.sha,
              targetBranch: "main",
            })),
          };
        },
      },
    });
    const planResponse = await app.request(`/api/projects/${projectId}/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: { title: "Backend", description: "Create the backend" },
        tasks: [{
          key: "backend",
          title: "Build backend",
          description: "Create the scaffold",
          assignedRole: "backend_developer",
          repositoryIds: [repositoryId],
          acceptanceCriteria: ["Backend works"],
          dependsOn: [],
        }],
      }),
    });
    const plan = (await planResponse.json()) as { approval: { id: string }; tasks: Array<{ id: string }> };
    await app.request(`/api/projects/${projectId}/approvals/${plan.approval.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    const startResponse = await app.request(`/api/projects/${projectId}/tasks/${plan.tasks[0]!.id}/runs`, { method: "POST" });
    assert.equal(startResponse.status, 202);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    const state = database.getOrchestrationState(projectId);
    assert.equal(state?.tasks[0]?.status, "review");
    assert.equal(state?.runs[0]?.status, "completed");
    assert.equal(state?.runs[0]?.result?.commits[0]?.sha, "abc123");

    const applyResponse = await app.request(`/api/projects/${projectId}/tasks/${plan.tasks[0]!.id}/apply`, { method: "POST" });
    const applyBody = await applyResponse.json();
    assert.equal(applyResponse.status, 200, JSON.stringify(applyBody));
    assert.equal(applied, true);
    assert.equal(database.getOrchestrationState(projectId)?.tasks[0]?.status, "completed");
    assert.equal(database.getOrchestrationState(projectId)?.runs[0]?.result?.artifacts.some((artifact) => artifact.startsWith("applied:agent/")), true);

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("completes reviewer tasks with evidence and no code commit", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    const projectId = "33333333-3333-4333-8333-333333333333";
    const repositoryId = "44444444-4444-4444-8444-444444444444";
    createGitRepository(workspaceRoot, "backend");
    database.createProject({
      id: projectId,
      name: "Builder",
      repository: { id: repositoryId, name: "backend", relativePath: "backend", defaultBranch: "main" },
    });
    database.createCodingHarness(projectId, "harness-review", {
      name: "Codex",
      adapter: "codex",
      executable: "codex",
      supportedProtocols: ["openai-responses"],
      capabilities: ["coding", "review", "testing"],
    });
    database.createModelBackend(projectId, "backend-review", {
      name: "ChatGPT",
      provider: "openai",
      protocol: "openai-responses",
      model: "gpt-test",
      authMode: "chatgpt",
    });
    database.assignAgentRuntime(projectId, "code_reviewer", "harness-review", "backend-review");
    const app = createApp(database, {
      workspaceRoot,
      taskExecutor: {
        async executeTask(request) {
          assert.equal(request.run.agentRole, "code_reviewer");
          return {
            workerId: `engineering-team-task-${request.run.runId}`,
            imageDigest: "sha256:test",
            providerThreadId: "thread-review",
            branches: [],
            result: {
              schemaVersion: 1,
              status: "completed",
              summary: "Reviewed the implementation; no changes required.",
              changedFiles: [],
              commits: [],
              checks: [{ command: "npm test", status: "passed" }],
              acceptanceCriteria: [{ criterion: "Implementation is verified", satisfied: true, evidence: "Tests pass" }],
              questions: [],
              risks: [],
              artifacts: [],
            },
          };
        },
        async applyTask() {
          throw new Error("Evidence-only runs must not be applied");
        },
      },
    });
    const planResponse = await app.request(`/api/projects/${projectId}/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: { title: "Review", description: "Verify the backend" },
        tasks: [{
          key: "review",
          title: "Review backend",
          description: "Run the checks",
          assignedRole: "code_reviewer",
          repositoryIds: [repositoryId],
          acceptanceCriteria: ["Implementation is verified"],
          dependsOn: [],
        }],
      }),
    });
    const plan = (await planResponse.json()) as { approval: { id: string }; tasks: Array<{ id: string }> };
    await app.request(`/api/projects/${projectId}/approvals/${plan.approval.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    const startResponse = await app.request(`/api/projects/${projectId}/tasks/${plan.tasks[0]!.id}/runs`, { method: "POST" });
    assert.equal(startResponse.status, 202);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(database.getOrchestrationState(projectId)?.tasks[0]?.status, "completed");
    const response = await app.request(`/api/projects/${projectId}/orchestration`);
    const body = await response.json() as { reviews: Array<{ state: string }> };
    assert.equal(body.reviews[0]?.state, "report-only");

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("creates and registers a new sibling repository", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    const app = createApp(database, { workspaceRoot });

    const response = await app.request("/api/projects/new", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Greenfield App",
        directoryName: "greenfield-app",
      }),
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      project: { id: string; name: string; repositories: Array<{ relativePath: string; defaultBranch: string }> };
    };
    assert.equal(body.project.name, "Greenfield App");
    const repository = body.project.repositories[0];
    assert.ok(repository);
    assert.equal(repository.relativePath, "greenfield-app");
    assert.equal(repository.defaultBranch, "main");

    const discoveryResponse = await app.request("/api/repositories/discover");
    const discovery = (await discoveryResponse.json()) as {
      repositories: Array<{ relativePath: string; registered: boolean; projectId: string | null }>;
    };
    assert.equal(discovery.repositories.length, 1);
    assert.equal(discovery.repositories[0]?.relativePath, "greenfield-app");
    assert.equal(discovery.repositories[0]?.registered, true);
    assert.equal(discovery.repositories[0]?.projectId, body.project.id);

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("attaches repository sections and queues messages for a specific agent", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    const app = createApp(database, { workspaceRoot, workspaceName: "Commerce Workspace" });

    const first = await app.request("/api/projects/workspace", { method: "POST" });
    const firstBody = (await first.json()) as { project: { id: string; name: string } };
    assert.equal(firstBody.project.name, "Commerce Workspace");

    const rename = await app.request(`/api/projects/${firstBody.project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Commerce" }),
    });
    assert.equal(rename.status, 200);

    const backend = await app.request(`/api/projects/${firstBody.project.id}/repositories/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directoryName: "backend" }),
    });
    assert.equal(backend.status, 201);

    await app.request("/api/projects/new", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Temporary", directoryName: "frontend" }),
    });
    const temporary = database.listProjects().find((project) => project.name === "Temporary");
    assert.ok(temporary);
    database.connection.prepare("DELETE FROM projects WHERE id = ?").run(temporary.id);

    const attach = await app.request(`/api/projects/${firstBody.project.id}/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relativePath: "frontend" }),
    });
    assert.equal(attach.status, 201);
    const attachBody = (await attach.json()) as { project: { repositories: Array<{ id: string; name: string }> } };
    assert.deepEqual(attachBody.project.repositories.map((repository) => repository.name), ["backend", "frontend"]);

    const frontendRepository = attachBody.project.repositories.find((repository) => repository.name === "frontend");
    assert.ok(frontendRepository);
    const configure = await app.request(`/api/projects/${firstBody.project.id}/repositories/${frontendRepository.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "Customer-facing web application", enabled: false }),
    });
    assert.equal(configure.status, 200);
    const configured = database.getProject(firstBody.project.id)?.repositories.find((repository) => repository.id === frontendRepository.id);
    assert.equal(configured?.description, "Customer-facing web application");
    assert.equal(configured?.enabled, false);

    rmSync(join(workspaceRoot, "frontend"), { recursive: true, force: true });
    const refreshed = await app.request("/api/projects/workspace", { method: "POST" });
    const refreshedBody = (await refreshed.json()) as {
      project: { repositories: Array<{ name: string; relativePath: string; available: boolean }> };
    };
    const missingFrontend = refreshedBody.project.repositories.find((repository) => repository.name === "frontend");
    assert.equal(missingFrontend?.relativePath, "frontend");
    assert.equal(missingFrontend?.available, false);

    const sent = await app.request(`/api/projects/${firstBody.project.id}/agents/architect/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Check the application boundary." }),
    });
    assert.equal(sent.status, 201);
    assert.equal(database.getOrchestrationState(firstBody.project.id)?.messages[0]?.body, "Check the application boundary.");

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});
