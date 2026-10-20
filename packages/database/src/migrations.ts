import type Database from "better-sqlite3";
import { basename, isAbsolute } from "node:path";

interface Migration {
  version: number;
  name: string;
  sql?: string;
  apply?: (database: Database.Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_project_state",
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE repositories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        default_branch TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX events_project_created_idx
        ON events(project_id, created_at);
    `,
  },
  {
    version: 2,
    name: "durable_orchestration_state",
    sql: `
      CREATE TABLE objectives (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'completed', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX objectives_project_updated_idx
        ON objectives(project_id, updated_at DESC);

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'blocked', 'in_progress', 'review', 'completed', 'cancelled')),
        assigned_role TEXT NOT NULL CHECK (assigned_role IN (
          'project_manager', 'architect', 'tech_lead', 'backend_developer',
          'frontend_developer', 'devops_database_engineer', 'qa_engineer',
          'code_reviewer', 'security_reviewer', 'release_manager'
        )),
        acceptance_criteria_json TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX tasks_project_status_idx ON tasks(project_id, status);
      CREATE INDEX tasks_objective_created_idx ON tasks(objective_id, created_at);

      CREATE TABLE task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, depends_on_task_id),
        CHECK (task_id <> depends_on_task_id)
      );

      CREATE TABLE approval_requests (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        objective_id TEXT REFERENCES objectives(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        approval_type TEXT NOT NULL CHECK (approval_type IN ('plan', 'integration', 'release', 'high_risk')),
        title TEXT NOT NULL,
        details TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
        requested_by_role TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        decided_at TEXT,
        decision_note TEXT
      );

      CREATE INDEX approvals_project_status_idx
        ON approval_requests(project_id, status, requested_at DESC);
    `,
  },
  {
    version: 3,
    name: "multi_repository_projects_and_agent_chat",
    sql: `
      CREATE TABLE repositories_next (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        default_branch TEXT,
        created_at TEXT NOT NULL
      );

      INSERT INTO repositories_next (id, project_id, path, name, default_branch, created_at)
        SELECT id, project_id, path, name, default_branch, created_at FROM repositories;

      DROP TABLE repositories;
      ALTER TABLE repositories_next RENAME TO repositories;
      CREATE INDEX repositories_project_name_idx ON repositories(project_id, name);

      CREATE TABLE task_repositories (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, repository_id)
      );

      CREATE TABLE agent_messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_role TEXT NOT NULL CHECK (agent_role IN (
          'project_manager', 'architect', 'tech_lead', 'backend_developer',
          'frontend_developer', 'devops_database_engineer', 'qa_engineer',
          'code_reviewer', 'security_reviewer', 'release_manager'
        )),
        author TEXT NOT NULL CHECK (author IN ('director', 'agent', 'system')),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX agent_messages_project_role_created_idx
        ON agent_messages(project_id, agent_role, created_at);
    `,
  },
  {
    version: 4,
    name: "repair_legacy_task_sort_order",
    apply(database) {
      const columns = database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "sort_order")) {
        database.exec("ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
  {
    version: 5,
    name: "provider_neutral_agent_runtime",
    sql: `
      CREATE TABLE brain_profiles (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        harness TEXT NOT NULL,
        model_class TEXT NOT NULL,
        model TEXT,
        reasoning_level TEXT,
        credential_ref TEXT NOT NULL,
        configuration_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, name),
        UNIQUE (project_id, id)
      );

      CREATE TABLE agent_role_brain_profiles (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_role TEXT NOT NULL CHECK (agent_role IN (
          'project_manager', 'architect', 'tech_lead', 'backend_developer',
          'frontend_developer', 'devops_database_engineer', 'qa_engineer',
          'code_reviewer', 'security_reviewer', 'release_manager'
        )),
        brain_profile_id TEXT NOT NULL,
        assigned_at TEXT NOT NULL,
        PRIMARY KEY (project_id, agent_role),
        FOREIGN KEY (project_id, brain_profile_id)
          REFERENCES brain_profiles(project_id, id) ON DELETE CASCADE
      );

      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        agent_role TEXT NOT NULL CHECK (agent_role IN (
          'project_manager', 'architect', 'tech_lead', 'backend_developer',
          'frontend_developer', 'devops_database_engineer', 'qa_engineer',
          'code_reviewer', 'security_reviewer', 'release_manager'
        )),
        brain_profile_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'queued', 'provisioning', 'running', 'waiting', 'completed', 'failed',
          'cancelled', 'timed_out'
        )),
        run_spec_json TEXT NOT NULL,
        result_json TEXT,
        provider_thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (project_id, brain_profile_id)
          REFERENCES brain_profiles(project_id, id)
      );

      CREATE INDEX agent_runs_project_status_created_idx
        ON agent_runs(project_id, status, created_at DESC);
      CREATE INDEX agent_runs_task_created_idx
        ON agent_runs(task_id, created_at DESC);

      CREATE TABLE run_attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        status TEXT NOT NULL CHECK (status IN (
          'provisioning', 'running', 'completed', 'failed', 'cancelled', 'timed_out'
        )),
        worker_id TEXT,
        image_digest TEXT,
        failure_code TEXT,
        failure_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE (run_id, attempt_number)
      );

      CREATE TABLE agent_run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        attempt_id TEXT REFERENCES run_attempts(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        event_type TEXT NOT NULL,
        message TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, sequence)
      );

      CREATE INDEX agent_run_events_run_sequence_idx
        ON agent_run_events(run_id, sequence);

      CREATE TABLE run_artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        attempt_id TEXT REFERENCES run_attempts(id) ON DELETE SET NULL,
        artifact_kind TEXT NOT NULL CHECK (artifact_kind IN (
          'log', 'patch', 'commit', 'test_output', 'report', 'screenshot', 'other'
        )),
        name TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        media_type TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX run_artifacts_run_created_idx
        ON run_artifacts(run_id, created_at);

      CREATE TABLE run_usage (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        attempt_id TEXT REFERENCES run_attempts(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
        cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
        output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reasoning_output_tokens >= 0),
        cost_cents REAL CHECK (cost_cents IS NULL OR cost_cents >= 0),
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
        created_at TEXT NOT NULL
      );

      CREATE INDEX run_usage_run_created_idx
        ON run_usage(run_id, created_at);

      CREATE TABLE task_leases (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
        lease_token TEXT NOT NULL UNIQUE,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 6,
    name: "project_setup_and_execution_settings",
    sql: `
      CREATE TABLE project_settings (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        setup_status TEXT NOT NULL DEFAULT 'not_started' CHECK (setup_status IN (
          'not_started', 'in_progress', 'completed'
        )),
        setup_completed_at TEXT,
        default_run_timeout_seconds INTEGER NOT NULL DEFAULT 900
          CHECK (default_run_timeout_seconds BETWEEN 30 AND 86400),
        default_run_retries INTEGER NOT NULL DEFAULT 1
          CHECK (default_run_retries BETWEEN 0 AND 5),
        default_token_budget INTEGER
          CHECK (default_token_budget IS NULL OR default_token_budget BETWEEN 1 AND 10000000),
        default_cost_budget_cents REAL
          CHECK (default_cost_budget_cents IS NULL OR default_cost_budget_cents > 0),
        planning_network_policy TEXT NOT NULL DEFAULT 'model-provider-only'
          CHECK (planning_network_policy IN ('offline', 'model-provider-only', 'restricted')),
        require_plan_approval INTEGER NOT NULL DEFAULT 1
          CHECK (require_plan_approval IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (setup_status = 'completed' AND setup_completed_at IS NOT NULL)
          OR (setup_status <> 'completed' AND setup_completed_at IS NULL)
        )
      );

      INSERT INTO project_settings (project_id, created_at, updated_at)
        SELECT id, created_at, updated_at FROM projects;
    `,
  },
  {
    version: 7,
    name: "model_backends",
    sql: `
      CREATE TABLE model_backends (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN (
          'openai', 'anthropic', 'runpod', 'openrouter', 'ollama', 'custom'
        )),
        protocol TEXT NOT NULL CHECK (protocol IN (
          'openai-responses', 'openai-chat-completions', 'anthropic-messages', 'ollama'
        )),
        model TEXT,
        base_url TEXT,
        auth_mode TEXT NOT NULL CHECK (auth_mode IN ('chatgpt', 'api-key', 'none')),
        credential_ref TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, name),
        UNIQUE (project_id, id),
        CHECK (auth_mode <> 'api-key' OR credential_ref IS NOT NULL)
      );

      CREATE INDEX model_backends_project_name_idx
        ON model_backends(project_id, name);
    `,
  },
  {
    version: 8,
    name: "coding_harnesses",
    sql: `
      CREATE TABLE coding_harnesses (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        adapter TEXT NOT NULL CHECK (adapter IN (
          'codex', 'claude-code', 'opencode', 'pi', 'deepseek-harness',
          'grok-build', 'custom'
        )),
        executable TEXT NOT NULL,
        container_image TEXT,
        supported_protocols_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, name),
        UNIQUE (project_id, id)
      );

      CREATE INDEX coding_harnesses_project_name_idx
        ON coding_harnesses(project_id, name);
    `,
  },
  {
    version: 9,
    name: "runtime_profiles",
    sql: `
      CREATE TABLE runtime_profiles (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        coding_harness_id TEXT NOT NULL,
        model_backend_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, name),
        UNIQUE (project_id, id),
        FOREIGN KEY (project_id, coding_harness_id)
          REFERENCES coding_harnesses(project_id, id),
        FOREIGN KEY (project_id, model_backend_id)
          REFERENCES model_backends(project_id, id)
      );

      CREATE INDEX runtime_profiles_project_name_idx
        ON runtime_profiles(project_id, name);
      CREATE INDEX runtime_profiles_harness_idx
        ON runtime_profiles(coding_harness_id);
      CREATE INDEX runtime_profiles_backend_idx
        ON runtime_profiles(model_backend_id);
    `,
  },
  {
    version: 10,
    name: "agent_runtime_profile_assignments",
    sql: `
      CREATE TABLE agent_runtime_profile_assignments (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_role TEXT NOT NULL CHECK (agent_role IN (
          'project_manager', 'architect', 'tech_lead', 'backend_developer',
          'frontend_developer', 'devops_database_engineer', 'qa_engineer',
          'code_reviewer', 'security_reviewer', 'release_manager'
        )),
        runtime_profile_id TEXT NOT NULL,
        assigned_at TEXT NOT NULL,
        PRIMARY KEY (project_id, agent_role),
        FOREIGN KEY (project_id, runtime_profile_id)
          REFERENCES runtime_profiles(project_id, id) ON DELETE CASCADE
      );

      CREATE INDEX agent_runtime_profile_assignments_profile_idx
        ON agent_runtime_profile_assignments(runtime_profile_id);
    `,
  },
  {
    version: 11,
    name: "direct_agent_runtime_assignments",
    sql: `
      CREATE TABLE agent_runtime_assignments (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_role TEXT NOT NULL CHECK (agent_role IN (
          'project_manager', 'architect', 'tech_lead', 'backend_developer',
          'frontend_developer', 'devops_database_engineer', 'qa_engineer',
          'code_reviewer', 'security_reviewer', 'release_manager'
        )),
        coding_harness_id TEXT NOT NULL,
        model_backend_id TEXT NOT NULL,
        assigned_at TEXT NOT NULL,
        PRIMARY KEY (project_id, agent_role),
        FOREIGN KEY (project_id, coding_harness_id)
          REFERENCES coding_harnesses(project_id, id) ON DELETE CASCADE,
        FOREIGN KEY (project_id, model_backend_id)
          REFERENCES model_backends(project_id, id) ON DELETE CASCADE
      );

      INSERT INTO agent_runtime_assignments
        (project_id, agent_role, coding_harness_id, model_backend_id, assigned_at)
      SELECT assignment.project_id, assignment.agent_role,
             profile.coding_harness_id, profile.model_backend_id, assignment.assigned_at
      FROM agent_runtime_profile_assignments assignment
      JOIN runtime_profiles profile
        ON profile.project_id = assignment.project_id
       AND profile.id = assignment.runtime_profile_id;

      DROP TABLE agent_runtime_profile_assignments;

      CREATE INDEX agent_runtime_assignments_harness_idx
        ON agent_runtime_assignments(coding_harness_id);
      CREATE INDEX agent_runtime_assignments_backend_idx
        ON agent_runtime_assignments(model_backend_id);
    `,
  },
  {
    version: 12,
    name: "partial_agent_runtime_assignments",
    sql: `
      ALTER TABLE agent_runtime_assignments RENAME TO agent_runtime_assignments_complete;

      CREATE TABLE agent_runtime_assignments (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_role TEXT NOT NULL CHECK (agent_role IN (
          'project_manager', 'architect', 'tech_lead', 'backend_developer',
          'frontend_developer', 'devops_database_engineer', 'qa_engineer',
          'code_reviewer', 'security_reviewer', 'release_manager'
        )),
        coding_harness_id TEXT REFERENCES coding_harnesses(id) ON DELETE SET NULL,
        model_backend_id TEXT REFERENCES model_backends(id) ON DELETE SET NULL,
        assigned_at TEXT NOT NULL,
        PRIMARY KEY (project_id, agent_role)
      );

      INSERT INTO agent_runtime_assignments
        (project_id, agent_role, coding_harness_id, model_backend_id, assigned_at)
      SELECT project_id, agent_role, coding_harness_id, model_backend_id, assigned_at
      FROM agent_runtime_assignments_complete;

      DROP TABLE agent_runtime_assignments_complete;

      CREATE INDEX agent_runtime_assignments_harness_idx
        ON agent_runtime_assignments(coding_harness_id);
      CREATE INDEX agent_runtime_assignments_backend_idx
        ON agent_runtime_assignments(model_backend_id);

      CREATE TRIGGER cleanup_empty_agent_runtime_assignment
      AFTER UPDATE OF coding_harness_id, model_backend_id ON agent_runtime_assignments
      WHEN NEW.coding_harness_id IS NULL AND NEW.model_backend_id IS NULL
      BEGIN
        DELETE FROM agent_runtime_assignments
        WHERE project_id = NEW.project_id AND agent_role = NEW.agent_role;
      END;
    `,
  },
  {
    version: 13,
    name: "portable_repository_metadata",
    sql: `
      ALTER TABLE repositories RENAME COLUMN path TO relative_path;
      ALTER TABLE repositories ADD COLUMN remote_url TEXT;
      ALTER TABLE repositories ADD COLUMN description TEXT NOT NULL DEFAULT '';
      ALTER TABLE repositories ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));
      ALTER TABLE repositories ADD COLUMN available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1));
    `,
    apply(database) {
      const rows = database
        .prepare("SELECT id, relative_path FROM repositories")
        .all() as Array<{ id: string; relative_path: string }>;
      const update = database.prepare("UPDATE repositories SET relative_path = ? WHERE id = ?");
      for (const row of rows) {
        if (isAbsolute(row.relative_path)) update.run(basename(row.relative_path), row.id);
      }
    },
  },
  {
    version: 14,
    name: "task_required_checks",
    sql: `
      ALTER TABLE tasks ADD COLUMN required_checks_json TEXT NOT NULL
        DEFAULT '{"qa":false,"codeReview":false,"security":false}';
    `,
  },
  {
    version: 15,
    name: "agent_directives",
    sql: `
      CREATE TABLE agent_directives (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_role TEXT NOT NULL CHECK (agent_role IN (
          'project_manager', 'architect', 'tech_lead', 'backend_developer',
          'frontend_developer', 'devops_database_engineer', 'qa_engineer',
          'code_reviewer', 'security_reviewer', 'release_manager'
        )),
        content TEXT NOT NULL,
        source_message_id TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        removed_at TEXT
      );

      CREATE INDEX agent_directives_project_role_status_idx
        ON agent_directives(project_id, agent_role, status, created_at);
    `,
  },
  {
    version: 16,
    name: "agent_role_prompts",
    sql: `
      CREATE TABLE agent_configurations (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_role TEXT NOT NULL CHECK (agent_role IN (
          'project_manager', 'architect', 'tech_lead', 'backend_developer',
          'frontend_developer', 'devops_database_engineer', 'qa_engineer',
          'code_reviewer', 'security_reviewer', 'release_manager'
        )),
        role_prompt TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, agent_role)
      );
    `,
  },
  {
    version: 17,
    name: "agent_consultation_preferences",
    sql: `
      ALTER TABLE agent_configurations
        ADD COLUMN consultation_roles_json TEXT NOT NULL DEFAULT '[]';

      UPDATE agent_configurations
        SET consultation_roles_json = '["architect","tech_lead"]'
        WHERE agent_role = 'project_manager';
    `,
  },
  {
    version: 18,
    name: "project_and_repository_context",
    sql: `
      CREATE TABLE context_documents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        repository_id TEXT REFERENCES repositories(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (repository_id)
      );

      CREATE UNIQUE INDEX context_documents_project_scope_idx
        ON context_documents(project_id) WHERE repository_id IS NULL;
      CREATE INDEX context_documents_project_idx
        ON context_documents(project_id, repository_id);

      CREATE TABLE context_revisions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES context_documents(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        repository_id TEXT REFERENCES repositories(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX context_revisions_document_version_idx
        ON context_revisions(document_id, version DESC);

      CREATE TABLE proposed_context_updates (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        approval_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
        repository_id TEXT REFERENCES repositories(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        reason TEXT NOT NULL,
        proposed_by_role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected')),
        created_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE INDEX proposed_context_updates_approval_idx
        ON proposed_context_updates(approval_id, status);
    `,
  },
  {
    version: 19,
    name: "task_workflow_recovery",
    sql: `
      CREATE TABLE task_workflow_recoveries (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        interrupted_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        stage TEXT NOT NULL CHECK (stage IN ('implementation', 'repair', 'verification')),
        verification_check TEXT CHECK (verification_check IS NULL OR verification_check IN ('qa', 'code_review', 'security')),
        reason TEXT NOT NULL,
        interrupted_at TEXT NOT NULL
      );

      CREATE INDEX task_workflow_recoveries_project_idx
        ON task_workflow_recoveries(project_id, interrupted_at DESC);
    `,
  },
  {
    version: 20,
    name: "release_manager_integration_proposals",
    sql: `
      CREATE TABLE task_workflow_recoveries_next (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        interrupted_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        stage TEXT NOT NULL CHECK (stage IN ('implementation', 'repair', 'verification', 'release')),
        verification_check TEXT CHECK (verification_check IS NULL OR verification_check IN ('qa', 'code_review', 'security')),
        reason TEXT NOT NULL,
        interrupted_at TEXT NOT NULL
      );

      INSERT INTO task_workflow_recoveries_next
        SELECT * FROM task_workflow_recoveries;
      DROP TABLE task_workflow_recoveries;
      ALTER TABLE task_workflow_recoveries_next RENAME TO task_workflow_recoveries;
      CREATE INDEX task_workflow_recoveries_project_idx
        ON task_workflow_recoveries(project_id, interrupted_at DESC);

      CREATE TABLE task_integration_proposals (
        approval_id TEXT PRIMARY KEY REFERENCES approval_requests(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        change_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        release_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'applied')),
        created_at TEXT NOT NULL,
        decided_at TEXT,
        applied_at TEXT
      );

      CREATE INDEX task_integration_proposals_project_idx
        ON task_integration_proposals(project_id, created_at DESC);
      CREATE INDEX task_integration_proposals_task_idx
        ON task_integration_proposals(task_id, created_at DESC);
    `,
  },
  {
    version: 21,
    name: "task_workflow_director_guidance",
    sql: `
      ALTER TABLE task_workflow_recoveries ADD COLUMN guidance TEXT;
    `,
  },
  {
    version: 22,
    name: "agent_runtime_fallbacks",
    sql: `
      ALTER TABLE agent_runtime_assignments
        ADD COLUMN fallback_coding_harness_id TEXT REFERENCES coding_harnesses(id) ON DELETE SET NULL;
      ALTER TABLE agent_runtime_assignments
        ADD COLUMN fallback_model_backend_id TEXT REFERENCES model_backends(id) ON DELETE SET NULL;

      CREATE INDEX agent_runtime_assignments_fallback_harness_idx
        ON agent_runtime_assignments(fallback_coding_harness_id);
      CREATE INDEX agent_runtime_assignments_fallback_backend_idx
        ON agent_runtime_assignments(fallback_model_backend_id);
    `,
  },
];

export function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = database
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((row) => row.version));

  const applyMigration = database.transaction((migration: Migration) => {
    if (migration.sql) database.exec(migration.sql);
    migration.apply?.(database);
    database
      .prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      )
      .run(migration.version, migration.name, new Date().toISOString());
  });

  for (const migration of migrations) {
    if (!applied.has(migration.version)) {
      applyMigration(migration);
    }
  }
}
