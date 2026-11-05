# Local Engineering Team

A local command center for directing an AI software engineering organization. It runs beside one or more Git repositories, stores operational state in SQLite, and is designed for voice or text interaction.

The complete product direction is recorded in [ENGINEERING_TEAM_PLAN.md](ENGINEERING_TEAM_PLAN.md), with detailed decisions in the [architecture decision records](docs/adr/).

## What works today

- A single local website for the dashboard and API
- Automatic discovery and project onboarding of adjacent Git repositories
- Creation of new sibling folders initialized as Git repositories on `main`
- Persistent projects and an append-only audit log in SQLite
- Durable objectives and dependency-aware task graphs
- Sibling repositories grouped under one workspace Project
- A Live Team view with agent presence, current assignments, durable conversations, directives, and memory placeholders
- A Kanban Tasks view covering proposed work through completion
- Assignments across all ten engineering agent roles
- Provider-neutral agent-run contracts and durable runtime-state storage
- Durable Project setup and execution settings with a validated local API
- Zero-setup launch that derives the Project name and automatically attaches sibling Git repositories
- Project and repository context editors plus a permanent Settings view for execution defaults, harnesses, and model backends
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

Additional executable provider adapters beyond OpenAI and Amazon Bedrock, native Project Manager worker-event streaming, and local spoken replies are the next product layers. Local voice supports wake-word capture, questions, reviewed work requests, task guidance, and standing instructions. Conversations and planning remain read-only: agents can inspect isolated clones and advise or propose work, but they cannot change source code outside an approved task run.

## Current execution boundary

The settings UI can describe many harnesses and model providers, but configuration does not install or connect an adapter. End-to-end execution currently supports Codex with either an OpenAI Responses backend using a mounted ChatGPT `auth.json`/API-key credential reference or supported OpenAI models served by Amazon Bedrock using a named AWS profile. Primary/fallback routing works across those connected runtimes. Anthropic, RunPod, OpenCode, Pi, DeepSeek Harness, Grok Build, Ollama, and other entries remain configuration-only until their worker adapters are implemented.

Worker containers request CPU, memory, and PID limits from Docker. Hosts without the required cgroup capabilities may warn that some limits cannot be enforced; review those warnings before relying on the installation for unattended or untrusted workloads. Endpoint-level network egress enforcement is also still future hardening.

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

Model Backends in Settings can record a ChatGPT-account backend without an API key, a named AWS profile for Amazon Bedrock, and API-key or unauthenticated local backends. Coding Harnesses independently register the CLIs that will drive those models and declare supported protocols and task capabilities. Each Live Team agent card directly selects its harness and model from two clickable lists in a compact popover; either choice may remain unassigned. These records intentionally store only configuration and credential references—never key values, temporary AWS credentials, or ChatGPT session tokens. The trusted controller currently verifies Codex against the actual allowlisted worker image; other harness registrations correctly show as missing until their images are implemented.

The connected Codex adapter supports ChatGPT-session authentication, an API-key credential reference, or a named AWS profile for Bedrock. Its planning flow is:

1. Open Live Team and select the Project Manager.
2. Describe the feature or outcome you want.
3. For a non-trivial goal, the Project Manager requests focused input from its configured planning collaborators. Each consultant runs in a separate disposable, read-only container with its own role prompt and runtime assignment.
4. The Project Manager receives the consultation results and returns a validated task graph.
5. Review the proposed tickets and any Project/Repository Context updates on the Tasks board, then approve or reject the plan.
6. Start an approved task. Its implementation agent works in a disposable writable container, then the configured QA, Code Reviewer, and Security agents independently inspect that exact commit in their own disposable containers.
7. If a required gate fails, the implementation agent receives the findings for one bounded repair pass and all required gates rerun. The same ticket stays in progress throughout; no review tickets are created.
8. When every required gate passes, the Release Manager prepares an integration proposal. The Director can approve and apply it or reject it for rework. Dependencies become ready when the approved change is applied and the task completes.

The Codex adapter executes planning, consultations, and approved tasks through OpenAI Responses or Amazon Bedrock today. Each participant resolves its harness and model from its Live Team assignment. A configured consultant must have a compatible enabled runtime before the Project Manager can request its input.

The controller image pins Codex with the `CODEX_VERSION` Docker build argument. Settings reports the installed CLI version only when a registered Codex harness uses the allowlisted worker image and a `codex` executable. A saved harness configuration does not install software by itself.

Plans cannot execute before approval, invalid dependency graphs are rejected, and every decision and task transition is written to the audit log.

Project Context is edited in Project Settings. Repository Context is edited from each repository's gear button. Both are durable Markdown shared with Project Manager, Architect, and Tech Lead planning runs. Direct edits create revisions immediately; agent-proposed replacements remain pending and are applied atomically only when their plan is approved.

### Amazon Bedrock

Expose the host AWS configuration directory to the trusted controller in `.env`:

```bash
AWS_CONFIG_DIR=/home/you/.aws
```

The controller mounts that directory read-only; agent containers never receive it. The controller resolves each run's named profile and signs model requests through a per-run provider proxy. AWS credentials remain in the controller; workers receive only the proxy socket and the configured Region. For an AWS IAM Identity Center profile, refresh the host session when necessary:

```bash
aws sso login --profile codex-bedrock
```

In Settings, add an **Amazon Bedrock** model backend, enter the profile name and Region, choose Runtime (recommended) or Mantle, and save it. **Discover models** loads compatible inference profiles for Runtime or foundation models for Mantle. **Test connection** verifies profile resolution, discovery permissions, Region availability, and the selected model. Assign the backend to an agent with the Codex harness just like a ChatGPT backend.

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

Only repositories inside this root can be registered. The browser-facing service is loopback-only and does not receive the host Docker socket. A separate trusted controller receives the socket solely to create and destroy allowlisted workers. Each PM run clones the selected repositories into its own directory, mounts it read-only, and destroys the worker and clone afterward.

Planning, consultation, and coding workers use a per-run Unix socket to reach a provider proxy in the trusted controller. ChatGPT tokens, API keys, and AWS credentials never enter worker mounts or process environments. The worker's Codex home is an empty temporary filesystem. The proxy permits only model discovery, Responses, and compaction requests to the selected provider; it signs or authenticates requests in the controller, rejects redirects, and closes when the run ends. Refreshed ChatGPT tokens are cached in the controller-only `/worktrees/.provider-auth` directory with restricted permissions; replacing the configured host auth file starts a new credential cache. Repository commands can use their run's model proxy while it is active, so this boundary protects credentials but does not enforce a token or spending budget.

## Operate it

### Local voice control (V1–V3)

Start the optional voice profile on the developer's own machine:

```bash
docker compose --profile voice up --build --detach
```

The first build compiles pinned sherpa-onnx browser keyword spotting and whisper.cpp CPU transcription engines. Setup downloads a checksum-verified English `base.en` transcription model (148 MB) into the `engineering-team-speech-models` volume. Subsequent starts reuse it, including offline starts after the images and model have been installed. The speech runtime has no published port and runs on an internal Docker network without internet access. Model setup is the separate service allowed to download files.

Open the app at <http://127.0.0.1:4318>, select **Enable voice**, and allow microphone access. Once it says **Listening for ‘Hey Dev Team’**, say the phrase followed by your request. Pause for about 1.2 seconds to finish; the request is limited to 30 seconds. The transcript appears below the voice controls. **Turn off microphone** stops capture and releases the microphone. Listening starts only through that button and requires the app to stay open.

Say “Hey Dev Team. Architect, what is blocking progress?” to ask that agent, or “Hey Dev Team. What should we focus on?” to ask the Project Manager for the team. Clear questions are sent automatically. Unknown recipients or unclear wording open an editable question and recipient selector. Configure the recipient's Codex planning harness and supported OpenAI or Bedrock model first. Questions use a separate read-only worker with a timestamped snapshot of recorded tasks, dependencies, active runs, and pending approvals; they do not inspect a busy agent's live working copy. They cannot create plans, change standing directives or context, or interrupt tasks.

Accepted question text and answers are saved in that agent's conversation history. Listening pauses while a question is being clarified or answered and resumes afterward. If the connection drops, **Retry question** reconnects using the same request ID, so a lost response does not create duplicate work. Terminal failed or cancelled questions are not restarted by retries. Each agent can answer one question at a time alongside its existing work. The text chat also provides **Ask question — work continues**; **Send guidance** explicitly stops and restarts the active stage.

Work requests and instructions open an editable action form. **Review action** shows the exact recipient, instruction, and effect; a separate **Confirm** button applies that reviewed action. Examples:

- “Hey Dev Team. Frontend, build a settings page.” requests a new plan from the Project Manager for the named role. It still requires plan approval before execution.
- “Hey Dev Team. Backend, for your current task, keep the API backwards compatible.” selects task guidance. Review the running task before confirming; if its run changes after review, the request is rejected without interrupting the replacement.
- “Hey Dev Team. Team, from now on always document relevant tests.” saves the instruction for all ten agents. Name an agent to restrict its scope. Instructions apply to future conversations and task stages, including verification and release; existing workers retain their original instructions.
- “Hey Dev Team. Team, remove the instruction to always document relevant tests.” opens removal. Select the exact saved instruction and review its recipients before confirming.

Standing instructions are saved without a model call. New work uses the existing Project Manager worker, and guidance uses the existing cancellation/recovery workflow. Integration approvals still apply. Retrying a lost response reuses the original action; it cannot save instructions twice, launch a second planner, or redirect a replacement run. Reviewed actions are stored on the server, with their ID remembered in the browser so a reload can restore the review or result. If the app restarts during dispatch, it marks the action interrupted and does not replay it automatically: inspect the conversation and task recovery before making another request. Guidance saved before an uncertain worker stop remains available through the task's Resume workflow control.

Audio stays on the machine, is processed in memory, and is not saved to the database or recordings. Wake detection and transcription need no speech accounts, API keys, or cloud fallback. Accepted text goes to the agent's configured model provider, which may be remote. Unreviewed clarification drafts remain only in the current page. Reviewed actions and accepted text are durable. Turning off the microphone releases capture; an already accepted question continues and can be cancelled separately on the agent card.

The initial implementation uses a fixed English wake phrase, an English transcription model, and a simple local silence threshold. Accents, microphone quality, background noise, and technical names need testing on your hardware; recognition is not guaranteed to be exact. GPU acceleration, spoken responses, adjustable microphone/sensitivity settings, and browser-closed listening are future work. See the **Voice milestones** in [the project plan](ENGINEERING_TEAM_PLAN.md#voice-milestones).

To stop the speech service:

```bash
docker compose --profile voice stop speech
```

Audio unit tests and API regression tests run with `npm test`. An opt-in real browser/model smoke test is in `scripts/voice-browser-smoke.mjs`; it requires Playwright, a running isolated app with local speech enabled, and `VOICE_TEST_AUDIO` pointing to a WAV containing initial silence, “Hey Dev Team. Architect, what is blocking progress?”, and trailing silence. Set `VOICE_TEST_URL` to that app. This test blocks external browser requests, checks the real wake-to-transcript path, verifies exactly one routed question with a stubbed agent answer (no model-provider calls), and checks microphone cleanup. It supplements human microphone trials rather than measuring real-world wake accuracy. `scripts/voice-questions-browser-smoke.mjs` separately checks routing, clarification, history, lost-response retries, task visibility, and typed questions with deterministic speech inputs; use an isolated app with all roles configured, a running Backend Developer task, and a test consultation executor. After `npm run build`, start the supplied disposable fixture with `node scripts/voice-question-fixture.mjs`, then run `VOICE_TEST_URL=http://127.0.0.1:14318 node scripts/voice-questions-browser-smoke.mjs` with Playwright installed. Stop the fixture with Ctrl-C to remove its temporary database. `scripts/voice-commands-browser-smoke.mjs` uses that same fixture to check V3 review, confirmation, reload recovery, team/role directives, plan approval, and task guidance. These browser scripts do not call a paid agent model.

### Service commands

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

This runs the database, API, and microphone audio tests, TypeScript typecheck, and production web/server build.

## Stop and update

```bash
docker compose down
docker compose up --build --detach
```

Rebuilding does not remove the persistent SQLite volume.
