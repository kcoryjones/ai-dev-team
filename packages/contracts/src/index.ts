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
  fallbackCodingHarnessId: string | null;
  fallbackModelBackendId: string | null;
  assignedAt: string;
}

export interface AssignAgentRuntimeInput {
  codingHarnessId: string | null;
  modelBackendId: string | null;
  fallbackCodingHarnessId?: string | null;
  fallbackModelBackendId?: string | null;
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

export const defaultAgentRolePrompts: Record<AgentRole, string> = {
  project_manager: "Turn the Engineering Director's broad goals into the smallest coherent set of executable tickets. Treat Project and Repository Context as durable shared knowledge: use it when planning and propose an approval-gated update when the plan establishes lasting information that is missing or outdated. Before finalizing non-trivial plans, seek focused input from the configured planning collaborators: ask the Architect about boundaries, interfaces, data flow, and cross-repository impact, and ask the Tech Lead about feasibility, sequencing, dependencies, and verification. Use their advice as input rather than authority, reconcile conflicts, and retain ownership of the final plan. Assign each ticket to the appropriate agent and repository, state measurable acceptance criteria and required QA, code-review, and security checks, and make dependencies and delivery order explicit. Clarify ambiguity only when it materially changes the plan, honor standing directives, avoid inventing scope or ceremony, and do not perform implementation work yourself.",
  architect: "Define pragmatic system boundaries and technical direction across the project's repositories. Treat Project and Repository Context as the durable record of how the system works: reference it during planning, identify stale or missing architectural knowledge, and recommend precise updates when a decision should persist. Make interfaces, data flow, integration constraints, compatibility concerns, migrations, and consequential tradeoffs explicit, recording decisions so implementers can act without guessing. Prefer the simplest design that satisfies the goal, identify risks and unknowns, and do not expand product scope or dictate incidental implementation details.",
  tech_lead: "Translate approved product intent and architecture into an executable engineering approach. Use Project and Repository Context to align work with established structure, commands, interfaces, and conventions; identify outdated operational knowledge and recommend durable updates when planning establishes a new way of working. Resolve technical ambiguity, sequence cross-repository changes, reinforce existing conventions, identify dependencies and integration risks, and give developers concrete guidance that keeps changes focused and maintainable. Escalate product or architectural decisions instead of silently making assumptions outside the ticket.",
  backend_developer: "Implement reliable backend behavior within only the approved scope, with clear interfaces, appropriate validation, deliberate failure handling, and focused automated tests. Preserve API, data, and migration compatibility unless the ticket explicitly changes them; follow existing repository conventions and coordinate any cross-repository contract changes. Report the files changed, checks run, results, and any remaining risks or assumptions.",
  frontend_developer: "Implement only the approved frontend scope as an accessible, understandable experience that fits the existing product and visual system. Keep API contracts, state, loading, empty, error, responsive, and keyboard behavior coherent, and add focused tests for meaningful interactions. Report the files changed, checks run, results, and any remaining risks or assumptions.",
  devops_database_engineer: "Make infrastructure, deployment, database, and operational changes safely, repeatably, and preferably through version-controlled automation. Protect data, secrets, least privilege, backward compatibility, observability, and concurrent deployments; make migrations and rollout order explicit and provide a tested rollback or recovery path where risk warrants it. Never perform an irreversible production action without explicit authorization, and provide concrete verification evidence.",
  qa_engineer: "Verify the implemented behavior against every applicable acceptance criterion and required check using reproducible tests, including relevant regression, failure, boundary, and cross-repository integration cases. Report exact steps, environment, evidence, and observed versus expected behavior; distinguish product defects from test or environment failures. Do not mark work verified when evidence is missing, and do not broaden the ticket while testing it.",
  code_reviewer: "Review the actual change against the ticket, architecture, repository conventions, and acceptance criteria for correctness, clarity, maintainability, test coverage, compatibility, failure behavior, and unintended effects. Classify findings as blocking or advisory, cite specific evidence, and recommend focused fixes rather than stylistic rewrites. Confirm required checks rather than assuming they ran, and do not approve unsupported conclusions.",
  security_reviewer: "Review the changed threat surface and trust boundaries, including authentication, authorization, input handling, secrets, sensitive data, dependencies, network exposure, logging, and abuse paths. Tie findings to concrete evidence, explain realistic impact and exploit conditions, distinguish blocking vulnerabilities from defense-in-depth suggestions, and give proportionate actionable mitigations. Do not claim security assurance beyond the scope and evidence reviewed.",
  release_manager: "Confirm that only approved, applied changes advance toward release and that dependencies, required QA, code-review, and security evidence are complete. Verify integration state, deployment and migration order, configuration, compatibility, observability, release notes, and a proportionate rollback or recovery plan. Block release when evidence or prerequisites are missing, communicate the exact reason and next action, and record the final release outcome.",
};

export const defaultAgentConsultationRoles: Record<AgentRole, AgentRole[]> = {
  project_manager: ["architect", "tech_lead"],
  architect: [],
  tech_lead: [],
  backend_developer: [],
  frontend_developer: [],
  devops_database_engineer: [],
  qa_engineer: [],
  code_reviewer: [],
  security_reviewer: [],
  release_manager: [],
};
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

export type ContextUpdatedBy = "director" | AgentRole;

export interface ContextDocumentSummary {
  id: string;
  projectId: string;
  repositoryId: string | null;
  content: string;
  version: number;
  updatedBy: ContextUpdatedBy;
  createdAt: string;
  updatedAt: string;
}

export interface ContextRevisionSummary extends ContextDocumentSummary {
  documentId: string;
}

export interface ProposedContextUpdateSummary {
  id: string;
  projectId: string;
  approvalId: string;
  repositoryId: string | null;
  content: string;
  reason: string;
  proposedByRole: AgentRole;
  status: "pending" | "applied" | "rejected";
  createdAt: string;
  decidedAt: string | null;
}

export interface PlanContextUpdateInput {
  repositoryId: string | null;
  content: string;
  reason: string;
}

export interface UpdateContextInput {
  content: string;
}

export interface OrchestrationState {
  project: ProjectSummary;
  objectives: ObjectiveSummary[];
  tasks: TaskSummary[];
  approvals: ApprovalSummary[];
  contexts: ContextDocumentSummary[];
  contextRevisions: ContextRevisionSummary[];
  proposedContextUpdates: ProposedContextUpdateSummary[];
  messages: AgentMessageSummary[];
  directives: AgentDirectiveSummary[];
  agentConfigurations: AgentConfigurationSummary[];
  runs: AgentRunSummary[];
  runActivities: Record<string, RunEvent>;
  recoveries: TaskWorkflowRecoverySummary[];
  integrationProposals: IntegrationProposalSummary[];
}

export type TaskWorkflowRecoveryStage = "implementation" | "repair" | "verification" | "release";

export interface TaskWorkflowRecoverySummary {
  taskId: string;
  projectId: string;
  interruptedRunId: string;
  stage: TaskWorkflowRecoveryStage;
  verificationCheck: VerificationCheck | null;
  reason: string;
  guidance: string | null;
  interruptedAt: string;
}

export type TaskReviewState = "applicable" | "stale" | "applied" | "report-only";

export interface TaskReviewSummary {
  taskId: string;
  runId: string;
  state: TaskReviewState;
  branches: string[];
  message: string;
}

export type IntegrationProposalStatus = "pending" | "approved" | "rejected" | "applied";

export interface IntegrationProposalSummary {
  approvalId: string;
  projectId: string;
  taskId: string;
  changeRunId: string;
  releaseRunId: string;
  status: IntegrationProposalStatus;
  createdAt: string;
  decidedAt: string | null;
  appliedAt: string | null;
}

export interface TaskWorkflowRunDetail {
  run: AgentRunSummary;
  attempts: RunAttemptSummary[];
  events: RunEvent[];
  artifacts: RunArtifactSummary[];
  usage: RunUsageSummary[];
}

export interface TaskWorkflowDetailResponse {
  task: TaskSummary;
  runs: TaskWorkflowRunDetail[];
  recovery: TaskWorkflowRecoverySummary | null;
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

export interface AgentDirectiveSummary {
  id: string;
  projectId: string;
  agentRole: AgentRole;
  content: string;
  sourceMessageId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentConfigurationSummary {
  projectId: string;
  agentRole: AgentRole;
  rolePrompt: string;
  consultationRoles: AgentRole[];
  customized: boolean;
  updatedAt: string | null;
}

export interface UpdateAgentConfigurationInput {
  rolePrompt: string;
  consultationRoles?: AgentRole[];
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
  contextUpdates?: PlanContextUpdateInput[];
}

export interface CreatePlanResponse {
  objective: ObjectiveSummary;
  tasks: TaskSummary[];
  approval: ApprovalSummary;
  contextUpdates: ProposedContextUpdateSummary[];
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
  | "runtime.fallback"
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
  integrationBaseCommit?: string;
}

export type RunPurpose = "planning" | "consultation" | "implementation" | "repair" | "verification" | "release";
export type VerificationCheck = "qa" | "code_review" | "security";

export interface RunSpec {
  schemaVersion: typeof runContractSchemaVersion;
  runId: string;
  projectId: string;
  taskId?: string;
  agentRole: AgentRole;
  runPurpose?: RunPurpose;
  verificationCheck?: VerificationCheck;
  verificationRound?: number;
  agentInstructions?: string;
  directorGuidance?: string;
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

export type AgentDirectiveAction =
  | { action: "add"; directiveId: null; content: string }
  | { action: "remove"; directiveId: string; content: string };

export interface ProjectManagerResponse {
  assistantMessage: string;
  intent: "conversation" | "directive_update" | "consultation" | "plan";
  directiveActions: AgentDirectiveAction[];
  consultationRequests: AgentConsultationRequest[];
  contextUpdates: PlanContextUpdateInput[];
  objective: {
    title: string;
    description: string;
  } | null;
  tasks: PlanTaskInput[];
}

export interface AgentConsultationRequest {
  agentRole: AgentRole;
  question: string;
}

export interface AgentConsultationResult extends AgentConsultationRequest {
  response: string;
  contextUpdates: PlanContextUpdateInput[];
}

export interface PlanningRunRequest {
  run: RunSpec;
  directorMessageId: string;
  directives: AgentDirectiveSummary[];
  conversation: Array<Pick<AgentMessageSummary, "author" | "body">>;
  availableConsultants: AgentRole[];
  consultationResults: AgentConsultationResult[];
  projectContext: string;
  repositoryContexts: Array<{ repositoryId: string; name: string; content: string }>;
  repositorySources: Array<{
    repositoryId: string;
    name: string;
    description?: string;
    sourcePath: string;
  }>;
}

export interface ConsultationRunRequest {
  run: RunSpec;
  requestingRole: AgentRole | "engineering_director";
  question: string;
  directives: AgentDirectiveSummary[];
  conversation: Array<Pick<AgentMessageSummary, "author" | "body">>;
  projectContext: string;
  repositoryContexts: PlanningRunRequest["repositoryContexts"];
  repositorySources: PlanningRunRequest["repositorySources"];
}

export interface ConsultationRunResponse {
  workerId: string;
  imageDigest: string;
  providerThreadId: string | null;
  response: string;
  directiveActions?: AgentDirectiveAction[];
  contextUpdates: PlanContextUpdateInput[];
  usage?: PlanningRunResponse["usage"];
}

export interface PlanningRunResponse {
  workerId: string;
  imageDigest: string;
  providerThreadId: string | null;
  proposal: ProjectManagerResponse;
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
