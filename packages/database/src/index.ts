import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  AgentRuntimeAssignmentSummary,
  AgentRunStatus,
  AgentRunSummary,
  AgentMessageAuthor,
  AgentMessageSummary,
  AgentRole,
  ApprovalStatus,
  ApprovalSummary,
  ApprovalType,
  BrainProfileRef,
  BrainProfileSummary,
  CodingHarnessSummary,
  ModelBackendSummary,
  ObjectiveStatus,
  ObjectiveSummary,
  OrchestrationState,
  PlanningNetworkPolicy,
  ProjectStatus,
  ProjectSettingsSummary,
  ProjectSetupStatus,
  ProjectSummary,
  RepositorySummary,
  RunArtifactKind,
  RunArtifactSummary,
  RunAttemptStatus,
  RunAttemptSummary,
  RunEvent,
  RunResult,
  RunSpec,
  RunUsageSummary,
  RuntimeProfileSummary,
  TaskLeaseSummary,
  TaskRequiredChecks,
  TaskStatus,
  TaskSummary,
  UpdateProjectSettingsInput,
  SaveModelBackendInput,
  SaveCodingHarnessInput,
  SaveRuntimeProfileInput,
} from "@engineering-team/contracts";
import { runContractSchemaVersion } from "@engineering-team/contracts";
import { migrate } from "./migrations.js";

interface ProjectRow {
  id: string;
  name: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
}

interface RepositoryRow {
  id: string;
  project_id: string;
  relative_path: string;
  name: string;
  default_branch: string | null;
  remote_url: string | null;
  description: string;
  enabled: 0 | 1;
  available: 0 | 1;
}

interface AgentMessageRow {
  id: string;
  project_id: string;
  agent_role: AgentRole;
  author: AgentMessageAuthor;
  body: string;
  created_at: string;
}

interface ObjectiveRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: ObjectiveStatus;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  project_id: string;
  objective_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assigned_role: AgentRole;
  acceptance_criteria_json: string;
  required_checks_json: string;
  created_at: string;
  updated_at: string;
}

interface ApprovalRow {
  id: string;
  project_id: string;
  objective_id: string | null;
  task_id: string | null;
  approval_type: ApprovalType;
  title: string;
  details: string;
  status: ApprovalStatus;
  requested_by_role: AgentRole;
  requested_at: string;
  decided_at: string | null;
  decision_note: string | null;
}

interface BrainProfileRow {
  id: string;
  project_id: string;
  name: string;
  provider: string;
  harness: string;
  model_class: string;
  model: string | null;
  reasoning_level: string | null;
  credential_ref: string;
  configuration_json: string;
  created_at: string;
  updated_at: string;
}

interface AgentRunRow {
  id: string;
  project_id: string;
  task_id: string | null;
  agent_role: AgentRole;
  brain_profile_id: string;
  status: AgentRunStatus;
  run_spec_json: string;
  result_json: string | null;
  provider_thread_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface RunAttemptRow {
  id: string;
  run_id: string;
  attempt_number: number;
  status: RunAttemptStatus;
  worker_id: string | null;
  image_digest: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface RunEventRow {
  id: string;
  run_id: string;
  attempt_id: string | null;
  sequence: number;
  event_type: RunEvent["type"];
  message: string | null;
  payload_json: string;
  created_at: string;
}

interface RunArtifactRow {
  id: string;
  run_id: string;
  attempt_id: string | null;
  artifact_kind: RunArtifactKind;
  name: string;
  storage_path: string;
  media_type: string | null;
  metadata_json: string;
  created_at: string;
}

interface RunUsageRow {
  id: string;
  run_id: string;
  attempt_id: string | null;
  provider: string;
  model: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  cost_cents: number | null;
  duration_ms: number | null;
  created_at: string;
}

interface TaskLeaseRow {
  task_id: string;
  run_id: string;
  lease_token: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

interface ProjectSettingsRow {
  project_id: string;
  setup_status: ProjectSetupStatus;
  setup_completed_at: string | null;
  default_run_timeout_seconds: number;
  default_run_retries: number;
  default_token_budget: number | null;
  default_cost_budget_cents: number | null;
  planning_network_policy: PlanningNetworkPolicy;
  require_plan_approval: 0 | 1;
  created_at: string;
  updated_at: string;
}

interface ModelBackendRow {
  id: string;
  project_id: string;
  name: string;
  provider: ModelBackendSummary["provider"];
  protocol: ModelBackendSummary["protocol"];
  model: string | null;
  base_url: string | null;
  auth_mode: ModelBackendSummary["authMode"];
  credential_ref: string | null;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}

interface CodingHarnessRow {
  id: string;
  project_id: string;
  name: string;
  adapter: CodingHarnessSummary["adapter"];
  executable: string;
  container_image: string | null;
  supported_protocols_json: string;
  capabilities_json: string;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}

interface RuntimeProfileRow {
  id: string;
  project_id: string;
  name: string;
  coding_harness_id: string;
  model_backend_id: string;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}

interface AgentRuntimeAssignmentRow {
  agent_role: AgentRole;
  coding_harness_id: string | null;
  model_backend_id: string | null;
  assigned_at: string;
}

export interface NewProjectRecord {
  id: string;
  name: string;
  repository: NewRepositoryRecord;
}

export type NewRepositoryRecord = Pick<RepositorySummary, "id" | "relativePath" | "name" | "defaultBranch">
  & Partial<Pick<RepositorySummary, "remoteUrl" | "description" | "enabled" | "available">>;

export interface NewPlanRecord {
  projectId: string;
  objective: {
    id: string;
    title: string;
    description: string;
  };
  tasks: Array<{
    id: string;
    key: string;
    title: string;
    description: string;
    assignedRole: AgentRole;
    repositoryIds: string[];
    acceptanceCriteria: string[];
    requiredChecks?: TaskRequiredChecks;
    dependsOn: string[];
  }>;
  approvalId: string;
}

export interface NewBrainProfileRecord extends BrainProfileRef {
  id: string;
  projectId: string;
  name: string;
  configuration: Record<string, unknown>;
}

export interface NewRunAttemptRecord {
  id: string;
  runId: string;
  attemptNumber: number;
  workerId?: string;
  imageDigest?: string;
}

export class TeamDatabase {
  readonly connection: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.connection = new Database(databasePath);
    this.connection.pragma("foreign_keys = ON");
    this.connection.pragma("journal_mode = WAL");
    this.connection.pragma("busy_timeout = 5000");
    migrate(this.connection);
  }

  close(): void {
    this.connection.close();
  }

  listProjects(): ProjectSummary[] {
    const rows = this.connection
      .prepare("SELECT * FROM projects ORDER BY updated_at DESC")
      .all() as ProjectRow[];
    const repositoryRows = this.connection
      .prepare("SELECT id, project_id, relative_path, name, default_branch, remote_url, description, enabled, available FROM repositories ORDER BY name")
      .all() as RepositoryRow[];
    const repositoriesByProject = new Map<string, RepositorySummary[]>();
    for (const repository of repositoryRows) {
      repositoriesByProject.set(repository.project_id, [
        ...(repositoriesByProject.get(repository.project_id) ?? []),
        mapRepositoryRow(repository),
      ]);
    }

    return rows.map((row) => mapProjectRow(row, repositoriesByProject.get(row.id) ?? []));
  }

  getProject(projectId: string): ProjectSummary | null {
    return this.listProjects().find((project) => project.id === projectId) ?? null;
  }

  createProject(record: NewProjectRecord): ProjectSummary {
    const now = new Date().toISOString();
    const create = this.connection.transaction(() => {
      this.connection
        .prepare(
          `INSERT INTO projects (id, name, status, created_at, updated_at)
           VALUES (?, ?, 'active', ?, ?)`,
        )
        .run(record.id, record.name, now, now);

      this.insertDefaultProjectSettings(record.id, now);

      this.connection
        .prepare(
          `INSERT INTO repositories
            (id, project_id, relative_path, name, default_branch, remote_url, description, enabled, available, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.repository.id,
          record.id,
          record.repository.relativePath,
          record.repository.name,
          record.repository.defaultBranch,
          record.repository.remoteUrl ?? null,
          record.repository.description ?? "",
          record.repository.enabled === false ? 0 : 1,
          record.repository.available === false ? 0 : 1,
          now,
        );

      this.recordEvent(record.id, "project.created", "project", record.id, {
        repositoryId: record.repository.id,
      }, now);
    });

    create();
    const project = this.getProject(record.id);
    if (!project) throw new Error("Project was created but could not be read back");
    return project;
  }

  createWorkspaceProject(id: string, name: string): ProjectSummary {
    const existing = this.listProjects()[0];
    if (existing) return existing;
    const now = new Date().toISOString();
    const create = this.connection.transaction(() => {
      this.connection
        .prepare(
          `INSERT INTO projects (id, name, status, created_at, updated_at)
           VALUES (?, ?, 'active', ?, ?)`,
        )
        .run(id, name, now, now);
      this.insertDefaultProjectSettings(id, now);
      this.recordEvent(id, "project.created", "project", id, { source: "workspace" }, now);
    });
    create();
    const project = this.getProject(id);
    if (!project) throw new Error("Project was created but could not be read back");
    return project;
  }

  renameProject(projectId: string, name: string): ProjectSummary {
    const now = new Date().toISOString();
    const result = this.connection
      .prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
      .run(name, now, projectId);
    if (result.changes === 0) throw new Error("Project not found");
    this.recordEvent(projectId, "project.renamed", "project", projectId, { name }, now);
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project could not be read back");
    return project;
  }

  getProjectSettings(projectId: string): ProjectSettingsSummary | null {
    const row = this.connection
      .prepare("SELECT * FROM project_settings WHERE project_id = ?")
      .get(projectId) as ProjectSettingsRow | undefined;
    return row ? mapProjectSettingsRow(row) : null;
  }

  updateProjectSettings(
    projectId: string,
    input: UpdateProjectSettingsInput,
  ): ProjectSettingsSummary {
    const current = this.getProjectSettings(projectId);
    if (!current) throw new Error("Project settings not found");
    const now = new Date().toISOString();
    const setupStatus = input.setupStatus ?? current.setupStatus;
    const setupCompletedAt =
      setupStatus === "completed"
        ? current.setupCompletedAt ?? now
        : null;
    const updated: ProjectSettingsSummary = {
      ...current,
      setupStatus,
      setupCompletedAt,
      defaultRunTimeoutSeconds:
        input.defaultRunTimeoutSeconds ?? current.defaultRunTimeoutSeconds,
      defaultRunRetries: input.defaultRunRetries ?? current.defaultRunRetries,
      defaultTokenBudget:
        input.defaultTokenBudget === undefined
          ? current.defaultTokenBudget
          : input.defaultTokenBudget,
      defaultCostBudgetCents:
        input.defaultCostBudgetCents === undefined
          ? current.defaultCostBudgetCents
          : input.defaultCostBudgetCents,
      planningNetworkPolicy:
        input.planningNetworkPolicy ?? current.planningNetworkPolicy,
      requirePlanApproval: input.requirePlanApproval ?? current.requirePlanApproval,
      updatedAt: now,
    };

    const update = this.connection.transaction(() => {
      this.connection
        .prepare(
          `UPDATE project_settings SET
            setup_status = ?, setup_completed_at = ?, default_run_timeout_seconds = ?,
            default_run_retries = ?, default_token_budget = ?, default_cost_budget_cents = ?,
            planning_network_policy = ?, require_plan_approval = ?, updated_at = ?
           WHERE project_id = ?`,
        )
        .run(
          updated.setupStatus,
          updated.setupCompletedAt,
          updated.defaultRunTimeoutSeconds,
          updated.defaultRunRetries,
          updated.defaultTokenBudget,
          updated.defaultCostBudgetCents,
          updated.planningNetworkPolicy,
          updated.requirePlanApproval ? 1 : 0,
          updated.updatedAt,
          projectId,
        );
      this.recordEvent(projectId, "project.settings_updated", "project_settings", projectId, {
        changedFields: Object.keys(input),
        setupStatus: updated.setupStatus,
      }, now);
    });
    update();
    return updated;
  }

  listModelBackends(projectId: string): ModelBackendSummary[] {
    const rows = this.connection
      .prepare("SELECT * FROM model_backends WHERE project_id = ? ORDER BY name")
      .all(projectId) as ModelBackendRow[];
    return rows.map(mapModelBackendRow);
  }

  getModelBackend(projectId: string, backendId: string): ModelBackendSummary | null {
    const row = this.connection
      .prepare("SELECT * FROM model_backends WHERE project_id = ? AND id = ?")
      .get(projectId, backendId) as ModelBackendRow | undefined;
    return row ? mapModelBackendRow(row) : null;
  }

  createModelBackend(
    projectId: string,
    backendId: string,
    input: SaveModelBackendInput,
  ): ModelBackendSummary {
    if (!this.getProject(projectId)) throw new Error("Project not found");
    const now = new Date().toISOString();
    this.connection.transaction(() => {
      this.connection
        .prepare(
          `INSERT INTO model_backends
            (id, project_id, name, provider, protocol, model, base_url, auth_mode,
             credential_ref, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          backendId,
          projectId,
          input.name,
          input.provider,
          input.protocol,
          input.model ?? null,
          input.baseUrl ?? null,
          input.authMode,
          input.credentialRef ?? null,
          input.enabled === false ? 0 : 1,
          now,
          now,
        );
      this.recordEvent(projectId, "model_backend.created", "model_backend", backendId, {
        name: input.name,
        provider: input.provider,
        protocol: input.protocol,
      }, now);
    })();
    const backend = this.getModelBackend(projectId, backendId);
    if (!backend) throw new Error("Model backend could not be read back");
    return backend;
  }

  updateModelBackend(
    projectId: string,
    backendId: string,
    input: SaveModelBackendInput,
  ): ModelBackendSummary {
    const attachedProfiles = this.connection
      .prepare("SELECT coding_harness_id FROM runtime_profiles WHERE project_id = ? AND model_backend_id = ?")
      .all(projectId, backendId) as Array<{ coding_harness_id: string }>;
    const assignedHarnesses = this.connection
      .prepare("SELECT coding_harness_id FROM agent_runtime_assignments WHERE project_id = ? AND model_backend_id = ?")
      .all(projectId, backendId) as Array<{ coding_harness_id: string | null }>;
    for (const profile of [...attachedProfiles, ...assignedHarnesses]) {
      if (!profile.coding_harness_id) continue;
      const harness = this.getCodingHarness(projectId, profile.coding_harness_id);
      if (harness && !harness.supportedProtocols.includes(input.protocol)) {
        throw new Error("The selected protocol is not supported by an attached or assigned coding harness");
      }
    }
    const now = new Date().toISOString();
    const result = this.connection
      .prepare(
        `UPDATE model_backends SET
          name = ?, provider = ?, protocol = ?, model = ?, base_url = ?, auth_mode = ?,
          credential_ref = ?, enabled = ?, updated_at = ?
         WHERE project_id = ? AND id = ?`,
      )
      .run(
        input.name,
        input.provider,
        input.protocol,
        input.model ?? null,
        input.baseUrl ?? null,
        input.authMode,
        input.credentialRef ?? null,
        input.enabled === false ? 0 : 1,
        now,
        projectId,
        backendId,
      );
    if (result.changes === 0) throw new Error("Model backend not found");
    this.recordEvent(projectId, "model_backend.updated", "model_backend", backendId, {
      name: input.name,
      provider: input.provider,
      protocol: input.protocol,
      enabled: input.enabled !== false,
    }, now);
    const backend = this.getModelBackend(projectId, backendId);
    if (!backend) throw new Error("Model backend could not be read back");
    return backend;
  }

  deleteModelBackend(projectId: string, backendId: string): void {
    const now = new Date().toISOString();
    const remove = this.connection.transaction(() => {
      const result = this.connection
        .prepare("DELETE FROM model_backends WHERE project_id = ? AND id = ?")
        .run(projectId, backendId);
      if (result.changes === 0) throw new Error("Model backend not found");
      this.recordEvent(projectId, "model_backend.deleted", "model_backend", backendId, {}, now);
    });
    remove();
  }

  listCodingHarnesses(projectId: string): CodingHarnessSummary[] {
    const rows = this.connection
      .prepare("SELECT * FROM coding_harnesses WHERE project_id = ? ORDER BY name")
      .all(projectId) as CodingHarnessRow[];
    return rows.map(mapCodingHarnessRow);
  }

  getCodingHarness(projectId: string, harnessId: string): CodingHarnessSummary | null {
    const row = this.connection
      .prepare("SELECT * FROM coding_harnesses WHERE project_id = ? AND id = ?")
      .get(projectId, harnessId) as CodingHarnessRow | undefined;
    return row ? mapCodingHarnessRow(row) : null;
  }

  createCodingHarness(
    projectId: string,
    harnessId: string,
    input: SaveCodingHarnessInput,
  ): CodingHarnessSummary {
    if (!this.getProject(projectId)) throw new Error("Project not found");
    const now = new Date().toISOString();
    this.connection.transaction(() => {
      this.connection
        .prepare(
          `INSERT INTO coding_harnesses
            (id, project_id, name, adapter, executable, container_image,
             supported_protocols_json, capabilities_json, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          harnessId,
          projectId,
          input.name,
          input.adapter,
          input.executable,
          input.containerImage ?? null,
          JSON.stringify(input.supportedProtocols),
          JSON.stringify(input.capabilities),
          input.enabled === false ? 0 : 1,
          now,
          now,
        );
      this.recordEvent(projectId, "coding_harness.created", "coding_harness", harnessId, {
        name: input.name,
        adapter: input.adapter,
      }, now);
    })();
    const harness = this.getCodingHarness(projectId, harnessId);
    if (!harness) throw new Error("Coding harness could not be read back");
    return harness;
  }

  updateCodingHarness(
    projectId: string,
    harnessId: string,
    input: SaveCodingHarnessInput,
  ): CodingHarnessSummary {
    const attachedProfiles = this.connection
      .prepare("SELECT model_backend_id FROM runtime_profiles WHERE project_id = ? AND coding_harness_id = ?")
      .all(projectId, harnessId) as Array<{ model_backend_id: string }>;
    const assignedBackends = this.connection
      .prepare("SELECT model_backend_id FROM agent_runtime_assignments WHERE project_id = ? AND coding_harness_id = ?")
      .all(projectId, harnessId) as Array<{ model_backend_id: string | null }>;
    for (const profile of [...attachedProfiles, ...assignedBackends]) {
      if (!profile.model_backend_id) continue;
      const backend = this.getModelBackend(projectId, profile.model_backend_id);
      if (backend && !input.supportedProtocols.includes(backend.protocol)) {
        throw new Error("Supported protocols must include every attached or assigned model backend");
      }
    }
    const now = new Date().toISOString();
    const result = this.connection
      .prepare(
        `UPDATE coding_harnesses SET
          name = ?, adapter = ?, executable = ?, container_image = ?,
          supported_protocols_json = ?, capabilities_json = ?, enabled = ?, updated_at = ?
         WHERE project_id = ? AND id = ?`,
      )
      .run(
        input.name,
        input.adapter,
        input.executable,
        input.containerImage ?? null,
        JSON.stringify(input.supportedProtocols),
        JSON.stringify(input.capabilities),
        input.enabled === false ? 0 : 1,
        now,
        projectId,
        harnessId,
      );
    if (result.changes === 0) throw new Error("Coding harness not found");
    this.recordEvent(projectId, "coding_harness.updated", "coding_harness", harnessId, {
      name: input.name,
      adapter: input.adapter,
      enabled: input.enabled !== false,
    }, now);
    const harness = this.getCodingHarness(projectId, harnessId);
    if (!harness) throw new Error("Coding harness could not be read back");
    return harness;
  }

  deleteCodingHarness(projectId: string, harnessId: string): void {
    const now = new Date().toISOString();
    this.connection.transaction(() => {
      const result = this.connection
        .prepare("DELETE FROM coding_harnesses WHERE project_id = ? AND id = ?")
        .run(projectId, harnessId);
      if (result.changes === 0) throw new Error("Coding harness not found");
      this.recordEvent(projectId, "coding_harness.deleted", "coding_harness", harnessId, {}, now);
    })();
  }

  listRuntimeProfiles(projectId: string): RuntimeProfileSummary[] {
    const rows = this.connection
      .prepare("SELECT * FROM runtime_profiles WHERE project_id = ? ORDER BY name")
      .all(projectId) as RuntimeProfileRow[];
    return rows.map((row) => this.mapRuntimeProfileRow(row));
  }

  getRuntimeProfile(projectId: string, profileId: string): RuntimeProfileSummary | null {
    const row = this.connection
      .prepare("SELECT * FROM runtime_profiles WHERE project_id = ? AND id = ?")
      .get(projectId, profileId) as RuntimeProfileRow | undefined;
    return row ? this.mapRuntimeProfileRow(row) : null;
  }

  createRuntimeProfile(
    projectId: string,
    profileId: string,
    input: SaveRuntimeProfileInput,
  ): RuntimeProfileSummary {
    this.assertRuntimeProfilePair(projectId, input);
    const now = new Date().toISOString();
    this.connection.transaction(() => {
      this.connection
        .prepare(
          `INSERT INTO runtime_profiles
            (id, project_id, name, coding_harness_id, model_backend_id, enabled,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          profileId,
          projectId,
          input.name,
          input.codingHarnessId,
          input.modelBackendId,
          input.enabled === false ? 0 : 1,
          now,
          now,
        );
      this.recordEvent(projectId, "runtime_profile.created", "runtime_profile", profileId, {
        name: input.name,
        codingHarnessId: input.codingHarnessId,
        modelBackendId: input.modelBackendId,
      }, now);
    })();
    const profile = this.getRuntimeProfile(projectId, profileId);
    if (!profile) throw new Error("Runtime profile could not be read back");
    return profile;
  }

  updateRuntimeProfile(
    projectId: string,
    profileId: string,
    input: SaveRuntimeProfileInput,
  ): RuntimeProfileSummary {
    this.assertRuntimeProfilePair(projectId, input);
    const now = new Date().toISOString();
    const result = this.connection
      .prepare(
        `UPDATE runtime_profiles SET
          name = ?, coding_harness_id = ?, model_backend_id = ?, enabled = ?, updated_at = ?
         WHERE project_id = ? AND id = ?`,
      )
      .run(
        input.name,
        input.codingHarnessId,
        input.modelBackendId,
        input.enabled === false ? 0 : 1,
        now,
        projectId,
        profileId,
      );
    if (result.changes === 0) throw new Error("Runtime profile not found");
    this.recordEvent(projectId, "runtime_profile.updated", "runtime_profile", profileId, {
      name: input.name,
      codingHarnessId: input.codingHarnessId,
      modelBackendId: input.modelBackendId,
      enabled: input.enabled !== false,
    }, now);
    const profile = this.getRuntimeProfile(projectId, profileId);
    if (!profile) throw new Error("Runtime profile could not be read back");
    return profile;
  }

  deleteRuntimeProfile(projectId: string, profileId: string): void {
    const now = new Date().toISOString();
    this.connection.transaction(() => {
      const result = this.connection
        .prepare("DELETE FROM runtime_profiles WHERE project_id = ? AND id = ?")
        .run(projectId, profileId);
      if (result.changes === 0) throw new Error("Runtime profile not found");
      this.recordEvent(projectId, "runtime_profile.deleted", "runtime_profile", profileId, {}, now);
    })();
  }

  private assertRuntimeProfilePair(projectId: string, input: SaveRuntimeProfileInput): void {
    if (!this.getProject(projectId)) throw new Error("Project not found");
    const harness = this.getCodingHarness(projectId, input.codingHarnessId);
    if (!harness) throw new Error("Coding harness is not part of this project");
    const backend = this.getModelBackend(projectId, input.modelBackendId);
    if (!backend) throw new Error("Model backend is not part of this project");
    if (!harness.supportedProtocols.includes(backend.protocol)) {
      throw new Error(`${harness.name} does not support the ${backend.protocol} protocol`);
    }
    if (input.enabled !== false && (!harness.enabled || !backend.enabled)) {
      throw new Error("Enabled runtime profiles require an enabled harness and model backend");
    }
  }

  private mapRuntimeProfileRow(row: RuntimeProfileRow): RuntimeProfileSummary {
    const harness = this.getCodingHarness(row.project_id, row.coding_harness_id);
    const backend = this.getModelBackend(row.project_id, row.model_backend_id);
    const compatible = Boolean(
      harness && backend && harness.supportedProtocols.includes(backend.protocol),
    );
    const enabled = row.enabled === 1;
    const status = !compatible
      ? "incompatible"
      : !enabled || !harness?.enabled || !backend?.enabled
        ? "disabled"
        : "ready";
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      codingHarnessId: row.coding_harness_id,
      modelBackendId: row.model_backend_id,
      protocol: backend?.protocol ?? "openai-responses",
      enabled,
      status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listAgentRuntimeAssignments(
    projectId: string,
  ): AgentRuntimeAssignmentSummary[] {
    const rows = this.connection
      .prepare(
        `SELECT agent_role, coding_harness_id, model_backend_id, assigned_at
         FROM agent_runtime_assignments
         WHERE project_id = ?
         ORDER BY agent_role`,
      )
      .all(projectId) as AgentRuntimeAssignmentRow[];
    return rows.map((row) => ({
      agentRole: row.agent_role,
      codingHarnessId: row.coding_harness_id,
      modelBackendId: row.model_backend_id,
      assignedAt: row.assigned_at,
    }));
  }

  getAgentRuntimeAssignment(
    projectId: string,
    agentRole: AgentRole,
  ): AgentRuntimeAssignmentSummary | null {
    return this.listAgentRuntimeAssignments(projectId)
      .find((assignment) => assignment.agentRole === agentRole) ?? null;
  }

  assignAgentRuntime(
    projectId: string,
    agentRole: AgentRole,
    codingHarnessId: string | null,
    modelBackendId: string | null,
  ): AgentRuntimeAssignmentSummary | null {
    if (!this.getProject(projectId)) throw new Error("Project not found");
    const now = new Date().toISOString();
    if (codingHarnessId === null && modelBackendId === null) {
      this.connection
        .prepare(
          "DELETE FROM agent_runtime_assignments WHERE project_id = ? AND agent_role = ?",
        )
        .run(projectId, agentRole);
      this.recordEvent(projectId, "agent_role.runtime_cleared", "agent_role", agentRole, {
        agentRole,
      }, now);
      return null;
    }
    const harness = codingHarnessId ? this.getCodingHarness(projectId, codingHarnessId) : null;
    if (codingHarnessId && !harness) throw new Error("Coding harness is not part of this project");
    const backend = modelBackendId ? this.getModelBackend(projectId, modelBackendId) : null;
    if (modelBackendId && !backend) throw new Error("Model backend is not part of this project");
    if (harness && backend && !harness.supportedProtocols.includes(backend.protocol)) {
      throw new Error(`${harness.name} does not support the ${backend.protocol} protocol`);
    }
    if ((harness && !harness.enabled) || (backend && !backend.enabled)) {
      throw new Error("Agent runtime assignments require enabled harnesses and model backends");
    }
    this.connection
      .prepare(
        `INSERT INTO agent_runtime_assignments
          (project_id, agent_role, coding_harness_id, model_backend_id, assigned_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, agent_role) DO UPDATE SET
           coding_harness_id = excluded.coding_harness_id,
           model_backend_id = excluded.model_backend_id,
           assigned_at = excluded.assigned_at`,
      )
      .run(projectId, agentRole, codingHarnessId, modelBackendId, now);
    this.recordEvent(projectId, "agent_role.runtime_assigned", "agent_role", agentRole, {
      agentRole, codingHarnessId, modelBackendId,
    }, now);
    return { agentRole, codingHarnessId, modelBackendId, assignedAt: now };
  }

  addRepository(projectId: string, repository: NewRepositoryRecord): ProjectSummary {
    const now = new Date().toISOString();
    const add = this.connection.transaction(() => {
      if (!this.getProject(projectId)) throw new Error("Project not found");
      this.connection
        .prepare(
          `INSERT INTO repositories
            (id, project_id, relative_path, name, default_branch, remote_url, description, enabled, available, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          repository.id,
          projectId,
          repository.relativePath,
          repository.name,
          repository.defaultBranch,
          repository.remoteUrl ?? null,
          repository.description ?? "",
          repository.enabled === false ? 0 : 1,
          repository.available === false ? 0 : 1,
          now,
        );
      this.connection.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, projectId);
      this.recordEvent(projectId, "repository.added", "repository", repository.id, {
        relativePath: repository.relativePath,
      }, now);
    });
    add();
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project could not be read back");
    return project;
  }

  refreshRepository(
    projectId: string,
    repositoryId: string,
    inspection: Pick<RepositorySummary, "name" | "defaultBranch" | "remoteUrl" | "available">,
  ): void {
    this.connection
      .prepare(
        `UPDATE repositories
         SET name = ?, default_branch = ?, remote_url = ?, available = ?
         WHERE id = ? AND project_id = ?`,
      )
      .run(
        inspection.name,
        inspection.defaultBranch,
        inspection.remoteUrl,
        inspection.available ? 1 : 0,
        repositoryId,
        projectId,
      );
  }

  updateRepository(
    projectId: string,
    repositoryId: string,
    input: { description?: string; enabled?: boolean },
  ): ProjectSummary {
    const current = this.getProject(projectId)?.repositories.find((repository) => repository.id === repositoryId);
    if (!current) throw new Error("Repository not found");
    const now = new Date().toISOString();
    this.connection.transaction(() => {
      this.connection
        .prepare("UPDATE repositories SET description = ?, enabled = ? WHERE id = ? AND project_id = ?")
        .run(
          input.description ?? current.description,
          (input.enabled ?? current.enabled) ? 1 : 0,
          repositoryId,
          projectId,
        );
      this.connection.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, projectId);
      this.recordEvent(projectId, "repository.updated", "repository", repositoryId, input, now);
    })();
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project could not be read back");
    return project;
  }

  getOrchestrationState(projectId: string): OrchestrationState | null {
    const project = this.getProject(projectId);
    if (!project) return null;

    const objectives = (
      this.connection
        .prepare("SELECT * FROM objectives WHERE project_id = ? ORDER BY created_at DESC")
        .all(projectId) as ObjectiveRow[]
    ).map(mapObjectiveRow);

    const taskRows = this.connection
        .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, sort_order")
      .all(projectId) as TaskRow[];
    const dependencyRows = this.connection
      .prepare(
        `SELECT td.task_id, td.depends_on_task_id
         FROM task_dependencies td
         JOIN tasks t ON t.id = td.task_id
         WHERE t.project_id = ?`,
      )
      .all(projectId) as Array<{ task_id: string; depends_on_task_id: string }>;
    const dependencies = new Map<string, string[]>();
    for (const row of dependencyRows) {
      dependencies.set(row.task_id, [...(dependencies.get(row.task_id) ?? []), row.depends_on_task_id]);
    }

    const taskRepositoryRows = this.connection
      .prepare(
        `SELECT tr.task_id, tr.repository_id
         FROM task_repositories tr
         JOIN tasks t ON t.id = tr.task_id
         WHERE t.project_id = ?`,
      )
      .all(projectId) as Array<{ task_id: string; repository_id: string }>;
    const repositoriesByTask = new Map<string, string[]>();
    for (const row of taskRepositoryRows) {
      repositoriesByTask.set(row.task_id, [
        ...(repositoriesByTask.get(row.task_id) ?? []),
        row.repository_id,
      ]);
    }

    const tasks = taskRows.map((row) =>
      mapTaskRow(row, dependencies.get(row.id) ?? [], repositoriesByTask.get(row.id) ?? []),
    );
    const approvals = (
      this.connection
        .prepare(
          "SELECT * FROM approval_requests WHERE project_id = ? ORDER BY requested_at DESC",
        )
        .all(projectId) as ApprovalRow[]
    ).map(mapApprovalRow);

    const messages = (
      this.connection
        .prepare("SELECT * FROM agent_messages WHERE project_id = ? ORDER BY created_at, rowid")
        .all(projectId) as AgentMessageRow[]
    ).map(mapAgentMessageRow);

    const runs = this.listAgentRuns(projectId);
    return { project, objectives, tasks, approvals, messages, runs };
  }

  createPlan(record: NewPlanRecord): {
    objective: ObjectiveSummary;
    tasks: TaskSummary[];
    approval: ApprovalSummary;
  } {
    const now = new Date().toISOString();
    const taskIdsByKey = new Map(record.tasks.map((task) => [task.key, task.id]));

    const create = this.connection.transaction(() => {
      if (!this.getProject(record.projectId)) throw new Error("Project not found");
      const projectRepositoryIds = new Set(
        this.getProject(record.projectId)?.repositories.map((repository) => repository.id) ?? [],
      );
      for (const task of record.tasks) {
        for (const repositoryId of task.repositoryIds) {
          if (!projectRepositoryIds.has(repositoryId)) {
            throw new Error(`Repository is not part of this project: ${repositoryId}`);
          }
        }
      }

      const pending = this.connection
        .prepare(
          `SELECT id FROM approval_requests
           WHERE project_id = ? AND approval_type = 'plan' AND status = 'pending'`,
        )
        .get(record.projectId);
      if (pending) throw new Error("A plan is already waiting for director approval");

      this.connection
        .prepare(
          `INSERT INTO objectives
            (id, project_id, title, description, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
        )
        .run(
          record.objective.id,
          record.projectId,
          record.objective.title,
          record.objective.description,
          now,
          now,
        );

      const insertTask = this.connection.prepare(
        `INSERT INTO tasks
          (id, project_id, objective_id, title, description, status, assigned_role,
           acceptance_criteria_json, required_checks_json, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
      );
      for (const [index, task] of record.tasks.entries()) {
        insertTask.run(
          task.id,
          record.projectId,
          record.objective.id,
          task.title,
          task.description,
          task.assignedRole,
          JSON.stringify(task.acceptanceCriteria),
          JSON.stringify(task.requiredChecks ?? { qa: false, codeReview: false, security: false }),
          index,
          now,
          now,
        );
      }

      const insertDependency = this.connection.prepare(
        "INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)",
      );
      for (const task of record.tasks) {
        for (const dependencyKey of task.dependsOn) {
          const dependencyId = taskIdsByKey.get(dependencyKey);
          if (!dependencyId) throw new Error(`Unknown task dependency: ${dependencyKey}`);
          insertDependency.run(task.id, dependencyId);
        }
      }

      const insertTaskRepository = this.connection.prepare(
        "INSERT INTO task_repositories (task_id, repository_id) VALUES (?, ?)",
      );
      for (const task of record.tasks) {
        for (const repositoryId of task.repositoryIds) {
          insertTaskRepository.run(task.id, repositoryId);
        }
      }

      this.connection
        .prepare(
          `INSERT INTO approval_requests
            (id, project_id, objective_id, task_id, approval_type, title, details,
             status, requested_by_role, requested_at)
           VALUES (?, ?, ?, NULL, 'plan', ?, ?, 'pending', 'project_manager', ?)`,
        )
        .run(
          record.approvalId,
          record.projectId,
          record.objective.id,
          `Approve plan: ${record.objective.title}`,
          `${record.tasks.length} task${record.tasks.length === 1 ? "" : "s"} proposed for execution.`,
          now,
        );

      this.connection
        .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
        .run(now, record.projectId);
      this.recordEvent(record.projectId, "plan.created", "objective", record.objective.id, {
        approvalId: record.approvalId,
        taskCount: record.tasks.length,
      }, now);
    });

    create();
    const state = this.getOrchestrationState(record.projectId);
    const objective = state?.objectives.find((item) => item.id === record.objective.id);
    const approval = state?.approvals.find((item) => item.id === record.approvalId);
    if (!state || !objective || !approval) throw new Error("Plan could not be read back");
    return {
      objective,
      tasks: state.tasks.filter((task) => task.objectiveId === objective.id),
      approval,
    };
  }

  decideApproval(
    projectId: string,
    approvalId: string,
    decision: "approved" | "rejected",
    note: string | null,
  ): ApprovalSummary {
    const now = new Date().toISOString();
    const decide = this.connection.transaction(() => {
      const row = this.connection
        .prepare("SELECT * FROM approval_requests WHERE id = ? AND project_id = ?")
        .get(approvalId, projectId) as ApprovalRow | undefined;
      if (!row) throw new Error("Approval request not found");
      if (row.status !== "pending") throw new Error("Approval request has already been decided");

      this.connection
        .prepare(
          `UPDATE approval_requests
           SET status = ?, decided_at = ?, decision_note = ?
           WHERE id = ?`,
        )
        .run(decision, now, note, approvalId);

      if (row.approval_type === "plan" && row.objective_id) {
        if (decision === "approved") {
          this.connection
            .prepare("UPDATE objectives SET status = 'active', updated_at = ? WHERE id = ?")
            .run(now, row.objective_id);
          this.connection
            .prepare(
              `UPDATE tasks
               SET status = CASE
                 WHEN EXISTS (
                   SELECT 1 FROM task_dependencies td WHERE td.task_id = tasks.id
                 ) THEN 'blocked' ELSE 'ready' END,
                 updated_at = ?
               WHERE objective_id = ? AND status = 'draft'`,
            )
            .run(now, row.objective_id);
        } else {
          this.connection
            .prepare("UPDATE objectives SET status = 'cancelled', updated_at = ? WHERE id = ?")
            .run(now, row.objective_id);
          this.connection
            .prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE objective_id = ?")
            .run(now, row.objective_id);
        }
      }

      this.connection
        .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
        .run(now, projectId);
      this.recordEvent(projectId, "approval.decided", "approval", approvalId, {
        decision,
        note,
      }, now);
    });

    decide();
    const row = this.connection
      .prepare("SELECT * FROM approval_requests WHERE id = ?")
      .get(approvalId) as ApprovalRow;
    return mapApprovalRow(row);
  }

  updateTaskStatus(
    projectId: string,
    taskId: string,
    nextStatus: "in_progress" | "review" | "completed",
  ): TaskSummary {
    const now = new Date().toISOString();
    const update = this.connection.transaction(() => {
      const task = this.connection
        .prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?")
        .get(taskId, projectId) as TaskRow | undefined;
      if (!task) throw new Error("Task not found");

      const validTransitions: Record<TaskStatus, TaskStatus[]> = {
        draft: [],
        ready: ["in_progress"],
        blocked: [],
        in_progress: ["review"],
        review: ["in_progress", "completed"],
        completed: [],
        cancelled: [],
      };
      if (!validTransitions[task.status].includes(nextStatus)) {
        throw new Error(`Task cannot move from ${task.status} to ${nextStatus}`);
      }

      this.connection
        .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
        .run(nextStatus, now, taskId);

      if (nextStatus === "completed") {
        this.connection
          .prepare(
            `UPDATE tasks
             SET status = 'ready', updated_at = ?
             WHERE objective_id = ? AND status = 'blocked'
               AND NOT EXISTS (
                 SELECT 1
                 FROM task_dependencies td
                 JOIN tasks dependency ON dependency.id = td.depends_on_task_id
                 WHERE td.task_id = tasks.id AND dependency.status <> 'completed'
               )`,
          )
          .run(now, task.objective_id);

        const unfinished = this.connection
          .prepare(
            `SELECT 1 FROM tasks
             WHERE objective_id = ? AND status NOT IN ('completed', 'cancelled') LIMIT 1`,
          )
          .get(task.objective_id);
        if (!unfinished) {
          this.connection
            .prepare("UPDATE objectives SET status = 'completed', updated_at = ? WHERE id = ?")
            .run(now, task.objective_id);
        }
      }

      this.connection
        .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
        .run(now, projectId);
      this.recordEvent(projectId, "task.status_changed", "task", taskId, {
        from: task.status,
        to: nextStatus,
      }, now);
    });

    update();
    const state = this.getOrchestrationState(projectId);
    const task = state?.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("Task could not be read back");
    return task;
  }

  requeueTask(projectId: string, taskId: string): TaskSummary {
    const now = new Date().toISOString();
    this.connection.transaction(() => {
      const task = this.connection
        .prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?")
        .get(taskId, projectId) as TaskRow | undefined;
      if (!task) throw new Error("Task not found");
      if (!["review", "completed"].includes(task.status)) {
        throw new Error(`Task cannot be re-run while it is ${task.status}`);
      }
      const incompleteDependency = this.connection
        .prepare(
          `SELECT 1
           FROM task_dependencies td
           JOIN tasks dependency ON dependency.id = td.depends_on_task_id
           WHERE td.task_id = ? AND dependency.status <> 'completed' LIMIT 1`,
        )
        .get(taskId);
      const nextStatus: TaskStatus = incompleteDependency ? "blocked" : "ready";
      this.connection
        .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
        .run(nextStatus, now, taskId);
      this.connection
        .prepare("UPDATE objectives SET status = 'active', updated_at = ? WHERE id = ? AND status = 'completed'")
        .run(now, task.objective_id);
      this.connection
        .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
        .run(now, projectId);
      this.recordEvent(projectId, "task.requeued", "task", taskId, {
        from: task.status,
        to: nextStatus,
      }, now);
    })();
    const task = this.getOrchestrationState(projectId)?.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error("Task could not be read back");
    return task;
  }

  createAgentMessage(record: {
    id: string;
    projectId: string;
    agentRole: AgentRole;
    author: AgentMessageAuthor;
    body: string;
  }): AgentMessageSummary {
    const now = new Date().toISOString();
    if (!this.getProject(record.projectId)) throw new Error("Project not found");
    this.connection
      .prepare(
        `INSERT INTO agent_messages
          (id, project_id, agent_role, author, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.projectId, record.agentRole, record.author, record.body, now);
    this.recordEvent(record.projectId, "agent.message_created", "agent_message", record.id, {
      agentRole: record.agentRole,
      author: record.author,
    }, now);
    return {
      id: record.id,
      projectId: record.projectId,
      agentRole: record.agentRole,
      author: record.author,
      body: record.body,
      createdAt: now,
    };
  }

  createBrainProfile(record: NewBrainProfileRecord): BrainProfileSummary {
    const now = new Date().toISOString();
    if (!this.getProject(record.projectId)) throw new Error("Project not found");
    this.connection
      .prepare(
        `INSERT INTO brain_profiles
          (id, project_id, name, provider, harness, model_class, model, reasoning_level,
           credential_ref, configuration_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.projectId,
        record.name,
        record.provider,
        record.harness,
        record.modelClass,
        record.model ?? null,
        record.reasoningLevel ?? null,
        record.credentialRef,
        JSON.stringify(record.configuration),
        now,
        now,
      );
    const profile = this.getBrainProfile(record.id);
    if (!profile) throw new Error("Brain profile could not be read back");
    this.recordEvent(record.projectId, "brain_profile.created", "brain_profile", record.id, {
      name: record.name,
      provider: record.provider,
      harness: record.harness,
    }, now);
    return profile;
  }

  updateBrainProfile(record: NewBrainProfileRecord): BrainProfileSummary {
    const now = new Date().toISOString();
    const result = this.connection
      .prepare(
        `UPDATE brain_profiles SET
          name = ?, provider = ?, harness = ?, model_class = ?, model = ?,
          reasoning_level = ?, credential_ref = ?, configuration_json = ?, updated_at = ?
         WHERE id = ? AND project_id = ?`,
      )
      .run(
        record.name,
        record.provider,
        record.harness,
        record.modelClass,
        record.model ?? null,
        record.reasoningLevel ?? null,
        record.credentialRef,
        JSON.stringify(record.configuration),
        now,
        record.id,
        record.projectId,
      );
    if (result.changes === 0) throw new Error("Brain profile not found");
    this.recordEvent(record.projectId, "brain_profile.updated", "brain_profile", record.id, {
      name: record.name,
      provider: record.provider,
      harness: record.harness,
    }, now);
    const profile = this.getBrainProfile(record.id);
    if (!profile) throw new Error("Brain profile could not be read back");
    return profile;
  }

  getBrainProfile(profileId: string): BrainProfileSummary | null {
    const row = this.connection
      .prepare("SELECT * FROM brain_profiles WHERE id = ?")
      .get(profileId) as BrainProfileRow | undefined;
    return row ? mapBrainProfileRow(row) : null;
  }

  assignBrainProfile(
    projectId: string,
    agentRole: AgentRole,
    brainProfileId: string,
  ): BrainProfileSummary {
    const profile = this.connection
      .prepare("SELECT * FROM brain_profiles WHERE id = ? AND project_id = ?")
      .get(brainProfileId, projectId) as BrainProfileRow | undefined;
    if (!profile) throw new Error("Brain profile is not part of this project");
    this.connection
      .prepare(
        `INSERT INTO agent_role_brain_profiles
          (project_id, agent_role, brain_profile_id, assigned_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, agent_role) DO UPDATE SET
           brain_profile_id = excluded.brain_profile_id,
           assigned_at = excluded.assigned_at`,
      )
      .run(projectId, agentRole, brainProfileId, new Date().toISOString());
    this.recordEvent(projectId, "agent_role.brain_assigned", "brain_profile", brainProfileId, {
      agentRole,
    }, new Date().toISOString());
    return mapBrainProfileRow(profile);
  }

  getBrainProfileForRole(projectId: string, agentRole: AgentRole): BrainProfileSummary | null {
    const row = this.connection
      .prepare(
        `SELECT bp.* FROM brain_profiles bp
         JOIN agent_role_brain_profiles assignment
           ON assignment.brain_profile_id = bp.id AND assignment.project_id = bp.project_id
         WHERE assignment.project_id = ? AND assignment.agent_role = ?`,
      )
      .get(projectId, agentRole) as BrainProfileRow | undefined;
    return row ? mapBrainProfileRow(row) : null;
  }

  createAgentRun(brainProfileId: string, spec: RunSpec): AgentRunSummary {
    assertRunSpecVersion(spec);
    if (spec.runId.length === 0) throw new Error("Run ID is required");
    const profile = this.connection
      .prepare("SELECT * FROM brain_profiles WHERE id = ? AND project_id = ?")
      .get(brainProfileId, spec.projectId) as BrainProfileRow | undefined;
    if (!profile) throw new Error("Brain profile is not part of this project");
    if (
      profile.provider !== spec.brainProfile.provider ||
      profile.harness !== spec.brainProfile.harness ||
      profile.model_class !== spec.brainProfile.modelClass ||
      profile.credential_ref !== spec.brainProfile.credentialRef
    ) {
      throw new Error("Run brain profile snapshot does not match the selected profile");
    }
    if (spec.taskId) {
      const task = this.connection
        .prepare("SELECT id FROM tasks WHERE id = ? AND project_id = ?")
        .get(spec.taskId, spec.projectId);
      if (!task) throw new Error("Task is not part of this project");
    }

    const now = new Date().toISOString();
    const create = this.connection.transaction(() => {
      this.connection
        .prepare(
          `INSERT INTO agent_runs
            (id, project_id, task_id, agent_role, brain_profile_id, status, run_spec_json,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(
          spec.runId,
          spec.projectId,
          spec.taskId ?? null,
          spec.agentRole,
          brainProfileId,
          JSON.stringify(spec),
          now,
          now,
        );
      this.recordEvent(spec.projectId, "agent.run_created", "agent_run", spec.runId, {
        agentRole: spec.agentRole,
        taskId: spec.taskId ?? null,
      }, now);
    });
    create();
    const run = this.getAgentRun(spec.runId);
    if (!run) throw new Error("Agent run could not be read back");
    return run;
  }

  getAgentRun(runId: string): AgentRunSummary | null {
    const row = this.connection
      .prepare("SELECT * FROM agent_runs WHERE id = ?")
      .get(runId) as AgentRunRow | undefined;
    return row ? mapAgentRunRow(row) : null;
  }

  markRunBranchesApplied(runId: string, branches: string[]): AgentRunSummary {
    const run = this.getAgentRun(runId);
    if (!run?.result) throw new Error("Completed run result not found");
    const appliedArtifacts = branches.map((branch) => `applied:${branch}`);
    const result: RunResult = {
      ...run.result,
      artifacts: [...new Set([...run.result.artifacts, ...appliedArtifacts])],
    };
    const now = new Date().toISOString();
    this.connection
      .prepare("UPDATE agent_runs SET result_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(result), now, runId);
    const updated = this.getAgentRun(runId);
    if (!updated) throw new Error("Applied run could not be read back");
    return updated;
  }

  listAgentRuns(projectId: string, limit = 25): AgentRunSummary[] {
    return (
      this.connection
        .prepare("SELECT * FROM agent_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(projectId, limit) as AgentRunRow[]
    ).map(mapAgentRunRow);
  }

  createRunAttempt(record: NewRunAttemptRecord): RunAttemptSummary {
    const now = new Date().toISOString();
    const create = this.connection.transaction(() => {
      const run = this.connection
        .prepare("SELECT status FROM agent_runs WHERE id = ?")
        .get(record.runId) as { status: AgentRunStatus } | undefined;
      if (!run) throw new Error("Agent run not found");
      if (!["queued", "waiting", "failed", "timed_out"].includes(run.status)) {
        throw new Error(`Cannot start an attempt for a ${run.status} run`);
      }
      this.connection
        .prepare(
          `INSERT INTO run_attempts
            (id, run_id, attempt_number, status, worker_id, image_digest, created_at)
           VALUES (?, ?, ?, 'provisioning', ?, ?, ?)`,
        )
        .run(
          record.id,
          record.runId,
          record.attemptNumber,
          record.workerId ?? null,
          record.imageDigest ?? null,
          now,
        );
      this.connection
        .prepare(
          `UPDATE agent_runs SET status = 'provisioning', result_json = NULL,
           completed_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(now, record.runId);
    });
    create();
    return this.getRunAttempt(record.id);
  }

  markRunAttemptRunning(
    attemptId: string,
    workerId: string,
    imageDigest: string,
    providerThreadId: string | null = null,
  ): RunAttemptSummary {
    const now = new Date().toISOString();
    const update = this.connection.transaction(() => {
      const attempt = this.connection
        .prepare("SELECT run_id, status FROM run_attempts WHERE id = ?")
        .get(attemptId) as { run_id: string; status: RunAttemptStatus } | undefined;
      if (!attempt) throw new Error("Run attempt not found");
      if (attempt.status !== "provisioning") throw new Error("Run attempt is not provisioning");
      this.connection
        .prepare(
          `UPDATE run_attempts SET status = 'running', worker_id = ?, image_digest = ?,
           started_at = ? WHERE id = ?`,
        )
        .run(workerId, imageDigest, now, attemptId);
      this.connection
        .prepare(
          `UPDATE agent_runs SET status = 'running',
           provider_thread_id = COALESCE(?, provider_thread_id),
           started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`,
        )
        .run(providerThreadId, now, now, attempt.run_id);
    });
    update();
    return this.getRunAttempt(attemptId);
  }

  appendRunEvent(event: RunEvent): RunEvent {
    if (event.schemaVersion !== runContractSchemaVersion) {
      throw new Error(`Unsupported run event schema version: ${event.schemaVersion}`);
    }
    this.connection
      .prepare(
        `INSERT INTO agent_run_events
          (id, run_id, attempt_id, sequence, event_type, message, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.runId,
        event.attemptId,
        event.sequence,
        event.type,
        event.message ?? null,
        JSON.stringify(event.payload),
        event.createdAt,
      );
    return event;
  }

  listRunEvents(runId: string): RunEvent[] {
    return (
      this.connection
        .prepare("SELECT * FROM agent_run_events WHERE run_id = ? ORDER BY sequence")
        .all(runId) as RunEventRow[]
    ).map(mapRunEventRow);
  }

  completeAgentRun(runId: string, attemptId: string, result: RunResult): AgentRunSummary {
    if (result.schemaVersion !== runContractSchemaVersion) {
      throw new Error(`Unsupported run result schema version: ${result.schemaVersion}`);
    }
    const runStatus: AgentRunStatus =
      result.status === "completed"
        ? "completed"
        : result.status === "failed"
          ? "failed"
          : result.status === "cancelled"
            ? "cancelled"
            : "waiting";
    const attemptStatus: RunAttemptStatus =
      result.status === "failed"
        ? "failed"
        : result.status === "cancelled"
          ? "cancelled"
          : "completed";
    const now = new Date().toISOString();
    const complete = this.connection.transaction(() => {
      const attempt = this.connection
        .prepare("SELECT run_id, status FROM run_attempts WHERE id = ? AND run_id = ?")
        .get(attemptId, runId) as { run_id: string; status: RunAttemptStatus } | undefined;
      if (!attempt) throw new Error("Run attempt not found");
      if (!['provisioning', 'running'].includes(attempt.status)) {
        throw new Error("Run attempt has already finished");
      }
      this.connection
        .prepare(
          `UPDATE run_attempts SET status = ?, completed_at = ?,
           failure_message = ? WHERE id = ?`,
        )
        .run(attemptStatus, now, result.status === "failed" ? result.summary : null, attemptId);
      this.connection
        .prepare(
          `UPDATE agent_runs SET status = ?, result_json = ?, updated_at = ?, completed_at = ?
           WHERE id = ?`,
        )
        .run(
          runStatus,
          JSON.stringify(result),
          now,
          runStatus === "waiting" ? null : now,
          runId,
        );
    });
    complete();
    const run = this.getAgentRun(runId);
    if (!run) throw new Error("Agent run could not be read back");
    return run;
  }

  createRunArtifact(record: Omit<RunArtifactSummary, "createdAt">): RunArtifactSummary {
    const now = new Date().toISOString();
    this.connection
      .prepare(
        `INSERT INTO run_artifacts
          (id, run_id, attempt_id, artifact_kind, name, storage_path, media_type,
           metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.attemptId,
        record.kind,
        record.name,
        record.storagePath,
        record.mediaType,
        JSON.stringify(record.metadata),
        now,
      );
    return { ...record, createdAt: now };
  }

  recordRunUsage(record: Omit<RunUsageSummary, "createdAt">): RunUsageSummary {
    const now = new Date().toISOString();
    this.connection
      .prepare(
        `INSERT INTO run_usage
          (id, run_id, attempt_id, provider, model, input_tokens, cached_input_tokens,
           output_tokens, reasoning_output_tokens, cost_cents, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.attemptId,
        record.provider,
        record.model,
        record.inputTokens,
        record.cachedInputTokens,
        record.outputTokens,
        record.reasoningOutputTokens,
        record.costCents,
        record.durationMs,
        now,
      );
    return { ...record, createdAt: now };
  }

  acquireTaskLease(record: TaskLeaseSummary): TaskLeaseSummary {
    const run = this.connection
      .prepare("SELECT project_id, task_id FROM agent_runs WHERE id = ?")
      .get(record.runId) as { project_id: string; task_id: string | null } | undefined;
    if (!run || run.task_id !== record.taskId) {
      throw new Error("Run is not assigned to this task");
    }
    const task = this.connection
      .prepare("SELECT project_id FROM tasks WHERE id = ?")
      .get(record.taskId) as { project_id: string } | undefined;
    if (!task || task.project_id !== run.project_id) throw new Error("Task is not part of this project");
    const acquire = this.connection.transaction(() => {
      this.connection
        .prepare("DELETE FROM task_leases WHERE task_id = ? AND expires_at <= ?")
        .run(record.taskId, record.acquiredAt);
      this.connection
        .prepare(
          `INSERT INTO task_leases
            (task_id, run_id, lease_token, acquired_at, heartbeat_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.taskId,
          record.runId,
          record.leaseToken,
          record.acquiredAt,
          record.heartbeatAt,
          record.expiresAt,
        );
    });
    acquire();
    return record;
  }

  heartbeatTaskLease(leaseToken: string, heartbeatAt: string, expiresAt: string): TaskLeaseSummary {
    const result = this.connection
      .prepare("UPDATE task_leases SET heartbeat_at = ?, expires_at = ? WHERE lease_token = ?")
      .run(heartbeatAt, expiresAt, leaseToken);
    if (result.changes === 0) throw new Error("Task lease not found");
    const row = this.connection
      .prepare("SELECT * FROM task_leases WHERE lease_token = ?")
      .get(leaseToken) as TaskLeaseRow;
    return mapTaskLeaseRow(row);
  }

  releaseTaskLease(leaseToken: string): void {
    const result = this.connection
      .prepare("DELETE FROM task_leases WHERE lease_token = ?")
      .run(leaseToken);
    if (result.changes === 0) throw new Error("Task lease not found");
  }

  private getRunAttempt(attemptId: string): RunAttemptSummary {
    const row = this.connection
      .prepare("SELECT * FROM run_attempts WHERE id = ?")
      .get(attemptId) as RunAttemptRow | undefined;
    if (!row) throw new Error("Run attempt not found");
    return mapRunAttemptRow(row);
  }

  private insertDefaultProjectSettings(projectId: string, createdAt: string): void {
    this.connection
      .prepare(
        `INSERT INTO project_settings (project_id, created_at, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(projectId, createdAt, createdAt);
  }

  private recordEvent(
    projectId: string,
    eventType: string,
    entityType: string,
    entityId: string,
    payload: unknown,
    createdAt: string,
  ): void {
    this.connection
      .prepare(
        `INSERT INTO events
          (project_id, event_type, entity_type, entity_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, eventType, entityType, entityId, JSON.stringify(payload), createdAt);
  }
}

function mapProjectRow(row: ProjectRow, repositories: RepositorySummary[]): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    repositories,
  };
}

function mapProjectSettingsRow(row: ProjectSettingsRow): ProjectSettingsSummary {
  return {
    projectId: row.project_id,
    setupStatus: row.setup_status,
    setupCompletedAt: row.setup_completed_at,
    defaultRunTimeoutSeconds: row.default_run_timeout_seconds,
    defaultRunRetries: row.default_run_retries,
    defaultTokenBudget: row.default_token_budget,
    defaultCostBudgetCents: row.default_cost_budget_cents,
    planningNetworkPolicy: row.planning_network_policy,
    requirePlanApproval: row.require_plan_approval === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapModelBackendRow(row: ModelBackendRow): ModelBackendSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    provider: row.provider,
    protocol: row.protocol,
    model: row.model,
    baseUrl: row.base_url,
    authMode: row.auth_mode,
    credentialRef: row.credential_ref,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCodingHarnessRow(row: CodingHarnessRow): CodingHarnessSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    adapter: row.adapter,
    executable: row.executable,
    containerImage: row.container_image,
    supportedProtocols: JSON.parse(row.supported_protocols_json) as CodingHarnessSummary["supportedProtocols"],
    capabilities: JSON.parse(row.capabilities_json) as CodingHarnessSummary["capabilities"],
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRepositoryRow(row: RepositoryRow): RepositorySummary {
  return {
    id: row.id,
    relativePath: row.relative_path,
    name: row.name,
    defaultBranch: row.default_branch,
    remoteUrl: row.remote_url,
    description: row.description,
    enabled: row.enabled === 1,
    available: row.available === 1,
  };
}

function mapObjectiveRow(row: ObjectiveRow): ObjectiveSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskRow(row: TaskRow, dependsOn: string[], repositoryIds: string[]): TaskSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    objectiveId: row.objective_id,
    title: row.title,
    description: row.description,
    status: row.status,
    assignedRole: row.assigned_role,
    repositoryIds,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json) as string[],
    requiredChecks: JSON.parse(row.required_checks_json) as TaskRequiredChecks,
    dependsOn,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAgentMessageRow(row: AgentMessageRow): AgentMessageSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    agentRole: row.agent_role,
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
  };
}

function mapApprovalRow(row: ApprovalRow): ApprovalSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    objectiveId: row.objective_id,
    taskId: row.task_id,
    type: row.approval_type,
    title: row.title,
    details: row.details,
    status: row.status,
    requestedByRole: row.requested_by_role,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
  };
}

function mapBrainProfileRow(row: BrainProfileRow): BrainProfileSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    provider: row.provider,
    harness: row.harness,
    modelClass: row.model_class,
    credentialRef: row.credential_ref,
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.reasoning_level === null ? {} : { reasoningLevel: row.reasoning_level }),
    configuration: JSON.parse(row.configuration_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAgentRunRow(row: AgentRunRow): AgentRunSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    agentRole: row.agent_role,
    brainProfileId: row.brain_profile_id,
    status: row.status,
    spec: JSON.parse(row.run_spec_json) as RunSpec,
    result: row.result_json ? JSON.parse(row.result_json) as RunResult : null,
    providerThreadId: row.provider_thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapRunAttemptRow(row: RunAttemptRow): RunAttemptSummary {
  return {
    id: row.id,
    runId: row.run_id,
    attemptNumber: row.attempt_number,
    status: row.status,
    workerId: row.worker_id,
    imageDigest: row.image_digest,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapRunEventRow(row: RunEventRow): RunEvent {
  return {
    schemaVersion: runContractSchemaVersion,
    id: row.id,
    runId: row.run_id,
    attemptId: row.attempt_id,
    sequence: row.sequence,
    type: row.event_type,
    ...(row.message === null ? {} : { message: row.message }),
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function mapTaskLeaseRow(row: TaskLeaseRow): TaskLeaseSummary {
  return {
    taskId: row.task_id,
    runId: row.run_id,
    leaseToken: row.lease_token,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
  };
}

function assertRunSpecVersion(spec: RunSpec): void {
  if (spec.schemaVersion !== runContractSchemaVersion) {
    throw new Error(`Unsupported run specification schema version: ${spec.schemaVersion}`);
  }
}
