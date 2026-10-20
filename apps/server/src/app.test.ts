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
        fallbackCodingHarnessId: null,
        fallbackModelBackendId: null,
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
      body: JSON.stringify({ codingHarnessId: null, modelBackendId: null, fallbackCodingHarnessId: null, fallbackModelBackendId: null }),
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

  it("remembers Project Manager directives and applies them to later planning", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    createGitRepository(workspaceRoot, "backend");
    let execution = 0;
    const app = createApp(database, {
      workspaceRoot,
      workspaceName: "Customer Platform",
      planningExecutor: {
        async execute(request) {
          execution += 1;
          const repositoryId = request.run.repositories[0]?.repositoryId;
          assert.ok(repositoryId);
          assert.match(request.projectContext, /customer-facing platform/);
          assert.match(request.repositoryContexts.find((context) => context.repositoryId === repositoryId)?.content ?? "", /backend owns authenticated APIs/);
          if (execution === 1) {
            assert.equal(request.run.agentInstructions, "Plan the smallest practical delivery without inventing ceremony.");
            assert.equal(request.directives.length, 0);
            assert.match(request.conversation.at(-1)?.body ?? "", /From now on/);
            return {
              workerId: `worker-${request.run.runId}`,
              imageDigest: "sha256:test-worker",
              providerThreadId: "thread-directive",
              proposal: {
                assistantMessage: "Understood. I will keep verification on implementation tickets.",
                intent: "directive_update",
                directiveActions: [{
                  action: "add",
                  directiveId: null,
                  content: "Represent QA, code review, and security as required checks instead of separate tickets.",
                }],
                consultationRequests: [],
                contextUpdates: [],
                objective: null,
                tasks: [],
              },
            };
          }
          if (execution === 2) {
            assert.deepEqual(request.availableConsultants, ["architect", "tech_lead"]);
            assert.equal(request.consultationResults.length, 0);
            return {
              workerId: `worker-${request.run.runId}`,
              imageDigest: "sha256:test-worker",
              providerThreadId: "thread-consult",
              proposal: {
                assistantMessage: "I am checking the architecture and delivery approach before drafting tickets.",
                intent: "consultation",
                directiveActions: [],
                consultationRequests: [
                  { agentRole: "architect", question: "What boundaries and contracts should this feature preserve?" },
                  { agentRole: "tech_lead", question: "What implementation sequence and verification should the plan use?" },
                ],
                contextUpdates: [],
                objective: null,
                tasks: [],
              },
            };
          }
          assert.equal(request.directives.length, 1);
          assert.match(request.directives[0]?.content ?? "", /required checks/);
          assert.deepEqual(request.consultationResults.map((result) => result.agentRole), ["architect", "tech_lead"]);
          assert.equal(request.consultationResults.find((result) => result.agentRole === "architect")?.contextUpdates.length, 1);
          return {
            workerId: `worker-${request.run.runId}`,
            imageDigest: "sha256:test-worker",
            providerThreadId: "thread-test",
            proposal: {
              assistantMessage: "I mapped the goal into a small backend delivery plan.",
              intent: "plan",
              directiveActions: [],
              consultationRequests: [],
              contextUpdates: [{
                repositoryId,
                content: "# Backend\n\nThe backend owns authenticated APIs and customer notification preferences.",
                reason: "Record the newly planned ownership of notification preferences.",
              }],
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
        async consult(request) {
          assert.equal(request.requestingRole, "project_manager");
          assert.equal(request.run.permissions.filesystem, "read-only");
          assert.match(request.run.agentInstructions ?? "", request.run.agentRole === "architect" ? /system boundaries/ : /executable engineering approach/);
          assert.match(request.projectContext, /customer-facing platform/);
          assert.match(request.repositoryContexts[0]?.content ?? "", /backend owns authenticated APIs/);
          return {
            workerId: `consultant-${request.run.runId}`,
            imageDigest: "sha256:test-worker",
            providerThreadId: `thread-${request.run.agentRole}`,
            response: request.run.agentRole === "architect"
              ? "Keep preferences behind the existing authenticated backend boundary."
              : "Implement persistence first, then endpoints, then focused integration tests.",
            contextUpdates: request.run.agentRole === "architect" ? [{
              repositoryId: request.repositoryContexts[0]!.repositoryId,
              content: "# Backend\n\nThe backend owns authenticated APIs and customer notification preferences.",
              reason: "Record the architectural ownership established by this plan.",
            }] : [],
          };
        },
      },
    });
    const workspaceResponse = await app.request("/api/projects/workspace", { method: "POST" });
    const workspace = (await workspaceResponse.json()) as { project: { id: string; repositories: Array<{ id: string }> } };
    const repositoryId = workspace.project.repositories[0]?.id;
    assert.ok(repositoryId);
    assert.equal((await app.request(`/api/projects/${workspace.project.id}/context`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# Product\n\nA customer-facing platform." }),
    })).status, 200);
    assert.equal((await app.request(`/api/projects/${workspace.project.id}/repositories/${repositoryId}/context`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# Backend\n\nThe backend owns authenticated APIs." }),
    })).status, 200);
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
    for (const consultantRole of ["architect", "tech_lead"] as const) {
      const consultantAssignment = await app.request(`/api/projects/${workspace.project.id}/agents/${consultantRole}/runtime`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codingHarnessId: harness.harness.id, modelBackendId: backend.backend.id }),
      });
      assert.equal(consultantAssignment.status, 200);
    }

    const configurationResponse = await app.request(`/api/projects/${workspace.project.id}/agents/project_manager/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rolePrompt: "Plan the smallest practical delivery without inventing ceremony." }),
    });
    assert.equal(configurationResponse.status, 200);

    const directiveResponse = await app.request(`/api/projects/${workspace.project.id}/agents/project_manager/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "From now on, keep verification on implementation tickets." }),
    });
    assert.equal(directiveResponse.status, 202);

    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    let state = database.getOrchestrationState(workspace.project.id);
    assert.equal(state?.tasks.length, 0);
    assert.equal(state?.directives.length, 1);
    assert.equal(state?.runs.find((run) => run.agentRole === "project_manager")?.status, "completed");

    const messageResponse = await app.request(`/api/projects/${workspace.project.id}/agents/project_manager/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Let customers manage notification preferences." }),
    });
    assert.equal(messageResponse.status, 202);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    state = database.getOrchestrationState(workspace.project.id);
    assert.equal(state?.runs.filter((run) => ["project_manager", "architect", "tech_lead"].includes(run.agentRole)).every((run) => run.status === "completed"), true);
    assert.equal(state?.runs.filter((run) => ["architect", "tech_lead"].includes(run.agentRole)).length, 2);
    assert.equal(state?.tasks[0]?.title, "Build preferences API");
    assert.equal(state?.tasks[0]?.status, "draft");
    assert.equal(state?.proposedContextUpdates[0]?.status, "pending");
    assert.doesNotMatch(state?.contexts.find((document) => document.repositoryId === repositoryId)?.content ?? "", /notification preferences/);
    assert.deepEqual(state?.tasks[0]?.requiredChecks, { qa: true, codeReview: true, security: true });
    assert.equal(state?.approvals[0]?.status, "pending");
    assert.equal(state?.messages.at(-1)?.author, "agent");
    assert.match(state?.messages.at(-1)?.body ?? "", /sent the plan for your approval/);
    assert.equal(database.listRunEvents(state?.runs[0]?.id ?? "").at(-1)?.type, "run.completed");

    const approvalId = state?.approvals[0]?.id;
    assert.ok(approvalId);
    const approvalResponse = await app.request(`/api/projects/${workspace.project.id}/approvals/${approvalId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    assert.equal(approvalResponse.status, 200);
    state = database.getOrchestrationState(workspace.project.id);
    assert.equal(state?.proposedContextUpdates[0]?.status, "applied");
    assert.match(state?.contexts.find((document) => document.repositoryId === repositoryId)?.content ?? "", /notification preferences/);
    assert.equal(state?.contextRevisions.filter((revision) => revision.repositoryId === repositoryId).length, 2);

    const directiveId = state?.directives[0]?.id;
    assert.ok(directiveId);
    const removeResponse = await app.request(`/api/projects/${workspace.project.id}/agents/project_manager/directives/${directiveId}`, { method: "DELETE" });
    assert.equal(removeResponse.status, 204);
    assert.equal(database.getOrchestrationState(workspace.project.id)?.directives.length, 0);

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
    database.createModelBackend(projectId, "backend-fallback", {
      name: "API fallback",
      provider: "openai",
      protocol: "openai-responses",
      model: "gpt-fallback",
      authMode: "api-key",
      credentialRef: "OPENAI_API_KEY",
    });
    database.assignAgentRuntime(projectId, "backend_developer", "harness-1", "backend-1", "harness-1", "backend-fallback");
    database.assignAgentRuntime(projectId, "release_manager", "harness-1", "backend-1");
    let applied = false;
    const app = createApp(database, {
      workspaceRoot,
      taskExecutor: {
        async executeTask(request, onEvent) {
          if (request.run.runPurpose === "release") {
            assert.equal(request.run.agentRole, "release_manager");
            return {
              workerId: `engineering-team-task-${request.run.runId}`, imageDigest: "sha256:test", providerThreadId: "thread-release", branches: [],
              result: {
                schemaVersion: 1, status: "completed", summary: "Ready to integrate.", changedFiles: [], commits: [],
                checks: [{ command: "release assessment", status: "passed" }],
                acceptanceCriteria: request.run.acceptanceCriteria.map((criterion) => ({ criterion, satisfied: true, evidence: "Verified evidence is complete" })),
                questions: [], risks: [], artifacts: [],
              },
            };
          }
          assert.equal(request.run.agentRole, "backend_developer");
          if (request.run.brainProfile.model === "gpt-test") throw new Error("429 quota limit reached");
          assert.equal(request.run.brainProfile.model, "gpt-fallback");
          assert.match(request.run.agentInstructions ?? "", /reliable backend behavior/);
          assert.equal(request.run.permissions.filesystem, "workspace-write");
          onEvent?.({
            type: "command.started",
            message: "Running: npm test",
            payload: { command: "npm test" },
            createdAt: new Date().toISOString(),
          });
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
          requiredChecks: { qa: false, codeReview: false, security: false },
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
    for (let index = 0; index < 20 && database.getOrchestrationState(projectId)?.tasks[0]?.status !== "review"; index += 1) {
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
    }
    const state = database.getOrchestrationState(projectId);
    assert.equal(state?.tasks[0]?.status, "review", JSON.stringify({ runs: state?.runs.map((run) => ({ role: run.agentRole, status: run.status, purpose: run.spec.runPurpose, result: run.result?.summary })), messages: state?.messages.slice(-3) }));
    assert.equal(state?.runs.every((run) => run.status === "completed"), true);
    const implementationRun = state?.runs.find((run) => run.spec.runPurpose === "implementation");
    assert.equal(implementationRun?.result?.commits[0]?.sha, "abc123");
    assert.equal(database.listRunEvents(implementationRun!.id).some((event) => event.type === "runtime.fallback" && event.message?.includes("gpt-fallback")), true);
    assert.equal(database.listRunEvents(implementationRun!.id).some((event) => event.type === "command.started" && event.message === "Running: npm test"), true);
    const integrationApproval = state?.approvals.find((approval) => approval.type === "integration");
    assert.equal(integrationApproval?.status, "pending");
    const directApplyResponse = await app.request(`/api/projects/${projectId}/tasks/${plan.tasks[0]!.id}/apply`, { method: "POST" });
    assert.equal(directApplyResponse.status, 409);
    assert.equal(applied, false);

    const applyResponse = await app.request(`/api/projects/${projectId}/approvals/${integrationApproval!.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approved" }),
    });
    const applyBody = await applyResponse.json();
    assert.equal(applyResponse.status, 200, JSON.stringify(applyBody));
    assert.equal(applied, true);
    assert.equal(database.getOrchestrationState(projectId)?.tasks[0]?.status, "completed");
    assert.equal(database.getOrchestrationState(projectId)?.runs.find((run) => run.spec.runPurpose === "implementation")?.result?.artifacts.some((artifact) => artifact.startsWith("applied:agent/")), true);

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("cancels an active task worker and preserves a resumable workflow", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const repositoryId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const taskId = "task-cancel";
    const runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    createGitRepository(workspaceRoot, "backend");
    database.createProject({
      id: projectId,
      name: "Cancellation",
      repository: { id: repositoryId, name: "backend", relativePath: "backend", defaultBranch: "main" },
    });
    const plan = database.createPlan({
      projectId,
      objective: { id: "objective-cancel", title: "Cancellation", description: "Exercise cancellation." },
      tasks: [{
        id: taskId,
        key: "cancel",
        title: "Long-running backend task",
        description: "Keep running until cancelled.",
        assignedRole: "backend_developer",
        repositoryIds: [repositoryId],
        acceptanceCriteria: ["Cancellation is recoverable"],
        requiredChecks: { qa: true, codeReview: true, security: true },
        dependsOn: [],
      }],
      approvalId: "approval-cancel",
    });
    database.decideApproval(projectId, plan.approval.id, "approved", null);
    database.updateTaskStatus(projectId, taskId, "in_progress");
    const profile = database.createBrainProfile({
      id: "profile-cancel",
      projectId,
      name: "Cancellation profile",
      provider: "openai",
      harness: "codex",
      modelClass: "coding",
      credentialRef: "CODEX_ACCESS_TOKEN",
      model: "gpt-test",
      configuration: {},
    });
    database.createAgentRun(profile.id, {
      schemaVersion: 1,
      runId,
      projectId,
      taskId,
      agentRole: "backend_developer",
      runPurpose: "implementation",
      brainProfile: { provider: "openai", harness: "codex", modelClass: "coding", credentialRef: "CODEX_ACCESS_TOKEN", model: "gpt-test" },
      repositories: [{ repositoryId, checkoutPath: "/workspace/repos/01-backend", baseCommit: "unborn" }],
      objective: "Cancellation",
      taskDescription: "Keep running until cancelled.",
      acceptanceCriteria: ["Cancellation is recoverable"],
      permissions: { filesystem: "workspace-write", networkPolicy: "model-provider-only", allowedTools: ["run_tests"] },
      limits: { timeoutSeconds: 900, retries: 1 },
      verificationRound: 0,
      upstreamArtifacts: [],
    });
    database.createRunAttempt({ id: "attempt-cancel", runId, attemptNumber: 1 });
    database.markRunAttemptRunning("attempt-cancel", `engineering-team-task-${runId}`, "sha256:test");
    database.acquireTaskLease({
      taskId,
      runId,
      leaseToken: "lease-cancel",
      acquiredAt: "2026-10-20T00:00:00.000Z",
      heartbeatAt: "2026-10-20T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const stoppedRuns: string[] = [];
    const app = createApp(database, {
      workspaceRoot,
      taskExecutor: {
        async executeTask() { throw new Error("Not used"); },
        async applyTask() { throw new Error("Not used"); },
        async stopTaskWorker(stoppedRunId) { stoppedRuns.push(stoppedRunId); },
      },
    });

    const response = await app.request(`/api/projects/${projectId}/tasks/${taskId}/cancel`, { method: "POST" });
    const body = await response.json() as { workerStopped: boolean; recovery: { taskId: string; projectId: string; stage: string; interruptedRunId: string } };
    assert.equal(response.status, 200);
    assert.equal(body.workerStopped, true);
    assert.deepEqual(stoppedRuns, [runId]);
    assert.equal(database.getAgentRun(runId)?.status, "cancelled");
    assert.equal(database.listRunEvents(runId).at(-1)?.type, "run.cancelled");
    assert.equal(body.recovery.taskId, taskId);
    assert.equal(body.recovery.projectId, projectId);
    assert.equal(body.recovery.interruptedRunId, runId);
    assert.equal(body.recovery.stage, "implementation");
    assert.throws(() => database.releaseTaskLease("lease-cancel"), /Task lease not found/);

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("redirects an active task and restarts it with Director guidance", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    const projectId = "12121212-1212-4212-8212-121212121212";
    const repositoryId = "34343434-3434-4434-8434-343434343434";
    const taskId = "task-redirect";
    const interruptedRunId = "56565656-5656-4656-8656-565656565656";
    createGitRepository(workspaceRoot, "backend");
    database.createProject({ id: projectId, name: "Redirect", repository: { id: repositoryId, name: "backend", relativePath: "backend", defaultBranch: "main" } });
    database.createCodingHarness(projectId, "harness-redirect", {
      name: "Codex", adapter: "codex", executable: "codex", supportedProtocols: ["openai-responses"], capabilities: ["coding", "testing"],
    });
    database.createModelBackend(projectId, "backend-redirect", {
      name: "ChatGPT", provider: "openai", protocol: "openai-responses", model: "gpt-test", authMode: "chatgpt",
    });
    database.assignAgentRuntime(projectId, "backend_developer", "harness-redirect", "backend-redirect");
    database.assignAgentRuntime(projectId, "release_manager", "harness-redirect", "backend-redirect");
    const plan = database.createPlan({
      projectId,
      objective: { id: "objective-redirect", title: "Redirect", description: "Change direction safely." },
      tasks: [{ id: taskId, key: "redirect", title: "Implement API", description: "Build the endpoint.", assignedRole: "backend_developer", repositoryIds: [repositoryId], acceptanceCriteria: ["API works"], requiredChecks: { qa: false, codeReview: false, security: false }, dependsOn: [] }],
      approvalId: "approval-redirect",
    });
    database.decideApproval(projectId, plan.approval.id, "approved", null);
    database.updateTaskStatus(projectId, taskId, "in_progress");
    const profile = database.createBrainProfile({ id: "profile-redirect", projectId, name: "Redirect profile", provider: "openai", harness: "codex", modelClass: "coding", credentialRef: "CODEX_ACCESS_TOKEN", model: "gpt-test", configuration: {} });
    database.createAgentRun(profile.id, {
      schemaVersion: 1, runId: interruptedRunId, projectId, taskId, agentRole: "backend_developer", runPurpose: "implementation",
      brainProfile: { provider: "openai", harness: "codex", modelClass: "coding", credentialRef: "CODEX_ACCESS_TOKEN", model: "gpt-test" },
      repositories: [{ repositoryId, checkoutPath: "/workspace/repos/01-backend", baseCommit: "unborn" }], objective: "Redirect", taskDescription: "Build the endpoint.", acceptanceCriteria: ["API works"], upstreamArtifacts: [],
      permissions: { filesystem: "workspace-write", networkPolicy: "model-provider-only", allowedTools: ["run_tests"] }, limits: { timeoutSeconds: 900, retries: 1 },
    });
    database.createRunAttempt({ id: "attempt-redirect", runId: interruptedRunId, attemptNumber: 1 });
    database.markRunAttemptRunning("attempt-redirect", `engineering-team-task-${interruptedRunId}`, "sha256:test");
    database.acquireTaskLease({ taskId, runId: interruptedRunId, leaseToken: "lease-redirect", acquiredAt: "2026-10-20T00:00:00.000Z", heartbeatAt: "2026-10-20T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" });
    const stoppedRuns: string[] = [];
    const observedGuidance: string[] = [];
    const app = createApp(database, {
      workspaceRoot,
      taskExecutor: {
        async executeTask(request) {
          if (request.run.directorGuidance) observedGuidance.push(request.run.directorGuidance);
          if (request.run.runPurpose === "release") return {
            workerId: `engineering-team-task-${request.run.runId}`, imageDigest: "sha256:test", providerThreadId: null, branches: [],
            result: { schemaVersion: 1, status: "completed", summary: "Ready to integrate.", changedFiles: [], commits: [], checks: [{ command: "release", status: "passed" }], acceptanceCriteria: request.run.acceptanceCriteria.map((criterion) => ({ criterion, satisfied: true, evidence: "Verified" })), questions: [], risks: [], artifacts: [] },
          };
          return {
            workerId: `engineering-team-task-${request.run.runId}`, imageDigest: "sha256:test", providerThreadId: null,
            branches: [{ repositoryId, branch: "agent/redirected", sha: "redirect123" }],
            result: { schemaVersion: 1, status: "completed", summary: "Implemented with Director guidance.", changedFiles: ["backend/api.ts"], commits: [{ repositoryId, sha: "redirect123" }], checks: [{ command: "npm test", status: "passed" }], acceptanceCriteria: [{ criterion: "API works", satisfied: true, evidence: "Tests pass" }], questions: [], risks: [], artifacts: [] },
          };
        },
        async applyTask() { throw new Error("Not used"); },
        async stopTaskWorker(runId) { stoppedRuns.push(runId); },
      },
    });
    const guidance = "Keep the public API backwards compatible and use the existing authentication middleware.";
    const response = await app.request(`/api/projects/${projectId}/tasks/${taskId}/redirect`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guidance }),
    });
    assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.deepEqual(stoppedRuns, [interruptedRunId]);
    assert.equal(database.getAgentRun(interruptedRunId)?.status, "cancelled");
    assert.equal(observedGuidance.includes(guidance), true);
    const replacement = database.listAgentRunsForTask(projectId, taskId).find((run) => run.id !== interruptedRunId && run.spec.runPurpose === "implementation");
    assert.equal(replacement?.spec.directorGuidance, guidance);
    assert.equal(database.getTaskWorkflowRecovery(projectId, taskId), null);
    assert.match(database.getOrchestrationState(projectId)?.messages.find((message) => message.author === "director")?.body ?? "", /backwards compatible/);

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("cancels an active direct agent conversation", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    const projectId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const repositoryId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const runId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    createGitRepository(workspaceRoot, "backend");
    database.createProject({ id: projectId, name: "Chat cancellation", repository: { id: repositoryId, name: "backend", relativePath: "backend", defaultBranch: "main" } });
    const profile = database.createBrainProfile({
      id: "profile-chat-cancel", projectId, name: "Architect chat", provider: "openai", harness: "codex", modelClass: "planning",
      credentialRef: "CODEX_ACCESS_TOKEN", model: "gpt-test", configuration: {},
    });
    database.createAgentRun(profile.id, {
      schemaVersion: 1, runId, projectId, agentRole: "architect", runPurpose: "consultation",
      brainProfile: { provider: "openai", harness: "codex", modelClass: "planning", credentialRef: "CODEX_ACCESS_TOKEN", model: "gpt-test" },
      repositories: [{ repositoryId, checkoutPath: "/workspace/repos/01-backend", baseCommit: "unborn" }],
      objective: "Discuss architecture", taskDescription: "Answer the Director", acceptanceCriteria: ["Return advice"],
      upstreamArtifacts: ["director-message:test"], permissions: { filesystem: "read-only", networkPolicy: "model-provider-only", allowedTools: ["inspect_repository", "respond_to_request"] },
      limits: { timeoutSeconds: 900, retries: 1 },
    });
    database.createRunAttempt({ id: "attempt-chat-cancel", runId, attemptNumber: 1 });
    database.markRunAttemptRunning("attempt-chat-cancel", `engineering-team-consultation-${runId}`, "sha256:test");
    const stoppedRuns: string[] = [];
    const app = createApp(database, {
      workspaceRoot,
      planningExecutor: {
        async execute() { throw new Error("Not used"); },
        async stopAgentWorker(stoppedRunId) { stoppedRuns.push(stoppedRunId); },
      },
    });
    const response = await app.request(`/api/projects/${projectId}/agents/architect/runs/${runId}/cancel`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(stoppedRuns, [runId]);
    assert.equal(database.getAgentRun(runId)?.status, "cancelled");
    assert.equal(database.listRunEvents(runId).at(-1)?.type, "run.cancelled");
    assert.match(database.getOrchestrationState(projectId)?.messages.at(-1)?.body ?? "", /Cancelled by the Engineering Director/);

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("runs required checks, repairs failures, and applies only the verified commit", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    const projectId = "55555555-5555-4555-8555-555555555555";
    const repositoryId = "66666666-6666-4666-8666-666666666666";
    createGitRepository(workspaceRoot, "backend");
    database.createProject({
      id: projectId,
      name: "Builder",
      repository: { id: repositoryId, name: "backend", relativePath: "backend", defaultBranch: "main" },
    });
    database.createCodingHarness(projectId, "harness-gates", {
      name: "Codex",
      adapter: "codex",
      executable: "codex",
      supportedProtocols: ["openai-responses"],
      capabilities: ["coding", "review", "testing"],
    });
    database.createModelBackend(projectId, "backend-gates", {
      name: "ChatGPT",
      provider: "openai",
      protocol: "openai-responses",
      model: "gpt-test",
      authMode: "chatgpt",
    });
    for (const role of ["backend_developer", "qa_engineer", "code_reviewer", "security_reviewer", "release_manager"] as const) {
      database.assignAgentRuntime(projectId, role, "harness-gates", "backend-gates");
    }
    const calls: Array<{ purpose: string | undefined; check: string | undefined; role: string; baseCommit: string }> = [];
    let qaRuns = 0;
    let appliedSha = "";
    const app = createApp(database, {
      workspaceRoot,
      taskExecutor: {
        async executeTask(request) {
          calls.push({ purpose: request.run.runPurpose, check: request.run.verificationCheck, role: request.run.agentRole, baseCommit: request.run.repositories[0]!.baseCommit });
          if (request.run.runPurpose === "verification") {
            const failed = request.run.verificationCheck === "qa" && qaRuns++ === 0;
            return {
              workerId: `engineering-team-task-${request.run.runId}`,
              imageDigest: "sha256:test",
              providerThreadId: `thread-${request.run.verificationCheck}`,
              branches: [],
              result: {
                schemaVersion: 1,
                status: failed ? "failed" as const : "completed" as const,
                summary: failed ? "The regression test fails." : `${request.run.verificationCheck} passed.`,
                changedFiles: [],
                commits: [],
                checks: [{ command: request.run.verificationCheck ?? "verify", status: failed ? "failed" as const : "passed" as const }],
                acceptanceCriteria: request.run.acceptanceCriteria.map((criterion) => ({ criterion, satisfied: !failed, evidence: failed ? "Regression reproduced" : "Verified" })),
                questions: [],
                risks: failed ? ["Blocking regression"] : [],
                artifacts: [],
              },
            };
          }
          if (request.run.runPurpose === "release") {
            return {
              workerId: `engineering-team-task-${request.run.runId}`, imageDigest: "sha256:test", providerThreadId: "thread-release", branches: [],
              result: {
                schemaVersion: 1, status: "completed", summary: "Verified commit is ready for integration.", changedFiles: [], commits: [],
                checks: [{ command: "release assessment", status: "passed" }],
                acceptanceCriteria: request.run.acceptanceCriteria.map((criterion) => ({ criterion, satisfied: true, evidence: "Release evidence checked" })),
                questions: [], risks: [], artifacts: [],
              },
            };
          }
          const repaired = request.run.runPurpose === "repair";
          const sha = repaired ? "repair456" : "initial123";
          return {
            workerId: `engineering-team-task-${request.run.runId}`,
            imageDigest: "sha256:test",
            providerThreadId: repaired ? "thread-repair" : "thread-implementation",
            branches: [{ repositoryId, branch: repaired ? "agent/repaired" : "agent/initial", sha }],
            result: {
              schemaVersion: 1,
              status: "completed",
              summary: repaired ? "Repaired the regression." : "Implemented the feature.",
              changedFiles: ["backend/index.ts"],
              commits: [{ repositoryId, sha }],
              checks: [{ command: "npm test", status: "passed" }],
              acceptanceCriteria: [{ criterion: "Backend works", satisfied: true, evidence: "Tests pass" }],
              questions: [],
              risks: [],
              artifacts: [`git:${repaired ? "agent/repaired" : "agent/initial"}`],
            },
          };
        },
        async applyTask(request) {
          appliedSha = request.repositories[0]!.sha;
          return { applied: request.repositories.map((repository) => ({ repositoryId: repository.repositoryId, branch: repository.branch, sha: repository.sha, targetBranch: "main" })) };
        },
      },
    });
    const planResponse = await app.request(`/api/projects/${projectId}/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: { title: "Verified backend", description: "Implement and verify the backend" },
        tasks: [{
          key: "backend",
          title: "Build verified backend",
          description: "Create the behavior",
          assignedRole: "backend_developer",
          repositoryIds: [repositoryId],
          acceptanceCriteria: ["Backend works"],
          requiredChecks: { qa: true, codeReview: true, security: true },
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
    const taskId = plan.tasks[0]!.id;
    const startResponse = await app.request(`/api/projects/${projectId}/tasks/${taskId}/runs`, { method: "POST" });
    assert.equal(startResponse.status, 202);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    const state = database.getOrchestrationState(projectId);
    assert.equal(state?.tasks[0]?.status, "review");
    assert.deepEqual(calls.map((call) => call.purpose), ["implementation", "verification", "verification", "verification", "repair", "verification", "verification", "verification", "release"]);
    assert.deepEqual(calls.filter((call) => call.purpose === "verification").map((call) => call.check), ["qa", "code_review", "security", "qa", "code_review", "security"]);
    assert.equal(calls[1]?.baseCommit, "initial123");
    assert.equal(calls[5]?.baseCommit, "repair456");
    assert.equal(state?.runs.filter((run) => run.spec.runPurpose === "verification").length, 6);
    assert.equal(state?.runs.find((run) => run.spec.runPurpose === "repair")?.result?.commits[0]?.sha, "repair456");

    const workflowResponse = await app.request(`/api/projects/${projectId}/tasks/${taskId}/workflow`);
    assert.equal(workflowResponse.status, 200);
    const workflow = await workflowResponse.json() as {
      task: { id: string };
      runs: Array<{ run: { spec: { runPurpose?: string } }; attempts: unknown[]; events: unknown[]; artifacts: unknown[]; usage: unknown[] }>;
    };
    assert.equal(workflow.task.id, taskId);
    assert.equal(workflow.runs.length, 9);
    assert.equal(workflow.runs.every((run) => run.attempts.length === 1 && run.events.length >= 5), true);
    assert.equal(workflow.runs.filter((run) => run.run.spec.runPurpose === "verification").length, 6);

    const integrationApproval = database.getOrchestrationState(projectId)?.approvals.find((approval) => approval.type === "integration" && approval.taskId === taskId);
    assert.equal(integrationApproval?.status, "pending");
    const applyResponse = await app.request(`/api/projects/${projectId}/approvals/${integrationApproval!.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approved" }),
    });
    assert.equal(applyResponse.status, 200);
    assert.equal(appliedSha, "repair456");
    assert.equal(database.getOrchestrationState(projectId)?.tasks[0]?.status, "completed");

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("resumes interrupted verification without repeating checks that already passed", async () => {
    const database = new TeamDatabase(":memory:");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engineering-team-api-"));
    const projectId = "77777777-7777-4777-8777-777777777777";
    const repositoryId = "88888888-8888-4888-8888-888888888888";
    createGitRepository(workspaceRoot, "backend");
    database.createProject({ id: projectId, name: "Recovery", repository: { id: repositoryId, name: "backend", relativePath: "backend", defaultBranch: "main" } });
    database.createCodingHarness(projectId, "harness-recovery", {
      name: "Codex", adapter: "codex", executable: "codex", supportedProtocols: ["openai-responses"], capabilities: ["coding", "review", "testing"],
    });
    database.createModelBackend(projectId, "backend-recovery", {
      name: "ChatGPT", provider: "openai", protocol: "openai-responses", model: "gpt-test", authMode: "chatgpt",
    });
    for (const role of ["backend_developer", "qa_engineer", "code_reviewer", "security_reviewer", "release_manager"] as const) {
      database.assignAgentRuntime(projectId, role, "harness-recovery", "backend-recovery");
    }
    const plan = database.createPlan({
      projectId,
      objective: { id: "objective-resume", title: "Resume", description: "Resume interrupted verification." },
      tasks: [{
        id: "task-resume", key: "resume", title: "Resume checks", description: "Verify once.", assignedRole: "backend_developer",
        repositoryIds: [repositoryId], acceptanceCriteria: ["All checks pass"], requiredChecks: { qa: true, codeReview: true, security: true }, dependsOn: [],
      }],
      approvalId: "approval-resume",
    });
    database.decideApproval(projectId, plan.approval.id, "approved", null);
    database.updateTaskStatus(projectId, "task-resume", "in_progress");
    const profile = database.createBrainProfile({
      id: "profile-resume", projectId, name: "Resume profile", provider: "openai", harness: "codex", modelClass: "coding",
      credentialRef: "CODEX_ACCESS_TOKEN", model: "gpt-test", configuration: {},
    });
    const baseCommit = "unborn";
    const baseSpec = {
      schemaVersion: 1 as const,
      projectId,
      taskId: "task-resume",
      brainProfile: { provider: "openai", harness: "codex", modelClass: "coding", credentialRef: "CODEX_ACCESS_TOKEN", model: "gpt-test" },
      repositories: [{ repositoryId, checkoutPath: "/workspace/repos/01-backend", baseCommit }],
      objective: "Resume interrupted verification",
      taskDescription: "Implement and verify",
      acceptanceCriteria: ["All checks pass"],
      permissions: { filesystem: "workspace-write" as const, networkPolicy: "model-provider-only", allowedTools: ["run_tests"] },
      limits: { timeoutSeconds: 900, retries: 1 },
    };
    const implementationSpec = { ...baseSpec, runId: "run-implementation-resume", agentRole: "backend_developer" as const, runPurpose: "implementation" as const, verificationRound: 0, upstreamArtifacts: [] };
    database.createAgentRun(profile.id, implementationSpec);
    database.createRunAttempt({ id: "attempt-implementation-resume", runId: implementationSpec.runId, attemptNumber: 1 });
    database.markRunAttemptRunning("attempt-implementation-resume", "worker-implementation", "sha256:test");
    database.completeAgentRun(implementationSpec.runId, "attempt-implementation-resume", {
      schemaVersion: 1, status: "completed", summary: "Implemented.", changedFiles: ["backend/index.js"], commits: [{ repositoryId, sha: "verified123" }],
      checks: [{ command: "npm test", status: "passed" }], acceptanceCriteria: [{ criterion: "All checks pass", satisfied: true, evidence: "Implementation test" }], questions: [], risks: [], artifacts: ["git:agent/task-resum-run-impl"],
    });
    const qaSpec = { ...baseSpec, runId: "run-qa-resume", agentRole: "qa_engineer" as const, runPurpose: "verification" as const, verificationCheck: "qa" as const, verificationRound: 0, repositories: [{ ...baseSpec.repositories[0]!, baseCommit: "verified123", integrationBaseCommit: baseCommit }], upstreamArtifacts: [`implementation-run:${implementationSpec.runId}`] };
    database.createAgentRun(profile.id, qaSpec);
    database.createRunAttempt({ id: "attempt-qa-resume", runId: qaSpec.runId, attemptNumber: 1 });
    database.markRunAttemptRunning("attempt-qa-resume", "worker-qa", "sha256:test");
    database.completeAgentRun(qaSpec.runId, "attempt-qa-resume", {
      schemaVersion: 1, status: "completed", summary: "QA passed.", changedFiles: [], commits: [], checks: [{ command: "qa", status: "passed" }],
      acceptanceCriteria: [{ criterion: "All checks pass", satisfied: true, evidence: "QA evidence" }], questions: [], risks: [], artifacts: [],
    });
    const reviewSpec = { ...qaSpec, runId: "run-review-resume", agentRole: "code_reviewer" as const, verificationCheck: "code_review" as const };
    database.createAgentRun(profile.id, reviewSpec);
    database.createRunAttempt({ id: "attempt-review-resume", runId: reviewSpec.runId, attemptNumber: 1 });
    database.markRunAttemptRunning("attempt-review-resume", "worker-review", "sha256:test");
    database.acquireTaskLease({
      taskId: "task-resume", runId: reviewSpec.runId, leaseToken: "lease-review-resume",
      acquiredAt: "2026-10-19T00:00:00.000Z", heartbeatAt: "2026-10-19T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    });
    database.reconcileInterruptedTaskRuns("2026-10-19T01:00:00.000Z", true);

    const resumedChecks: string[] = [];
    const app = createApp(database, {
      workspaceRoot,
      taskExecutor: {
        async executeTask(request) {
          if (request.run.runPurpose === "release") {
            return {
              workerId: "worker-release", imageDigest: "sha256:test", providerThreadId: null, branches: [],
              result: {
                schemaVersion: 1, status: "completed", summary: "Ready to integrate.", changedFiles: [], commits: [],
                checks: [{ command: "release assessment", status: "passed" }],
                acceptanceCriteria: request.run.acceptanceCriteria.map((criterion) => ({ criterion, satisfied: true, evidence: "Evidence complete" })),
                questions: [], risks: [], artifacts: [],
              },
            };
          }
          assert.equal(request.run.runPurpose, "verification");
          resumedChecks.push(request.run.verificationCheck ?? "");
          return {
            workerId: `worker-${request.run.verificationCheck}`, imageDigest: "sha256:test", providerThreadId: null, branches: [],
            result: {
              schemaVersion: 1, status: "completed", summary: `${request.run.verificationCheck} passed.`, changedFiles: [], commits: [],
              checks: [{ command: request.run.verificationCheck ?? "verify", status: "passed" }],
              acceptanceCriteria: request.run.acceptanceCriteria.map((criterion) => ({ criterion, satisfied: true, evidence: "Recovered check passed" })), questions: [], risks: [], artifacts: [],
            },
          };
        },
        async applyTask() { throw new Error("Not used"); },
      },
    });
    const resumeResponse = await app.request(`/api/projects/${projectId}/tasks/task-resume/resume`, { method: "POST" });
    assert.equal(resumeResponse.status, 202, JSON.stringify(await resumeResponse.clone().json()));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.deepEqual(resumedChecks, ["code_review", "security"]);
    const state = database.getOrchestrationState(projectId);
    assert.equal(state?.tasks[0]?.status, "review");
    assert.equal(state?.integrationProposals[0]?.status, "pending");
    assert.equal(state?.recoveries.length, 0);
    assert.equal(database.getAgentRun(reviewSpec.runId)?.status, "timed_out");
    assert.equal(database.listRunEvents(reviewSpec.runId).at(-1)?.type, "run.timed_out");

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
          requiredChecks: { qa: false, codeReview: false, security: false },
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

  it("attaches repository sections and runs a direct conversation with a specific agent", async () => {
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

    database.createCodingHarness(firstBody.project.id, "harness-chat", {
      name: "Codex", adapter: "codex", executable: "codex", supportedProtocols: ["openai-responses"], capabilities: ["planning", "coding"],
    });
    database.createModelBackend(firstBody.project.id, "backend-chat", {
      name: "ChatGPT", provider: "openai", protocol: "openai-responses", model: "gpt-test", authMode: "chatgpt",
    });
    database.assignAgentRuntime(firstBody.project.id, "architect", "harness-chat", "backend-chat");
    const conversationApp = createApp(database, {
      workspaceRoot,
      planningExecutor: {
        async execute() { throw new Error("Not used"); },
        async consult(request, onEvent) {
          assert.equal(request.requestingRole, "engineering_director");
          assert.equal(request.run.agentRole, "architect");
          assert.equal(request.run.permissions.filesystem, "read-only");
          assert.equal(request.repositorySources.length, 1);
          assert.equal(request.repositorySources[0]?.name, "backend");
          assert.match(request.conversation.at(-1)?.body ?? "", /application boundary/);
          onEvent?.({ type: "repository.inspected", message: "Inspected backend", payload: {}, createdAt: new Date().toISOString() });
          return {
            workerId: `engineering-team-consultation-${request.run.runId}`,
            imageDigest: "sha256:test",
            providerThreadId: "thread-architect",
            response: "Keep the API boundary in the backend and expose a versioned contract to the frontend.",
            directiveActions: [{ action: "add", directiveId: null, content: "Prefer versioned contracts at application boundaries." }],
            contextUpdates: [],
          };
        },
      },
    });
    const sent = await conversationApp.request(`/api/projects/${firstBody.project.id}/agents/architect/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Check the application boundary." }),
    });
    assert.equal(sent.status, 202);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    const conversationState = database.getOrchestrationState(firstBody.project.id);
    assert.deepEqual(conversationState?.messages.filter((message) => message.agentRole === "architect").map((message) => message.author), ["director", "agent"]);
    assert.match(conversationState?.messages.at(-1)?.body ?? "", /versioned contract/);
    assert.equal(conversationState?.directives.find((directive) => directive.agentRole === "architect")?.content, "Prefer versioned contracts at application boundaries.");
    const conversationRun = conversationState?.runs.find((run) => run.agentRole === "architect");
    assert.equal(conversationRun?.status, "completed");
    assert.equal(database.listRunEvents(conversationRun!.id).some((event) => event.type === "repository.inspected"), true);

    database.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});
