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

The database enforces evidence when a task enters review or completes, so the status API and automatic workflows use the same gate. It checks the latest implementation or repair, passing checks, and satisfied evidence for every acceptance criterion. Each configured specialist must assess the exact current repository snapshots; a newer failure supersedes an older success. Active runs block advancement, and a requeued task needs new execution evidence. These decisions use task-specific history without display pagination.

The controller validates the worker's structured task report before assigning a successful run status. Required criteria have unique, nonempty text, and reported evidence must match that text exactly once for every criterion. The persisted result follows the required criterion order; missing, duplicate, unsatisfied, or empty evidence produces a failed criterion, while unrelated evidence fails report validation. Malformed fields are rejected rather than coerced. Implementation, repair, verification, and release use the same validation, so incomplete specialist reports trigger the normal failure or repair path before review. Model output schemas and prompts describe these requirements, but controller validation remains authoritative.

The orchestration response keeps its latest 25 project runs for display. A separate, unpaginated `activeRuns` list drives live presence and cancellation controls, including runs waiting for input. Each task card receives its latest run, current implementation or repair, latest specialist results for that implementation, and active runs in `taskRuns`. Full task history remains available through the task workflow endpoint. API busy checks and cancellation query active runs directly; reviews, reruns, and recovery consult task history independently of the display limit.

Code changes also require a completed Release Manager assessment before review and durable approved integration before completion. Artifact strings alone do not prove integration. QA, code-review, and security tasks can complete with a report containing no source changes, passing checks, and complete acceptance evidence; their configured specialist checks still run and must pass. A rejected transition leaves task status, dependent tasks, objective status, and transition events unchanged.

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

The task controller accepts both `read-only` and `workspace-write` filesystem permissions. Read-only assessments, including Release Manager runs, receive a read-only repository bind mount and return evidence without capturing or publishing changes, regardless of agent role. Scratch files can use `/tmp`; checks that require modifying the supplied repository must be reported as unavailable under these permissions. Writable implementation runs retain the separate capture and publication path described below.

Controller run schemas share validation for purpose, verification check, and verification round, using the contract's purpose/check values. Task requests reject unknown run fields rather than silently discarding them. The validated purpose selects the worker instructions and publication policy. Verification and release runs inspect the supplied base commit and return evidence without publishing worker edits or commits, including when their filesystem policy permits a writable clone for test artifacts. Implementation and repair runs retain change publication. The verification round is included in the worker's context.

Provider credentials stay in the trusted controller. Each run receives a separate, read-only mount containing only a Unix socket to a constrained provider proxy. A credential-free worker launcher relays local Codex HTTP requests to that socket. The proxy accepts only model discovery, Responses, and compaction routes for the selected provider and model, applies bearer authentication or AWS SigV4, and streams successful responses without exposing credential-bearing headers or upstream error bodies. It never follows redirects. ChatGPT token refreshes are serialized and persisted in a controller-only directory, never mounted into a worker. Worker homes are empty temporary filesystems and worker environments contain no real provider credentials. The public Bedrock placeholder only selects Codex's built-in provider behavior; the controller replaces it with a signed request.

The proxy is revoked and active upstream requests are aborted when a run ends. Repository commands can invoke their run's proxy while it is active; this separation protects provider credentials, not the run's spending budget. Endpoint-level enforcement of other worker network traffic remains future hardening.

Coding output is captured through a separate controller-owned checkout that is never mounted into a worker. After the worker stops, the controller copies its working files into that checkout while excluding all Git metadata. Directory substitutions and special files are rejected; symlinks are preserved as link text without reading their targets. Commits are constructed from this file snapshot, not from the worker's index, object database, configuration, or commit history. Capture Git commands use an isolated environment with hooks and configuration-driven helpers disabled. The source repository receives the resulting branch through a local fetch from the private checkout, avoiding receiving hooks from a local push.

A task may change only some of its assigned repositories. Capture finishes for every repository before any branch is published. The result's commit manifest contains the cumulative task changes relative to the original integration bases, including commits carried forward unchanged through repair passes. Each such commit has a branch under the current run; repositories without task changes keep their specified base snapshot, including an unborn base, and need no published branch. Verification and release assess all assigned snapshots, while integration applies only the manifest's repositories. A code task with no changes remains a failed run; specialist reports may complete without commits.

If capture fails, no branches from that run have been published. If publication fails partway through, the failed result records all confirmed published commits, branches, and files, preventing them from disappearing from workflow history. This is not atomic publication across repositories and does not provide restart recovery for a controller crash during publication. Approval also checks that unchanged assigned repositories still match the assessed bases.

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

On API startup, interrupted task workflows become resumable and active taskless planning, conversation, and consultation turns become `timed_out`. Prior messages, results, provider threads, and completed attempts remain in history. A system message explains that the Director can send a new message to continue; unfinished plans or replies are not replayed automatically. The periodic recovery sweep checks task leases only, so it does not interrupt live conversations that have no task lease.

The same transaction that records an interrupted run queues its worker for cleanup. Startup and periodic recovery ask the controller to stop that run's task, planning, or consultation container. Cleanup requests remain in the database until the controller confirms success, survive further API restarts, and retry when a missing or unavailable controller returns. Recovery sweeps do not overlap.

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

Integration approval and the exact apply request (including commit IDs and target branches) are reserved in one SQLite transaction before calling the controller. Pending proposals must still refer to the task's current implementation and completed release assessment. A renewable lease admits one API caller; completion records the controller result, applied evidence, task transition, and notification in one transaction. Duplicate completed requests return the saved result.

The single trusted controller serializes integrations and keeps durable per-repository receipts under `.integrations` in the persistent worktree volume, outside worker mounts. It preflights all remaining repositories, fast-forwards the approved SHA, and saves progress after each repository. A retry uses the original request and skips completed repositories; Git ancestry covers a process interruption between merge and receipt persistence. These records must be preserved alongside the orchestration database. This is resumable integration, not an atomic transaction across Git repositories, and assumes one controller owns integration into the workspace.

An interrupted integration stays approved and appears as **Resume apply** in the task board after a failure or lease expiry. Its task cannot rerun or change status while the integration is unfinished. Resuming requires the remaining repositories to be on their approved target branches and bases; it never silently retargets or authorizes a replacement implementation.

Requeueing a task or starting a replacement implementation, repair, or release run supersedes its prior integration proposals in the same database transaction. Both approval and proposal expose a `superseded` status and timestamp. The stored original decision, Director feedback, applied timestamps, and controller receipts remain as history; superseded requests cannot authorize integration. An unfinished authorized apply must resume before its task can be requeued.

Each rerun uses execution history after its requeue event. Rejected work can be repaired from its previous commit while the source still matches that work's integration base; otherwise it starts from the current source and carries forward the Director's feedback. Historical rejections from earlier reruns do not select a new baseline. A release proposal can be reused only for the current implementation and release assessment, and the database rejects delayed proposals for replaced work. Existing databases receive the same supersession rules during migration while preserving authorized interrupted applies.

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
