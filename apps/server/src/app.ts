import { randomUUID } from "node:crypto";
import { basename, relative, resolve } from "node:path";
import type {
  AddProjectRepositoryInput,
  ApplyCodingRunRequest,
  AgentRuntimeAssignmentSummary,
  AgentConsultationResult,
  AgentRole,
  ApiError,
  AssignAgentRuntimeInput,
  CodingHarnessInstallationSummary,
  CodingHarnessPreflightSummary,
  CodingRunRequest,
  CodingRunResponse,
  ConsultationRunRequest,
  CreateAgentMessageInput,
  CreateNewProjectInput,
  CreatePlanInput,
  CreatePlanResponse,
  CreateProjectRepositoryInput,
  CreateProjectInput,
  DecideApprovalInput,
  HealthResponse,
  OrchestrationState,
  SaveCodingHarnessInput,
  SaveRuntimeProfileInput,
  SaveModelBackendInput,
  PlanningRunRequest,
  RunEvent,
  RunResult,
  TaskReviewSummary,
  TaskWorkflowDetailResponse,
  VerificationCheck,
  RepositoryDiscoveryResponse,
  UpdateProjectInput,
  UpdateProjectRepositoryInput,
  UpdateProjectSettingsInput,
  UpdateAgentConfigurationInput,
  UpdateTaskStatusInput,
} from "@engineering-team/contracts";
import { agentRoles, runContractSchemaVersion } from "@engineering-team/contracts";
import type { TeamDatabase } from "@engineering-team/database";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { z } from "zod";
import type { HarnessInspector, PlanningExecutor, TaskExecutor } from "./planning.js";
import { createRepository, discoverRepositories, getRepositoryHead, inspectRepository, resolveRepositoryPath } from "./repository.js";

const validAgentRoles = [
  "project_manager",
  "architect",
  "tech_lead",
  "backend_developer",
  "frontend_developer",
  "devops_database_engineer",
  "qa_engineer",
  "code_reviewer",
  "security_reviewer",
  "release_manager",
] as const satisfies readonly AgentRole[];
const reportOnlyTaskRoles = new Set<AgentRole>(["qa_engineer", "code_reviewer", "security_reviewer"]);

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  repositoryPath: z.string().trim().min(1),
});

const createNewProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  directoryName: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(
      /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,62}[a-zA-Z0-9])?$/,
      "Use letters, numbers, dots, dashes, or underscores; start and end with a letter or number",
    ),
});

const requiredChecksSchema = z.object({
  qa: z.boolean(),
  codeReview: z.boolean(),
  security: z.boolean(),
}).strict().default({ qa: true, codeReview: true, security: true });

const planTaskSchema = z.object({
  key: z.string().trim().min(1).max(60).regex(/^[a-z0-9-]+$/),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).default(""),
  assignedRole: z.enum(validAgentRoles),
  repositoryIds: z.array(z.string().uuid()).max(20).default([]),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  requiredChecks: requiredChecksSchema,
  dependsOn: z.array(z.string().trim().min(1).max(60)).max(20),
});

const planContextUpdateSchema = z.object({
  repositoryId: z.string().uuid().nullable(),
  content: z.string().trim().min(1).max(30_000),
  reason: z.string().trim().min(1).max(2_000),
}).strict();
const planContextUpdatesSchema = z.array(planContextUpdateSchema).max(20).refine(
  (updates) => new Set(updates.map((update) => update.repositoryId ?? "project")).size === updates.length,
  "Only one context update may be proposed for each scope",
);

const createPlanSchema = z
  .object({
    objective: z.object({
      title: z.string().trim().min(1).max(160),
      description: z.string().trim().min(1).max(4_000),
    }),
    tasks: z.array(planTaskSchema).min(1).max(50),
    contextUpdates: planContextUpdatesSchema.default([]),
  })
  .superRefine((plan, context) => {
    const keys = new Set<string>();
    for (const [index, task] of plan.tasks.entries()) {
      if (keys.has(task.key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tasks", index, "key"],
          message: `Duplicate task key: ${task.key}`,
        });
      }
      keys.add(task.key);
    }
    for (const [index, task] of plan.tasks.entries()) {
      for (const dependency of task.dependsOn) {
        if (!keys.has(dependency)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tasks", index, "dependsOn"],
            message: `Unknown task dependency: ${dependency}`,
          });
        }
        if (dependency === task.key) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tasks", index, "dependsOn"],
            message: "A task cannot depend on itself",
          });
        }
      }
    }

    const taskByKey = new Map(plan.tasks.map((task) => [task.key, task]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycle = (key: string): boolean => {
      if (visiting.has(key)) return true;
      if (visited.has(key)) return false;
      visiting.add(key);
      const task = taskByKey.get(key);
      const cyclic = task?.dependsOn.some((dependency) => hasCycle(dependency)) ?? false;
      visiting.delete(key);
      visited.add(key);
      return cyclic;
    };
    if (plan.tasks.some((task) => hasCycle(task.key))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tasks"],
        message: "Task dependencies must not contain a cycle",
      });
    }
  });

const decideApprovalSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(2_000).optional(),
});

const updateTaskStatusSchema = z.object({
  status: z.enum(["in_progress", "review", "completed"]),
});

const addProjectRepositorySchema = z.object({
  relativePath: z.string().trim().min(1),
});

const createProjectRepositorySchema = z.object({
  directoryName: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(
      /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,62}[a-zA-Z0-9])?$/,
      "Use letters, numbers, dots, dashes, or underscores; start and end with a letter or number",
    ),
});

const updateProjectRepositorySchema = z.object({
  description: z.string().trim().max(2_000).optional(),
  enabled: z.boolean().optional(),
}).strict().refine(
  (input) => input.description !== undefined || input.enabled !== undefined,
  "Provide a description or enabled state",
);

const updateContextSchema = z.object({
  content: z.string().max(30_000),
}).strict();

const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

const updateProjectSettingsSchema = z
  .object({
    setupStatus: z.enum(["not_started", "in_progress", "completed"]).optional(),
    defaultRunTimeoutSeconds: z.number().int().min(30).max(86_400).optional(),
    defaultRunRetries: z.number().int().min(0).max(5).optional(),
    defaultTokenBudget: z.number().int().min(1).max(10_000_000).nullable().optional(),
    defaultCostBudgetCents: z.number().positive().max(1_000_000).nullable().optional(),
    planningNetworkPolicy: z.enum(["offline", "model-provider-only", "restricted"]).optional(),
    requirePlanApproval: z.boolean().optional(),
  })
  .strict()
  .refine((settings) => Object.keys(settings).length > 0, {
    message: "Provide at least one setting to update",
  });

const modelBackendUrlSchema = z.string().trim().url().max(2_000).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" || (
    url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  );
}, "Endpoint URL must use HTTPS unless it is a local endpoint");

const saveModelBackendSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    provider: z.enum(["openai", "anthropic", "runpod", "openrouter", "ollama", "custom"]),
    protocol: z.enum(["openai-responses", "openai-chat-completions", "anthropic-messages", "ollama"]),
    model: z.string().trim().min(1).max(160).optional(),
    baseUrl: modelBackendUrlSchema.optional(),
    authMode: z.enum(["chatgpt", "api-key", "none"]),
    credentialRef: z.string().trim().min(2).max(128).regex(
      /^[A-Z][A-Z0-9_]*$/,
      "Credential reference must be an environment variable name",
    ).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((backend, context) => {
    if (backend.authMode === "api-key" && !backend.credentialRef) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credentialRef"],
        message: "API key authentication requires a credential environment variable",
      });
    }
    if (backend.authMode !== "api-key" && backend.credentialRef) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credentialRef"],
        message: "Credential references are only used with API key authentication",
      });
    }
    if (backend.authMode === "chatgpt" && backend.provider !== "openai") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authMode"],
        message: "ChatGPT workspace authentication is only available for OpenAI backends",
      });
    }
    if (["runpod", "ollama", "custom"].includes(backend.provider) && !backend.baseUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseUrl"],
        message: `${backend.provider} backends require an endpoint URL`,
      });
    }
    if (backend.provider === "ollama" && backend.protocol !== "ollama") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["protocol"],
        message: "Ollama backends must use the Ollama protocol",
      });
    }
  });

const saveCodingHarnessSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    adapter: z.enum([
      "codex",
      "claude-code",
      "opencode",
      "pi",
      "deepseek-harness",
      "grok-build",
      "custom",
    ]),
    executable: z.string().trim().min(1).max(255).regex(
      /^[a-zA-Z0-9_./-]+$/,
      "Executable must be a binary name or path without shell arguments",
    ),
    containerImage: z.string().trim().min(1).max(255).regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$/,
      "Container image must be a valid image reference",
    ).optional(),
    supportedProtocols: z.array(z.enum([
      "openai-responses",
      "openai-chat-completions",
      "anthropic-messages",
      "ollama",
    ])).min(1).max(4),
    capabilities: z.array(z.enum([
      "planning",
      "coding",
      "review",
      "testing",
      "release",
    ])).min(1).max(5),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((harness, context) => {
    if (new Set(harness.supportedProtocols).size !== harness.supportedProtocols.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supportedProtocols"],
        message: "Supported protocols must not contain duplicates",
      });
    }
    if (new Set(harness.capabilities).size !== harness.capabilities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "Capabilities must not contain duplicates",
      });
    }
  });

const saveRuntimeProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  codingHarnessId: z.string().uuid(),
  modelBackendId: z.string().uuid(),
  enabled: z.boolean().optional(),
}).strict();

const assignAgentRuntimeSchema = z.object({
  codingHarnessId: z.string().uuid().nullable(),
  modelBackendId: z.string().uuid().nullable(),
  fallbackCodingHarnessId: z.string().uuid().nullable().optional(),
  fallbackModelBackendId: z.string().uuid().nullable().optional(),
}).strict();

const startTaskRunSchema = z.object({
  runtime: z.enum(["primary", "fallback"]).optional(),
}).strict();

const createAgentMessageSchema = z.object({
  body: z.string().trim().min(1).max(8_000),
});

const redirectTaskSchema = z.object({
  guidance: z.string().trim().min(1).max(8_000),
}).strict();

const updateAgentConfigurationSchema = z.object({
  rolePrompt: z.string().trim().min(1).max(8_000),
  consultationRoles: z.array(z.enum(agentRoles)).max(agentRoles.length).refine((roles) => new Set(roles).size === roles.length, "Consultation roles must be unique").optional(),
}).strict();

const directiveActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), directiveId: z.null(), content: z.string().trim().min(1).max(2_000) }).strict(),
  z.object({ action: z.literal("remove"), directiveId: z.string().uuid(), content: z.string().trim().min(1).max(2_000) }).strict(),
]);

const projectManagerResponseSchema = z.object({
  assistantMessage: z.string().trim().min(1).max(8_000),
  intent: z.enum(["conversation", "directive_update", "consultation", "plan"]),
  directiveActions: z.array(directiveActionSchema).max(20),
  consultationRequests: z.array(z.object({
    agentRole: z.enum(agentRoles),
    question: z.string().trim().min(1).max(2_000),
  }).strict()).max(5),
  contextUpdates: planContextUpdatesSchema,
  objective: z.object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(4_000),
  }).nullable(),
  tasks: z.array(planTaskSchema).max(50),
}).strict().superRefine((response, context) => {
  if (response.intent === "plan" && (!response.objective || response.tasks.length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["objective"], message: "A planning response requires an objective and at least one task" });
  }
  if (response.intent !== "plan" && (response.objective !== null || response.tasks.length > 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks"], message: "Only a planning response may contain an objective or tasks" });
  }
  if (response.intent !== "plan" && response.contextUpdates.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["contextUpdates"], message: "Only a planning response may propose context updates" });
  }
  if (response.intent === "consultation" && response.consultationRequests.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["consultationRequests"], message: "A consultation response requires at least one request" });
  }
  if (response.intent !== "consultation" && response.consultationRequests.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["consultationRequests"], message: "Only a consultation response may request consultations" });
  }
});

export interface AppOptions {
  workspaceRoot: string;
  workspaceName?: string;
  staticRoot?: string;
  planningExecutor?: PlanningExecutor;
  taskExecutor?: TaskExecutor;
  harnessInspector?: HarnessInspector;
}

export function createApp(database: TeamDatabase, options: AppOptions): Hono {
  const app = new Hono();

  app.onError((error, context) => {
    console.error("Unhandled API error", error);
    return context.json(
      {
        error: "internal_server_error",
        message: "The local orchestration service encountered an unexpected error. Check the server logs for details.",
      } satisfies ApiError,
      500,
    );
  });

  app.get("/api/health", (context) =>
    context.json({
      status: "ok",
      database: "connected",
      timestamp: new Date().toISOString(),
    } satisfies HealthResponse),
  );

  app.get("/api/projects", (context) =>
    context.json({ projects: database.listProjects() }),
  );

  app.post("/api/projects/workspace", (context) => {
    const existingProject = database.listProjects()[0] ?? null;
    let project = database.createWorkspaceProject(
      randomUUID(),
      options.workspaceName?.trim() || basename(options.workspaceRoot) || "Project",
    );
    const discoveredRepositories = discoverRepositories(options.workspaceRoot);
    const discoveredByPath = new Map(
      discoveredRepositories.map((repository) => [repository.relativePath, repository]),
    );
    for (const repository of project.repositories) {
      const inspected = discoveredByPath.get(repository.relativePath);
      database.refreshRepository(project.id, repository.id, {
        name: inspected?.name ?? repository.name,
        defaultBranch: inspected?.defaultBranch ?? repository.defaultBranch,
        remoteUrl: inspected?.remoteUrl ?? repository.remoteUrl,
        available: Boolean(inspected),
      });
    }
    const registeredPaths = new Set(
      database.listProjects().flatMap((candidate) =>
        candidate.repositories.map((repository) => repository.relativePath),
      ),
    );
    for (const repository of discoveredRepositories) {
      if (registeredPaths.has(repository.relativePath)) continue;
      project = database.addRepository(project.id, { id: randomUUID(), ...repository });
      registeredPaths.add(repository.relativePath);
    }
    project = database.getProject(project.id) ?? project;
    const settings = database.getProjectSettings(project.id);
    if (settings && settings.setupStatus !== "completed") {
      database.updateProjectSettings(project.id, { setupStatus: "completed" });
    }
    return context.json({ project }, existingProject ? 200 : 201);
  });

  app.patch("/api/projects/:projectId", async (context) => {
    let body: UpdateProjectInput;
    try {
      body = await context.req.json<UpdateProjectInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }
    const parsed = updateProjectSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        { error: "invalid_project", message: parsed.error.issues[0]?.message ?? "Invalid project" } satisfies ApiError,
        400,
      );
    }
    try {
      return context.json({ project: database.renameProject(context.req.param("projectId"), parsed.data.name) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to rename project";
      return context.json({ error: "project_not_found", message } satisfies ApiError, 404);
    }
  });

  app.get("/api/projects/:projectId/settings", (context) => {
    const settings = database.getProjectSettings(context.req.param("projectId"));
    if (!settings) {
      return context.json(
        { error: "project_not_found", message: "Project settings not found" } satisfies ApiError,
        404,
      );
    }
    return context.json({ settings });
  });

  app.patch("/api/projects/:projectId/settings", async (context) => {
    let body: UpdateProjectSettingsInput;
    try {
      body = await context.req.json<UpdateProjectSettingsInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }
    const parsed = updateProjectSettingsSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        {
          error: "invalid_project_settings",
          message: parsed.error.issues[0]?.message ?? "Invalid project settings",
        } satisfies ApiError,
        400,
      );
    }
    try {
      const settings = database.updateProjectSettings(
        context.req.param("projectId"),
        parsed.data as UpdateProjectSettingsInput,
      );
      return context.json({ settings });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update project settings";
      return context.json(
        { error: "project_not_found", message } satisfies ApiError,
        404,
      );
    }
  });

  app.get("/api/projects/:projectId/model-backends", (context) => {
    const projectId = context.req.param("projectId");
    if (!database.getProject(projectId)) {
      return context.json(
        { error: "project_not_found", message: "Project not found" } satisfies ApiError,
        404,
      );
    }
    return context.json({ backends: database.listModelBackends(projectId) });
  });

  app.post("/api/projects/:projectId/model-backends", async (context) => {
    const projectId = context.req.param("projectId");
    if (!database.getProject(projectId)) {
      return context.json(
        { error: "project_not_found", message: "Project not found" } satisfies ApiError,
        404,
      );
    }
    let body: SaveModelBackendInput;
    try {
      body = await context.req.json<SaveModelBackendInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }
    const parsed = saveModelBackendSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        { error: "invalid_model_backend", message: parsed.error.issues[0]?.message ?? "Invalid model backend" } satisfies ApiError,
        400,
      );
    }
    try {
      const backend = database.createModelBackend(
        projectId,
        randomUUID(),
        parsed.data as SaveModelBackendInput,
      );
      return context.json({ backend }, 201);
    } catch (error) {
      const message = error instanceof Error && error.message.includes("UNIQUE")
        ? "A model backend with this name already exists"
        : error instanceof Error ? error.message : "Unable to create model backend";
      return context.json(
        { error: "model_backend_not_created", message } satisfies ApiError,
        409,
      );
    }
  });

  app.put("/api/projects/:projectId/model-backends/:backendId", async (context) => {
    let body: SaveModelBackendInput;
    try {
      body = await context.req.json<SaveModelBackendInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }
    const parsed = saveModelBackendSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        { error: "invalid_model_backend", message: parsed.error.issues[0]?.message ?? "Invalid model backend" } satisfies ApiError,
        400,
      );
    }
    try {
      const backend = database.updateModelBackend(
        context.req.param("projectId"),
        context.req.param("backendId"),
        parsed.data as SaveModelBackendInput,
      );
      return context.json({ backend });
    } catch (error) {
      const message = error instanceof Error && error.message.includes("UNIQUE")
        ? "A model backend with this name already exists"
        : error instanceof Error ? error.message : "Unable to update model backend";
      const status = message === "Model backend not found" ? 404 : 409;
      return context.json(
        { error: "model_backend_not_updated", message } satisfies ApiError,
        status,
      );
    }
  });

  app.delete("/api/projects/:projectId/model-backends/:backendId", (context) => {
    try {
      database.deleteModelBackend(
        context.req.param("projectId"),
        context.req.param("backendId"),
      );
      return context.body(null, 204);
    } catch (error) {
      const referenced = error instanceof Error && error.message.includes("FOREIGN KEY");
      const message = referenced
        ? "This model backend is used by a runtime profile"
        : error instanceof Error ? error.message : "Unable to delete model backend";
      return context.json(
        { error: referenced ? "model_backend_in_use" : "model_backend_not_found", message } satisfies ApiError,
        referenced ? 409 : 404,
      );
    }
  });

  app.get("/api/projects/:projectId/harnesses", (context) => {
    const projectId = context.req.param("projectId");
    if (!database.getProject(projectId)) {
      return context.json(
        { error: "project_not_found", message: "Project not found" } satisfies ApiError,
        404,
      );
    }
    return context.json({ harnesses: database.listCodingHarnesses(projectId) });
  });

  app.get("/api/projects/:projectId/harnesses/status", async (context) => {
    const projectId = context.req.param("projectId");
    if (!database.getProject(projectId)) {
      return context.json(
        { error: "project_not_found", message: "Project not found" } satisfies ApiError,
        404,
      );
    }
    const harnesses = database.listCodingHarnesses(projectId);
    if (!options.harnessInspector) {
      return context.json({
        statuses: harnesses.map((harness): CodingHarnessInstallationSummary => ({
          harnessId: harness.id,
          state: "controller-unavailable",
          version: null,
          workerImage: null,
          message: "Worker controller is not configured",
        })),
      });
    }
    try {
      const capabilities = await options.harnessInspector.getCapabilities();
      const codex = capabilities.harnesses.find((capability) => capability.adapter === "codex");
      const statuses = harnesses.map((harness): CodingHarnessInstallationSummary => {
        const usesCodexAdapter = harness.adapter === "codex" && basename(harness.executable) === "codex";
        const usesAllowlistedImage = !harness.containerImage || harness.containerImage === capabilities.workerImage;
        const installed = usesCodexAdapter && usesAllowlistedImage && codex?.installed === true;
        let message = "This harness is not installed in the Codex-first worker image";
        if (usesCodexAdapter && !usesAllowlistedImage) {
          message = "The configured container image is not the allowlisted Codex worker image";
        } else if (usesCodexAdapter && usesAllowlistedImage && !codex?.installed) {
          message = "The Codex binary is missing from the worker image";
        } else if (installed) {
          message = `Codex is installed in ${capabilities.workerImage}`;
        }
        return {
          harnessId: harness.id,
          state: installed ? "installed" : "missing",
          version: installed ? codex?.version ?? null : null,
          workerImage: capabilities.workerImage,
          message,
        };
      });
      return context.json({ statuses });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Worker controller is unavailable";
      return context.json({
        statuses: harnesses.map((harness): CodingHarnessInstallationSummary => ({
          harnessId: harness.id,
          state: "controller-unavailable",
          version: null,
          workerImage: null,
          message,
        })),
      });
    }
  });

  app.post("/api/projects/:projectId/harnesses/:harnessId/preflight", async (context) => {
    const projectId = context.req.param("projectId");
    const harness = database.getCodingHarness(projectId, context.req.param("harnessId"));
    if (!database.getProject(projectId)) {
      return context.json(
        { error: "project_not_found", message: "Project not found" } satisfies ApiError,
        404,
      );
    }
    if (!harness) {
      return context.json(
        { error: "coding_harness_not_found", message: "Coding harness not found" } satisfies ApiError,
        404,
      );
    }
    if (harness.adapter !== "codex" || basename(harness.executable) !== "codex") {
      return context.json({
        preflight: {
          harnessId: harness.id,
          state: "unsupported",
          version: null,
          workerImage: null,
          message: "Authentication preflight is currently available for the Codex adapter",
        } satisfies CodingHarnessPreflightSummary,
      });
    }
    if (!options.harnessInspector?.preflightCodex) {
      return context.json({
        preflight: {
          harnessId: harness.id,
          state: "failed",
          version: null,
          workerImage: null,
          message: "Worker controller is not configured for Codex authentication checks",
        } satisfies CodingHarnessPreflightSummary,
      });
    }
    try {
      const result = await options.harnessInspector.preflightCodex();
      return context.json({
        preflight: {
          harnessId: harness.id,
          state: result.state,
          version: result.version,
          workerImage: result.workerImage,
          message: result.message,
        } satisfies CodingHarnessPreflightSummary,
      });
    } catch (error) {
      return context.json({
        preflight: {
          harnessId: harness.id,
          state: "failed",
          version: null,
          workerImage: null,
          message: error instanceof Error ? error.message : "Codex authentication preflight failed",
        } satisfies CodingHarnessPreflightSummary,
      });
    }
  });

  app.post("/api/projects/:projectId/harnesses", async (context) => {
    const projectId = context.req.param("projectId");
    if (!database.getProject(projectId)) {
      return context.json(
        { error: "project_not_found", message: "Project not found" } satisfies ApiError,
        404,
      );
    }
    let body: SaveCodingHarnessInput;
    try {
      body = await context.req.json<SaveCodingHarnessInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }
    const parsed = saveCodingHarnessSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        { error: "invalid_coding_harness", message: parsed.error.issues[0]?.message ?? "Invalid coding harness" } satisfies ApiError,
        400,
      );
    }
    try {
      const harness = database.createCodingHarness(
        projectId,
        randomUUID(),
        parsed.data as SaveCodingHarnessInput,
      );
      return context.json({ harness }, 201);
    } catch (error) {
      const message = error instanceof Error && error.message.includes("UNIQUE")
        ? "A coding harness with this name already exists"
        : error instanceof Error ? error.message : "Unable to create coding harness";
      return context.json(
        { error: "coding_harness_not_created", message } satisfies ApiError,
        409,
      );
    }
  });

  app.put("/api/projects/:projectId/harnesses/:harnessId", async (context) => {
    let body: SaveCodingHarnessInput;
    try {
      body = await context.req.json<SaveCodingHarnessInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }
    const parsed = saveCodingHarnessSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        { error: "invalid_coding_harness", message: parsed.error.issues[0]?.message ?? "Invalid coding harness" } satisfies ApiError,
        400,
      );
    }
    try {
      const harness = database.updateCodingHarness(
        context.req.param("projectId"),
        context.req.param("harnessId"),
        parsed.data as SaveCodingHarnessInput,
      );
      return context.json({ harness });
    } catch (error) {
      const message = error instanceof Error && error.message.includes("UNIQUE")
        ? "A coding harness with this name already exists"
        : error instanceof Error ? error.message : "Unable to update coding harness";
      const status = message === "Coding harness not found" ? 404 : 409;
      return context.json(
        { error: "coding_harness_not_updated", message } satisfies ApiError,
        status,
      );
    }
  });

  app.delete("/api/projects/:projectId/harnesses/:harnessId", (context) => {
    try {
      database.deleteCodingHarness(
        context.req.param("projectId"),
        context.req.param("harnessId"),
      );
      return context.body(null, 204);
    } catch (error) {
      const referenced = error instanceof Error && error.message.includes("FOREIGN KEY");
      const message = referenced
        ? "This coding harness is used by a runtime profile"
        : error instanceof Error ? error.message : "Unable to delete coding harness";
      return context.json(
        { error: referenced ? "coding_harness_in_use" : "coding_harness_not_found", message } satisfies ApiError,
        referenced ? 409 : 404,
      );
    }
  });

  app.get("/api/projects/:projectId/runtime-profiles", (context) => {
    const projectId = context.req.param("projectId");
    if (!database.getProject(projectId)) {
      return context.json(
        { error: "project_not_found", message: "Project not found" } satisfies ApiError,
        404,
      );
    }
    return context.json({ profiles: database.listRuntimeProfiles(projectId) });
  });

  app.post("/api/projects/:projectId/runtime-profiles", async (context) => {
    const projectId = context.req.param("projectId");
    if (!database.getProject(projectId)) {
      return context.json(
        { error: "project_not_found", message: "Project not found" } satisfies ApiError,
        404,
      );
    }
    let body: SaveRuntimeProfileInput;
    try {
      body = await context.req.json<SaveRuntimeProfileInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }
    const parsed = saveRuntimeProfileSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        { error: "invalid_runtime_profile", message: parsed.error.issues[0]?.message ?? "Invalid runtime profile" } satisfies ApiError,
        400,
      );
    }
    try {
      const profile = database.createRuntimeProfile(
        projectId,
        randomUUID(),
        parsed.data as SaveRuntimeProfileInput,
      );
      return context.json({ profile }, 201);
    } catch (error) {
      const message = error instanceof Error && error.message.includes("UNIQUE")
        ? "A runtime profile with this name already exists"
        : error instanceof Error ? error.message : "Unable to create runtime profile";
      return context.json(
        { error: "runtime_profile_not_created", message } satisfies ApiError,
        409,
      );
    }
  });

  app.put("/api/projects/:projectId/runtime-profiles/:profileId", async (context) => {
    let body: SaveRuntimeProfileInput;
    try {
      body = await context.req.json<SaveRuntimeProfileInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }
    const parsed = saveRuntimeProfileSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        { error: "invalid_runtime_profile", message: parsed.error.issues[0]?.message ?? "Invalid runtime profile" } satisfies ApiError,
        400,
      );
    }
    try {
      const profile = database.updateRuntimeProfile(
        context.req.param("projectId"),
        context.req.param("profileId"),
        parsed.data as SaveRuntimeProfileInput,
      );
      return context.json({ profile });
    } catch (error) {
      const message = error instanceof Error && error.message.includes("UNIQUE")
        ? "A runtime profile with this name already exists"
        : error instanceof Error ? error.message : "Unable to update runtime profile";
      const status = message === "Runtime profile not found" ? 404 : 409;
      return context.json(
        { error: "runtime_profile_not_updated", message } satisfies ApiError,
        status,
      );
    }
  });

  app.delete("/api/projects/:projectId/runtime-profiles/:profileId", (context) => {
    try {
      database.deleteRuntimeProfile(
        context.req.param("projectId"),
        context.req.param("profileId"),
      );
      return context.body(null, 204);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to delete runtime profile";
      return context.json(
        { error: "runtime_profile_not_found", message } satisfies ApiError,
        404,
      );
    }
  });

  app.get("/api/projects/:projectId/agent-runtime-assignments", (context) => {
    const projectId = context.req.param("projectId");
    if (!database.getProject(projectId)) {
      return context.json(
        { error: "project_not_found", message: "Project not found" } satisfies ApiError,
        404,
      );
    }
    return context.json({
      assignments: database.listAgentRuntimeAssignments(projectId),
    });
  });

  app.put("/api/projects/:projectId/agents/:agentRole/runtime", async (context) => {
    const projectId = context.req.param("projectId");
    const parsedRole = z.enum(validAgentRoles).safeParse(context.req.param("agentRole"));
    if (!parsedRole.success) {
      return context.json(
        { error: "invalid_agent_role", message: "Unknown agent role" } satisfies ApiError,
        400,
      );
    }
    if (!database.getProject(projectId)) {
      return context.json(
        { error: "project_not_found", message: "Project not found" } satisfies ApiError,
        404,
      );
    }
    let body: AssignAgentRuntimeInput;
    try {
      body = await context.req.json<AssignAgentRuntimeInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }
    const parsed = assignAgentRuntimeSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        { error: "invalid_runtime_profile_assignment", message: parsed.error.issues[0]?.message ?? "Invalid runtime profile assignment" } satisfies ApiError,
        400,
      );
    }
    try {
      const assignment = database.assignAgentRuntime(
        projectId,
        parsedRole.data,
        parsed.data.codingHarnessId,
        parsed.data.modelBackendId,
        parsed.data.fallbackCodingHarnessId,
        parsed.data.fallbackModelBackendId,
      );
      return context.json({
        assignment: assignment satisfies AgentRuntimeAssignmentSummary | null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to assign runtime profile";
      return context.json(
        { error: "runtime_not_assigned", message } satisfies ApiError,
        message.includes("not part of this project") ? 404 : 409,
      );
    }
  });

  app.get("/api/projects/:projectId/orchestration", (context) => {
    const state = database.getOrchestrationState(context.req.param("projectId"));
    if (!state) {
      return context.json(
        { error: "project_not_found", message: "Project not found" } satisfies ApiError,
        404,
      );
    }
    return context.json({ state, reviews: buildTaskReviews(state, options.workspaceRoot) });
  });

  app.get("/api/projects/:projectId/tasks/:taskId/workflow", (context) => {
    const projectId = context.req.param("projectId");
    const taskId = context.req.param("taskId");
    const state = database.getOrchestrationState(projectId);
    if (!state) {
      return context.json({ error: "project_not_found", message: "Project not found" } satisfies ApiError, 404);
    }
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      return context.json({ error: "task_not_found", message: "Task not found" } satisfies ApiError, 404);
    }
    const runs = database.listAgentRunsForTask(projectId, taskId).map((run) => ({
      run,
      attempts: database.listRunAttempts(run.id),
      events: database.listRunEvents(run.id),
      artifacts: database.listRunArtifacts(run.id),
      usage: database.listRunUsage(run.id),
    }));
    return context.json({ task, runs, recovery: database.getTaskWorkflowRecovery(projectId, taskId) } satisfies TaskWorkflowDetailResponse);
  });

  app.get("/api/repositories/discover", (context) => {
    const registeredRepositories = new Map(
      database.listProjects().flatMap((project) =>
        project.repositories.map((repository) => [repository.relativePath, project.id] as const),
      ),
    );
    const repositories = discoverRepositories(options.workspaceRoot).map((repository) => ({
      id: repository.relativePath,
      ...repository,
      registered: registeredRepositories.has(repository.relativePath),
      projectId: registeredRepositories.get(repository.relativePath) ?? null,
    }));

    return context.json({
      repositories,
      workspaceRoot: options.workspaceRoot,
      workspaceName: options.workspaceName?.trim() || basename(options.workspaceRoot) || "Project",
    } satisfies RepositoryDiscoveryResponse);
  });

  app.post("/api/projects/:projectId/repositories", async (context) => {
    let body: AddProjectRepositoryInput;
    try {
      body = await context.req.json<AddProjectRepositoryInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }
    const parsed = addProjectRepositorySchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        { error: "invalid_request", message: parsed.error.issues[0]?.message ?? "Invalid repository" } satisfies ApiError,
        400,
      );
    }
    try {
      const inspected = inspectRepository(
        resolveRepositoryPath(options.workspaceRoot, parsed.data.relativePath),
        options.workspaceRoot,
      );
      const project = database.addRepository(context.req.param("projectId"), {
        id: randomUUID(),
        ...inspected,
      });
      return context.json({ project }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to add repository";
      return context.json(
        {
          error: message === "Project not found" ? "project_not_found" : "repository_conflict",
          message: message.includes("UNIQUE constraint failed")
            ? "This repository is already assigned to a project"
            : message,
        } satisfies ApiError,
        message === "Project not found" ? 404 : 409,
      );
    }
  });

  app.post("/api/projects/:projectId/repositories/new", async (context) => {
    let body: CreateProjectRepositoryInput;
    try {
      body = await context.req.json<CreateProjectRepositoryInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }
    const parsed = createProjectRepositorySchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        { error: "invalid_repository", message: parsed.error.issues[0]?.message ?? "Invalid repository" } satisfies ApiError,
        400,
      );
    }
    try {
      const created = createRepository(options.workspaceRoot, parsed.data.directoryName);
      const project = database.addRepository(context.req.param("projectId"), {
        id: randomUUID(),
        ...created,
      });
      return context.json({ project }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create repository";
      return context.json(
        { error: message === "Project not found" ? "project_not_found" : "repository_create_failed", message } satisfies ApiError,
        message === "Project not found" ? 404 : 409,
      );
    }
  });

  app.patch("/api/projects/:projectId/repositories/:repositoryId", async (context) => {
    let body: UpdateProjectRepositoryInput;
    try {
      body = await context.req.json<UpdateProjectRepositoryInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }
    const parsed = updateProjectRepositorySchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        { error: "invalid_repository", message: parsed.error.issues[0]?.message ?? "Invalid repository settings" } satisfies ApiError,
        400,
      );
    }
    try {
      const project = database.updateRepository(
        context.req.param("projectId"),
        context.req.param("repositoryId"),
        {
          ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
          ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
        },
      );
      return context.json({ project });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update repository";
      return context.json(
        { error: "repository_not_found", message } satisfies ApiError,
        404,
      );
    }
  });

  app.get("/api/projects/:projectId/context", (context) => {
    const projectId = context.req.param("projectId");
    if (!database.getProject(projectId)) return context.json({ error: "project_not_found", message: "Project not found" } satisfies ApiError, 404);
    const document = database.getContextDocuments(projectId).find((candidate) => candidate.repositoryId === null) ?? null;
    return context.json({ document, revisions: database.listContextRevisions(projectId, null) });
  });

  app.put("/api/projects/:projectId/context", async (context) => {
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError, 400); }
    const parsed = updateContextSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "invalid_context", message: parsed.error.issues[0]?.message ?? "Invalid project context" } satisfies ApiError, 400);
    try {
      const document = database.saveContext(context.req.param("projectId"), null, parsed.data.content, "director");
      return context.json({ document, revisions: database.listContextRevisions(document.projectId, null) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save project context";
      return context.json({ error: "context_save_failed", message } satisfies ApiError, message === "Project not found" ? 404 : 409);
    }
  });

  app.get("/api/projects/:projectId/repositories/:repositoryId/context", (context) => {
    const projectId = context.req.param("projectId");
    const repositoryId = context.req.param("repositoryId");
    const project = database.getProject(projectId);
    if (!project) return context.json({ error: "project_not_found", message: "Project not found" } satisfies ApiError, 404);
    if (!project.repositories.some((repository) => repository.id === repositoryId)) return context.json({ error: "repository_not_found", message: "Repository not found" } satisfies ApiError, 404);
    const document = database.getContextDocuments(projectId).find((candidate) => candidate.repositoryId === repositoryId) ?? null;
    return context.json({ document, revisions: database.listContextRevisions(projectId, repositoryId) });
  });

  app.put("/api/projects/:projectId/repositories/:repositoryId/context", async (context) => {
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError, 400); }
    const parsed = updateContextSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "invalid_context", message: parsed.error.issues[0]?.message ?? "Invalid repository context" } satisfies ApiError, 400);
    try {
      const projectId = context.req.param("projectId");
      const repositoryId = context.req.param("repositoryId");
      const document = database.saveContext(projectId, repositoryId, parsed.data.content, "director");
      return context.json({ document, revisions: database.listContextRevisions(projectId, repositoryId) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save repository context";
      return context.json({ error: "context_save_failed", message } satisfies ApiError, message === "Project not found" || message === "Repository is not part of this project" ? 404 : 409);
    }
  });

  app.post("/api/projects/:projectId/agents/:agentRole/messages", async (context) => {
    const role = context.req.param("agentRole") as AgentRole;
    if (!validAgentRoles.includes(role)) {
      return context.json(
        { error: "invalid_agent_role", message: "Unknown agent role" } satisfies ApiError,
        400,
      );
    }
    let body: CreateAgentMessageInput;
    try {
      body = await context.req.json<CreateAgentMessageInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }
    const parsed = createAgentMessageSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        { error: "invalid_message", message: parsed.error.issues[0]?.message ?? "Invalid message" } satisfies ApiError,
        400,
      );
    }
    const projectId = context.req.param("projectId");
    if (role === "project_manager") {
      const project = database.getProject(projectId);
      if (!project) {
        return context.json(
          { error: "project_not_found", message: "Project not found" } satisfies ApiError,
          404,
        );
      }
      const runtimeAssignment = database.getAgentRuntimeAssignment(projectId, role);
      if (!runtimeAssignment?.codingHarnessId || !runtimeAssignment.modelBackendId) {
        return context.json(
          { error: "runtime_not_configured", message: "Choose a harness and model on the Project Manager card before sending a planning goal" } satisfies ApiError,
          409,
        );
      }
      const harness = database.getCodingHarness(projectId, runtimeAssignment.codingHarnessId);
      const backend = database.getModelBackend(projectId, runtimeAssignment.modelBackendId);
      if (!harness || !backend) {
        return context.json(
          { error: "runtime_not_configured", message: "The Project Manager runtime assignment refers to a missing harness or model" } satisfies ApiError,
          409,
        );
      }
      if (!harness.enabled || !backend.enabled) {
        return context.json(
          { error: "runtime_disabled", message: "Enable the Project Manager harness and model before sending a planning goal" } satisfies ApiError,
          409,
        );
      }
      if (!harness.supportedProtocols.includes(backend.protocol)) {
        return context.json(
          { error: "runtime_incompatible", message: `${harness.name} does not support the ${backend.protocol} model protocol` } satisfies ApiError,
          409,
        );
      }
      if (harness.adapter !== "codex" || !harness.capabilities.includes("planning") || backend.provider !== "openai" || backend.protocol !== "openai-responses") {
        return context.json(
          { error: "adapter_not_connected", message: `The ${harness.name}/${backend.name} planning adapter is not connected yet; choose a Codex planning harness and OpenAI Responses model` } satisfies ApiError,
          409,
        );
      }
      if (backend.authMode === "none") {
        return context.json(
          { error: "authentication_not_configured", message: "The selected OpenAI model requires ChatGPT or API-key authentication" } satisfies ApiError,
          409,
        );
      }
      const credentialRef = backend.authMode === "chatgpt"
        ? "CODEX_ACCESS_TOKEN"
        : backend.credentialRef;
      if (!credentialRef) {
        return context.json(
          { error: "authentication_not_configured", message: "The selected model backend does not identify a credential environment variable" } satisfies ApiError,
          409,
        );
      }
      const executionProfileRecord = {
        id: `runtime-${projectId}-${role}`,
        projectId,
        name: `Runtime assignment: ${role}`,
        provider: backend.provider,
        harness: harness.adapter,
        modelClass: role === "project_manager" ? "planning" : "coding",
        credentialRef,
        ...(backend.model ? { model: backend.model } : {}),
        configuration: {
          source: "agent_runtime_assignment",
          codingHarnessId: harness.id,
          modelBackendId: backend.id,
          authMode: backend.authMode,
          protocol: backend.protocol,
          ...(backend.baseUrl ? { baseUrl: backend.baseUrl } : {}),
        },
      };
      const existingExecutionProfile = database.getBrainProfile(executionProfileRecord.id);
      const profile = existingExecutionProfile
        ? database.updateBrainProfile(executionProfileRecord)
        : database.createBrainProfile(executionProfileRecord);
      if (!options.planningExecutor) {
        return context.json(
          { error: "controller_unavailable", message: "The trusted worker controller is not configured" } satisfies ApiError,
          503,
        );
      }
      const state = database.getOrchestrationState(projectId);
      if (state?.runs.some((run) => run.agentRole === role && ["queued", "provisioning", "running", "waiting"].includes(run.status))) {
        return context.json(
          { error: "agent_busy", message: "The Project Manager is already working on a planning goal" } satisfies ApiError,
          409,
        );
      }
      const settings = database.getProjectSettings(projectId);
      if (!settings) {
        return context.json(
          { error: "project_settings_not_found", message: "Project settings not found" } satisfies ApiError,
          404,
        );
      }
      if (settings.planningNetworkPolicy !== "model-provider-only") {
        return context.json(
          { error: "network_policy_not_supported", message: "The Codex planning worker currently requires the model-provider-only network policy" } satisfies ApiError,
          409,
        );
      }
      const message = database.createAgentMessage({
        id: randomUUID(),
        projectId,
        agentRole: role,
        author: "director",
        body: parsed.data.body,
      });
      const runId = randomUUID();
      const attemptId = randomUUID();
      const activeRepositories = project.repositories.filter((repository) => repository.enabled && repository.available);
      const runSpec = {
        schemaVersion: runContractSchemaVersion,
        runId,
        projectId,
        agentRole: role,
        agentInstructions: state?.agentConfigurations.find((configuration) => configuration.agentRole === role)?.rolePrompt ?? "",
        brainProfile: {
          provider: profile.provider,
          harness: profile.harness,
          modelClass: profile.modelClass,
          credentialRef: profile.credentialRef,
          ...(profile.model ? { model: profile.model } : {}),
          ...(profile.reasoningLevel ? { reasoningLevel: profile.reasoningLevel } : {}),
        },
        repositories: activeRepositories.map((repository, index) => ({
          repositoryId: repository.id,
          checkoutPath: `/workspace/repos/${String(index + 1).padStart(2, "0")}-${repository.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`,
          baseCommit: getRepositoryHead(repository.relativePath, options.workspaceRoot),
        })),
        objective: parsed.data.body,
        taskDescription: "Respond naturally to the director. Update standing directives only when explicitly requested, and create a proposed implementation plan only when the director provides a goal to execute.",
        acceptanceCriteria: [
          "Return a valid conversational Project Manager response",
          "Apply explicit standing-directive requests accurately",
          "Do not modify any repository",
        ],
        upstreamArtifacts: [],
        permissions: {
          filesystem: "read-only" as const,
          networkPolicy: settings.planningNetworkPolicy,
          allowedTools: ["inspect_repository", "respond_to_director"],
        },
        limits: {
          timeoutSeconds: settings.defaultRunTimeoutSeconds,
          retries: settings.defaultRunRetries,
          ...(settings.defaultTokenBudget === null ? {} : { tokenBudget: settings.defaultTokenBudget }),
          ...(settings.defaultCostBudgetCents === null ? {} : { costBudgetCents: settings.defaultCostBudgetCents }),
        },
      };
      const run = database.createAgentRun(profile.id, runSpec);
      database.createRunAttempt({ id: attemptId, runId, attemptNumber: 1 });
      appendRunEvent(database, runId, attemptId, 1, "run.queued", "Project Manager planning run queued");
      appendRunEvent(database, runId, attemptId, 2, "worker.provisioning", "Preparing an isolated read-only worker");
      const request: PlanningRunRequest = {
        run: runSpec,
        directorMessageId: message.id,
        directives: (state?.directives ?? []).filter((directive) => directive.agentRole === role),
        conversation: [...(state?.messages ?? []), message]
          .filter((candidate) => candidate.agentRole === role)
          .slice(-20)
          .map(({ author, body }) => ({ author, body })),
        availableConsultants: state?.agentConfigurations.find((configuration) => configuration.agentRole === role)?.consultationRoles ?? [],
        consultationResults: [],
        projectContext: state?.contexts.find((document) => document.repositoryId === null)?.content ?? "",
        repositoryContexts: activeRepositories.map((repository) => ({
          repositoryId: repository.id,
          name: repository.name,
          content: state?.contexts.find((document) => document.repositoryId === repository.id)?.content ?? "",
        })),
        repositorySources: activeRepositories.map((repository) => ({
          repositoryId: repository.id,
          name: repository.name,
          ...(repository.description ? { description: repository.description } : {}),
          sourcePath: resolveRepositoryPath(options.workspaceRoot, repository.relativePath),
        })),
      };
      void executeProjectManagerPlanning(database, options.planningExecutor, request, attemptId);
      return context.json({ message, run }, 202);
    }
    try {
      const project = database.getProject(projectId);
      if (!project) return context.json({ error: "project_not_found", message: "Project not found" } satisfies ApiError, 404);
      if (!options.planningExecutor?.consult) return context.json({ error: "controller_unavailable", message: "The trusted consultation worker controller is not configured" } satisfies ApiError, 503);
      const state = database.getOrchestrationState(projectId);
      const settings = database.getProjectSettings(projectId);
      if (!state || !settings) return context.json({ error: "project_settings_not_found", message: "Project settings not found" } satisfies ApiError, 404);
      if (state.runs.some((run) => run.agentRole === role && ["queued", "provisioning", "running", "waiting"].includes(run.status))) {
        return context.json({ error: "agent_busy", message: `The ${role.replaceAll("_", " ")} is already working` } satisfies ApiError, 409);
      }
      if (settings.planningNetworkPolicy !== "model-provider-only") {
        return context.json({ error: "network_policy_not_supported", message: "Read-only agent conversation currently requires the model-provider-only network policy" } satisfies ApiError, 409);
      }
      const profile = resolveReadOnlyAgentProfile(database, projectId, role);
      const message = database.createAgentMessage({ id: randomUUID(), projectId, agentRole: role, author: "director", body: parsed.data.body });
      const runId = randomUUID();
      const attemptId = randomUUID();
      const activeRepositories = project.repositories.filter((repository) => repository.enabled && repository.available);
      const runSpec = {
        schemaVersion: runContractSchemaVersion,
        runId,
        projectId,
        agentRole: role,
        runPurpose: "consultation" as const,
        agentInstructions: state.agentConfigurations.find((configuration) => configuration.agentRole === role)?.rolePrompt ?? "",
        brainProfile: {
          provider: profile.provider, harness: profile.harness, modelClass: profile.modelClass, credentialRef: profile.credentialRef,
          ...(profile.model ? { model: profile.model } : {}), ...(profile.reasoningLevel ? { reasoningLevel: profile.reasoningLevel } : {}),
        },
        repositories: activeRepositories.map((repository, index) => ({
          repositoryId: repository.id,
          checkoutPath: `/workspace/repos/${String(index + 1).padStart(2, "0")}-${repository.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`,
          baseCommit: getRepositoryHead(repository.relativePath, options.workspaceRoot),
        })),
        objective: parsed.data.body,
        taskDescription: "Respond directly to the Engineering Director without modifying repositories or creating work items.",
        acceptanceCriteria: ["Answer the Director's message using the agent's role, directives, conversation, and project context", "Do not modify any repository"],
        upstreamArtifacts: [`director-message:${message.id}`],
        permissions: { filesystem: "read-only" as const, networkPolicy: settings.planningNetworkPolicy, allowedTools: ["inspect_repository", "respond_to_request"] },
        limits: {
          timeoutSeconds: settings.defaultRunTimeoutSeconds, retries: settings.defaultRunRetries,
          ...(settings.defaultTokenBudget === null ? {} : { tokenBudget: settings.defaultTokenBudget }),
          ...(settings.defaultCostBudgetCents === null ? {} : { costBudgetCents: settings.defaultCostBudgetCents }),
        },
      };
      const run = database.createAgentRun(profile.id, runSpec);
      database.createRunAttempt({ id: attemptId, runId, attemptNumber: 1 });
      appendRunEvent(database, runId, attemptId, 1, "run.queued", `${role.replaceAll("_", " ")} conversation queued`);
      appendRunEvent(database, runId, attemptId, 2, "worker.provisioning", "Preparing an isolated read-only conversation worker");
      const request: ConsultationRunRequest = {
        run: runSpec,
        requestingRole: "engineering_director",
        question: parsed.data.body,
        directives: state.directives.filter((directive) => directive.agentRole === role),
        conversation: [...state.messages, message].filter((candidate) => candidate.agentRole === role).slice(-20).map(({ author, body }) => ({ author, body })),
        projectContext: state.contexts.find((document) => document.repositoryId === null)?.content ?? "",
        repositoryContexts: activeRepositories.map((repository) => ({ repositoryId: repository.id, name: repository.name, content: state.contexts.find((document) => document.repositoryId === repository.id)?.content ?? "" })),
        repositorySources: activeRepositories.map((repository) => ({ repositoryId: repository.id, name: repository.name, ...(repository.description ? { description: repository.description } : {}), sourcePath: resolveRepositoryPath(options.workspaceRoot, repository.relativePath) })),
      };
      void executeDirectorAgentConversation(database, options.planningExecutor, request, attemptId, message.id);
      return context.json({ message, run }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start agent conversation";
      return context.json({ error: "message_failed", message } satisfies ApiError, message === "Project not found" ? 404 : 409);
    }
  });

  app.post("/api/projects/:projectId/agents/:agentRole/runs/:runId/cancel", async (context) => {
    const role = context.req.param("agentRole") as AgentRole;
    if (!validAgentRoles.includes(role)) return context.json({ error: "invalid_agent_role", message: "Unknown agent role" } satisfies ApiError, 400);
    const executor = options.planningExecutor;
    if (!executor?.stopAgentWorker) return context.json({ error: "controller_unavailable", message: "The trusted worker controller cannot cancel this agent run" } satisfies ApiError, 503);
    try {
      const reason = "Cancelled by the Engineering Director. Recorded conversation activity was preserved.";
      const run = database.cancelAgentRun(context.req.param("projectId"), role, context.req.param("runId"), reason);
      let workerStopped = true;
      try { await executor.stopAgentWorker(run.id); } catch (error) { workerStopped = false; console.warn(`Cancelled agent run ${run.id}, but its worker could not be confirmed stopped`, error); }
      database.createAgentMessage({ id: randomUUID(), projectId: run.projectId, agentRole: role, author: "system", body: reason });
      return context.json({ run, workerStopped });
    } catch (error) {
      return context.json({ error: "agent_cancel_rejected", message: error instanceof Error ? error.message : "Unable to cancel agent run" } satisfies ApiError, 409);
    }
  });

  app.delete("/api/projects/:projectId/agents/:agentRole/directives/:directiveId", (context) => {
    const role = context.req.param("agentRole") as AgentRole;
    if (!validAgentRoles.includes(role)) {
      return context.json({ error: "invalid_agent_role", message: "Unknown agent role" } satisfies ApiError, 400);
    }
    try {
      database.removeAgentDirective(context.req.param("projectId"), role, context.req.param("directiveId"));
      return context.body(null, 204);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to remove directive";
      return context.json({ error: "directive_not_found", message } satisfies ApiError, 404);
    }
  });

  app.put("/api/projects/:projectId/agents/:agentRole/configuration", async (context) => {
    const role = context.req.param("agentRole") as AgentRole;
    if (!validAgentRoles.includes(role)) {
      return context.json({ error: "invalid_agent_role", message: "Unknown agent role" } satisfies ApiError, 400);
    }
    let body: UpdateAgentConfigurationInput;
    try {
      body = await context.req.json<UpdateAgentConfigurationInput>();
    } catch {
      return context.json({ error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError, 400);
    }
    const parsed = updateAgentConfigurationSchema.safeParse(body);
    if (!parsed.success) {
      return context.json({ error: "invalid_agent_configuration", message: parsed.error.issues[0]?.message ?? "Invalid role prompt" } satisfies ApiError, 400);
    }
    try {
      const currentConfiguration = database.getAgentConfigurations(context.req.param("projectId")).find((configuration) => configuration.agentRole === role);
      const consultationRoles = parsed.data.consultationRoles ?? currentConfiguration?.consultationRoles ?? [];
      if (consultationRoles.includes(role)) {
        return context.json({ error: "invalid_agent_configuration", message: "An agent cannot consult itself" } satisfies ApiError, 400);
      }
      const configuration = database.updateAgentConfiguration(context.req.param("projectId"), role, parsed.data.rolePrompt, consultationRoles);
      return context.json({ configuration });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update agent configuration";
      return context.json({ error: "agent_configuration_failed", message } satisfies ApiError, message === "Project not found" ? 404 : 409);
    }
  });

  app.post("/api/projects", async (context) => {
    let body: CreateProjectInput;
    try {
      body = await context.req.json<CreateProjectInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }

    const parsed = createProjectSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        {
          error: "invalid_request",
          message: parsed.error.issues[0]?.message ?? "Invalid project details",
        } satisfies ApiError,
        400,
      );
    }

    let repository;
    try {
      repository = inspectRepository(parsed.data.repositoryPath, options.workspaceRoot);
    } catch (error) {
      return context.json(
        {
          error: "invalid_repository",
          message: error instanceof Error ? error.message : "Invalid repository",
        } satisfies ApiError,
        400,
      );
    }

    try {
      const project = database.createProject({
        id: randomUUID(),
        name: parsed.data.name,
        repository: {
          id: randomUUID(),
          ...repository,
        },
      });
      return context.json({ project }, 201);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        return context.json(
          {
            error: "repository_exists",
            message: "This repository is already registered",
          } satisfies ApiError,
          409,
        );
      }
      throw error;
    }
  });

  app.post("/api/projects/new", async (context) => {
    let body: CreateNewProjectInput;
    try {
      body = await context.req.json<CreateNewProjectInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }

    const parsed = createNewProjectSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        {
          error: "invalid_request",
          message: parsed.error.issues[0]?.message ?? "Invalid project details",
        } satisfies ApiError,
        400,
      );
    }

    let repository;
    try {
      repository = createRepository(options.workspaceRoot, parsed.data.directoryName);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create repository";
      return context.json(
        {
          error: message.includes("already exists") ? "path_exists" : "repository_create_failed",
          message,
        } satisfies ApiError,
        message.includes("already exists") ? 409 : 400,
      );
    }

    const project = database.createProject({
      id: randomUUID(),
      name: parsed.data.name,
      repository: {
        id: randomUUID(),
        ...repository,
      },
    });
    return context.json({ project }, 201);
  });

  app.post("/api/projects/:projectId/plans", async (context) => {
    const projectId = context.req.param("projectId");
    let body: CreatePlanInput;
    try {
      body = await context.req.json<CreatePlanInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }

    const parsed = createPlanSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        {
          error: "invalid_plan",
          message: parsed.error.issues[0]?.message ?? "Invalid plan",
        } satisfies ApiError,
        400,
      );
    }

    try {
      const plan = database.createPlan({
        projectId,
        objective: { id: randomUUID(), ...parsed.data.objective },
        tasks: parsed.data.tasks.map((task) => ({ id: randomUUID(), ...task })),
        approvalId: randomUUID(),
        contextUpdates: parsed.data.contextUpdates.map((update) => ({ id: randomUUID(), ...update, proposedByRole: "project_manager" as const })),
      });
      return context.json(plan satisfies CreatePlanResponse, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create plan";
      return context.json(
        {
          error: message === "Project not found" ? "project_not_found" : "plan_conflict",
          message,
        } satisfies ApiError,
        message === "Project not found" ? 404 : 409,
      );
    }
  });

  app.patch("/api/projects/:projectId/approvals/:approvalId", async (context) => {
    let body: DecideApprovalInput;
    try {
      body = await context.req.json<DecideApprovalInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }
    const parsed = decideApprovalSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        { error: "invalid_decision", message: parsed.error.issues[0]?.message ?? "Invalid decision" } satisfies ApiError,
        400,
      );
    }

    try {
      const projectId = context.req.param("projectId");
      const approvalId = context.req.param("approvalId");
      const currentApproval = database.getApproval(projectId, approvalId);
      if (!currentApproval) throw new Error("Approval request not found");
      let applied: Awaited<ReturnType<TaskExecutor["applyTask"]>> | null = null;
      let appliedRunId: string | null = null;
      if (currentApproval.type === "integration" && parsed.data.decision === "approved") {
        if (!options.taskExecutor) throw new Error("The trusted task worker controller is not configured");
        const proposal = database.getIntegrationProposal(projectId, approvalId);
        if (!proposal) throw new Error("Integration proposal not found");
        const state = database.getOrchestrationState(projectId);
        const run = database.getAgentRun(proposal.changeRunId);
        if (!state || !run?.result) throw new Error("The verified implementation for this proposal is unavailable");
        const repositories = buildApplyRepositories(state, run, options.workspaceRoot);
        applied = await options.taskExecutor.applyTask({ runId: run.id, taskId: proposal.taskId, repositories });
        appliedRunId = run.id;
      }
      const approval = database.decideApproval(
        projectId,
        approvalId,
        parsed.data.decision,
        parsed.data.note || null,
      );
      if (applied && appliedRunId && currentApproval.taskId) {
        database.markRunBranchesApplied(appliedRunId, applied.applied.map((item) => item.branch));
        database.markIntegrationProposalApplied(projectId, approvalId);
        const state = database.getOrchestrationState(projectId);
        const task = state?.tasks.find((candidate) => candidate.id === currentApproval.taskId);
        if (task?.status === "review") database.updateTaskStatus(projectId, task.id, "completed");
        database.createAgentMessage({
          id: randomUUID(), projectId, agentRole: "release_manager", author: "system",
          body: `Director approved integration. Applied ${applied.applied.map((item) => `${item.branch} to ${item.targetBranch}`).join(", ")}.`,
        });
      }
      return context.json({ approval, ...(applied ? { applied: applied.applied } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to decide approval";
      return context.json(
        { error: "approval_conflict", message } satisfies ApiError,
        message === "Approval request not found" ? 404 : 409,
      );
    }
  });

  app.post("/api/projects/:projectId/tasks/:taskId/runs", async (context) => {
    const projectId = context.req.param("projectId");
    const taskId = context.req.param("taskId");
    const project = database.getProject(projectId);
    const state = database.getOrchestrationState(projectId);
    const task = state?.tasks.find((candidate) => candidate.id === taskId);
    if (!project || !state) {
      return context.json({ error: "project_not_found", message: "Project not found" } satisfies ApiError, 404);
    }
    if (!task) {
      return context.json({ error: "task_not_found", message: "Task not found" } satisfies ApiError, 404);
    }
    if (!options.taskExecutor) {
      return context.json({ error: "controller_unavailable", message: "The trusted task worker controller is not configured" } satisfies ApiError, 503);
    }
    if (!['ready', 'in_progress'].includes(task.status)) {
      return context.json({ error: "task_not_runnable", message: `Task cannot run while it is ${task.status}` } satisfies ApiError, 409);
    }
    if (state.runs.some((run) => run.taskId === taskId && ["queued", "provisioning", "running", "waiting"].includes(run.status))) {
      return context.json({ error: "task_busy", message: "This task already has an active agent run" } satisfies ApiError, 409);
    }
    let startInput: z.infer<typeof startTaskRunSchema> = {};
    try {
      const text = await context.req.text();
      if (text.trim()) {
        const parsed = startTaskRunSchema.safeParse(JSON.parse(text));
        if (!parsed.success) return context.json({ error: "invalid_run_request", message: parsed.error.issues[0]?.message ?? "Invalid run request" } satisfies ApiError, 400);
        startInput = parsed.data;
      }
    } catch {
      return context.json({ error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError, 400);
    }
    const runtimeSelection = startInput.runtime ?? "primary";
    const runtimeAssignment = database.getAgentRuntimeAssignment(projectId, task.assignedRole);
    const selectedHarnessId = runtimeSelection === "fallback" ? runtimeAssignment?.fallbackCodingHarnessId : runtimeAssignment?.codingHarnessId;
    const selectedBackendId = runtimeSelection === "fallback" ? runtimeAssignment?.fallbackModelBackendId : runtimeAssignment?.modelBackendId;
    if (!selectedHarnessId || !selectedBackendId) {
      return context.json({
        error: "runtime_not_assigned",
        message: `Assign ${runtimeSelection === "fallback" ? "a fallback " : ""}harness and model to ${task.assignedRole.replaceAll("_", " ")} in Live Team before starting this task`,
      } satisfies ApiError, 409);
    }
    const harness = database.getCodingHarness(projectId, selectedHarnessId);
    const backend = database.getModelBackend(projectId, selectedBackendId);
    if (!harness || !backend || !harness.enabled || !backend.enabled) {
      return context.json({ error: "runtime_not_available", message: "The assigned harness or model is missing or disabled" } satisfies ApiError, 409);
    }
    if (!harness.supportedProtocols.includes(backend.protocol)) {
      return context.json({ error: "runtime_incompatible", message: `${harness.name} does not support the ${backend.protocol} model protocol` } satisfies ApiError, 409);
    }
    if (harness.adapter !== "codex" || !harness.capabilities.includes("coding") || backend.provider !== "openai" || backend.protocol !== "openai-responses") {
      return context.json({ error: "adapter_not_connected", message: "Task execution currently requires a Codex harness with an OpenAI model backend" } satisfies ApiError, 409);
    }
    const credentialRef = backend.authMode === "chatgpt" ? "CODEX_ACCESS_TOKEN" : backend.credentialRef;
    if (!credentialRef) {
      return context.json({ error: "authentication_not_configured", message: "The assigned model does not have an authentication method" } satisfies ApiError, 409);
    }
    const requiredVerificationRoles: AgentRole[] = [
      ...(task.requiredChecks.qa ? ["qa_engineer" as const] : []),
      ...(task.requiredChecks.codeReview ? ["code_reviewer" as const] : []),
      ...(task.requiredChecks.security ? ["security_reviewer" as const] : []),
      ...(!reportOnlyTaskRoles.has(task.assignedRole) ? ["release_manager" as const] : []),
    ];
    try {
      for (const role of requiredVerificationRoles) resolveTaskExecutionProfile(database, projectId, role);
    } catch (error) {
      return context.json({
        error: "required_check_runtime_unavailable",
        message: error instanceof Error ? error.message : "A required-check agent is not configured",
      } satisfies ApiError, 409);
    }
    const profileRecord = {
      id: runtimeSelection === "primary" ? `runtime-${projectId}-${task.assignedRole}` : `runtime-fallback-${projectId}-${task.assignedRole}`,
      projectId,
      name: `Runtime assignment: ${task.assignedRole}`,
      provider: backend.provider,
      harness: harness.adapter,
      modelClass: "coding",
      credentialRef,
      ...(backend.model ? { model: backend.model } : {}),
      configuration: {
        source: "agent_runtime_assignment",
        selection: runtimeSelection,
        codingHarnessId: harness.id,
        modelBackendId: backend.id,
        authMode: backend.authMode,
        protocol: backend.protocol,
        ...(backend.baseUrl ? { baseUrl: backend.baseUrl } : {}),
      },
    };
    const profile = database.getBrainProfile(profileRecord.id)
      ? database.updateBrainProfile(profileRecord)
      : database.createBrainProfile(profileRecord);
    const repositories = task.repositoryIds.map((repositoryId) => project.repositories.find((repository) => repository.id === repositoryId));
    if (repositories.length === 0 || repositories.some((repository) => !repository?.enabled || !repository.available)) {
      return context.json({ error: "repository_unavailable", message: "Every task repository must be enabled and available before execution" } satisfies ApiError, 409);
    }
    const settings = database.getProjectSettings(projectId);
    if (!settings) {
      return context.json({ error: "project_settings_not_found", message: "Project settings not found" } satisfies ApiError, 404);
    }

    const runId = randomUUID();
    const attemptId = randomUUID();
    const leaseToken = randomUUID();
    const workflowRecovery = database.getTaskWorkflowRecovery(projectId, taskId);
    const rejectedIntegration = state.integrationProposals.find((proposal) => proposal.taskId === taskId && proposal.status === "rejected");
    const rejectedIntegrationApproval = rejectedIntegration
      ? state.approvals.find((approval) => approval.id === rejectedIntegration.approvalId)
      : undefined;
    const priorChangeRun = (task.status === "in_progress" || Boolean(rejectedIntegration))
      ? state.runs.find((candidate) => candidate.taskId === taskId && candidate.status === "completed" && candidate.result?.status === "completed" && candidate.result.commits.length > 0 && ["implementation", "repair"].includes(candidate.spec.runPurpose ?? "implementation"))
      : undefined;
    const priorCommitByRepository = new Map(priorChangeRun?.result?.commits.map((commit) => [commit.repositoryId, commit.sha]) ?? []);
    const failedVerificationRuns = priorChangeRun
      ? state.runs.filter((candidate) => candidate.taskId === taskId && candidate.spec.runPurpose === "verification" && candidate.spec.upstreamArtifacts.includes(`implementation-run:${priorChangeRun.id}`) && candidate.result?.status !== "completed")
      : [];
    const verificationRound = priorChangeRun ? (priorChangeRun.spec.verificationRound ?? 0) + 1 : 0;
    const runSpec = {
      schemaVersion: runContractSchemaVersion,
      runId,
      projectId,
      taskId,
      agentRole: task.assignedRole,
      runPurpose: priorChangeRun ? "repair" as const : "implementation" as const,
      verificationRound,
      agentInstructions: state.agentConfigurations.find((configuration) => configuration.agentRole === task.assignedRole)?.rolePrompt ?? "",
      ...(workflowRecovery?.guidance ? { directorGuidance: workflowRecovery.guidance } : {}),
      brainProfile: {
        provider: profile.provider,
        harness: profile.harness,
        modelClass: profile.modelClass,
        credentialRef: profile.credentialRef,
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.reasoningLevel ? { reasoningLevel: profile.reasoningLevel } : {}),
      },
      repositories: repositories.map((repository, index) => ({
        repositoryId: repository!.id,
        checkoutPath: `/workspace/repos/${String(index + 1).padStart(2, "0")}-${repository!.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`,
        baseCommit: priorCommitByRepository.get(repository!.id) ?? getRepositoryHead(repository!.relativePath, options.workspaceRoot),
        ...(priorChangeRun ? { integrationBaseCommit: priorChangeRun.spec.repositories.find((candidate) => candidate.repositoryId === repository!.id)?.integrationBaseCommit ?? priorChangeRun.spec.repositories.find((candidate) => candidate.repositoryId === repository!.id)?.baseCommit ?? getRepositoryHead(repository!.relativePath, options.workspaceRoot) } : {}),
      })),
      objective: state.objectives.find((objective) => objective.id === task.objectiveId)?.description ?? task.title,
      taskDescription: priorChangeRun
        ? `${task.title}\n\nRepair the current implementation in response to these blocking findings:\n${[
          ...failedVerificationRuns.map((candidate) => `- ${candidate.spec.verificationCheck?.replaceAll("_", " ")}: ${candidate.result?.summary}`),
          ...(rejectedIntegrationApproval?.decisionNote ? [`- Director integration feedback: ${rejectedIntegrationApproval.decisionNote}`] : []),
        ].join("\n") || "- Re-run the implementation carefully and address the unresolved workflow findings."}`
        : `${task.title}\n\n${task.description}`.trim(),
      acceptanceCriteria: task.acceptanceCriteria,
        upstreamArtifacts: priorChangeRun ? [`implementation-run:${priorChangeRun.id}`] : [],
      permissions: {
        filesystem: "workspace-write" as const,
        networkPolicy: settings.planningNetworkPolicy,
        allowedTools: ["inspect_repository", "edit_files", "run_commands", "run_tests", "commit_changes"],
      },
      limits: {
        timeoutSeconds: settings.defaultRunTimeoutSeconds,
        retries: settings.defaultRunRetries,
        ...(settings.defaultTokenBudget === null ? {} : { tokenBudget: settings.defaultTokenBudget }),
        ...(settings.defaultCostBudgetCents === null ? {} : { costBudgetCents: settings.defaultCostBudgetCents }),
      },
    };
    try {
      const run = database.createAgentRun(profile.id, runSpec);
      database.createRunAttempt({ id: attemptId, runId, attemptNumber: 1 });
      const now = new Date();
      database.acquireTaskLease({
        taskId,
        runId,
        leaseToken,
        acquiredAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + (settings.defaultRunTimeoutSeconds * 10 + 60) * 1_000).toISOString(),
      });
      database.resolveTaskWorkflowRecovery(projectId, taskId);
      if (task.status === "ready") database.updateTaskStatus(projectId, taskId, "in_progress");
      appendRunEvent(database, runId, attemptId, 1, "run.queued", `${task.assignedRole.replaceAll("_", " ")} task run queued`);
      appendRunEvent(database, runId, attemptId, 2, "worker.provisioning", "Preparing isolated writable repository worktrees");
      const request: CodingRunRequest = {
        run: runSpec,
        repositorySources: repositories.map((repository) => ({
          repositoryId: repository!.id,
          name: repository!.name,
          ...(repository!.description ? { description: repository!.description } : {}),
          sourcePath: resolveRepositoryPath(options.workspaceRoot, repository!.relativePath),
        })),
      };
      void executeAgentTask(database, options.taskExecutor, request, attemptId, leaseToken);
      return context.json({ run }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start task run";
      return context.json({ error: "task_run_rejected", message } satisfies ApiError, 409);
    }
  });

  app.post("/api/projects/:projectId/tasks/:taskId/resume", (context) => {
    const projectId = context.req.param("projectId");
    const taskId = context.req.param("taskId");
    const project = database.getProject(projectId);
    const state = database.getOrchestrationState(projectId);
    const task = state?.tasks.find((candidate) => candidate.id === taskId);
    const recovery = database.getTaskWorkflowRecovery(projectId, taskId);
    if (!project || !state) return context.json({ error: "project_not_found", message: "Project not found" } satisfies ApiError, 404);
    if (!task) return context.json({ error: "task_not_found", message: "Task not found" } satisfies ApiError, 404);
    if (!recovery) return context.json({ error: "workflow_not_recoverable", message: "This task does not have an interrupted workflow to resume" } satisfies ApiError, 409);
    if (!["verification", "release"].includes(recovery.stage)) {
      return context.json({ error: "resume_with_agent", message: "Resume this implementation or repair through the task run endpoint" } satisfies ApiError, 409);
    }
    if (!options.taskExecutor) return context.json({ error: "controller_unavailable", message: "The trusted task worker controller is not configured" } satisfies ApiError, 503);
    if (state.runs.some((run) => run.taskId === taskId && ["queued", "provisioning", "running", "waiting"].includes(run.status))) {
      return context.json({ error: "task_busy", message: "This task already has an active agent run" } satisfies ApiError, 409);
    }
    const interruptedRun = database.getAgentRun(recovery.interruptedRunId);
    const referencedBaselineId = interruptedRun?.spec.upstreamArtifacts.find((artifact) => artifact.startsWith("implementation-run:"))?.slice("implementation-run:".length);
    const baseline = (referencedBaselineId ? database.getAgentRun(referencedBaselineId) : null)
      ?? database.listAgentRunsForTask(projectId, taskId).find((candidate) => candidate.status === "completed" && candidate.result?.status === "completed" && candidate.result.commits.length > 0 && ["implementation", "repair"].includes(candidate.spec.runPurpose ?? "implementation"));
    if (!baseline?.result) return context.json({ error: "recovery_baseline_missing", message: "The completed implementation commit needed to resume verification is unavailable" } satisfies ApiError, 409);
    try {
      for (const role of [
        ...(task.requiredChecks.qa ? ["qa_engineer" as const] : []),
        ...(task.requiredChecks.codeReview ? ["code_reviewer" as const] : []),
        ...(task.requiredChecks.security ? ["security_reviewer" as const] : []),
        "release_manager" as const,
      ]) resolveTaskExecutionProfile(database, projectId, role);
      const repositories = baseline.spec.repositories.map((runRepository) => {
        const repository = project.repositories.find((candidate) => candidate.id === runRepository.repositoryId);
        if (!repository?.enabled || !repository.available) throw new Error("Every task repository must be enabled and available before recovery");
        return repository;
      });
      const settings = database.getProjectSettings(projectId);
      if (!settings) throw new Error("Project settings not found");
      const leaseToken = randomUUID();
      const now = new Date();
      database.acquireTaskLease({
        taskId,
        runId: recovery.interruptedRunId,
        leaseToken,
        acquiredAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + (settings.defaultRunTimeoutSeconds * 10 + 60) * 1_000).toISOString(),
      });
      database.resolveTaskWorkflowRecovery(projectId, taskId);
      const request: CodingRunRequest = {
        run: {
          ...baseline.spec,
          ...(recovery.guidance ? { directorGuidance: recovery.guidance } : {}),
        },
        repositorySources: repositories.map((repository) => ({
          repositoryId: repository.id,
          name: repository.name,
          ...(repository.description ? { description: repository.description } : {}),
          sourcePath: resolveRepositoryPath(options.workspaceRoot, repository.relativePath),
        })),
      };
      const commitByRepository = new Map(baseline.result.commits.map((commit) => [commit.repositoryId, commit.sha]));
      const response: CodingRunResponse = {
        workerId: `recovered-${baseline.id}`,
        imageDigest: "preserved",
        providerThreadId: baseline.providerThreadId,
        result: baseline.result,
        branches: baseline.spec.repositories.flatMap((repository) => {
          const sha = commitByRepository.get(repository.repositoryId);
          return sha ? [{ repositoryId: repository.repositoryId, branch: `agent/${taskId.slice(0, 8)}-${baseline.id.slice(0, 8)}`, sha }] : [];
        }),
      };
      if (recovery.stage === "release") {
        void resumeReleaseManagerWorkflow(database, options.taskExecutor, request, leaseToken);
      } else {
        void resumeTaskVerificationWorkflow(database, options.taskExecutor, request, response, leaseToken);
      }
      return context.json({ recovery, baselineRunId: baseline.id }, 202);
    } catch (error) {
      return context.json({ error: "workflow_resume_rejected", message: error instanceof Error ? error.message : "Unable to resume workflow" } satisfies ApiError, 409);
    }
  });

  app.post("/api/projects/:projectId/tasks/:taskId/cancel", async (context) => {
    const projectId = context.req.param("projectId");
    const taskId = context.req.param("taskId");
    const state = database.getOrchestrationState(projectId);
    const task = state?.tasks.find((candidate) => candidate.id === taskId);
    if (!state) return context.json({ error: "project_not_found", message: "Project not found" } satisfies ApiError, 404);
    if (!task) return context.json({ error: "task_not_found", message: "Task not found" } satisfies ApiError, 404);
    const run = state.runs.find((candidate) => candidate.taskId === taskId && ["queued", "provisioning", "running", "waiting"].includes(candidate.status));
    if (!run) return context.json({ error: "active_run_not_found", message: "This task has no active agent run to cancel" } satisfies ApiError, 409);
    if (!options.taskExecutor?.stopTaskWorker) return context.json({ error: "controller_unavailable", message: "The trusted worker controller cannot cancel this run" } satisfies ApiError, 503);
    try {
      const reason = "Cancelled by the Engineering Director. Recorded activity was preserved and the workflow can be resumed.";
      const cancelledRun = database.cancelTaskRun(projectId, taskId, run.id, reason);
      let workerStopped = true;
      try {
        await options.taskExecutor.stopTaskWorker(run.id);
      } catch (error) {
        workerStopped = false;
        console.warn(`Cancelled run ${run.id} in the workflow store, but its worker could not be confirmed stopped`, error);
      }
      database.createAgentMessage({ id: randomUUID(), projectId, agentRole: run.agentRole, author: "system", body: reason });
      return context.json({ run: cancelledRun, recovery: database.getTaskWorkflowRecovery(projectId, taskId), workerStopped });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to cancel task run";
      return context.json({ error: "task_cancel_rejected", message } satisfies ApiError, 409);
    }
  });

  app.post("/api/projects/:projectId/tasks/:taskId/redirect", async (context) => {
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError, 400); }
    const parsed = redirectTaskSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "invalid_guidance", message: parsed.error.issues[0]?.message ?? "Guidance is required" } satisfies ApiError, 400);
    const projectId = context.req.param("projectId");
    const taskId = context.req.param("taskId");
    const state = database.getOrchestrationState(projectId);
    const task = state?.tasks.find((candidate) => candidate.id === taskId);
    if (!state) return context.json({ error: "project_not_found", message: "Project not found" } satisfies ApiError, 404);
    if (!task) return context.json({ error: "task_not_found", message: "Task not found" } satisfies ApiError, 404);
    const run = state.runs.find((candidate) => candidate.taskId === taskId && ["queued", "provisioning", "running", "waiting"].includes(candidate.status));
    if (!run) return context.json({ error: "active_run_not_found", message: "This task has no active run to redirect" } satisfies ApiError, 409);
    if (!options.taskExecutor?.stopTaskWorker) return context.json({ error: "controller_unavailable", message: "The trusted worker controller cannot redirect this run" } satisfies ApiError, 503);
    try {
      const reason = "Redirected by the Engineering Director. Recorded activity was preserved and the interrupted stage will restart with new guidance.";
      const cancelledRun = database.cancelTaskRun(projectId, taskId, run.id, reason, parsed.data.guidance);
      database.createAgentMessage({
        id: randomUUID(), projectId, agentRole: run.agentRole, author: "director",
        body: `Guidance for “${task.title}”\n\n${parsed.data.guidance}`,
      });
      try {
        await options.taskExecutor.stopTaskWorker(run.id);
      } catch (error) {
        console.warn(`Redirected run ${run.id}, but its worker could not be confirmed stopped`, error);
        return context.json({ error: "worker_stop_unconfirmed", message: "Your guidance was saved, but the worker could not be confirmed stopped. Use Resume workflow after checking the worker." } satisfies ApiError, 409);
      }
      const recovery = database.getTaskWorkflowRecovery(projectId, taskId);
      if (!recovery) throw new Error("The redirected workflow recovery point is unavailable");
      const restartEndpoint = ["verification", "release"].includes(recovery.stage)
        ? `/api/projects/${projectId}/tasks/${taskId}/resume`
        : `/api/projects/${projectId}/tasks/${taskId}/runs`;
      const restartResponse = await app.request(restartEndpoint, { method: "POST" });
      if (!restartResponse.ok) {
        const restartBody = await restartResponse.json() as { message?: unknown };
        const message = typeof restartBody.message === "string" ? restartBody.message : "The redirected workflow could not restart";
        return context.json({ error: "guidance_restart_failed", message: `Your guidance was saved. ${message}` } satisfies ApiError, 409);
      }
      return context.json({ run: cancelledRun, guidance: parsed.data.guidance, restarted: true }, 202);
    } catch (error) {
      return context.json({ error: "task_redirect_rejected", message: error instanceof Error ? error.message : "Unable to redirect task" } satisfies ApiError, 409);
    }
  });

  app.post("/api/projects/:projectId/tasks/:taskId/apply", async (context) => {
    const projectId = context.req.param("projectId");
    const taskId = context.req.param("taskId");
    const state = database.getOrchestrationState(projectId);
    const task = state?.tasks.find((candidate) => candidate.id === taskId);
    if (!state) {
      return context.json({ error: "project_not_found", message: "Project not found" } satisfies ApiError, 404);
    }
    if (!task) {
      return context.json({ error: "task_not_found", message: "Task not found" } satisfies ApiError, 404);
    }
    return context.json({
      error: "integration_approval_required",
      message: "Verified changes can only be applied by approving the Release Manager's integration proposal.",
    } satisfies ApiError, 409);
  });

  app.post("/api/projects/:projectId/tasks/:taskId/rerun", (context) => {
    const projectId = context.req.param("projectId");
    const taskId = context.req.param("taskId");
    const state = database.getOrchestrationState(projectId);
    const task = state?.tasks.find((candidate) => candidate.id === taskId);
    if (!state) {
      return context.json({ error: "project_not_found", message: "Project not found" } satisfies ApiError, 404);
    }
    if (!task) {
      return context.json({ error: "task_not_found", message: "Task not found" } satisfies ApiError, 404);
    }
    const review = buildTaskReviews(state, options.workspaceRoot).find((candidate) => candidate.taskId === taskId);
    const rejectedIntegration = state.integrationProposals.find((proposal) => proposal.taskId === taskId && proposal.status === "rejected");
    if (review?.state !== "stale" && !rejectedIntegration) {
      return context.json({ error: "task_not_rerunnable", message: "Only a stale or rejected integration can be re-run" } satisfies ApiError, 409);
    }
    try {
      return context.json({ task: database.requeueTask(projectId, taskId) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Task could not be requeued";
      return context.json({ error: "task_rerun_rejected", message } satisfies ApiError, 409);
    }
  });

  app.patch("/api/projects/:projectId/tasks/:taskId/status", async (context) => {
    let body: UpdateTaskStatusInput;
    try {
      body = await context.req.json<UpdateTaskStatusInput>();
    } catch {
      return context.json(
        { error: "invalid_json", message: "Request body must be valid JSON" } satisfies ApiError,
        400,
      );
    }
    const parsed = updateTaskStatusSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        { error: "invalid_status", message: parsed.error.issues[0]?.message ?? "Invalid status" } satisfies ApiError,
        400,
      );
    }

    try {
      if (parsed.data.status === "completed") {
        const state = database.getOrchestrationState(context.req.param("projectId"));
        const review = state
          ? buildTaskReviews(state, options.workspaceRoot).find((candidate) => candidate.taskId === context.req.param("taskId"))
          : undefined;
        if (review && ["applicable", "stale"].includes(review.state)) {
          return context.json({
            error: "task_changes_not_applied",
            message: review.state === "stale"
              ? "This task is stale and must be re-run on the current branch"
              : "Apply the reviewed branch before completing this task",
          } satisfies ApiError, 409);
        }
      }
      const task = database.updateTaskStatus(
        context.req.param("projectId"),
        context.req.param("taskId"),
        parsed.data.status,
      );
      return context.json({ task });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update task";
      return context.json(
        { error: "task_transition_rejected", message } satisfies ApiError,
        message === "Task not found" ? 404 : 409,
      );
    }
  });

  if (options.staticRoot) {
    const staticRoot = relative(process.cwd(), resolve(options.staticRoot));
    app.use("/*", serveStatic({ root: staticRoot }));
    const serveIndex = serveStatic({ root: staticRoot, path: "index.html" });
    app.get("*", async (context, next) => {
      if (context.req.path.startsWith("/api/")) {
        return context.json(
          { error: "not_found", message: "API route not found" } satisfies ApiError,
          404,
        );
      }
      const response = await serveIndex(context, next);
      return response ?? context.notFound();
    });
  }

  return app;
}

async function executeProjectManagerPlanning(
  database: TeamDatabase,
  executor: PlanningExecutor,
  request: PlanningRunRequest,
  attemptId: string,
): Promise<void> {
  const { run } = request;
  const startedAt = Date.now();
  try {
    database.markRunAttemptRunning(
      attemptId,
      `engineering-team-run-${run.runId}`,
      "configured-worker-image",
    );
    appendRunEvent(database, run.runId, attemptId, 3, "worker.started", "Disposable worker started");
    appendRunEvent(database, run.runId, attemptId, 4, "harness.connected", "Codex planning harness connected");
    let execution = await executePlanningWithRuntimeFallback(database, executor, request, attemptId);
    let effectiveRequest = execution.request;
    let response = execution.response;
    let parsedResponse = projectManagerResponseSchema.safeParse(response.proposal);
    if (!parsedResponse.success) {
      throw new Error(parsedResponse.error.issues[0]?.message ?? "Project Manager returned an invalid response");
    }
    let managerResponse = parsedResponse.data;
    if (managerResponse.intent === "consultation") {
      if (!executor.consult) throw new Error("The worker controller does not support agent consultations");
      const requestedRoles = new Set<AgentRole>();
      for (const consultation of managerResponse.consultationRequests) {
        if (!request.availableConsultants.includes(consultation.agentRole)) throw new Error(`Project Manager requested an unconfigured consultant: ${consultation.agentRole}`);
        if (consultation.agentRole === "project_manager") throw new Error("Project Manager cannot consult itself");
        if (requestedRoles.has(consultation.agentRole)) throw new Error(`Project Manager requested ${consultation.agentRole} more than once`);
        requestedRoles.add(consultation.agentRole);
      }
      appendNextRunEvent(database, run.runId, attemptId, "agent.waiting", `Project Manager requested ${managerResponse.consultationRequests.length} consultation${managerResponse.consultationRequests.length === 1 ? "" : "s"}`);
      const consultationResults: AgentConsultationResult[] = [];
      for (const consultation of managerResponse.consultationRequests) {
        consultationResults.push(await executeAgentConsultation(database, executor, effectiveRequest, consultation.agentRole, consultation.question));
      }
      appendNextRunEvent(database, run.runId, attemptId, "agent.message", "Planning consultations completed", { consultedRoles: consultationResults.map((result) => result.agentRole) });
      execution = await executePlanningWithRuntimeFallback(database, executor, { ...effectiveRequest, consultationResults }, attemptId);
      effectiveRequest = execution.request;
      response = execution.response;
      parsedResponse = projectManagerResponseSchema.safeParse(response.proposal);
      if (!parsedResponse.success) throw new Error(parsedResponse.error.issues[0]?.message ?? "Project Manager returned an invalid response after consultation");
      managerResponse = parsedResponse.data;
      if (managerResponse.intent === "consultation") throw new Error("Project Manager requested another consultation round instead of finalizing its response");
    }
    const activeDirectiveIds = new Set(request.directives.map((directive) => directive.id));
    for (const action of managerResponse.directiveActions) {
      if (action.action === "remove" && !activeDirectiveIds.has(action.directiveId)) {
        throw new Error(`Project Manager tried to remove an unknown directive: ${action.directiveId}`);
      }
    }

    let plan: CreatePlanResponse | null = null;
    if (managerResponse.intent === "plan") {
      const parsedPlan = createPlanSchema.safeParse({ objective: managerResponse.objective, tasks: managerResponse.tasks });
      if (!parsedPlan.success) {
        throw new Error(parsedPlan.error.issues[0]?.message ?? "Project Manager returned an invalid plan");
      }
      plan = database.createPlan({
        projectId: run.projectId,
        objective: { id: randomUUID(), ...parsedPlan.data.objective },
        tasks: parsedPlan.data.tasks.map((task) => ({ id: randomUUID(), ...task })),
        approvalId: randomUUID(),
        contextUpdates: managerResponse.contextUpdates.map((update) => ({ id: randomUUID(), ...update, proposedByRole: "project_manager" as const })),
      });
    }

    const changedDirectives: string[] = [];
    for (const action of managerResponse.directiveActions) {
      if (action.action === "add") {
        const directive = database.createAgentDirective({
          id: randomUUID(),
          projectId: run.projectId,
          agentRole: "project_manager",
          content: action.content,
          sourceMessageId: request.directorMessageId,
        });
        changedDirectives.push(`directive:${directive.id}`);
      } else {
        database.removeAgentDirective(run.projectId, "project_manager", action.directiveId);
        changedDirectives.push(`directive-removed:${action.directiveId}`);
      }
    }

    const reply = plan
      ? `${managerResponse.assistantMessage}\n\nI created ${plan.tasks.length} proposed task${plan.tasks.length === 1 ? "" : "s"}${plan.contextUpdates.length ? ` and ${plan.contextUpdates.length} proposed context update${plan.contextUpdates.length === 1 ? "" : "s"}` : ""}, and sent the plan for your approval.`
      : managerResponse.assistantMessage;
    database.createAgentMessage({
      id: randomUUID(),
      projectId: run.projectId,
      agentRole: "project_manager",
      author: "agent",
      body: reply,
    });
    appendNextRunEvent(database, run.runId, attemptId, "agent.message", "Project Manager returned a validated response", {
      intent: managerResponse.intent,
      directiveChanges: changedDirectives.length,
      ...(plan ? { objectiveId: plan.objective.id, approvalId: plan.approval.id, taskCount: plan.tasks.length } : {}),
    });
    const result: RunResult = {
      schemaVersion: runContractSchemaVersion,
      status: "completed",
      summary: reply,
      changedFiles: [],
      commits: [],
      checks: [{ command: "validate_project_manager_response", status: "passed" }],
      acceptanceCriteria: run.acceptanceCriteria.map((criterion) => ({
        criterion,
        satisfied: true,
        evidence: plan
          ? "The proposal passed server-side validation and entered director approval."
          : "The conversational response and any directive changes passed server-side validation.",
      })),
      questions: [],
      risks: [],
      artifacts: changedDirectives,
      ...(response.usage ? { usage: response.usage } : {}),
    };
    database.completeAgentRun(run.runId, attemptId, result);
    if (response.usage) {
      database.recordRunUsage({
        id: randomUUID(),
        runId: run.runId,
        attemptId,
        provider: effectiveRequest.run.brainProfile.provider,
        model: effectiveRequest.run.brainProfile.model ?? null,
        inputTokens: response.usage.inputTokens ?? 0,
        cachedInputTokens: response.usage.cachedInputTokens ?? 0,
        outputTokens: response.usage.outputTokens ?? 0,
        reasoningOutputTokens: response.usage.reasoningOutputTokens ?? 0,
        costCents: null,
        durationMs: Date.now() - startedAt,
      });
    }
    appendNextRunEvent(database, run.runId, attemptId, "run.completed", "Project Manager response completed");
  } catch (error) {
    if (database.getAgentRun(run.runId)?.status === "cancelled") return;
    const message = error instanceof Error ? error.message : "Planning run failed";
    const result: RunResult = {
      schemaVersion: runContractSchemaVersion,
      status: "failed",
      summary: message,
      changedFiles: [],
      commits: [],
      checks: [{ command: "validate_project_manager_response", status: "failed" }],
      acceptanceCriteria: run.acceptanceCriteria.map((criterion) => ({ criterion, satisfied: false, evidence: message })),
      questions: [],
      risks: [message],
      artifacts: [],
    };
    try {
      database.completeAgentRun(run.runId, attemptId, result);
      database.createAgentMessage({
        id: randomUUID(),
        projectId: run.projectId,
        agentRole: "project_manager",
        author: "system",
        body: `Project Manager run failed: ${message}`,
      });
      appendNextRunEvent(database, run.runId, attemptId, "run.failed", message);
    } catch (persistenceError) {
      console.error("Unable to persist planning failure", persistenceError);
    }
  }
}

async function executeAgentConsultation(
  database: TeamDatabase,
  executor: PlanningExecutor,
  planningRequest: PlanningRunRequest,
  agentRole: AgentRole,
  question: string,
): Promise<AgentConsultationResult> {
  if (!executor.consult) throw new Error("The worker controller does not support agent consultations");
  const state = database.getOrchestrationState(planningRequest.run.projectId);
  const settings = database.getProjectSettings(planningRequest.run.projectId);
  if (!state || !settings) throw new Error("Project state is unavailable for consultation");
  const profile = resolveReadOnlyAgentProfile(database, planningRequest.run.projectId, agentRole);
  const runId = randomUUID();
  const attemptId = randomUUID();
  const runSpec = {
    schemaVersion: runContractSchemaVersion,
    runId,
    projectId: planningRequest.run.projectId,
    agentRole,
    agentInstructions: state.agentConfigurations.find((configuration) => configuration.agentRole === agentRole)?.rolePrompt ?? "",
    brainProfile: {
      provider: profile.provider,
      harness: profile.harness,
      modelClass: profile.modelClass,
      credentialRef: profile.credentialRef,
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.reasoningLevel ? { reasoningLevel: profile.reasoningLevel } : {}),
    },
    repositories: planningRequest.run.repositories,
    objective: planningRequest.run.objective,
    taskDescription: question,
    acceptanceCriteria: ["Provide focused planning advice to the requesting agent"],
    upstreamArtifacts: [],
    permissions: {
      filesystem: "read-only" as const,
      networkPolicy: settings.planningNetworkPolicy,
      allowedTools: ["inspect_repository", "respond_to_request"],
    },
    limits: planningRequest.run.limits,
  };
  database.createAgentRun(profile.id, runSpec);
  database.createRunAttempt({ id: attemptId, runId, attemptNumber: 1 });
  appendRunEvent(database, runId, attemptId, 1, "run.queued", `${agentRole.replaceAll("_", " ")} consultation queued`);
  appendRunEvent(database, runId, attemptId, 2, "worker.provisioning", "Preparing an isolated read-only consultation worker");
  const startedAt = Date.now();
  try {
    database.markRunAttemptRunning(attemptId, `engineering-team-consultation-${runId}`, "configured-worker-image");
    appendRunEvent(database, runId, attemptId, 3, "worker.started", "Disposable consultation worker started");
    appendRunEvent(database, runId, attemptId, 4, "harness.connected", "Consultant planning harness connected");
    const consultationRequest: ConsultationRunRequest = {
      run: runSpec,
      requestingRole: "project_manager",
      question,
      directives: state.directives.filter((directive) => directive.agentRole === agentRole),
      conversation: state.messages.filter((message) => message.agentRole === agentRole).slice(-20).map(({ author, body }) => ({ author, body })),
      projectContext: planningRequest.projectContext,
      repositoryContexts: planningRequest.repositoryContexts,
      repositorySources: planningRequest.repositorySources,
    };
    const execution = await executeConsultationWithRuntimeFallback(database, executor, consultationRequest, attemptId, (event) => {
      appendNextRunEvent(database, runId, attemptId, event.type, event.message, event.payload, event.createdAt);
    });
    const { response } = execution;
    const result: RunResult = {
      schemaVersion: runContractSchemaVersion,
      status: "completed",
      summary: response.response,
      changedFiles: [],
      commits: [],
      checks: [{ command: "validate_consultation_response", status: "passed" }],
      acceptanceCriteria: [{ criterion: "Provide focused planning advice to the requesting agent", satisfied: true, evidence: "A structured consultation response was returned." }],
      questions: [],
      risks: [],
      artifacts: [`consultation-for:${planningRequest.run.runId}`, ...response.contextUpdates.map((update) => `context-suggestion:${update.repositoryId ?? "project"}`)],
      ...(response.usage ? { usage: response.usage } : {}),
    };
    database.completeAgentRun(runId, attemptId, result);
    database.createAgentMessage({
      id: randomUUID(),
      projectId: planningRequest.run.projectId,
      agentRole,
      author: "agent",
      body: `Consulted by the Project Manager\n\n${response.response}`,
    });
    if (response.usage) database.recordRunUsage({
      id: randomUUID(), runId, attemptId, provider: execution.request.run.brainProfile.provider, model: execution.request.run.brainProfile.model ?? null,
      inputTokens: response.usage.inputTokens ?? 0, cachedInputTokens: response.usage.cachedInputTokens ?? 0,
      outputTokens: response.usage.outputTokens ?? 0, reasoningOutputTokens: response.usage.reasoningOutputTokens ?? 0,
      costCents: null, durationMs: Date.now() - startedAt,
    });
    appendNextRunEvent(database, runId, attemptId, "agent.message", "Consultation advice returned");
    appendNextRunEvent(database, runId, attemptId, "run.completed", "Agent consultation completed");
    return { agentRole, question, response: response.response, contextUpdates: response.contextUpdates };
  } catch (error) {
    if (database.getAgentRun(runId)?.status === "cancelled") throw error;
    const message = error instanceof Error ? error.message : "Agent consultation failed";
    database.completeAgentRun(runId, attemptId, {
      schemaVersion: runContractSchemaVersion, status: "failed", summary: message, changedFiles: [], commits: [],
      checks: [{ command: "validate_consultation_response", status: "failed" }],
      acceptanceCriteria: [{ criterion: "Provide focused planning advice to the requesting agent", satisfied: false, evidence: message }],
      questions: [], risks: [message], artifacts: [`consultation-for:${planningRequest.run.runId}`],
    });
    appendNextRunEvent(database, runId, attemptId, "run.failed", message);
    throw error;
  }
}

async function executeDirectorAgentConversation(
  database: TeamDatabase,
  executor: PlanningExecutor,
  request: ConsultationRunRequest,
  attemptId: string,
  sourceMessageId: string,
): Promise<void> {
  const { run } = request;
  const startedAt = Date.now();
  try {
    if (!executor.consult) throw new Error("The worker controller does not support agent conversations");
    database.markRunAttemptRunning(attemptId, `engineering-team-consultation-${run.runId}`, "configured-worker-image");
    appendRunEvent(database, run.runId, attemptId, 3, "worker.started", "Disposable read-only conversation worker started");
    appendRunEvent(database, run.runId, attemptId, 4, "harness.connected", "Agent conversation harness connected");
    const execution = await executeConsultationWithRuntimeFallback(database, executor, request, attemptId, (event) => {
      if (database.getAgentRun(run.runId)?.status !== "cancelled") {
        appendNextRunEvent(database, run.runId, attemptId, event.type, event.message, event.payload, event.createdAt);
      }
    });
    const { response } = execution;
    if (response.contextUpdates.length > 0) throw new Error("Direct agent conversations cannot update project context");
    const parsedDirectiveActions = z.array(directiveActionSchema).max(20).safeParse(response.directiveActions ?? []);
    if (!parsedDirectiveActions.success) throw new Error(parsedDirectiveActions.error.issues[0]?.message ?? "Agent returned invalid directive changes");
    const directiveActions = parsedDirectiveActions.data;
    const activeDirectiveIds = new Set(request.directives.map((directive) => directive.id));
    for (const action of directiveActions) {
      if (action.action === "remove" && !activeDirectiveIds.has(action.directiveId)) throw new Error("Agent tried to remove an unknown standing directive");
      if (action.action === "add") {
        database.createAgentDirective({ id: randomUUID(), projectId: run.projectId, agentRole: run.agentRole, content: action.content, sourceMessageId });
      } else {
        database.removeAgentDirective(run.projectId, run.agentRole, action.directiveId);
      }
    }
    database.createAgentMessage({ id: randomUUID(), projectId: run.projectId, agentRole: run.agentRole, author: "agent", body: response.response });
    const result: RunResult = {
      schemaVersion: runContractSchemaVersion, status: "completed", summary: response.response, changedFiles: [], commits: [],
      checks: [{ command: "validate_agent_conversation", status: "passed" }],
      acceptanceCriteria: run.acceptanceCriteria.map((criterion) => ({ criterion, satisfied: true, evidence: "A validated read-only agent response was returned." })),
      questions: [], risks: [], artifacts: directiveActions.map((action) => `directive-${action.action}:${action.directiveId ?? "new"}`),
      ...(response.usage ? { usage: response.usage } : {}),
    };
    database.completeAgentRun(run.runId, attemptId, result);
    if (response.usage) database.recordRunUsage({
      id: randomUUID(), runId: run.runId, attemptId, provider: execution.request.run.brainProfile.provider, model: execution.request.run.brainProfile.model ?? null,
      inputTokens: response.usage.inputTokens ?? 0, cachedInputTokens: response.usage.cachedInputTokens ?? 0,
      outputTokens: response.usage.outputTokens ?? 0, reasoningOutputTokens: response.usage.reasoningOutputTokens ?? 0,
      costCents: null, durationMs: Date.now() - startedAt,
    });
    appendNextRunEvent(database, run.runId, attemptId, "agent.message", `${run.agentRole.replaceAll("_", " ")} replied`);
    appendNextRunEvent(database, run.runId, attemptId, "run.completed", "Agent conversation completed");
  } catch (error) {
    if (database.getAgentRun(run.runId)?.status === "cancelled") return;
    const message = error instanceof Error ? error.message : "Agent conversation failed";
    try {
      database.completeAgentRun(run.runId, attemptId, {
        schemaVersion: runContractSchemaVersion, status: "failed", summary: message, changedFiles: [], commits: [],
        checks: [{ command: "validate_agent_conversation", status: "failed" }],
        acceptanceCriteria: run.acceptanceCriteria.map((criterion) => ({ criterion, satisfied: false, evidence: message })),
        questions: [], risks: [message], artifacts: [],
      });
      database.createAgentMessage({ id: randomUUID(), projectId: run.projectId, agentRole: run.agentRole, author: "system", body: `Agent conversation failed: ${message}` });
      appendNextRunEvent(database, run.runId, attemptId, "run.failed", message);
    } catch (persistenceError) {
      console.error("Unable to persist agent conversation failure", persistenceError);
    }
  }
}

function resolveReadOnlyAgentProfile(database: TeamDatabase, projectId: string, agentRole: AgentRole, selection: "primary" | "fallback" = "primary") {
  const assignment = database.getAgentRuntimeAssignment(projectId, agentRole);
  const harnessId = selection === "fallback" ? assignment?.fallbackCodingHarnessId : assignment?.codingHarnessId;
  const backendId = selection === "fallback" ? assignment?.fallbackModelBackendId : assignment?.modelBackendId;
  if (!harnessId || !backendId) throw new Error(`${selection === "fallback" ? "Assign a fallback harness and model" : "Assign a harness and model"} to ${agentRole.replaceAll("_", " ")} before starting a conversation`);
  const harness = database.getCodingHarness(projectId, harnessId);
  const backend = database.getModelBackend(projectId, backendId);
  if (!harness || !backend || !harness.enabled || !backend.enabled) throw new Error(`The ${agentRole.replaceAll("_", " ")} conversation runtime is missing or disabled`);
  if (!harness.supportedProtocols.includes(backend.protocol)) throw new Error(`${harness.name} does not support the ${backend.protocol} model protocol`);
  if (harness.adapter !== "codex" || !harness.capabilities.includes("planning") || backend.provider !== "openai" || backend.protocol !== "openai-responses") {
    throw new Error(`${agentRole.replaceAll("_", " ")} conversations currently require a Codex planning harness and OpenAI Responses model`);
  }
  const credentialRef = backend.authMode === "chatgpt" ? "CODEX_ACCESS_TOKEN" : backend.credentialRef;
  if (!credentialRef) throw new Error(`The ${agentRole.replaceAll("_", " ")} model does not have an authentication method`);
  const record = {
    id: selection === "primary" ? `runtime-${projectId}-${agentRole}` : `runtime-fallback-${projectId}-${agentRole}`,
    projectId,
    name: `${selection === "fallback" ? "Fallback runtime" : "Runtime assignment"}: ${agentRole}`,
    provider: backend.provider,
    harness: harness.adapter,
    modelClass: "planning",
    credentialRef,
    ...(backend.model ? { model: backend.model } : {}),
    configuration: { source: "agent_runtime_assignment", selection, codingHarnessId: harness.id, modelBackendId: backend.id, authMode: backend.authMode, protocol: backend.protocol, ...(backend.baseUrl ? { baseUrl: backend.baseUrl } : {}) },
  };
  return database.getBrainProfile(record.id) ? database.updateBrainProfile(record) : database.createBrainProfile(record);
}

function buildTaskReviews(state: OrchestrationState, workspaceRoot: string): TaskReviewSummary[] {
  const reviews: TaskReviewSummary[] = [];
  for (const task of state.tasks) {
    if (!['review', 'completed'].includes(task.status)) continue;
    const changeRun = state.runs.find((candidate) =>
      candidate.taskId === task.id && candidate.status === "completed" && candidate.result?.status === "completed" && candidate.result.commits.length > 0 && ["implementation", "repair"].includes(candidate.spec.runPurpose ?? "implementation")
    );
    const reportRun = task.status === "completed"
      ? state.runs.find((candidate) =>
        candidate.taskId === task.id && candidate.status === "completed" && candidate.result?.status === "completed" && candidate.result.commits.length === 0 && candidate.spec.runPurpose !== "verification" && reportOnlyTaskRoles.has(candidate.agentRole)
      )
      : undefined;
    const run = changeRun ?? reportRun;
    if (!run?.result) continue;
    const branches = [...new Set(
      run.result.artifacts.filter((artifact) => artifact.startsWith("git:")).map((artifact) => artifact.slice(4)),
    )];
    const appliedBranches = new Set(
      run.result.artifacts.filter((artifact) => artifact.startsWith("applied:")).map((artifact) => artifact.slice(8)),
    );
    if (branches.length === 0) {
      reviews.push({
        taskId: task.id,
        runId: run.id,
        state: "report-only",
        branches: [],
        message: "This run completed with evidence only and has no code changes to apply.",
      });
      continue;
    }
    if (branches.every((branch) => appliedBranches.has(branch))) {
      reviews.push({
        taskId: task.id,
        runId: run.id,
        state: "applied",
        branches,
        message: "The reviewed branch has been applied to the checked-out repository branch.",
      });
      continue;
    }
    const stale = run.spec.repositories.some((runRepository) => {
      const repository = state.project.repositories.find((candidate) => candidate.id === runRepository.repositoryId);
      if (!repository?.available) return true;
      try {
        return getRepositoryHead(repository.relativePath, workspaceRoot) !== (runRepository.integrationBaseCommit ?? runRepository.baseCommit);
      } catch {
        return true;
      }
    });
    reviews.push({
      taskId: task.id,
      runId: run.id,
      state: stale ? "stale" : "applicable",
      branches,
      message: stale
        ? "The repository changed after this run started. Re-run the task on the current branch."
        : "The reviewed branch can be fast-forwarded onto the current repository branch.",
    });
  }
  return reviews;
}

function buildApplyRepositories(
  state: OrchestrationState,
  run: OrchestrationState["runs"][number],
  workspaceRoot: string,
): ApplyCodingRunRequest["repositories"] {
  if (!run.taskId || !run.result?.commits.length) throw new Error("The reviewed run has no changes to integrate");
  const commitByRepository = new Map(run.result.commits.map((commit) => [commit.repositoryId, commit.sha]));
  return run.spec.repositories.map((runRepository) => {
    const repository = state.project.repositories.find((candidate) => candidate.id === runRepository.repositoryId);
    const sha = commitByRepository.get(runRepository.repositoryId);
    if (!repository || !sha) throw new Error("The reviewed run is missing repository commit information");
    return {
      repositoryId: repository.id,
      name: repository.name,
      sourcePath: resolveRepositoryPath(workspaceRoot, repository.relativePath),
      branch: `agent/${run.taskId!.slice(0, 8)}-${run.id.slice(0, 8)}`,
      sha,
      baseCommit: runRepository.integrationBaseCommit ?? runRepository.baseCommit,
    };
  });
}

const verificationRoles: Record<VerificationCheck, AgentRole> = {
  qa: "qa_engineer",
  code_review: "code_reviewer",
  security: "security_reviewer",
};

function resolveTaskExecutionProfile(database: TeamDatabase, projectId: string, agentRole: AgentRole, selection: "primary" | "fallback" = "primary") {
  const assignment = database.getAgentRuntimeAssignment(projectId, agentRole);
  const harnessId = selection === "fallback" ? assignment?.fallbackCodingHarnessId : assignment?.codingHarnessId;
  const backendId = selection === "fallback" ? assignment?.fallbackModelBackendId : assignment?.modelBackendId;
  if (!harnessId || !backendId) throw new Error(`${selection === "fallback" ? "Assign a fallback harness and model" : "Assign a harness and model"} to ${agentRole.replaceAll("_", " ")} before its required check can run`);
  const harness = database.getCodingHarness(projectId, harnessId);
  const backend = database.getModelBackend(projectId, backendId);
  if (!harness || !backend || !harness.enabled || !backend.enabled) throw new Error(`The ${agentRole.replaceAll("_", " ")} runtime is missing or disabled`);
  if (!harness.supportedProtocols.includes(backend.protocol)) throw new Error(`${harness.name} does not support the ${backend.protocol} model protocol`);
  if (harness.adapter !== "codex" || !harness.capabilities.includes("coding") || backend.provider !== "openai" || backend.protocol !== "openai-responses") throw new Error(`${agentRole.replaceAll("_", " ")} execution currently requires a Codex coding harness and OpenAI Responses model`);
  const credentialRef = backend.authMode === "chatgpt" ? "CODEX_ACCESS_TOKEN" : backend.credentialRef;
  if (!credentialRef) throw new Error(`The ${agentRole.replaceAll("_", " ")} model does not have an authentication method`);
  const record = {
    id: selection === "primary" ? `runtime-${projectId}-${agentRole}` : `runtime-fallback-${projectId}-${agentRole}`,
    projectId,
    name: `${selection === "fallback" ? "Fallback runtime" : "Runtime assignment"}: ${agentRole}`,
    provider: backend.provider,
    harness: harness.adapter,
    modelClass: "coding",
    credentialRef,
    ...(backend.model ? { model: backend.model } : {}),
    configuration: { source: "agent_runtime_assignment", selection, codingHarnessId: harness.id, modelBackendId: backend.id, authMode: backend.authMode, protocol: backend.protocol, ...(backend.baseUrl ? { baseUrl: backend.baseUrl } : {}) },
  };
  return database.getBrainProfile(record.id) ? database.updateBrainProfile(record) : database.createBrainProfile(record);
}

function runtimeProfileRef(profile: ReturnType<typeof resolveTaskExecutionProfile>) {
  return {
    provider: profile.provider,
    harness: profile.harness,
    modelClass: profile.modelClass,
    credentialRef: profile.credentialRef,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.reasoningLevel ? { reasoningLevel: profile.reasoningLevel } : {}),
  };
}

function fallbackEligibleReason(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:quota|usage limit|rate[ _-]?limit|too many requests|\b429\b|unauthori[sz]ed|forbidden|authentication|access token|\b401\b|\b403\b|model.{0,30}(?:unavailable|not found)|provider.{0,30}unavailable|service unavailable|overloaded|capacity|temporarily unavailable|connection (?:failed|refused|reset)|network error|timed? out|timeout|\b5\d\d\b)/i.test(message)
    ? message
    : null;
}

function sameRuntime(left: CodingRunRequest["run"]["brainProfile"], right: CodingRunRequest["run"]["brainProfile"]): boolean {
  return left.provider === right.provider
    && left.harness === right.harness
    && left.credentialRef === right.credentialRef
    && left.model === right.model;
}

function resolveFallbackProfileRef(database: TeamDatabase, projectId: string, agentRole: AgentRole, modelClass: "planning" | "coding") {
  const assignment = database.getAgentRuntimeAssignment(projectId, agentRole);
  if (!assignment?.fallbackCodingHarnessId || !assignment.fallbackModelBackendId) return null;
  const profile = modelClass === "planning"
    ? resolveReadOnlyAgentProfile(database, projectId, agentRole, "fallback")
    : resolveTaskExecutionProfile(database, projectId, agentRole, "fallback");
  return runtimeProfileRef(profile);
}

async function executeTaskWithRuntimeFallback(
  database: TeamDatabase,
  executor: TaskExecutor,
  request: CodingRunRequest,
  attemptId: string,
  onEvent: Parameters<TaskExecutor["executeTask"]>[1],
): Promise<{ response: CodingRunResponse; request: CodingRunRequest }> {
  try {
    return { response: await executor.executeTask(request, onEvent), request };
  } catch (error) {
    const reason = fallbackEligibleReason(error);
    const fallback = resolveFallbackProfileRef(database, request.run.projectId, request.run.agentRole, "coding");
    if (!reason || !fallback || sameRuntime(request.run.brainProfile, fallback)) throw error;
    appendNextRunEvent(database, request.run.runId, attemptId, "runtime.fallback", `Primary runtime failed; retrying with ${fallback.model ?? fallback.provider}`, {
      reason,
      provider: fallback.provider,
      harness: fallback.harness,
      model: fallback.model ?? null,
    });
    const fallbackRequest = { ...request, run: { ...request.run, brainProfile: fallback } };
    return { response: await executor.executeTask(fallbackRequest, onEvent), request: fallbackRequest };
  }
}

async function executeConsultationWithRuntimeFallback(
  database: TeamDatabase,
  executor: PlanningExecutor,
  request: ConsultationRunRequest,
  attemptId: string,
  onEvent?: Parameters<NonNullable<PlanningExecutor["consult"]>>[1],
): Promise<{ response: Awaited<ReturnType<NonNullable<PlanningExecutor["consult"]>>>; request: ConsultationRunRequest }> {
  if (!executor.consult) throw new Error("The worker controller does not support agent conversations");
  try {
    return { response: await executor.consult(request, onEvent), request };
  } catch (error) {
    const reason = fallbackEligibleReason(error);
    const fallback = resolveFallbackProfileRef(database, request.run.projectId, request.run.agentRole, "planning");
    if (!reason || !fallback || sameRuntime(request.run.brainProfile, fallback)) throw error;
    appendNextRunEvent(database, request.run.runId, attemptId, "runtime.fallback", `Primary runtime failed; retrying with ${fallback.model ?? fallback.provider}`, {
      reason,
      provider: fallback.provider,
      harness: fallback.harness,
      model: fallback.model ?? null,
    });
    const fallbackRequest = { ...request, run: { ...request.run, brainProfile: fallback } };
    return { response: await executor.consult(fallbackRequest, onEvent), request: fallbackRequest };
  }
}

async function executePlanningWithRuntimeFallback(
  database: TeamDatabase,
  executor: PlanningExecutor,
  request: PlanningRunRequest,
  attemptId: string,
): Promise<{ response: Awaited<ReturnType<PlanningExecutor["execute"]>>; request: PlanningRunRequest }> {
  try {
    return { response: await executor.execute(request), request };
  } catch (error) {
    const reason = fallbackEligibleReason(error);
    const fallback = resolveFallbackProfileRef(database, request.run.projectId, request.run.agentRole, "planning");
    if (!reason || !fallback || sameRuntime(request.run.brainProfile, fallback)) throw error;
    appendNextRunEvent(database, request.run.runId, attemptId, "runtime.fallback", `Primary runtime failed; retrying with ${fallback.model ?? fallback.provider}`, {
      reason,
      provider: fallback.provider,
      harness: fallback.harness,
      model: fallback.model ?? null,
    });
    const fallbackRequest = { ...request, run: { ...request.run, brainProfile: fallback } };
    return { response: await executor.execute(fallbackRequest), request: fallbackRequest };
  }
}

async function executeManagedChildRun(
  database: TeamDatabase,
  executor: TaskExecutor,
  request: CodingRunRequest,
): Promise<CodingRunResponse> {
  const { run } = request;
  const attemptId = randomUUID();
  const profile = resolveTaskExecutionProfile(database, run.projectId, run.agentRole);
  database.createAgentRun(profile.id, run);
  database.createRunAttempt({ id: attemptId, runId: run.runId, attemptNumber: 1 });
  appendRunEvent(database, run.runId, attemptId, 1, "run.queued", `${run.agentRole.replaceAll("_", " ")} ${run.runPurpose ?? "task"} run queued`);
  appendRunEvent(database, run.runId, attemptId, 2, "worker.provisioning", "Preparing isolated repository worktrees");
  const startedAt = Date.now();
  try {
    database.markRunAttemptRunning(attemptId, `engineering-team-task-${run.runId}`, "configured-worker-image");
    appendRunEvent(database, run.runId, attemptId, 3, "worker.started", "Disposable coding worker started");
    appendRunEvent(database, run.runId, attemptId, 4, "harness.connected", "Codex coding harness connected");
    const execution = await executeTaskWithRuntimeFallback(database, executor, request, attemptId, (event) => {
      appendNextRunEvent(database, run.runId, attemptId, event.type, event.message ?? event.type.replaceAll(".", " "), event.payload, event.createdAt);
    });
    const { response } = execution;
    database.completeAgentRun(run.runId, attemptId, response.result);
    for (const branch of response.branches) database.createRunArtifact({
      id: randomUUID(), runId: run.runId, attemptId, kind: "commit", name: branch.branch,
      storagePath: `git:${branch.repositoryId}:${branch.branch}`, mediaType: null,
      metadata: { repositoryId: branch.repositoryId, branch: branch.branch, sha: branch.sha },
    });
    if (response.result.usage) database.recordRunUsage({
      id: randomUUID(), runId: run.runId, attemptId, provider: execution.request.run.brainProfile.provider, model: execution.request.run.brainProfile.model ?? null,
      inputTokens: response.result.usage.inputTokens ?? 0, cachedInputTokens: response.result.usage.cachedInputTokens ?? 0,
      outputTokens: response.result.usage.outputTokens ?? 0, reasoningOutputTokens: response.result.usage.reasoningOutputTokens ?? 0,
      costCents: response.result.usage.costCents ?? null, durationMs: Date.now() - startedAt,
    });
    appendNextRunEvent(database, run.runId, attemptId, response.result.status === "completed" ? "run.completed" : "run.failed", response.result.summary);
    database.createAgentMessage({ id: randomUUID(), projectId: run.projectId, agentRole: run.agentRole, author: response.result.status === "completed" ? "agent" : "system", body: response.result.summary });
    return response;
  } catch (error) {
    if (database.getAgentRun(run.runId)?.status === "cancelled") throw error;
    const message = error instanceof Error ? error.message : "Agent run failed";
    const result: RunResult = { schemaVersion: runContractSchemaVersion, status: "failed", summary: message, changedFiles: [], commits: [], checks: [{ command: "execute_task", status: "failed" }], acceptanceCriteria: run.acceptanceCriteria.map((criterion) => ({ criterion, satisfied: false, evidence: message })), questions: [], risks: [message], artifacts: [] };
    database.completeAgentRun(run.runId, attemptId, result);
    appendNextRunEvent(database, run.runId, attemptId, "run.failed", message);
    database.createAgentMessage({ id: randomUUID(), projectId: run.projectId, agentRole: run.agentRole, author: "system", body: `${run.runPurpose === "verification" ? "Required check" : "Repair run"} failed: ${message}` });
    return { workerId: `engineering-team-task-${run.runId}`, imageDigest: "unknown", providerThreadId: null, result, branches: [] };
  }
}

async function runTaskVerificationPipeline(
  database: TeamDatabase,
  executor: TaskExecutor,
  originalRequest: CodingRunRequest,
  initialResponse: CodingRunResponse,
): Promise<{ passed: boolean; summary: string }> {
  const taskId = originalRequest.run.taskId;
  if (!taskId) return { passed: true, summary: "No task verification was required." };
  const state = database.getOrchestrationState(originalRequest.run.projectId);
  const task = state?.tasks.find((candidate) => candidate.id === taskId);
  if (!state || !task) return { passed: false, summary: "Task state was unavailable for verification." };
  const checks: VerificationCheck[] = [
    ...(task.requiredChecks.qa ? ["qa" as const] : []),
    ...(task.requiredChecks.codeReview ? ["code_review" as const] : []),
    ...(task.requiredChecks.security ? ["security" as const] : []),
  ];
  if (checks.length === 0) return { passed: true, summary: "No specialist checks were required." };

  let baselineRequest = originalRequest;
  let baselineResponse = initialResponse;
  let repairCount = 0;
  while (true) {
    const baselineRunId = baselineRequest.run.runId;
    const previouslyPassedChecks = repairCount === 0
      ? new Set(state.runs.filter((candidate) =>
        candidate.taskId === taskId && candidate.spec.runPurpose === "verification" && candidate.status === "completed" && candidate.result?.status === "completed" && candidate.spec.upstreamArtifacts.includes(`implementation-run:${baselineRunId}`)
      ).map((candidate) => candidate.spec.verificationCheck).filter((check): check is VerificationCheck => Boolean(check)))
      : new Set<VerificationCheck>();
    const commitByRepository = new Map(baselineResponse.branches.map((branch) => [branch.repositoryId, branch.sha]));
    const round = baselineRequest.run.verificationRound ?? repairCount;
    const failed: Array<{ check: VerificationCheck; summary: string }> = [];
    for (const check of checks) {
      if (previouslyPassedChecks.has(check)) continue;
      const role = verificationRoles[check];
      const profile = resolveTaskExecutionProfile(database, task.projectId, role);
      const runId = randomUUID();
      const runSpec = {
        ...baselineRequest.run,
        runId,
        agentRole: role,
        runPurpose: "verification" as const,
        verificationCheck: check,
        verificationRound: round,
        agentInstructions: state.agentConfigurations.find((configuration) => configuration.agentRole === role)?.rolePrompt ?? "",
        brainProfile: { provider: profile.provider, harness: profile.harness, modelClass: profile.modelClass, credentialRef: profile.credentialRef, ...(profile.model ? { model: profile.model } : {}), ...(profile.reasoningLevel ? { reasoningLevel: profile.reasoningLevel } : {}) },
        repositories: baselineRequest.run.repositories.map((repository) => ({ ...repository, baseCommit: commitByRepository.get(repository.repositoryId) ?? repository.baseCommit, integrationBaseCommit: repository.integrationBaseCommit ?? repository.baseCommit })),
        taskDescription: `${task.title}\n\nPerform the required ${check.replaceAll("_", " ")} gate against the implementation at ${baselineRunId}. Do not modify source files. Report blocking findings precisely.\n\n${task.description}`,
        acceptanceCriteria: check === "qa"
          ? task.acceptanceCriteria
          : check === "code_review"
            ? ["The implementation satisfies the ticket and acceptance criteria without blocking correctness or maintainability defects", "Relevant automated checks and compatibility concerns have adequate evidence"]
            : ["The implementation introduces no blocking security vulnerability", "Authentication, authorization, input, secrets, data, dependency, and logging impacts are proportionately addressed"],
        upstreamArtifacts: [`implementation-run:${baselineRunId}`],
      };
      const response = await executeManagedChildRun(database, executor, { run: runSpec, repositorySources: baselineRequest.repositorySources });
      if (response.result.status !== "completed") failed.push({ check, summary: response.result.summary });
    }
    if (failed.length === 0) return { passed: true, summary: `${checks.length} required check${checks.length === 1 ? "" : "s"} passed.` };
    if (repairCount >= originalRequest.run.limits.retries) return { passed: false, summary: failed.map((finding) => `${finding.check.replaceAll("_", " ")}: ${finding.summary}`).join("\n") };

    repairCount += 1;
    const profile = resolveTaskExecutionProfile(database, task.projectId, task.assignedRole);
    const repairRunId = randomUUID();
    const { verificationCheck: _verificationCheck, ...baselineRun } = baselineRequest.run;
    const repairSpec = {
      ...baselineRun,
      runId: repairRunId,
      agentRole: task.assignedRole,
      runPurpose: "repair" as const,
      verificationRound: round + 1,
      agentInstructions: state.agentConfigurations.find((configuration) => configuration.agentRole === task.assignedRole)?.rolePrompt ?? "",
      brainProfile: { provider: profile.provider, harness: profile.harness, modelClass: profile.modelClass, credentialRef: profile.credentialRef, ...(profile.model ? { model: profile.model } : {}), ...(profile.reasoningLevel ? { reasoningLevel: profile.reasoningLevel } : {}) },
      repositories: baselineRequest.run.repositories.map((repository) => ({ ...repository, baseCommit: commitByRepository.get(repository.repositoryId) ?? repository.baseCommit, integrationBaseCommit: repository.integrationBaseCommit ?? repository.baseCommit })),
      taskDescription: `${task.title}\n\nRepair the implementation to resolve these blocking verification findings:\n${failed.map((finding) => `- ${finding.check.replaceAll("_", " ")}: ${finding.summary}`).join("\n")}`,
      acceptanceCriteria: task.acceptanceCriteria,
      upstreamArtifacts: [`implementation-run:${baselineRunId}`, ...failed.map((finding) => `finding:${finding.check}:${finding.summary}`)],
    };
    const repairResponse = await executeManagedChildRun(database, executor, { run: repairSpec, repositorySources: baselineRequest.repositorySources });
    if (repairResponse.result.status !== "completed" || repairResponse.branches.length === 0) return { passed: false, summary: `Automatic repair failed: ${repairResponse.result.summary}` };
    baselineRequest = { run: repairSpec, repositorySources: baselineRequest.repositorySources };
    baselineResponse = repairResponse;
  }
}

async function createReleaseManagerProposal(
  database: TeamDatabase,
  executor: TaskExecutor,
  projectId: string,
  taskId: string,
  repositorySources: CodingRunRequest["repositorySources"],
  directorGuidance?: string,
): Promise<{ passed: boolean; summary: string }> {
  const state = database.getOrchestrationState(projectId);
  const task = state?.tasks.find((candidate) => candidate.id === taskId);
  if (!state || !task) return { passed: false, summary: "Task state was unavailable for release assessment." };
  const existing = state.integrationProposals.find((proposal) => proposal.taskId === taskId && ["pending", "approved", "applied"].includes(proposal.status));
  if (existing) return { passed: true, summary: existing.status === "applied" ? "Integration was already applied." : "The integration proposal is already awaiting the Director." };
  const changeRun = database.listAgentRunsForTask(projectId, taskId).find((candidate) =>
    candidate.status === "completed" && candidate.result?.status === "completed" && candidate.result.commits.length > 0
      && ["implementation", "repair"].includes(candidate.spec.runPurpose ?? "implementation")
  );
  if (!changeRun?.result) return { passed: false, summary: "No verified implementation commit was available for release assessment." };

  const profile = resolveTaskExecutionProfile(database, projectId, "release_manager");
  const commitByRepository = new Map(changeRun.result.commits.map((commit) => [commit.repositoryId, commit.sha]));
  const verificationRuns = database.listAgentRunsForTask(projectId, taskId).filter((candidate) =>
    candidate.spec.runPurpose === "verification" && candidate.status === "completed" && candidate.result?.status === "completed"
      && candidate.spec.upstreamArtifacts.includes(`implementation-run:${changeRun.id}`)
  );
  const verificationEvidence = verificationRuns.length
    ? verificationRuns.map((run) => `- ${run.spec.verificationCheck?.replaceAll("_", " ") ?? "verification"}: ${run.result?.summary ?? "passed"}`).join("\n")
    : "- No specialist gates were required for this ticket.";
  const releaseRunId = randomUUID();
  const { verificationCheck: _verificationCheck, ...changeSpec } = changeRun.spec;
  const releaseSpec = {
    ...changeSpec,
    runId: releaseRunId,
    agentRole: "release_manager" as const,
    runPurpose: "release" as const,
    agentInstructions: state.agentConfigurations.find((configuration) => configuration.agentRole === "release_manager")?.rolePrompt ?? "",
    ...(directorGuidance ? { directorGuidance } : {}),
    brainProfile: { provider: profile.provider, harness: profile.harness, modelClass: profile.modelClass, credentialRef: profile.credentialRef, ...(profile.model ? { model: profile.model } : {}), ...(profile.reasoningLevel ? { reasoningLevel: profile.reasoningLevel } : {}) },
    repositories: changeRun.spec.repositories.map((repository) => ({
      ...repository,
      baseCommit: commitByRepository.get(repository.repositoryId) ?? repository.baseCommit,
      integrationBaseCommit: repository.integrationBaseCommit ?? repository.baseCommit,
    })),
    taskDescription: `${task.title}\n\nPrepare an integration proposal for the Engineering Director. Review the exact verified implementation commit and the completed specialist evidence. Do not modify source files.\n\nSpecialist evidence:\n${verificationEvidence}\n\n${task.description}`,
    acceptanceCriteria: [
      "All required QA, code-review, and security evidence is complete for the proposed commit",
      "The commit set, integration order, operational considerations, and rollback path are suitable for Director approval",
    ],
    upstreamArtifacts: [
      `implementation-run:${changeRun.id}`,
      ...verificationRuns.map((run) => `verification-run:${run.id}:${run.spec.verificationCheck ?? "check"}`),
    ],
    permissions: { ...changeRun.spec.permissions, filesystem: "read-only" as const, allowedTools: ["inspect_repository", "run_tests"] },
  };
  const response = await executeManagedChildRun(database, executor, { run: releaseSpec, repositorySources });
  if (response.result.status !== "completed") {
    return { passed: false, summary: `Release Manager blocked integration: ${response.result.summary}` };
  }

  const repositoryLines = releaseSpec.repositories.map((repository) => {
    const source = repositorySources.find((candidate) => candidate.repositoryId === repository.repositoryId);
    const target = state.project.repositories.find((candidate) => candidate.id === repository.repositoryId)?.defaultBranch ?? "current checked-out branch";
    return `- ${source?.name ?? repository.repositoryId}: ${repository.baseCommit.slice(0, 12)} → ${target}`;
  });
  const checkLines = verificationRuns.map((run) => `- ${run.spec.verificationCheck?.replaceAll("_", " ") ?? "verification"}: ${run.result?.summary ?? "passed"}`);
  const riskLines = response.result.risks.length ? response.result.risks.map((risk) => `- ${risk}`) : ["- No blocking release risks reported."];
  const approvalId = randomUUID();
  database.createIntegrationProposal({
    approvalId,
    projectId,
    taskId,
    changeRunId: changeRun.id,
    releaseRunId,
    title: `Integrate: ${task.title}`,
    details: `${response.result.summary}\n\nCommits\n${repositoryLines.join("\n")}\n\nVerification\n${checkLines.join("\n") || "- No specialist checks were required."}\n\nRisks and rollback\n${riskLines.join("\n")}`,
  });
  database.createAgentMessage({
    id: randomUUID(), projectId, agentRole: "release_manager", author: "agent",
    body: `${response.result.summary}\n\nI prepared an integration proposal for your approval.`,
  });
  return { passed: true, summary: "Release Manager prepared an integration proposal for Director approval." };
}

async function resumeTaskVerificationWorkflow(
  database: TeamDatabase,
  executor: TaskExecutor,
  baselineRequest: CodingRunRequest,
  baselineResponse: CodingRunResponse,
  leaseToken: string,
): Promise<void> {
  const taskId = baselineRequest.run.taskId;
  if (!taskId) return;
  try {
    const verification = await runTaskVerificationPipeline(database, executor, baselineRequest, baselineResponse);
    if (verification.passed) {
      const release = await createReleaseManagerProposal(database, executor, baselineRequest.run.projectId, taskId, baselineRequest.repositorySources, baselineRequest.run.directorGuidance);
      if (release.passed) {
        database.updateTaskStatus(baselineRequest.run.projectId, taskId, "review");
        database.createAgentMessage({
          id: randomUUID(), projectId: baselineRequest.run.projectId, agentRole: baselineRequest.run.agentRole, author: "system",
          body: `Resumed verification completed. ${verification.summary} ${release.summary}`,
        });
      } else {
        database.createAgentMessage({
          id: randomUUID(), projectId: baselineRequest.run.projectId, agentRole: "release_manager", author: "system", body: release.summary,
        });
      }
    } else {
      database.createAgentMessage({
        id: randomUUID(),
        projectId: baselineRequest.run.projectId,
        agentRole: baselineRequest.run.agentRole,
        author: "system",
        body: `The resumed workflow remains in progress because required checks did not pass:\n\n${verification.summary}`,
      });
    }
  } catch (error) {
    database.createAgentMessage({
      id: randomUUID(),
      projectId: baselineRequest.run.projectId,
      agentRole: baselineRequest.run.agentRole,
      author: "system",
      body: `Workflow recovery could not continue: ${error instanceof Error ? error.message : "Unknown recovery failure"}`,
    });
  } finally {
    try {
      database.releaseTaskLease(leaseToken);
    } catch (error) {
      console.error("Unable to release recovered task lease", error);
    }
  }
}

async function resumeReleaseManagerWorkflow(
  database: TeamDatabase,
  executor: TaskExecutor,
  baselineRequest: CodingRunRequest,
  leaseToken: string,
): Promise<void> {
  const taskId = baselineRequest.run.taskId;
  if (!taskId) return;
  try {
    const release = await createReleaseManagerProposal(database, executor, baselineRequest.run.projectId, taskId, baselineRequest.repositorySources, baselineRequest.run.directorGuidance);
    if (release.passed) {
      database.updateTaskStatus(baselineRequest.run.projectId, taskId, "review");
      database.createAgentMessage({
        id: randomUUID(), projectId: baselineRequest.run.projectId, agentRole: "release_manager", author: "system",
        body: `Resumed release assessment completed. ${release.summary}`,
      });
    } else {
      database.createAgentMessage({
        id: randomUUID(), projectId: baselineRequest.run.projectId, agentRole: "release_manager", author: "system", body: release.summary,
      });
    }
  } catch (error) {
    database.createAgentMessage({
      id: randomUUID(), projectId: baselineRequest.run.projectId, agentRole: "release_manager", author: "system",
      body: `Release workflow recovery could not continue: ${error instanceof Error ? error.message : "Unknown recovery failure"}`,
    });
  } finally {
    try {
      database.releaseTaskLease(leaseToken);
    } catch (error) {
      console.error("Unable to release recovered release lease", error);
    }
  }
}

async function executeAgentTask(
  database: TeamDatabase,
  executor: TaskExecutor,
  request: CodingRunRequest,
  attemptId: string,
  leaseToken: string,
): Promise<void> {
  const { run } = request;
  const startedAt = Date.now();
  try {
    database.markRunAttemptRunning(attemptId, `engineering-team-task-${run.runId}`, "configured-worker-image");
    appendRunEvent(database, run.runId, attemptId, 3, "worker.started", "Disposable coding worker started");
    appendRunEvent(database, run.runId, attemptId, 4, "harness.connected", "Codex coding harness connected");
    const execution = await executeTaskWithRuntimeFallback(database, executor, request, attemptId, (event) => {
      appendNextRunEvent(database, run.runId, attemptId, event.type, event.message ?? event.type.replaceAll(".", " "), event.payload, event.createdAt);
    });
    const { response } = execution;
    database.completeAgentRun(run.runId, attemptId, response.result);
    for (const branch of response.branches) {
      database.createRunArtifact({
        id: randomUUID(),
        runId: run.runId,
        attemptId,
        kind: "commit",
        name: branch.branch,
        storagePath: `git:${branch.repositoryId}:${branch.branch}`,
        mediaType: null,
        metadata: { repositoryId: branch.repositoryId, branch: branch.branch, sha: branch.sha },
      });
    }
    if (response.result.usage) {
      database.recordRunUsage({
        id: randomUUID(),
        runId: run.runId,
        attemptId,
        provider: execution.request.run.brainProfile.provider,
        model: execution.request.run.brainProfile.model ?? null,
        inputTokens: response.result.usage.inputTokens ?? 0,
        cachedInputTokens: response.result.usage.cachedInputTokens ?? 0,
        outputTokens: response.result.usage.outputTokens ?? 0,
        reasoningOutputTokens: response.result.usage.reasoningOutputTokens ?? 0,
        costCents: response.result.usage.costCents ?? null,
        durationMs: Date.now() - startedAt,
      });
    }
    if (response.result.status === "completed" && run.taskId) {
      const reportOnly = response.branches.length === 0 && reportOnlyTaskRoles.has(run.agentRole);
      if (reportOnly) {
        database.updateTaskStatus(run.projectId, run.taskId, "review");
        database.updateTaskStatus(run.projectId, run.taskId, "completed");
        database.createAgentMessage({
          id: randomUUID(),
          projectId: run.projectId,
          agentRole: run.agentRole,
          author: "agent",
          body: `${response.result.summary}\n\nVerification completed without code changes.`,
        });
        appendNextRunEvent(database, run.runId, attemptId, "run.completed", "Verification task completed with an evidence report");
      } else {
        database.createAgentMessage({
          id: randomUUID(),
          projectId: run.projectId,
          agentRole: run.agentRole,
          author: "agent",
          body: `${response.result.summary}\n\nImplementation is committed. Running the ticket's required checks now.`,
        });
        let verification: { passed: boolean; summary: string };
        try {
          verification = await runTaskVerificationPipeline(database, executor, execution.request, response);
        } catch (error) {
          verification = {
            passed: false,
            summary: error instanceof Error ? error.message : "The required-check workflow could not complete.",
          };
        }
        if (verification.passed) {
          const release = await createReleaseManagerProposal(database, executor, run.projectId, run.taskId, execution.request.repositorySources, run.directorGuidance);
          if (release.passed) {
            database.updateTaskStatus(run.projectId, run.taskId, "review");
            database.createAgentMessage({
              id: randomUUID(), projectId: run.projectId, agentRole: run.agentRole, author: "system",
              body: `${verification.summary} ${release.summary}`,
            });
            appendNextRunEvent(database, run.runId, attemptId, "run.completed", "Implementation, required checks, and release assessment passed");
          } else {
            database.createAgentMessage({
              id: randomUUID(), projectId: run.projectId, agentRole: "release_manager", author: "system", body: release.summary,
            });
            appendNextRunEvent(database, run.runId, attemptId, "run.failed", release.summary);
          }
        } else {
          database.createAgentMessage({
            id: randomUUID(),
            projectId: run.projectId,
            agentRole: run.agentRole,
            author: "system",
            body: `The ticket remains in progress because required checks did not pass:\n\n${verification.summary}`,
          });
          appendNextRunEvent(database, run.runId, attemptId, "run.failed", `Required checks blocked review: ${verification.summary}`);
        }
      }
    } else {
      database.createAgentMessage({
        id: randomUUID(),
        projectId: run.projectId,
        agentRole: run.agentRole,
        author: "system",
        body: `Task run needs attention: ${response.result.summary}`,
      });
      appendNextRunEvent(database, run.runId, attemptId, "run.failed", response.result.summary);
    }
  } catch (error) {
    if (database.getAgentRun(run.runId)?.status === "cancelled") return;
    const message = error instanceof Error ? error.message : "Task execution failed";
    const result: RunResult = {
      schemaVersion: runContractSchemaVersion,
      status: "failed",
      summary: message,
      changedFiles: [],
      commits: [],
      checks: [{ command: "execute_task", status: "failed" }],
      acceptanceCriteria: run.acceptanceCriteria.map((criterion) => ({ criterion, satisfied: false, evidence: message })),
      questions: [],
      risks: [message],
      artifacts: [],
    };
    try {
      database.completeAgentRun(run.runId, attemptId, result);
      database.createAgentMessage({
        id: randomUUID(),
        projectId: run.projectId,
        agentRole: run.agentRole,
        author: "system",
        body: `Task run failed: ${message}`,
      });
      appendNextRunEvent(database, run.runId, attemptId, "run.failed", message);
    } catch (persistenceError) {
      console.error("Unable to persist task execution failure", persistenceError);
    }
  } finally {
    if (database.getAgentRun(run.runId)?.status !== "cancelled") {
      try {
        database.releaseTaskLease(leaseToken);
      } catch (error) {
        console.error("Unable to release task lease", error);
      }
    }
  }
}

function appendRunEvent(
  database: TeamDatabase,
  runId: string,
  attemptId: string,
  sequence: number,
  type: RunEvent["type"],
  message: string,
  payload: Record<string, unknown> = {},
): void {
  database.appendRunEvent({
    schemaVersion: runContractSchemaVersion,
    id: randomUUID(),
    runId,
    attemptId,
    sequence,
    type,
    message,
    payload,
    createdAt: new Date().toISOString(),
  });
}

function appendNextRunEvent(
  database: TeamDatabase,
  runId: string,
  attemptId: string,
  type: RunEvent["type"],
  message: string,
  payload: Record<string, unknown> = {},
  createdAt = new Date().toISOString(),
): void {
  const sequence = (database.listRunEvents(runId).at(-1)?.sequence ?? 0) + 1;
  database.appendRunEvent({
    schemaVersion: runContractSchemaVersion,
    id: randomUUID(), runId, attemptId, sequence, type, message, payload, createdAt,
  });
}
