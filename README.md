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
- Credential references stored as environment-variable names without persisting secret values
- A planning-only Project Manager that turns Live Team messages into validated proposed tickets
- One disposable, hardened Codex container with isolated read-only clones for every PM planning turn
- A separate trusted worker controller; the web/API container and agent workers never receive the Docker socket
- Director approval or rejection of proposed plans
- Enforced task transitions from ready through implementation, review, and completion
- A production container that runs as a configurable non-root user
- Docker-native build, test, typecheck, health check, and startup workflows

Writable implementation agents, additional provider adapters, richer event streaming, recovery, and voice are the next product layers. The current Project Manager runtime is planning-only: it can inspect isolated read-only clones and propose work, but it cannot change source code.

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

Model Backends in Settings can record a ChatGPT-account backend without an API key, as well as API-key or unauthenticated local backends. Coding Harnesses independently register the CLIs that will drive those models and declare supported protocols and task capabilities. Each Live Team agent card directly selects its harness and model from two clickable lists in a compact popover; either choice may remain unassigned. These records intentionally store only configuration and environment-variable names—never key values or ChatGPT session tokens. The trusted controller currently verifies Codex against the actual allowlisted worker image; other harness registrations correctly show as missing until their images are implemented. The planning worker does not consume the new assignments yet.

The currently connected Project Manager planning adapter still uses its earlier OpenAI API-key path. Until that adapter resolves the Project Manager's direct harness/model assignment and ChatGPT-session authentication, its existing proof flow is:

1. Open Live Team and select the Project Manager.
2. Describe the feature or outcome you want.
3. Codex inspects isolated read-only clones in a disposable container and returns a validated task graph.
4. Review the proposed tickets on the Tasks board and approve or reject the plan.
5. Move approved tasks through start, review, and completion. Tasks become ready automatically when their dependencies complete.

Only the OpenAI/Codex planning adapter executes today. It resolves the Project Manager's harness and model directly from the assignments on the Live Team view; other roles are saved but are not connected to task execution yet.

The controller image pins Codex with the `CODEX_VERSION` Docker build argument. Settings reports the installed CLI version only when a registered Codex harness uses the allowlisted worker image and a `codex` executable. A saved harness configuration does not install software by itself.

Plans cannot execute before approval, invalid dependency graphs are rejected, and every decision and task transition is written to the audit log.

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
