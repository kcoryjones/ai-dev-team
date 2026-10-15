# Local AI Engineering Team — Architecture Plan

## Status

This document records the current product and architecture direction so work can continue across sessions.

The project will be a repository-independent local application that presents an AI engineering team through a locally hosted web interface. The user acts as Engineering Director and communicates primarily with an Orchestrator/Project Manager, using voice or text. Agent activity, decisions, tasks, approvals, reviews, and release state persist in SQLite.

### Implementation progress — 2026-10-12

The Docker-first foundation slice is implemented and verified:

- npm/TypeScript workspace with separate web, server, contracts, and database packages
- Local Hono API bound to loopback by default
- SQLite database with versioned migration support, foreign keys, WAL mode, and busy timeout
- Initial `projects`, `repositories`, `events`, and `schema_migrations` tables
- Transactional project creation with an append-only `project.created` audit event
- Git repository inspection and duplicate-registration protection
- React Engineering Director dashboard with repository registration and persistent project listing
- Repository discovery constrained to a configured workspace root, including path-escape protection
- Zero-setup adjacent repository onboarding and safe creation of new sibling Git repositories
- Multi-stage production image and Compose runtime; Docker is the only host runtime dependency
- One loopback-only origin serving both the built dashboard and API
- Persistent named volumes for SQLite data and future managed checkouts
- Writable sibling-repository mount with configurable host UID/GID ownership
- Read-only container filesystem, dropped capabilities, no-new-privileges, and no host Docker socket
- Durable objectives, tasks, task dependencies, role assignments, and approval requests
- Transactional plan creation with unknown-dependency, self-dependency, and cycle rejection
- Director plan approval/rejection gates that activate or cancel the proposed workflow
- Enforced task state transitions with automatic release of satisfied dependencies
- Automatic objective completion when all non-cancelled work is complete
- Dashboard control room for plan creation, approval decisions, and manual task progression
- One workspace Project containing multiple sibling repositories
- Separate Live Team and Kanban Tasks views
- Durable per-agent director messages and a connected planning-only Project Manager conversation
- Versioned provider-neutral `RunSpec`, `RunEvent`, and `RunResult` contracts
- Durable brain profiles, role assignments, agent runs, attempts, normalized run events, artifacts, usage, and exclusive task leases
- One-to-one Project settings with setup completion, execution defaults, budgets, planning network policy, and plan-approval policy
- Typed Project settings API with validated partial updates and auditable changes
- Zero-setup launch with automatic Project initialization and sibling-repository attachment
- Permanent Settings view for Project identity, repository access, and execution defaults
- Validated Project Manager brain configuration with provider/harness compatibility and secret-free credential references
- Codex-backed Project Manager turns that create schema-validated plans for director approval
- Trusted Docker worker controller, disposable hardened planning workers, and isolated read-only repository clones
- Durable, provider-neutral Model Backend registry with endpoint, protocol, model, auth-mode, credential-reference, and enabled-state configuration
- Model Backend Settings UI for ChatGPT, OpenAI, Anthropic, RunPod, OpenRouter, Ollama, and custom services
- Durable Coding Harness registry with adapter, executable, container-image, protocol compatibility, capability, and enabled-state configuration
- Coding Harness Settings UI for Codex, Claude Code, OpenCode, Pi, DeepSeek Harness, Grok Build, and custom CLIs
- Pinned Codex-first worker installation with controller-owned worker-image capability inspection
- Installed, missing, and controller-unavailable harness status in Settings
- Durable independent harness/model assignment for each role through compact clickable Live Team card popovers
- Append-only audit events for plan creation, approval decisions, and task transitions
- Automated database and API tests using the Node test runner
- Successful containerized tests, typecheck, production build, dependency audit, repository-write check, orchestration restart-persistence check, and live end-to-end smoke test

Each engineering-team role can now select one compatible Coding Harness and Model Backend directly. The next execution step is resolving that pair when a role starts a run. Planning-runtime cancellation, streamed normalized events, restart recovery, and an end-to-end live-container test remain required before writable coding-agent execution is enabled.

## Product vision

Create a package that can run alongside any software repository and provide a structured web-development organization:

```text
Engineering Director (human)
        |
        v
Orchestrator / Project Manager
        |
        +-- Architect
        +-- Tech Lead
                |
                +-- Backend Developer
                +-- Frontend Developer
                +-- DevOps / Database Engineer
                        |
                        +-- QA Engineer
                        +-- Code Reviewer
                        +-- Security Reviewer
                                |
                                v
                    Integration / Release Manager
```

This is an authority and workflow hierarchy, not a requirement to keep eleven model sessions running continuously. Agents should be activated on demand, according to project scope and risk.

## Current decisions

1. The primary experience will be a website served locally on `127.0.0.1`.
2. A local backend service—not the browser—will access repositories, request worker execution, manage Git checkouts, and persist state.
3. SQLite will be the authoritative project and workflow store.
4. Voice and text will be equivalent input methods, with a visible durable transcript.
5. The default user-facing agent will be the Project Manager/Orchestrator.
6. Specialist agents will be available for direct conversation when requested.
7. Codex will be the initial agent execution runtime.
8. OpenAI and RunPod models will eventually be selectable through a configurable model router.
9. A Codex plugin will complement the local application but will not contain the entire system.
10. The first release will validate one complete vertical workflow before adding the full organization and extensive autonomy.
11. Docker and Docker Compose will be the only required host runtime for the initial distribution.
12. The application repository should live beside the repositories it manages; a configured parent directory is mounted at `/workspaces`.
13. One installation represents the overall workspace Project. Its name defaults to the parent workspace folder when available and remains directly editable.
14. The Project may contain multiple sibling repositories such as backend, frontend, task runner, and ETL. Tasks may be Project-wide or scoped to one or more repositories.
15. Existing sibling Git repositories are discovered automatically, while new repositories are created only as validated direct children of the workspace root.
16. Every agent execution runs in its own disposable Docker container. Agents never execute inside the API/control-plane container.
17. Worker containers never receive a Docker socket or Docker API credentials. A trusted, narrow worker controller is the only component allowed to create, inspect, stop, and remove workers.
18. A worker receives only its task checkout and explicitly scoped runtime credentials. It never receives the source repository mount, another run's checkout, or the application data volume.
19. Agent identity and conversation state are durable orchestration concepts; model processes and worker containers are disposable execution details.
20. All providers implement versioned, provider-neutral `RunSpec`, `RunEvent`, and `RunResult` contracts. Provider commands, model names, and native event formats remain behind adapters.
21. Agent roles select configurable brain profiles and are not permanently bound to a provider or model.

The detailed decision and initial contract shapes are recorded in [ADR 001: Provider-neutral agent worker runtime](docs/adr/001-agent-worker-runtime.md).

## High-level architecture

```text
Local browser UI
  +-- Voice and text conversation
  +-- Project and task dashboard
  +-- Team activity and agent threads
  +-- Decisions and approval queue
  +-- Diffs, tests, reviews, and release status
               |
               v
Local orchestration service
  +-- Workflow and policy engine
  +-- Codex SDK / App Server adapter
  +-- Model and provider router
  +-- Voice gateway
  +-- Git repository/checkout manager
  +-- Event stream for live UI updates
  +-- SQLite persistence
               |
               v
Trusted worker controller (no model-driven commands)
  +-- Validates an allowlisted image and fixed security policy
  +-- Creates, monitors, cancels, and removes worker containers
  +-- Is the only service with access to the dedicated Docker API
               |
               v
Disposable worker container per agent run
  +-- One self-contained managed Git checkout
  +-- No Docker API, sibling repositories, or control-plane volumes
  +-- Bounded CPU, memory, processes, time, and output
```

The application manages one workspace Project containing zero or more sibling repositories. The Project retains shared objectives, tasks, team conversations, configuration, agent runs, decisions, and release history across those repositories. Compact repository shortcuts and add controls live beneath the primary Live team and Tasks navigation rather than in a separate application-management surface. The browser and API are served from the same loopback-only container port.

The browser-facing application must not mount the host Docker socket. The preferred deployment uses a dedicated rootless Docker Engine for worker containers. If an initial local deployment uses the host Engine, its socket may be exposed only to the trusted worker-controller service, and the UI must disclose that this grants the controller broad authority over that Engine. Workers never inherit that access.

## Proposed package structure

```text
engineering-team/
├── Dockerfile               # Multi-stage build, test, and runtime image
├── compose.yaml             # Local runtime, mounts, volumes, and test profile
├── docker/                  # Container entrypoint and runtime support
├── apps/
│   ├── web/                 # Local Engineering Director dashboard
│   └── server/              # Local API and orchestration host
├── packages/
│   ├── orchestration/       # Workflow engine, policies, and gates
│   ├── agents/              # Role definitions and handoff contracts
│   ├── codex-runtime/       # Codex CLI/SDK execution contract
│   ├── worker-controller/   # Validated Docker worker lifecycle
│   ├── model-router/        # OpenAI, RunPod, and future providers
│   ├── voice/               # Speech provider abstraction
│   ├── repositories/        # Git, branches, managed checkouts, and diffs
│   └── database/            # SQLite schema and migrations
├── plugin/                  # Optional Codex plugin
├── cli/                     # Initialization, startup, and configuration
└── docs/
```

A future command might look like:

```bash
engineering-team start --repo /path/to/project
```

## User experience

The main interface should be an Engineering Director cockpit with two primary project views:

1. **Live Team** shows every agent, presence, current task, and a durable role-specific conversation. The director can switch agents without leaving the overall project. Messages sent while no worker is running remain visibly queued.
2. **Tasks** is a Kanban board showing proposed, ready, blocked, in-progress, review, and completed work. Cards show their assigned agent and repository while Project-wide work remains possible. Compact repository shortcuts and add/create controls appear beneath the two primary views in the navigation.

Repositories are execution boundaries, not separate projects. A backend, frontend, task runner, and ETL repository may all contribute to one Project objective and one board.

The default view should show:

- Current project objective and active milestone
- Work in progress and task dependencies
- Decisions and approvals waiting for the director
- Blockers and material risks
- Agent activity and recent handoffs
- Test, review, and security status
- Integration and release readiness
- Voice/text transcript
- Model usage, elapsed time, and estimated cost

Example voice interactions:

- “What is blocking the release?”
- “Have the architect explain why they selected Postgres.”
- “Ask frontend and backend to agree on the API contract before continuing.”
- “Approve the plan, but require my confirmation before running the migration.”
- “Show me the reviewer’s evidence for that finding.”

## Roles and permissions

| Role | Primary responsibility | Default access |
|---|---|---|
| Project Manager | Scope, task graph, delegation, status, escalation | Project-state writes |
| Architect | System boundaries, architecture decisions, major tradeoffs | Design-artifact writes |
| Tech Lead | Implementation plan, sequencing, technical coordination | Planning-artifact writes |
| Backend Developer | APIs, services, and domain logic | Assigned checkout writes |
| Frontend Developer | UI, accessibility, and browser behavior | Assigned checkout writes |
| DevOps/DB Engineer | Infrastructure, schemas, migrations, observability | Assigned checkout writes |
| QA Engineer | Test planning, execution, and reproduction | Read-only by default |
| Code Reviewer | Correctness, maintainability, and regression review | Read-only |
| Security Reviewer | Threat modeling and security review | Read-only |
| Release Manager | Integration, release checks, and changelog | Integration checkout writes |

QA, code review, and security are independent gates. They should not be treated merely as subordinate agents expected to approve developer work.

## Workflow model

Agent work is represented as durable jobs:

```text
queued -> assigned -> running -> waiting -> review -> completed
                         |          |
                         v          v
                      blocked     changes requested
                         |
                         v
                       failed
```

A normal feature workflow is:

```text
Director request
  -> PM clarifies scope and acceptance criteria
  -> Architect records necessary design decisions
  -> Tech Lead creates the implementation plan and dependency graph
  -> Developers work in separate containerized Git checkouts
  -> QA verifies expected behavior
  -> Code Reviewer and Security Reviewer inspect independently
  -> Developers address substantiated findings
  -> Release Manager integrates and verifies the candidate
  -> Director approves protected or production-impacting actions
```

The PM selects only the roles justified by the change. A small UI correction should not automatically invoke every member of the organization.

## Persistence design

SQLite will run in WAL mode so the interface can read status while agents update project state.

In the Docker distribution, the database lives at `/data/engineering-team.db` on a named volume. It survives image rebuilds, container replacement, and ordinary `docker compose down` operations.

Likely core entities:

- Projects and registered repositories
- Application sections and task-to-repository scope
- Project objectives and milestones
- Agent role definitions and provider configurations
- Epics, tasks, dependencies, and acceptance criteria
- Agent runs, thread references, and execution status
- Conversations and transcript entries
- Architecture decisions and other durable decisions
- Handoffs and attached evidence
- Reviews, findings, severity, and resolution
- Human approval requests and responses
- Artifacts, files, commits, branches, and managed checkouts
- Test, quality, and security results
- Releases and deployments
- Model usage, timing, and cost estimates
- Append-only audit events

The design should combine normal query tables with an append-only event log. The event log provides traceability and permits rebuilding derived status when necessary.

API keys, tokens, and repository credentials must not be stored directly in SQLite. They should come from environment variables or an operating-system credential store.

## Agent and model runtime

Codex will initially provide agent execution through its SDK and, where richer streamed control is required, App Server. Agent roles should have configurable model, reasoning, tools, sandbox, and provider policies.

The provider-neutral runtime contract, persistent-agent/disposable-worker distinction, normalized event model, conversation behavior, and structured result requirements are defined in [ADR 001](docs/adr/001-agent-worker-runtime.md). The runtime should be implemented in this order:

1. Versioned `RunSpec`, `RunEvent`, and `RunResult` contracts.
2. Brain profiles plus run, attempt, event, artifact, usage, and task-lease persistence.
3. A trusted worker-controller interface and fake executor for orchestration tests.
4. One hardened Codex worker using an isolated self-contained checkout.
5. Live normalized event streaming and evidence-backed task transitions.
6. Cancellation, timeouts, retries, recovery, and safe chat interventions.
7. Independent review/integration execution, followed by additional provider adapters.

Provider-specific flags, model identifiers, and authentication mechanics belong in runtime configuration and adapter documentation rather than the architecture contract.

### Container execution boundary

An agent run is inseparable from its worker container. The orchestrator may queue and describe work, but model-driven code and shell commands execute only inside that run's container. The required lifecycle is:

1. Persist a queued run and immutable execution policy.
2. Prepare a self-contained checkout on a task-specific branch from a recorded commit.
3. Ask the trusted worker controller to launch one allowlisted worker image with a generated run ID.
4. Stream stdout, stderr, structured Codex events, resource usage, and heartbeats into durable run events.
5. On success, stop execution, inspect the checkout outside the worker, and capture the patch, tests, and artifacts as evidence.
6. On cancellation, timeout, or failure, stop and remove the container while retaining bounded logs and evidence.
7. Import or commit changes only through the trusted control plane after validation; a worker cannot merge or write to the registered source repository.

The controller API is declarative and narrow: start a run from a stored policy, observe it, cancel it, and clean it up. It must not accept arbitrary image names, bind mounts, Docker flags, privileged mode, host networking, device mappings, or free-form container creation requests from a prompt or browser payload.

Each worker policy must enforce:

- A non-root numeric UID/GID and no privileged mode
- All Linux capabilities dropped and `no-new-privileges`
- Only the assigned checkout mounted read-write; no source repository, application database, control-plane filesystem, SSH directory, cloud credential directory, or Docker socket
- A read-only container root filesystem with bounded temporary and dependency-cache storage
- CPU, memory, PID, wall-clock, output-size, retry, and concurrency limits
- A default seccomp profile plus AppArmor or SELinux policy where the host supports it
- No published ports and no attachment to the control-plane network
- Network disabled for offline roles; otherwise, explicit egress policy limited to required model and dependency endpoints
- Per-run scoped credentials supplied at launch, redacted from logs, and destroyed with the worker
- Deterministic labels tying the container, checkout, task, agent run, image digest, and policy version together

Docker is a containment layer, not a complete boundary against hostile code. Higher-risk or multi-user workloads should be able to replace the Docker backend with a VM or microVM executor without changing orchestration contracts.

Example policy shape:

```toml
[roles.architect]
provider = "openai"
model_class = "deep-reasoning"
sandbox = "read-only"

[roles.frontend]
provider = "runpod"
model_class = "implementation"
sandbox = "workspace-write"

[roles.security]
provider = "openai"
model_class = "high-assurance"
sandbox = "read-only"
```

Role policies should refer to capability classes where practical rather than scattering fixed model names throughout the application.

### RunPod compatibility

Current Codex custom model providers expect a Responses-compatible API. If the selected RunPod endpoint exposes only an OpenAI-style Chat Completions API, the project will need a compatibility gateway that translates:

- Requests and responses
- Streaming events
- Tool definitions and tool calls
- Structured outputs
- Errors, cancellation, and retry behavior

RunPod should initially be used for bounded tasks after candidate models pass capability evaluations. The control plane and difficult ambiguous reasoning should remain on the most reliable available model until evaluation shows that an alternative is suitable.

Required provider evaluations include:

- Instruction following
- Tool-call correctness
- Structured-output reliability
- Context limits
- Patch quality
- Test and debugging performance
- Cancellation and stop behavior
- Latency, throughput, and cost

## Voice design

Voice will be an interface to the same command and event system used by text. It should not create a separate source of truth.

The voice package should support interchangeable implementations:

1. Cloud speech using a low-latency realtime speech provider.
2. Local speech-to-text and text-to-speech for privacy or offline operation.

The first version should use push-to-talk rather than an always-listening microphone. The interface should display the interpreted transcript and make it clear when a command has begun execution.

Voice alone must not authorize destructive or production-impacting operations. Those require explicit visible confirmation.

## Repository isolation and integration

- The configured host repository root is mounted at `/workspaces`; canonical-path checks reject registration outside that boundary.
- Managed run checkouts live under `/worktrees` on a separate persistent volume unless a later workflow requires a project-specific location.
- Container processes use a configurable host UID/GID so repository writes do not become root-owned on Linux.
- Every agent receives a separate self-contained Git checkout or equivalent branch workspace, mounted into exactly one worker container.
- A native `git worktree` is not mounted by itself when its `.git` indirection would expose or require the registered repository's shared Git metadata. Prefer a self-contained clone for the first implementation.
- Workers cannot access the registered source repository or integration checkout. The trusted control plane captures patches or commits and performs integration after gates pass.
- Only one agent should own a file area at a time unless the PM explicitly coordinates shared work.
- Review and security agents are read-only by default.
- The Release Manager owns the integration checkout.
- Changes are integrated only after their required gates pass.
- The system records the source task and agent for every proposed commit.
- Existing uncommitted user changes are never overwritten or discarded.

## Approval and security guardrails

Human approval is required for at least:

- Production deployments
- Destructive database migrations
- Merging into protected branches
- Credential and secret changes
- Material infrastructure cost changes
- External messages or actions with organizational impact
- Broadening filesystem or network permissions

Additional guardrails:

- Acceptance criteria must exist before implementation begins.
- Findings must include concrete evidence such as a file, test, log, or reproducible behavior.
- Agent runs have token, time, retry, and concurrency limits.
- Sensitive values are never included in prompts or audit output.
- All significant decisions and state transitions are logged.
- Failed or interrupted jobs can be resumed without pretending they completed.
- Workers never receive a Docker socket, privileged mode, host PID/network namespaces, or arbitrary host bind mounts.
- Starting a run fails closed if its isolation, resource, credential, image-digest, or network policy cannot be applied.

## Initial technology direction

TypeScript is the preferred initial language so the web UI, local server, orchestration packages, and Codex integration can share types.

Provisional choices:

- Docker Compose as the initial packaging and local operations interface
- React for the browser interface
- Hono with its Node.js adapter for the local API server
- WebSocket or Server-Sent Events for live updates
- SQLite with versioned migrations
- Codex SDK for ordinary agent jobs
- Codex App Server for richer client controls and streamed events where needed
- Docker Engine adapter behind a narrow worker-controller API
- Git CLI integration for self-contained managed checkouts and diffs
- Provider adapters for OpenAI and RunPod

Avoid a large public-web framework initially. This is a local control application, so a small client and explicit backend will be easier to secure, debug, and distribute. A later Tauri or Electron wrapper should be possible without redesigning the core.

## MVP vertical slice

The first release should prove one complete workflow:

1. Register a repository.
2. Enter or speak a feature request.
3. The PM turns the request into acceptance criteria and a task graph.
4. The Architect or Tech Lead prepares a plan.
5. The director reviews and approves the plan.
6. One implementation agent works in its own disposable container and isolated checkout.
7. QA and Code Review inspect the result in separate disposable containers.
8. The implementation agent addresses any accepted findings.
9. The Release Manager prepares an integration proposal.
10. The director approves or rejects the merge.
11. The application restarts and resumes with complete project state.

For the MVP, the implementation may use five operational profiles even though all organizational titles are represented:

- Project Manager
- Design Lead
- Implementation Worker
- Independent Reviewer
- Release Manager

Roles can be split into their full specializations once the end-to-end workflow is reliable.

## Delivery milestones

### Milestone 1: Team in a repository

- [x] Docker-only local application scaffold
- [x] Adjacent repository discovery, onboarding, and new repository creation
- [x] SQLite schema, migrations, and persistent volume
- [x] Basic Engineering Director dashboard
- [x] Durable objectives, tasks, dependencies, and approvals
- [x] Role assignments and initial workflow state machine
- [x] Versioned provider-neutral run contracts
- [x] Runtime persistence for brain profiles, runs, attempts, events, artifacts, usage, and task leases
- [x] Project setup-completion state and validated settings API
- [x] Replace the setup wizard with zero-setup Project and repository initialization
- [x] Permanent Settings view
- [x] Project Manager brain configuration
- [x] Reusable Model Backend configuration and Settings UI
- [x] Harness registry and compatibility declarations
- [x] Direct compatible harness/model assignment for every engineering-team role
- [x] Codex-first harness installation and allowlisted worker-image version detection
- [ ] Resolve each agent's harness/model assignment during execution
- [ ] Role-specific prompt and tool policies
- [x] One disposable, hardened Docker container per Project Manager planning run
- [x] Trusted worker controller with no Docker access in workers or the web/API container
- [ ] Native Codex agent execution with streamed events and cancellation
- [x] Self-contained read-only checkout isolation and control-plane-owned planning result capture
- [x] Basic text interface and live planning status
- [ ] One complete approval-driven feature workflow

### Milestone 2: Reliable orchestration

- Durable dependency graph
- Structured handoffs
- Approval policies
- Recovery after interrupted runs
- Agent event stream
- Retry, timeout, concurrency, and budget controls
- Expanded dashboard

### Milestone 3: Hybrid inference

- RunPod compatibility adapter if required
- Provider registry and secure credentials
- Role-based model routing
- Model capability evaluation suite
- Fallback and retry policies
- Usage and cost reporting

### Milestone 4: Voice and richer interface

- Push-to-talk input and spoken responses
- Interruptible voice interaction
- Direct conversation routing to specialists
- Agent and dependency visualization
- Diff, review, and approval interfaces
- Optional desktop wrapper

## Open decisions

These decisions remain intentionally unresolved:

1. Final product and package name.
2. Whether the first distribution target is personal/local use only or immediate multi-user/team use.
3. Exact autonomy level before an agent may write code.
4. Whether every plan requires director approval or only plans above a risk threshold.
5. Initial OpenAI model assignments by role.
6. Initial RunPod model and endpoint type.
7. Cloud voice provider versus local speech stack for the first voice milestone.
8. Whether project configuration lives only in SQLite or also has a reviewable repository file.
9. Authentication strategy if the server ever binds beyond loopback.

## Guiding principle

The system should make the engineering organization observable and accountable. Agents should not merely exchange conversational messages; they should produce structured tasks, evidence, decisions, code changes, reviews, and approvals that survive restarts and can be inspected by the Engineering Director.
