# Local Engineering Team

A local command center for directing an AI software engineering organization. It runs beside one or more Git repositories, stores operational state in SQLite, and is designed for voice or text interaction.

Architecture decisions are recorded in [ENGINEERING_TEAM_PLAN.md](ENGINEERING_TEAM_PLAN.md) and the [architecture decision records](docs/adr/).

The complete product direction is recorded in [ENGINEERING_TEAM_PLAN.md](./ENGINEERING_TEAM_PLAN.md).

## What works today

- A single local website for the dashboard and API
- Automatic discovery and project onboarding of adjacent Git repositories
- Creation of new sibling folders initialized as Git repositories on `main`
- Persistent projects and an append-only audit log in SQLite
- Durable objectives and dependency-aware task graphs
- Sibling repositories grouped under one workspace Project
- A Live Team view with agent presence, current assignments, and durable queued messages
- A Kanban Tasks view covering proposed work through completion
- Assignments across all ten engineering agent roles
- Provider-neutral agent-run contracts and durable runtime-state storage
- Durable Project setup and execution settings with a validated local API
- Zero-setup launch that derives the Project name and automatically attaches sibling Git repositories
- A permanent Settings view for Project identity, repository access, and execution defaults
- Reusable Model Backend settings for ChatGPT, OpenAI, Anthropic, RunPod, OpenRouter, Ollama, and custom endpoints
- Configurable API protocol, model ID, endpoint URL, authentication mode, credential reference, and enabled state per backend
- Reusable Coding Harness settings for Codex, Claude Code, OpenCode, Pi, DeepSeek Harness, Grok Build, and custom CLIs
- Per-harness executable, optional container image, supported model protocols, capabilities, and enabled state
- Codex-first worker image with a pinned Codex CLI and trusted Installed/Missing version checks
- Direct per-agent Coding Harness and Model Backend assignments for every engineering-team role
- Protocol compatibility validation for each agent's selected harness/model pairing
- Direct per-agent coding harness and model assignments from the Live Team view
- Per-agent fallback harness/model assignments, automatic failover for quota and provider-runtime failures, and manual fallback retry for failed task runs
- Credential references stored as environment-variable names without persisting secret values
- A planning-only Project Manager that turns Live Team messages into validated proposed tickets
- One disposable, hardened Codex container with isolated read-only clones for every PM planning turn
- Configurable planning collaborators on each role, with Architect and Tech Lead enabled for the Project Manager by default
- Real read-only consultant runs using each consulted agent's own role definition and assigned harness/model before PM ticket synthesis
- Direct conversations with every specialist: sending a message launches that agent's disposable read-only worker with its role, directives, recent conversation, and project/repository context
- Durable Markdown Project Context and per-repository Context with revision history
- Approval-gated context updates proposed by the Project Manager, Architect, or Tech Lead during planning
- A separate trusted worker controller; the web/API container and agent workers never receive the Docker socket
- Director approval or rejection of proposed plans
- Enforced task transitions from ready through implementation, review, and completion
- Same-ticket QA, code-review, and security gates with visible pending/running/passed/failed state
- A bounded automatic repair loop that reruns every required gate and exposes Apply only after all gates pass
- A Release Manager assessment and durable Director integration approval that is the only path allowed to apply verified commits
- Clickable Kanban task details with a live workflow timeline, run evidence, findings, changed files, model usage, and container events
- Bounded live Codex task activity on Live Team and Kanban cards, with normalized command, tool, file-change, message, and lifecycle events persisted to each run
- Director cancellation for task and conversation workers; task cancellation preserves evidence and creates a stage-aware Resume action
- Safe Director guidance for active tasks: the current disposable worker is stopped, its history is preserved, and the interrupted stage automatically restarts with the new instruction
- Restart and expired-lease recovery that preserves evidence, stops orphaned workers, and resumes at the interrupted workflow stage without repeating passed gates
- A production container that runs as a configurable non-root user
- Docker-native build, test, typecheck, health check, and startup workflows

Additional provider adapters, live Project Manager planning events, and voice are the next product layers. Conversations and planning remain read-only: agents can inspect isolated clones and advise or propose work, but they cannot change source code outside an approved task run.

## Prerequisite

Install Docker with Docker Compose. Node.js, npm, Git, compilers, and SQLite libraries are supplied inside the images.

## Recommended directory layout

Keep this repository beside the repositories it will manage:

```text
workspace/
├── engineering-team/
├── product-one/
└── product-two/
```

With that layout, the default `WORKSPACE_ROOT=..` exposes the sibling repositories to the application as `/workspaces/...`.

## Start the application

```bash
cp .env.example .env
docker compose up --build --detach
```

Open <http://127.0.0.1:4318>. The repository picker scans the mounted workspace up to two directory levels deep.

With the recommended directory layout, simply clone Engineering Team beside existing repositories and start it. The parent folder becomes the Project name when it is visible to the server, and the name can be edited from the dashboard. Sibling repositories such as `backend`, `frontend`, `task-runner`, and `etl` appear in the compact Repos list beneath the Live team and Tasks views. They share one team room, objective history, and task board.

Because Docker mounts the host parent folder at the generic `/workspaces` path, set `ENGINEERING_TEAM_PROJECT_NAME` in `.env` when you want the initial Docker name to match the host folder exactly. This is only a display name and can also be changed inline later.

On first launch, the application creates the workspace Project, derives its name from the parent workspace when that path is visible, automatically attaches every detected sibling Git repository, and opens directly into Live Team. You can rename the Project, create repositories, or adjust optional execution defaults later in Settings.

Model Backends in Settings can record a ChatGPT-account backend without an API key, as well as API-key or unauthenticated local backends. Coding Harnesses independently register the CLIs that will drive those models and declare supported protocols and task capabilities. Each Live Team agent card directly selects its harness and model from two clickable lists in a compact popover; either choice may remain unassigned. These records intentionally store only configuration and environment-variable names—never key values or ChatGPT session tokens. The trusted controller currently verifies Codex against the actual allowlisted worker image; other harness registrations correctly show as missing until their images are implemented.

The connected Codex adapter supports ChatGPT-session authentication or an API-key credential reference. Its planning flow is:

1. Open Live Team and select the Project Manager.
2. Describe the feature or outcome you want.
3. For a non-trivial goal, the Project Manager requests focused input from its configured planning collaborators. Each consultant runs in a separate disposable, read-only container with its own role prompt and runtime assignment.
4. The Project Manager receives the consultation results and returns a validated task graph.
5. Review the proposed tickets and any Project/Repository Context updates on the Tasks board, then approve or reject the plan.
6. Start an approved task. Its implementation agent works in a disposable writable container, then the configured QA, Code Reviewer, and Security agents independently inspect that exact commit in their own disposable containers.
7. If a required gate fails, the implementation agent receives the findings for one bounded repair pass and all required gates rerun. The same ticket stays in progress throughout; no review tickets are created.
8. When every required gate passes, the task moves to Review and its verified branch becomes available to Apply. Dependencies become ready when the applied task completes.

The Codex/OpenAI Responses adapter executes planning, consultations, and approved tasks today. Each participant resolves its harness and model from its Live Team assignment. A configured consultant must have a compatible enabled runtime before the Project Manager can request its input.

The controller image pins Codex with the `CODEX_VERSION` Docker build argument. Settings reports the installed CLI version only when a registered Codex harness uses the allowlisted worker image and a `codex` executable. A saved harness configuration does not install software by itself.

Plans cannot execute before approval, invalid dependency graphs are rejected, and every decision and task transition is written to the audit log.

Project Context is edited in Project Settings. Repository Context is edited from each repository's gear button. Both are durable Markdown shared with Project Manager, Architect, and Tech Lead planning runs. Direct edits create revisions immediately; agent-proposed replacements remain pending and are applied atomically only when their plan is approved.

On Linux, set these values in `.env` to the account that owns the repositories:

```bash
ENGINEERING_TEAM_UID=1000
ENGINEERING_TEAM_GID=1000
```

Use `id -u` and `id -g` to obtain the appropriate numbers. This prevents files created through managed checkouts and integration from being owned by root.

To expose a different collection of repositories, set an absolute or Compose-relative path:

```bash
WORKSPACE_ROOT=/path/to/repositories
```

Only repositories inside this root can be registered. The browser-facing service is loopback-only and does not receive the host Docker socket. A separate trusted controller receives the socket solely to create and destroy allowlisted workers. Each PM run clones the selected repositories into its own directory, mounts only that directory read-only, filters credentials from model-generated command environments, and destroys the worker and clone afterward.

## Operate it

```bash
docker compose ps
docker compose logs --follow app controller
docker compose restart app
docker compose down
```

The SQLite database is stored at `/data/engineering-team.db` in the `engineering-team-data` named volume. `docker compose down` preserves it. Running `docker compose down --volumes` permanently deletes the application database and worktree volume.

## Verify the source

The verification image contains all development dependencies, so tests require only Docker:

```bash
docker compose --profile test run --rm test
```

This runs the database and API tests, TypeScript typecheck, and production web/server build.

## Stop and update

```bash
docker compose down
docker compose up --build --detach
```

Rebuilding does not remove the persistent SQLite volume.
