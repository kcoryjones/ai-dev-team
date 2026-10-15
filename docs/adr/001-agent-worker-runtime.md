# ADR 001: Provider-neutral agent worker runtime

- Status: Accepted
- Date: 2026-10-12

## Context

Engineering Team presents durable organizational roles such as Project Manager, Architect, developers, reviewers, and Release Manager. Those roles need model-backed execution, initially through Codex and later potentially through Claude, RunPod-hosted models, or other providers.

A role, a model, an agent harness, and a running container are different concerns:

- The **agent identity** is a durable role with instructions, conversation history, policy, and a default brain profile.
- The **brain profile** selects a provider, harness, model class, reasoning policy, credential reference, and capability limits.
- The **provider adapter** translates Engineering Team's execution contract into a provider-specific SDK or command and normalizes its events and result.
- The **worker** is a disposable, isolated container created for one run.

Keeping these concerns separate allows the application to change providers without changing task, workflow, or user-interface semantics.

## Decision

### Persistent roles, disposable execution

Agent identities and conversations persist in the orchestration database. Agent containers do not. A container exists only while executing a task turn or an advisory conversation turn, and is destroyed after its bounded outputs have been captured.

An agent's `available` presence means it has no active run. It does not mean a model process or container is continuously online.

### Provider-neutral contracts

The orchestrator communicates with every provider through three versioned contracts:

1. `RunSpec`: immutable input and execution policy for a run.
2. `RunEvent`: append-only progress and lifecycle events used by the Live Team interface and audit log.
3. `RunResult`: structured completion state and evidence used by the workflow engine.

Provider-specific commands, event formats, thread identifiers, and model names remain inside provider adapters.

An initial `RunSpec` should contain at least:

```ts
interface RunSpec {
  schemaVersion: number;
  runId: string;
  taskId?: string;
  projectId: string;
  agentRole: AgentRole;

  brainProfile: {
    provider: string;
    harness: string;
    modelClass: string;
    credentialRef: string;
  };

  repositories: Array<{
    repositoryId: string;
    checkoutPath: string;
    baseCommit: string;
  }>;

  objective: string;
  taskDescription: string;
  acceptanceCriteria: string[];
  upstreamArtifacts: string[];

  permissions: {
    filesystem: "read-only" | "workspace-write";
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
```

The orchestrator issues a structured `RunSpec`; it does not accept or construct an untrusted free-form container command. The trusted worker implementation selects an allowlisted image and translates the specification into the provider-specific invocation.

`RunEvent` records should cover container provisioning, harness connection, repository inspection, commands, file changes, tests, tool calls, waiting for input, cancellation, failure, and completion. Events must be bounded and redact credentials.

An initial `RunResult` should contain at least:

```ts
interface RunResult {
  schemaVersion: number;
  status: "completed" | "needs_input" | "blocked" | "failed" | "cancelled";
  summary: string;
  changedFiles: string[];
  commits: Array<{ repositoryId: string; sha: string }>;
  checks: Array<{
    command: string;
    status: "passed" | "failed" | "skipped";
    outputArtifact?: string;
  }>;
  acceptanceCriteria: Array<{
    criterion: string;
    satisfied: boolean;
    evidence: string;
  }>;
  questions: string[];
  risks: string[];
  artifacts: string[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costCents?: number;
  };
}
```

An exit code or final chat message alone cannot complete a workflow task. Workflow transitions require a valid result plus the evidence and approval gates appropriate to the task.

### Prompt assembly

The adapter builds the effective prompt from ordered layers:

1. Role charter and behavioral policy.
2. Project and repository instructions, including applicable `AGENTS.md` files.
3. Objective, task description, repository scope, dependencies, and acceptance criteria.
4. Relevant upstream decisions, handoffs, findings, and artifacts.
5. Execution permissions, resource limits, and prohibited actions.
6. The structured completion contract.

Repository content, issues, commit messages, dependency output, and external text are untrusted context rather than system policy. The harness should inspect the isolated checkout as needed instead of embedding an entire repository in the prompt.

### Provider adapters and brain profiles

Roles have default brain profiles, but a role is never permanently bound to a provider or model. The orchestration policy may override a profile for a particular task, retry, risk level, or cost constraint.

Codex is the first adapter. One-shot jobs may use non-interactive structured event output. Resumable conversations may use a provider thread/session through an SDK or application-server interface. Claude and RunPod adapters must implement the same Engineering Team contracts before they can be selected by the router.

A raw RunPod model endpoint is not itself a coding agent. Its adapter must also supply or integrate a harness that manages context, tool calls, command execution, iteration, cancellation, and structured results.

Fixed model names, command flags, and provider authentication procedures are configuration or implementation details and are not part of this ADR.

### Worker and repository boundaries

Every run receives a dedicated container and self-contained checkout. A multi-repository task may receive multiple assigned checkouts at explicit paths, but never the workspace parent or unrelated sibling repositories.

Workers do not receive:

- The Docker socket or Docker API credentials.
- The orchestration database or control-plane filesystem.
- Registered source repositories or the integration checkout.
- Other runs' checkouts.
- Host SSH, cloud, or general credential directories.
- Git push or merge authority.

The trusted control plane owns checkout creation, task leases, branch integration, commits or patch capture, pushing, merging, retries, and cleanup. Workers can modify only their assigned checkout when policy allows it.

Provider credentials are short-lived or narrowly scoped, are supplied only to the harness invocation, are redacted from events, and must not be inherited by repository-controlled build scripts or tests. Network access is disabled or restricted to explicitly required provider and dependency endpoints.

### Run lifecycle

The standard lifecycle is:

```text
task ready
  -> acquire task lease
  -> record immutable run policy and base commits
  -> prepare isolated checkout(s)
  -> start hardened worker
  -> stream and persist normalized events
  -> capture structured result, patch/commits, tests, and artifacts
  -> apply workflow and approval gates
  -> release lease and destroy worker
```

Runs support cancellation, deadlines, heartbeats, bounded retries, and idempotent recovery. A lease prevents two workers from executing the same task concurrently and expires when a worker is irrecoverably lost.

### Conversation behavior

Role-specific conversations belong to the orchestrator rather than a container.

- A message to an available agent can create a bounded advisory turn.
- A message to a working agent is queued as an intervention and delivered at a safe harness boundary.
- A later container may resume a provider thread when supported or receive a durable conversation summary.
- Asking a question does not implicitly authorize repository changes. The interface should distinguish advisory conversation from a direction to execute or alter work.

The Live Team view derives runtime presence from normalized run events. The Tasks view derives workflow state from durable task state. These two state machines are related but not interchangeable.

### Durable data

The runtime slice will require durable equivalents of:

- Brain profiles and role-to-profile defaults.
- Runs, attempts, task leases, and provider thread references.
- Normalized run events and heartbeats.
- Structured results and acceptance-criterion evidence.
- Logs, patches, commits, test output, and other artifacts.
- Usage, elapsed time, and estimated cost.

Secrets are referenced by identifier and are never stored directly in SQLite.

## Consequences

### Positive

- Workflow and UI behavior remain stable when providers change.
- Containers can be destroyed without losing role identity or conversation history.
- Task completion becomes evidence-based and auditable.
- Provider retries and model escalation can occur without duplicating workflow concepts.
- A VM or microVM executor can replace Docker later without changing run contracts.

### Costs and tradeoffs

- Each provider needs a maintained adapter and compatibility tests.
- Normalizing streaming events loses some provider-specific detail unless raw bounded artifacts are also retained.
- Resumable chat requires deliberate thread lifecycle and context-compaction policy.
- Credential brokering and network egress controls add infrastructure before autonomous execution is safe.
- Multi-repository tasks require explicit checkout and integration coordination.

## Initial implementation sequence

1. Define and validate versioned `RunSpec`, `RunEvent`, and `RunResult` contracts.
2. Add brain-profile, run, run-attempt, event, artifact, usage, and task-lease persistence.
3. Implement a trusted worker-controller interface with a fake executor for tests.
4. Implement one hardened Codex worker with an isolated self-contained checkout.
5. Stream normalized events into the Live Team view and persist them.
6. Require structured results and evidence for task-state transitions.
7. Add cancellation, timeouts, retry policy, recovery, and chat interventions.
8. Add independent QA/review runs and control-plane-owned integration.
9. Add additional provider adapters only after they pass the shared contract and capability evaluation suite.

## Deliberately deferred

- Exact provider and model assignments by role.
- Provider-specific CLI flags and authentication mechanisms.
- The first RunPod model and whether it requires a compatibility gateway.
- Detailed cost-routing and fallback thresholds.
- Whether long-running conversational workers are ever justified for selected local-only deployments.
