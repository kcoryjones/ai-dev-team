import { randomUUID } from "node:crypto";
import { basename, relative, resolve } from "node:path";
import type {
  AddProjectRepositoryInput,
  ApplyCodingRunRequest,
  AgentRuntimeAssignmentSummary,
  AgentRole,
  ApiError,
  AssignAgentRuntimeInput,
  CodingHarnessInstallationSummary,
  CodingHarnessPreflightSummary,
  CodingRunRequest,
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
  RepositoryDiscoveryResponse,
  UpdateProjectInput,
  UpdateProjectRepositoryInput,
  UpdateProjectSettingsInput,
  UpdateTaskStatusInput,
} from "@engineering-team/contracts";
import { runContractSchemaVersion } from "@engineering-team/contracts";
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

const createPlanSchema = z
  .object({
    objective: z.object({
      title: z.string().trim().min(1).max(160),
      description: z.string().trim().min(1).max(4_000),
    }),
    tasks: z.array(planTaskSchema).min(1).max(50),
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
}).strict();

const createAgentMessageSchema = z.object({
  body: z.string().trim().min(1).max(8_000),
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
      if (state?.approvals.some((approval) => approval.type === "plan" && approval.status === "pending")) {
        return context.json(
          { error: "plan_pending", message: "Review the current proposed plan before asking the Project Manager for another" } satisfies ApiError,
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
        taskDescription: "Inspect the Project repositories as needed and return a proposed implementation plan for director approval.",
        acceptanceCriteria: [
          "Return a valid objective and dependency-safe task graph",
          "Assign every task to an engineering role and valid Project repository",
          "Do not modify any repository",
        ],
        upstreamArtifacts: [],
        permissions: {
          filesystem: "read-only" as const,
          networkPolicy: settings.planningNetworkPolicy,
          allowedTools: ["inspect_repository", "propose_task_plan"],
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
      const message = database.createAgentMessage({
        id: randomUUID(),
        projectId,
        agentRole: role,
        author: "director",
        body: parsed.data.body,
      });
      return context.json({ message }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save message";
      return context.json(
        { error: "message_failed", message } satisfies ApiError,
        message === "Project not found" ? 404 : 409,
      );
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
      const approval = database.decideApproval(
        context.req.param("projectId"),
        context.req.param("approvalId"),
        parsed.data.decision,
        parsed.data.note || null,
      );
      return context.json({ approval });
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
    const runtimeAssignment = database.getAgentRuntimeAssignment(projectId, task.assignedRole);
    if (!runtimeAssignment?.codingHarnessId || !runtimeAssignment.modelBackendId) {
      return context.json({
        error: "runtime_not_assigned",
        message: `Assign a harness and model to ${task.assignedRole.replaceAll("_", " ")} in Live Team before starting this task`,
      } satisfies ApiError, 409);
    }
    const harness = database.getCodingHarness(projectId, runtimeAssignment.codingHarnessId);
    const backend = database.getModelBackend(projectId, runtimeAssignment.modelBackendId);
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
    const profileRecord = {
      id: `runtime-${projectId}-${task.assignedRole}`,
      projectId,
      name: `Runtime assignment: ${task.assignedRole}`,
      provider: backend.provider,
      harness: harness.adapter,
      modelClass: "coding",
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
    const runSpec = {
      schemaVersion: runContractSchemaVersion,
      runId,
      projectId,
      taskId,
      agentRole: task.assignedRole,
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
        baseCommit: getRepositoryHead(repository!.relativePath, options.workspaceRoot),
      })),
      objective: state.objectives.find((objective) => objective.id === task.objectiveId)?.description ?? task.title,
      taskDescription: `${task.title}\n\n${task.description}`.trim(),
      acceptanceCriteria: task.acceptanceCriteria,
      upstreamArtifacts: [],
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
        expiresAt: new Date(now.getTime() + (settings.defaultRunTimeoutSeconds + 60) * 1_000).toISOString(),
      });
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
    if (!["review", "completed"].includes(task.status)) {
      return context.json({ error: "task_not_reviewable", message: "Only a reviewed task can be applied" } satisfies ApiError, 409);
    }
    if (!options.taskExecutor) {
      return context.json({ error: "controller_unavailable", message: "The trusted task worker controller is not configured" } satisfies ApiError, 503);
    }
    const run = state.runs.find((candidate) =>
      candidate.taskId === taskId && candidate.status === "completed" && candidate.result?.status === "completed"
    );
    if (!run?.result) {
      return context.json({ error: "reviewed_run_not_found", message: "No successful reviewed run was found for this task" } satisfies ApiError, 409);
    }
    const commitByRepository = new Map(run.result.commits.map((commit) => [commit.repositoryId, commit.sha]));
    const repositories: ApplyCodingRunRequest["repositories"] = [];
    for (const runRepository of run.spec.repositories) {
      const repository = state.project.repositories.find((candidate) => candidate.id === runRepository.repositoryId);
      const sha = commitByRepository.get(runRepository.repositoryId);
      if (!repository || !sha) {
        return context.json({ error: "review_artifact_incomplete", message: "The reviewed run is missing repository commit information" } satisfies ApiError, 409);
      }
      repositories.push({
        repositoryId: repository.id,
        name: repository.name,
        sourcePath: resolveRepositoryPath(options.workspaceRoot, repository.relativePath),
        branch: `agent/${taskId.slice(0, 8)}-${run.id.slice(0, 8)}`,
        sha,
        baseCommit: runRepository.baseCommit,
      });
    }

    try {
      const applied = await options.taskExecutor.applyTask({ runId: run.id, taskId, repositories });
      database.markRunBranchesApplied(run.id, applied.applied.map((item) => item.branch));
      const completedTask = task.status === "review"
        ? database.updateTaskStatus(projectId, taskId, "completed")
        : task;
      database.createAgentMessage({
        id: randomUUID(),
        projectId,
        agentRole: task.assignedRole,
        author: "system",
        body: `Reviewed changes applied to ${applied.applied.map((item) => `${item.targetBranch} (${item.branch})`).join(", ")}.`,
      });
      return context.json({ task: completedTask, run, ...applied });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Reviewed changes could not be applied";
      return context.json({ error: "task_apply_rejected", message } satisfies ApiError, 409);
    }
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
    if (review?.state !== "stale") {
      return context.json({ error: "task_not_stale", message: "Only a stale reviewed run needs to be re-run" } satisfies ApiError, 409);
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
    const response = await executor.execute(request);
    const parsedPlan = createPlanSchema.safeParse(response.proposal);
    const parsedMessage = z.string().trim().min(1).max(8_000).safeParse(response.proposal.assistantMessage);
    if (!parsedPlan.success || !parsedMessage.success) {
      throw new Error(parsedPlan.success
        ? "Project Manager returned an invalid assistant message"
        : parsedPlan.error.issues[0]?.message ?? "Project Manager returned an invalid plan");
    }
    const plan = database.createPlan({
      projectId: run.projectId,
      objective: { id: randomUUID(), ...parsedPlan.data.objective },
      tasks: parsedPlan.data.tasks.map((task) => ({ id: randomUUID(), ...task })),
      approvalId: randomUUID(),
    });
    const reply = `${parsedMessage.data}\n\nI created ${plan.tasks.length} proposed task${plan.tasks.length === 1 ? "" : "s"} and sent the plan for your approval.`;
    database.createAgentMessage({
      id: randomUUID(),
      projectId: run.projectId,
      agentRole: "project_manager",
      author: "agent",
      body: reply,
    });
    appendRunEvent(database, run.runId, attemptId, 5, "agent.message", "Project Manager returned a validated plan", {
      objectiveId: plan.objective.id,
      approvalId: plan.approval.id,
      taskCount: plan.tasks.length,
    });
    const result: RunResult = {
      schemaVersion: runContractSchemaVersion,
      status: "completed",
      summary: reply,
      changedFiles: [],
      commits: [],
      checks: [{ command: "validate_project_plan", status: "passed" }],
      acceptanceCriteria: run.acceptanceCriteria.map((criterion) => ({
        criterion,
        satisfied: true,
        evidence: "The proposal passed server-side plan validation and entered director approval.",
      })),
      questions: [],
      risks: [],
      artifacts: [],
      ...(response.usage ? { usage: response.usage } : {}),
    };
    database.completeAgentRun(run.runId, attemptId, result);
    if (response.usage) {
      database.recordRunUsage({
        id: randomUUID(),
        runId: run.runId,
        attemptId,
        provider: run.brainProfile.provider,
        model: run.brainProfile.model ?? null,
        inputTokens: response.usage.inputTokens ?? 0,
        cachedInputTokens: response.usage.cachedInputTokens ?? 0,
        outputTokens: response.usage.outputTokens ?? 0,
        reasoningOutputTokens: response.usage.reasoningOutputTokens ?? 0,
        costCents: null,
        durationMs: Date.now() - startedAt,
      });
    }
    appendRunEvent(database, run.runId, attemptId, 6, "run.completed", "Planning run completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Planning run failed";
    const result: RunResult = {
      schemaVersion: runContractSchemaVersion,
      status: "failed",
      summary: message,
      changedFiles: [],
      commits: [],
      checks: [{ command: "validate_project_plan", status: "failed" }],
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
        body: `Planning run failed: ${message}`,
      });
      appendRunEvent(database, run.runId, attemptId, 5, "run.failed", message);
    } catch (persistenceError) {
      console.error("Unable to persist planning failure", persistenceError);
    }
  }
}

function buildTaskReviews(state: OrchestrationState, workspaceRoot: string): TaskReviewSummary[] {
  const reviews: TaskReviewSummary[] = [];
  for (const task of state.tasks) {
    const run = state.runs.find((candidate) =>
      candidate.taskId === task.id && candidate.status === "completed" && candidate.result?.status === "completed"
    );
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
        return getRepositoryHead(repository.relativePath, workspaceRoot) !== runRepository.baseCommit;
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
    const response = await executor.executeTask(request);
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
        provider: run.brainProfile.provider,
        model: run.brainProfile.model ?? null,
        inputTokens: response.result.usage.inputTokens ?? 0,
        cachedInputTokens: response.result.usage.cachedInputTokens ?? 0,
        outputTokens: response.result.usage.outputTokens ?? 0,
        reasoningOutputTokens: response.result.usage.reasoningOutputTokens ?? 0,
        costCents: response.result.usage.costCents ?? null,
        durationMs: Date.now() - startedAt,
      });
    }
    if (response.result.status === "completed" && run.taskId) {
      database.updateTaskStatus(run.projectId, run.taskId, "review");
      const reportOnly = response.branches.length === 0 && reportOnlyTaskRoles.has(run.agentRole);
      if (reportOnly) database.updateTaskStatus(run.projectId, run.taskId, "completed");
      database.createAgentMessage({
        id: randomUUID(),
        projectId: run.projectId,
        agentRole: run.agentRole,
        author: "agent",
        body: reportOnly
          ? `${response.result.summary}\n\nVerification completed without code changes.`
          : `${response.result.summary}\n\nChanges are committed on ${response.branches.map((branch) => branch.branch).join(", ")} and the task is ready for review.`,
      });
      appendRunEvent(
        database,
        run.runId,
        attemptId,
        5,
        "run.completed",
        reportOnly ? "Verification task completed with an evidence report" : "Task implementation completed and sent to review",
      );
    } else {
      database.createAgentMessage({
        id: randomUUID(),
        projectId: run.projectId,
        agentRole: run.agentRole,
        author: "system",
        body: `Task run needs attention: ${response.result.summary}`,
      });
      appendRunEvent(database, run.runId, attemptId, 5, "run.failed", response.result.summary);
    }
  } catch (error) {
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
      appendRunEvent(database, run.runId, attemptId, 5, "run.failed", message);
    } catch (persistenceError) {
      console.error("Unable to persist task execution failure", persistenceError);
    }
  } finally {
    try {
      database.releaseTaskLease(leaseToken);
    } catch (error) {
      console.error("Unable to release task lease", error);
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
