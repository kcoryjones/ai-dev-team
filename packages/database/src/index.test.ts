import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runContractSchemaVersion, type RunResult, type RunSpec } from "@engineering-team/contracts";
import { TeamDatabase } from "./index.js";
import { migrate } from "./migrations.js";

describe("TeamDatabase", () => {
  it("persists a project and its repository as one transaction", () => {
    const database = new TeamDatabase(":memory:");

    const created = database.createProject({
      id: "project-1",
      name: "Builder",
      repository: {
        id: "repository-1",
        name: "builder",
        relativePath: "builder",
        defaultBranch: "main",
        remoteUrl: "git@example.com:team/builder.git",
        description: "Engineering team control plane",
        enabled: false,
        available: false,
      },
    });

    assert.equal(created.name, "Builder");
    assert.equal(created.repositories[0]?.defaultBranch, "main");
    assert.equal(created.repositories[0]?.relativePath, "builder");
    assert.equal(created.repositories[0]?.remoteUrl, "git@example.com:team/builder.git");
    assert.equal(created.repositories[0]?.description, "Engineering team control plane");
    assert.equal(created.repositories[0]?.enabled, false);
    assert.equal(created.repositories[0]?.available, false);
    assert.deepEqual(database.listProjects(), [created]);

    const event = database.connection
      .prepare("SELECT event_type FROM events WHERE project_id = ?")
      .get(created.id) as { event_type: string };
    assert.equal(event.event_type, "project.created");

    database.close();
  });

  it("persists an approval-gated task graph and releases dependencies", () => {
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

    const plan = database.createPlan({
      projectId: "project-1",
      objective: {
        id: "objective-1",
        title: "Ship durable planning",
        description: "Create an approval-gated task graph.",
      },
      tasks: [
        {
          id: "task-1",
          key: "design",
          title: "Design the contract",
          description: "Define the state transitions.",
          assignedRole: "architect",
          repositoryIds: ["repository-1"],
          acceptanceCriteria: ["Transitions are explicit"],
          dependsOn: [],
        },
        {
          id: "task-2",
          key: "implement",
          title: "Implement the contract",
          description: "Build the approved design.",
          assignedRole: "backend_developer",
          repositoryIds: ["repository-1"],
          acceptanceCriteria: ["Tests pass"],
          dependsOn: ["design"],
        },
      ],
      approvalId: "approval-1",
    });

    assert.equal(plan.objective.status, "draft");
    assert.ok(plan.tasks.every((task) => task.status === "draft"));
    assert.deepEqual(plan.tasks[0]?.requiredChecks, { qa: false, codeReview: false, security: false });
    assert.equal(plan.approval.status, "pending");

    database.decideApproval("project-1", "approval-1", "approved", "Proceed");
    let state = database.getOrchestrationState("project-1");
    assert.equal(state?.objectives[0]?.status, "active");
    assert.equal(state?.tasks.find((task) => task.id === "task-1")?.status, "ready");
    assert.equal(state?.tasks.find((task) => task.id === "task-2")?.status, "blocked");

    database.updateTaskStatus("project-1", "task-1", "in_progress");
    database.updateTaskStatus("project-1", "task-1", "review");
    database.updateTaskStatus("project-1", "task-1", "completed");
    state = database.getOrchestrationState("project-1");
    assert.equal(state?.tasks.find((task) => task.id === "task-2")?.status, "ready");

    database.updateTaskStatus("project-1", "task-2", "in_progress");
    database.updateTaskStatus("project-1", "task-2", "review");
    database.updateTaskStatus("project-1", "task-2", "completed");
    state = database.getOrchestrationState("project-1");
    assert.equal(state?.objectives[0]?.status, "completed");

    database.requeueTask("project-1", "task-2");
    state = database.getOrchestrationState("project-1");
    assert.equal(state?.tasks.find((task) => task.id === "task-2")?.status, "ready");
    assert.equal(state?.objectives[0]?.status, "active");

    const events = database.connection
      .prepare("SELECT event_type FROM events WHERE project_id = ? ORDER BY id")
      .all("project-1") as Array<{ event_type: string }>;
    assert.ok(events.some((event) => event.event_type === "plan.created"));
    assert.ok(events.some((event) => event.event_type === "approval.decided"));
    assert.ok(events.some((event) => event.event_type === "task.requeued"));
    assert.equal(
      events.filter((event) => event.event_type === "task.status_changed").length,
      6,
    );

    database.close();
  });

  it("groups repositories into one project and persists per-agent messages", () => {
    const database = new TeamDatabase(":memory:");
    database.createProject({
      id: "project-1",
      name: "Commerce Suite",
      repository: {
        id: "repository-backend",
        name: "backend",
        relativePath: "backend",
        defaultBranch: "main",
      },
    });

    const project = database.addRepository("project-1", {
      id: "repository-frontend",
      name: "frontend",
      relativePath: "frontend",
      defaultBranch: "main",
    });
    assert.deepEqual(project.repositories.map((repository) => repository.name), ["backend", "frontend"]);

    const message = database.createAgentMessage({
      id: "message-1",
      projectId: "project-1",
      agentRole: "architect",
      author: "director",
      body: "Review the boundary between these sections.",
    });
    assert.equal(message.agentRole, "architect");
    assert.deepEqual(database.getOrchestrationState("project-1")?.messages, [message]);

    database.close();
  });

  it("creates and updates one durable settings record per project", () => {
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

    const defaults = database.getProjectSettings("project-1");
    assert.ok(defaults);
    assert.equal(defaults.setupStatus, "not_started");
    assert.equal(defaults.setupCompletedAt, null);
    assert.equal(defaults.defaultRunTimeoutSeconds, 900);
    assert.equal(defaults.defaultRunRetries, 1);
    assert.equal(defaults.defaultTokenBudget, null);
    assert.equal(defaults.defaultCostBudgetCents, null);
    assert.equal(defaults.planningNetworkPolicy, "model-provider-only");
    assert.equal(defaults.requirePlanApproval, true);

    const completed = database.updateProjectSettings("project-1", {
      setupStatus: "completed",
      defaultRunTimeoutSeconds: 1_200,
      defaultRunRetries: 2,
      defaultTokenBudget: 25_000,
      defaultCostBudgetCents: 500,
      planningNetworkPolicy: "restricted",
      requirePlanApproval: false,
    });
    assert.equal(completed.setupStatus, "completed");
    assert.ok(completed.setupCompletedAt);
    assert.equal(completed.defaultTokenBudget, 25_000);
    assert.equal(completed.requirePlanApproval, false);

    const reopened = database.updateProjectSettings("project-1", {
      setupStatus: "in_progress",
      defaultTokenBudget: null,
      defaultCostBudgetCents: null,
    });
    assert.equal(reopened.setupCompletedAt, null);
    assert.equal(reopened.defaultTokenBudget, null);
    assert.equal(reopened.defaultCostBudgetCents, null);

    const event = database.connection
      .prepare(
        `SELECT payload_json FROM events
         WHERE project_id = ? AND event_type = 'project.settings_updated'
         ORDER BY id DESC LIMIT 1`,
      )
      .get("project-1") as { payload_json: string };
    assert.deepEqual(
      (JSON.parse(event.payload_json) as { changedFields: string[] }).changedFields.sort(),
      ["defaultCostBudgetCents", "defaultTokenBudget", "setupStatus"].sort(),
    );
    database.close();
  });

  it("persists reusable model backend configurations without storing secrets", () => {
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

    const created = database.createModelBackend("project-1", "backend-1", {
      name: "RunPod DeepSeek",
      provider: "runpod",
      protocol: "openai-chat-completions",
      model: "deepseek-v3",
      baseUrl: "https://api.runpod.ai/v2/example/openai/v1",
      authMode: "api-key",
      credentialRef: "RUNPOD_API_KEY",
    });
    assert.equal(created.model, "deepseek-v3");
    assert.equal(created.credentialRef, "RUNPOD_API_KEY");
    assert.deepEqual(database.listModelBackends("project-1"), [created]);

    const updated = database.updateModelBackend("project-1", "backend-1", {
      name: "RunPod DeepSeek",
      provider: "runpod",
      protocol: "openai-responses",
      model: "deepseek-v3.1",
      baseUrl: "https://api.runpod.ai/v2/example/openai/v1",
      authMode: "api-key",
      credentialRef: "RUNPOD_API_KEY",
      enabled: false,
    });
    assert.equal(updated.protocol, "openai-responses");
    assert.equal(updated.enabled, false);

    database.deleteModelBackend("project-1", "backend-1");
    assert.deepEqual(database.listModelBackends("project-1"), []);
    const eventTypes = database.connection
      .prepare("SELECT event_type FROM events WHERE project_id = ? ORDER BY id")
      .all("project-1") as Array<{ event_type: string }>;
    assert.ok(eventTypes.some((event) => event.event_type === "model_backend.created"));
    assert.ok(eventTypes.some((event) => event.event_type === "model_backend.updated"));
    assert.ok(eventTypes.some((event) => event.event_type === "model_backend.deleted"));

    database.close();
  });

  it("persists coding harnesses and their compatibility declarations", () => {
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

    const created = database.createCodingHarness("project-1", "harness-1", {
      name: "Codex CLI",
      adapter: "codex",
      executable: "codex",
      containerImage: "local/engineering-team-codex:latest",
      supportedProtocols: ["openai-responses"],
      capabilities: ["planning", "coding", "review"],
    });
    assert.equal(created.adapter, "codex");
    assert.deepEqual(created.supportedProtocols, ["openai-responses"]);
    assert.deepEqual(database.listCodingHarnesses("project-1"), [created]);

    const updated = database.updateCodingHarness("project-1", "harness-1", {
      name: "Codex CLI",
      adapter: "codex",
      executable: "/usr/local/bin/codex",
      containerImage: "local/engineering-team-codex:latest",
      supportedProtocols: ["openai-responses", "openai-chat-completions"],
      capabilities: ["planning", "coding", "review", "testing"],
      enabled: false,
    });
    assert.equal(updated.executable, "/usr/local/bin/codex");
    assert.equal(updated.enabled, false);

    database.deleteCodingHarness("project-1", "harness-1");
    assert.deepEqual(database.listCodingHarnesses("project-1"), []);
    const eventTypes = database.connection
      .prepare("SELECT event_type FROM events WHERE project_id = ? ORDER BY id")
      .all("project-1") as Array<{ event_type: string }>;
    assert.ok(eventTypes.some((event) => event.event_type === "coding_harness.created"));
    assert.ok(eventTypes.some((event) => event.event_type === "coding_harness.updated"));
    assert.ok(eventTypes.some((event) => event.event_type === "coding_harness.deleted"));

    database.close();
  });

  it("pairs compatible harnesses and model backends into runtime profiles", () => {
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
    database.createModelBackend("project-1", "backend-1", {
      name: "RunPod DeepSeek",
      provider: "runpod",
      protocol: "openai-chat-completions",
      model: "deepseek-v3",
      baseUrl: "https://api.runpod.ai/v2/example/openai/v1",
      authMode: "api-key",
      credentialRef: "RUNPOD_API_KEY",
    });
    database.createCodingHarness("project-1", "harness-1", {
      name: "OpenCode",
      adapter: "opencode",
      executable: "opencode",
      supportedProtocols: ["openai-chat-completions", "anthropic-messages"],
      capabilities: ["coding", "testing"],
    });

    const created = database.createRuntimeProfile("project-1", "runtime-1", {
      name: "OpenCode + RunPod DeepSeek",
      codingHarnessId: "harness-1",
      modelBackendId: "backend-1",
    });
    assert.equal(created.protocol, "openai-chat-completions");
    assert.equal(created.status, "ready");
    assert.deepEqual(database.listRuntimeProfiles("project-1"), [created]);

    const assignment = database.assignAgentRuntime(
      "project-1",
      "backend_developer",
      "harness-1",
      "backend-1",
    );
    assert.equal(assignment?.codingHarnessId, "harness-1");
    assert.equal(assignment?.modelBackendId, "backend-1");
    assert.deepEqual(
      database.listAgentRuntimeAssignments("project-1").map(({ agentRole, codingHarnessId, modelBackendId }) => ({ agentRole, codingHarnessId, modelBackendId })),
      [{ agentRole: "backend_developer", codingHarnessId: "harness-1", modelBackendId: "backend-1" }],
    );

    assert.throws(
      () => database.updateCodingHarness("project-1", "harness-1", {
        name: "OpenCode",
        adapter: "opencode",
        executable: "opencode",
        supportedProtocols: ["anthropic-messages"],
        capabilities: ["coding"],
      }),
      /every attached or assigned model backend/,
    );
    assert.throws(
      () => database.deleteModelBackend("project-1", "backend-1"),
      /FOREIGN KEY/,
    );

    database.updateCodingHarness("project-1", "harness-1", {
      name: "OpenCode",
      adapter: "opencode",
      executable: "opencode",
      supportedProtocols: ["openai-chat-completions", "anthropic-messages"],
      capabilities: ["coding", "testing"],
      enabled: false,
    });
    assert.equal(database.getRuntimeProfile("project-1", "runtime-1")?.status, "disabled");
    assert.throws(
      () => database.assignAgentRuntime("project-1", "frontend_developer", "harness-1", "backend-1"),
      /enabled harnesses and model backends/,
    );

    database.updateRuntimeProfile("project-1", "runtime-1", {
      name: "OpenCode + RunPod DeepSeek",
      codingHarnessId: "harness-1",
      modelBackendId: "backend-1",
      enabled: false,
    });
    database.deleteRuntimeProfile("project-1", "runtime-1");
    database.deleteModelBackend("project-1", "backend-1");
    database.deleteCodingHarness("project-1", "harness-1");
    assert.deepEqual(database.listRuntimeProfiles("project-1"), []);
    assert.deepEqual(database.listAgentRuntimeAssignments("project-1"), []);

    database.close();
  });

  it("repairs databases whose recorded orchestration migration lacks task ordering", () => {
    const database = new TeamDatabase(":memory:");
    database.connection.exec("ALTER TABLE tasks DROP COLUMN sort_order");
    database.connection.prepare("DELETE FROM schema_migrations WHERE version = 4").run();

    migrate(database.connection);

    const columns = database.connection.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "sort_order"));
    assert.equal(
      (database.connection.prepare("SELECT name FROM schema_migrations WHERE version = 4").get() as { name: string }).name,
      "repair_legacy_task_sort_order",
    );
    database.close();
  });

  it("backfills default settings when an existing database upgrades", () => {
    const database = new TeamDatabase(":memory:");
    database.createWorkspaceProject("project-1", "Existing Project");
    database.connection.exec("DROP TABLE project_settings");
    database.connection.prepare("DELETE FROM schema_migrations WHERE version = 6").run();

    migrate(database.connection);

    assert.equal(database.getProjectSettings("project-1")?.setupStatus, "not_started");
    assert.equal(
      (database.connection.prepare("SELECT name FROM schema_migrations WHERE version = 6").get() as { name: string }).name,
      "project_setup_and_execution_settings",
    );
    database.close();
  });

  it("persists provider-neutral brain profiles, runs, events, evidence, and usage", () => {
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
    database.createPlan({
      projectId: "project-1",
      objective: {
        id: "objective-1",
        title: "Connect the project manager",
        description: "Turn a conversation into proposed work.",
      },
      tasks: [{
        id: "task-1",
        key: "runtime",
        title: "Create the runtime foundation",
        description: "Persist provider-neutral execution state.",
        assignedRole: "backend_developer",
        repositoryIds: ["repository-1"],
        acceptanceCriteria: ["Run evidence survives restart"],
        dependsOn: [],
      }],
      approvalId: "approval-1",
    });

    const profile = database.createBrainProfile({
      id: "brain-codex-planning",
      projectId: "project-1",
      name: "Codex planning",
      provider: "openai",
      harness: "codex",
      modelClass: "planning",
      credentialRef: "secret://openai/project-manager",
      reasoningLevel: "high",
      configuration: { sandbox: "read-only" },
    });
    database.assignBrainProfile("project-1", "project_manager", profile.id);
    assert.equal(
      database.getBrainProfileForRole("project-1", "project_manager")?.id,
      profile.id,
    );
    const updatedProfile = database.updateBrainProfile({
      ...profile,
      name: "Codex PM planning",
      model: "gpt-5-codex",
      reasoningLevel: "medium",
      credentialRef: "OPENAI_API_KEY",
      configuration: { filesystemAccess: "read-only", requiresPlanApproval: true },
    });
    assert.equal(updatedProfile.name, "Codex PM planning");
    assert.equal(updatedProfile.model, "gpt-5-codex");
    assert.equal(
      database.getBrainProfileForRole("project-1", "project_manager")?.credentialRef,
      "OPENAI_API_KEY",
    );

    const spec: RunSpec = {
      schemaVersion: runContractSchemaVersion,
      runId: "run-1",
      projectId: "project-1",
      taskId: "task-1",
      agentRole: "project_manager",
      brainProfile: {
        provider: "openai",
        harness: "codex",
        modelClass: "planning",
        credentialRef: "OPENAI_API_KEY",
        model: "gpt-5-codex",
        reasoningLevel: "medium",
      },
      repositories: [{
        repositoryId: "repository-1",
        checkoutPath: "/workspace/repos/builder",
        baseCommit: "abc123",
      }],
      objective: "Create tickets from a director conversation",
      taskDescription: "Propose a validated task plan.",
      acceptanceCriteria: ["Tickets appear in Proposed"],
      upstreamArtifacts: [],
      permissions: {
        filesystem: "read-only",
        networkPolicy: "model-provider-only",
        allowedTools: ["propose_task_plan"],
      },
      limits: { timeoutSeconds: 300, retries: 1, tokenBudget: 20_000 },
    };

    assert.equal(database.createAgentRun(profile.id, spec).status, "queued");
    assert.equal(
      database.createRunAttempt({
        id: "attempt-1",
        runId: spec.runId,
        attemptNumber: 1,
      }).status,
      "provisioning",
    );
    assert.equal(
      database.markRunAttemptRunning(
        "attempt-1",
        "container-1",
        "sha256:image",
        "provider-thread-1",
      ).status,
      "running",
    );

    const timestamp = new Date().toISOString();
    database.appendRunEvent({
      schemaVersion: runContractSchemaVersion,
      id: "run-event-1",
      runId: spec.runId,
      attemptId: "attempt-1",
      sequence: 0,
      type: "worker.started",
      message: "Worker started",
      payload: { containerId: "container-1" },
      createdAt: timestamp,
    });
    assert.equal(database.listRunEvents(spec.runId)[0]?.type, "worker.started");

    const lease = database.acquireTaskLease({
      taskId: "task-1",
      runId: spec.runId,
      leaseToken: "lease-1",
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(
      database.heartbeatTaskLease(
        lease.leaseToken,
        "2026-10-12T00:01:00.000Z",
        "2099-01-01T00:01:00.000Z",
      ).heartbeatAt,
      "2026-10-12T00:01:00.000Z",
    );

    database.createRunArtifact({
      id: "artifact-1",
      runId: spec.runId,
      attemptId: "attempt-1",
      kind: "report",
      name: "plan.json",
      storagePath: "/artifacts/run-1/plan.json",
      mediaType: "application/json",
      metadata: { schemaVersion: 1 },
    });
    database.recordRunUsage({
      id: "usage-1",
      runId: spec.runId,
      attemptId: "attempt-1",
      provider: "openai",
      model: "configured-at-runtime",
      inputTokens: 100,
      cachedInputTokens: 25,
      outputTokens: 50,
      reasoningOutputTokens: 10,
      costCents: 1.25,
      durationMs: 2_000,
    });

    const result: RunResult = {
      schemaVersion: runContractSchemaVersion,
      status: "completed",
      summary: "A plan was proposed.",
      changedFiles: [],
      commits: [],
      checks: [],
      acceptanceCriteria: [{
        criterion: "Tickets appear in Proposed",
        satisfied: true,
        evidence: "plan.json",
      }],
      questions: [],
      risks: [],
      artifacts: ["artifact-1"],
      usage: { inputTokens: 100, outputTokens: 50, costCents: 1.25 },
    };
    const completed = database.completeAgentRun(spec.runId, "attempt-1", result);
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.result, result);
    assert.equal(completed.providerThreadId, "provider-thread-1");
    assert.equal(
      (database.connection.prepare("SELECT COUNT(*) AS count FROM run_artifacts").get() as { count: number }).count,
      1,
    );
    assert.equal(
      (database.connection.prepare("SELECT COUNT(*) AS count FROM run_usage").get() as { count: number }).count,
      1,
    );

    database.releaseTaskLease(lease.leaseToken);
    database.close();
  });

  it("prevents two agent runs from leasing the same task", () => {
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
    database.createPlan({
      projectId: "project-1",
      objective: { id: "objective-1", title: "One owner", description: "Lease a task once." },
      tasks: [{
        id: "task-1",
        key: "only",
        title: "Exclusive task",
        description: "Only one run can own this.",
        assignedRole: "backend_developer",
        repositoryIds: [],
        acceptanceCriteria: ["One lease"],
        dependsOn: [],
      }],
      approvalId: "approval-1",
    });
    const profile = database.createBrainProfile({
      id: "brain-1",
      projectId: "project-1",
      name: "Test brain",
      provider: "test",
      harness: "fake",
      modelClass: "test",
      credentialRef: "secret://test",
      configuration: {},
    });
    const makeSpec = (runId: string): RunSpec => ({
      schemaVersion: runContractSchemaVersion,
      runId,
      projectId: "project-1",
      taskId: "task-1",
      agentRole: "backend_developer",
      brainProfile: {
        provider: "test",
        harness: "fake",
        modelClass: "test",
        credentialRef: "secret://test",
      },
      repositories: [],
      objective: "Test leasing",
      taskDescription: "Lease once",
      acceptanceCriteria: ["One lease"],
      upstreamArtifacts: [],
      permissions: { filesystem: "read-only", networkPolicy: "offline", allowedTools: [] },
      limits: { timeoutSeconds: 30, retries: 0 },
    });
    database.createAgentRun(profile.id, makeSpec("run-1"));
    database.createAgentRun(profile.id, makeSpec("run-2"));
    const acquiredAt = new Date().toISOString();
    database.acquireTaskLease({
      taskId: "task-1",
      runId: "run-1",
      leaseToken: "lease-1",
      acquiredAt,
      heartbeatAt: acquiredAt,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.throws(
      () => database.acquireTaskLease({
        taskId: "task-1",
        runId: "run-2",
        leaseToken: "lease-2",
        acquiredAt,
        heartbeatAt: acquiredAt,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
      /UNIQUE constraint failed/,
    );
    database.heartbeatTaskLease(
      "lease-1",
      "2020-01-01T00:00:00.000Z",
      "2020-01-01T00:01:00.000Z",
    );
    assert.equal(
      database.acquireTaskLease({
        taskId: "task-1",
        runId: "run-2",
        leaseToken: "lease-2",
        acquiredAt,
        heartbeatAt: acquiredAt,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }).runId,
      "run-2",
    );
    database.close();
  });
});
