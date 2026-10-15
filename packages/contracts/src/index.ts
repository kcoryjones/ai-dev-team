export type ProjectStatus = "active" | "paused" | "archived";

export interface RepositorySummary {
  id: string;
  relativePath: string;
  name: string;
  defaultBranch: string | null;
  remoteUrl: string | null;
  description: string;
  enabled: boolean;
  available: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  repositories: RepositorySummary[];
}

export interface CreateProjectInput {
  name: string;
  repositoryPath: string;
}

export interface CreateNewProjectInput {
  name: string;
  directoryName: string;
}

export interface AddProjectRepositoryInput {
  relativePath: string;
}

export interface CreateProjectRepositoryInput {
  directoryName: string;
}

export interface UpdateProjectRepositoryInput {
  description?: string;
  enabled?: boolean;
}

export interface UpdateProjectInput {
  name: string;
}

export type ProjectSetupStatus = "not_started" | "in_progress" | "completed";
export type PlanningNetworkPolicy = "offline" | "model-provider-only" | "restricted";

export interface ProjectSettingsSummary {
  projectId: string;
  setupStatus: ProjectSetupStatus;
  setupCompletedAt: string | null;
  defaultRunTimeoutSeconds: number;
  defaultRunRetries: number;
  defaultTokenBudget: number | null;
  defaultCostBudgetCents: number | null;
  planningNetworkPolicy: PlanningNetworkPolicy;
  requirePlanApproval: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateProjectSettingsInput {
  setupStatus?: ProjectSetupStatus;
  defaultRunTimeoutSeconds?: number;
  defaultRunRetries?: number;
  defaultTokenBudget?: number | null;
  defaultCostBudgetCents?: number | null;
  planningNetworkPolicy?: PlanningNetworkPolicy;
  requirePlanApproval?: boolean;
}

export const modelBackendProviders = [
  "openai",
  "anthropic",
  "runpod",
  "openrouter",
  "ollama",
  "custom",
] as const;

export const modelBackendProtocols = [
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
  "ollama",
] as const;

export const modelBackendAuthModes = ["chatgpt", "api-key", "none"] as const;

export type ModelBackendProvider = (typeof modelBackendProviders)[number];
export type ModelBackendProtocol = (typeof modelBackendProtocols)[number];
export type ModelBackendAuthMode = (typeof modelBackendAuthModes)[number];

export interface ModelBackendSummary {
  id: string;
  projectId: string;
  name: string;
  provider: ModelBackendProvider;
  protocol: ModelBackendProtocol;
  model: string | null;
  baseUrl: string | null;
  authMode: ModelBackendAuthMode;
  credentialRef: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SaveModelBackendInput {
  name: string;
  provider: ModelBackendProvider;
  protocol: ModelBackendProtocol;
  model?: string;
  baseUrl?: string;
  authMode: ModelBackendAuthMode;
  credentialRef?: string;
  enabled?: boolean;
}

export const codingHarnessAdapters = [
  "codex",
  "claude-code",
  "opencode",
  "pi",
  "deepseek-harness",
  "grok-build",
  "custom",
] as const;

export const harnessCapabilities = [
  "planning",
  "coding",
  "review",
  "testing",
  "release",
] as const;

export type CodingHarnessAdapter = (typeof codingHarnessAdapters)[number];
export type HarnessCapability = (typeof harnessCapabilities)[number];

export interface CodingHarnessSummary {
  id: string;
  projectId: string;
  name: string;
  adapter: CodingHarnessAdapter;
  executable: string;
  containerImage: string | null;
  supportedProtocols: ModelBackendProtocol[];
  capabilities: HarnessCapability[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SaveCodingHarnessInput {
  name: string;
  adapter: CodingHarnessAdapter;
  executable: string;
  containerImage?: string;
  supportedProtocols: ModelBackendProtocol[];
  capabilities: HarnessCapability[];
  enabled?: boolean;
}

export type HarnessInstallationState = "installed" | "missing" | "controller-unavailable";

export interface CodingHarnessInstallationSummary {
  harnessId: string;
  state: HarnessInstallationState;
  version: string | null;
  workerImage: string | null;
  message: string;
}

export type HarnessPreflightState = "ready" | "not-configured" | "failed" | "unsupported";

export interface CodingHarnessPreflightSummary {
  harnessId: string;
  state: HarnessPreflightState;
  version: string | null;
  workerImage: string | null;
  message: string;
}

export type RuntimeProfileStatus = "ready" | "disabled" | "incompatible";

export interface RuntimeProfileSummary {
  id: string;
  projectId: string;
  name: string;
  codingHarnessId: string;
  modelBackendId: string;
  protocol: ModelBackendProtocol;
  enabled: boolean;
  status: RuntimeProfileStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SaveRuntimeProfileInput {
  name: string;
  codingHarnessId: string;
  modelBackendId: string;
  enabled?: boolean;
}

export interface AgentRuntimeAssignmentSummary {
  agentRole: AgentRole;
  codingHarnessId: string | null;
  modelBackendId: string | null;
  assignedAt: string;
}

export interface AssignAgentRuntimeInput {
  codingHarnessId: string | null;
  modelBackendId: string | null;
}

export interface DiscoveredRepository extends RepositorySummary {
  registered: boolean;
  projectId: string | null;
}

export interface RepositoryDiscoveryResponse {
  repositories: DiscoveredRepository[];
  workspaceRoot: string;
  workspaceName: string;
}

export interface HealthResponse {
  status: "ok";
  database: "connected";
  timestamp: string;
}

export interface ApiError {
  error: string;
  message: string;
}

export const agentRoles = [
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
] as const;

export type AgentRole = (typeof agentRoles)[number];
export type ObjectiveStatus = "draft" | "active" | "completed" | "cancelled";
export type TaskStatus =
  | "draft"
  | "ready"
  | "blocked"
  | "in_progress"
  | "review"
  | "completed"
  | "cancelled";
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ApprovalType = "plan" | "integration" | "release" | "high_risk";

export interface ObjectiveSummary {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: ObjectiveStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSummary {
  id: string;
  projectId: string;
  objectiveId: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignedRole: AgentRole;
  repositoryIds: string[];
  acceptanceCriteria: string[];
  requiredChecks: TaskRequiredChecks;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskRequiredChecks {
  qa: boolean;
  codeReview: boolean;
  security: boolean;
}

export interface ApprovalSummary {
  id: string;
  projectId: string;
  objectiveId: string | null;
  taskId: string | null;
  type: ApprovalType;
  title: string;
  details: string;
  status: ApprovalStatus;
  requestedByRole: AgentRole;
  requestedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface OrchestrationState {
  project: ProjectSummary;
  objectives: ObjectiveSummary[];
  tasks: TaskSummary[];
  approvals: ApprovalSummary[];
  messages: AgentMessageSummary[];
  runs: AgentRunSummary[];
}

export type TaskReviewState = "applicable" | "stale" | "applied" | "report-only";

export interface TaskReviewSummary {
  taskId: string;
  runId: string;
  state: TaskReviewState;
  branches: string[];
  message: string;
}

export interface PlanTaskInput {
  key: string;
  title: string;
  description: string;
  assignedRole: AgentRole;
  repositoryIds?: string[];
  acceptanceCriteria: string[];
  requiredChecks?: TaskRequiredChecks;
  dependsOn: string[];
}

export type AgentMessageAuthor = "director" | "agent" | "system";

export interface AgentMessageSummary {
  id: string;
  projectId: string;
  agentRole: AgentRole;
  author: AgentMessageAuthor;
  body: string;
  createdAt: string;
}

export interface CreateAgentMessageInput {
  body: string;
}

export interface CreatePlanInput {
  objective: {
    title: string;
    description: string;
  };
  tasks: PlanTaskInput[];
}

export interface CreatePlanResponse {
  objective: ObjectiveSummary;
  tasks: TaskSummary[];
  approval: ApprovalSummary;
}

export interface DecideApprovalInput {
  decision: "approved" | "rejected";
  note?: string;
}

export interface UpdateTaskStatusInput {
  status: "in_progress" | "review" | "completed";
}

export const runContractSchemaVersion = 1 as const;

export type RunFilesystemAccess = "read-only" | "workspace-write";
export type AgentRunStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";
export type RunAttemptStatus =
  | "provisioning"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";
export type RunResultStatus =
  | "completed"
  | "needs_input"
  | "blocked"
  | "failed"
  | "cancelled";
export type RunEventType =
  | "run.queued"
  | "worker.provisioning"
  | "worker.started"
  | "worker.heartbeat"
  | "harness.connected"
  | "agent.message"
  | "agent.waiting"
  | "repository.inspected"
  | "command.started"
  | "command.completed"
  | "file.changed"
  | "test.completed"
  | "tool.started"
  | "tool.completed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.timed_out";

export interface BrainProfileRef {
  provider: string;
  harness: string;
  modelClass: string;
  credentialRef: string;
  model?: string;
  reasoningLevel?: string;
}

export interface RunRepositorySpec {
  repositoryId: string;
  checkoutPath: string;
  baseCommit: string;
}

export interface RunSpec {
  schemaVersion: typeof runContractSchemaVersion;
  runId: string;
  projectId: string;
  taskId?: string;
  agentRole: AgentRole;
  brainProfile: BrainProfileRef;
  repositories: RunRepositorySpec[];
  objective: string;
  taskDescription: string;
  acceptanceCriteria: string[];
  upstreamArtifacts: string[];
  permissions: {
    filesystem: RunFilesystemAccess;
    networkPolicy: string;
    allowedTools: string[];
  };
  limits: {
    timeoutSeconds: number;
    tokenBudget?: number;
    costBudgetCents?: number;
    retries: number;
  };
}

export interface RunEvent {
  schemaVersion: typeof runContractSchemaVersion;
  id: string;
  runId: string;
  attemptId: string | null;
  sequence: number;
  type: RunEventType;
  message?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RunCheckResult {
  command: string;
  status: "passed" | "failed" | "skipped";
  outputArtifact?: string;
}

export interface RunAcceptanceResult {
  criterion: string;
  satisfied: boolean;
  evidence: string;
}

export interface RunResult {
  schemaVersion: typeof runContractSchemaVersion;
  status: RunResultStatus;
  summary: string;
  changedFiles: string[];
  commits: Array<{ repositoryId: string; sha: string }>;
  checks: RunCheckResult[];
  acceptanceCriteria: RunAcceptanceResult[];
  questions: string[];
  risks: string[];
  artifacts: string[];
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
    costCents?: number;
  };
}

export interface BrainProfileSummary extends BrainProfileRef {
  id: string;
  projectId: string;
  name: string;
  configuration: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PlanningProposal {
  assistantMessage: string;
  objective: {
    title: string;
    description: string;
  };
  tasks: PlanTaskInput[];
}

export interface PlanningRunRequest {
  run: RunSpec;
  repositorySources: Array<{
    repositoryId: string;
    name: string;
    description?: string;
    sourcePath: string;
  }>;
}

export interface PlanningRunResponse {
  workerId: string;
  imageDigest: string;
  providerThreadId: string | null;
  proposal: PlanningProposal;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  };
}

export interface CodingRunRequest {
  run: RunSpec;
  repositorySources: Array<{
    repositoryId: string;
    name: string;
    description?: string;
    sourcePath: string;
  }>;
}

export interface CodingRunResponse {
  workerId: string;
  imageDigest: string;
  providerThreadId: string | null;
  result: RunResult;
  branches: Array<{ repositoryId: string; branch: string; sha: string }>;
}

export interface ApplyCodingRunRequest {
  runId: string;
  taskId: string;
  repositories: Array<{
    repositoryId: string;
    name: string;
    sourcePath: string;
    branch: string;
    sha: string;
    baseCommit: string;
  }>;
}

export interface ApplyCodingRunResponse {
  applied: Array<{
    repositoryId: string;
    branch: string;
    sha: string;
    targetBranch: string;
  }>;
}

export interface AgentRunSummary {
  id: string;
  projectId: string;
  taskId: string | null;
  agentRole: AgentRole;
  brainProfileId: string;
  status: AgentRunStatus;
  spec: RunSpec;
  result: RunResult | null;
  providerThreadId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunAttemptSummary {
  id: string;
  runId: string;
  attemptNumber: number;
  status: RunAttemptStatus;
  workerId: string | null;
  imageDigest: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type RunArtifactKind =
  | "log"
  | "patch"
  | "commit"
  | "test_output"
  | "report"
  | "screenshot"
  | "other";

export interface RunArtifactSummary {
  id: string;
  runId: string;
  attemptId: string | null;
  kind: RunArtifactKind;
  name: string;
  storagePath: string;
  mediaType: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RunUsageSummary {
  id: string;
  runId: string;
  attemptId: string | null;
  provider: string;
  model: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  costCents: number | null;
  durationMs: number | null;
  createdAt: string;
}

export interface TaskLeaseSummary {
  taskId: string;
  runId: string;
  leaseToken: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}
