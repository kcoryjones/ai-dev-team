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

Additional executable provider adapters beyond OpenAI and Amazon Bedrock, native Project Manager worker-event streaming, and broader voice validation are the next product layers. Local voice supports wake-word capture, questions and follow-ups, reviewed work requests, task guidance, standing instructions, optional local spoken replies, and microphone/playback controls. Conversations and planning remain read-only: agents can inspect isolated clones and advise or propose work, but they cannot change source code outside an approved task run.

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

For a fresh installation, create `.env` and generate a random controller secret using Docker:

```bash
cp .env.example .env
docker run --rm --network none node:22-bookworm-slim node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Paste the generated value after `ENGINEERING_TEAM_CONTROLLER_TOKEN=` in `.env`, then start the application:

```bash
docker compose up --build --detach
```

Compose supplies this secret to both the API and controller. The controller refuses to start with a missing, empty, or whitespace-only secret and requires authentication on every endpoint, including health checks. Existing installations should add the token to their current `.env` before running Compose commands; keep an existing token when upgrading. When starting the API and controller outside Compose, export the same `ENGINEERING_TEAM_CONTROLLER_TOKEN` in both processes.

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
7. If a required gate fails, the implementation agent receives the findings and all required gates rerun after each successful repair. Settings → Execution defaults → **Automatic repair attempts** caps these repair passes for future runs, from zero (disabled) to five; the default is one. The same ticket stays in progress throughout; no review tickets are created. This setting controls verification repairs; provider fallback is configured separately.
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

All planning, consultation, and task workers have external networking disabled. Model access uses the controller's provider socket; workers cannot directly reach the internet, host services, other containers, or cloud metadata endpoints. Dependencies required for checks must already be supplied in the worker image or checkout because package downloads are blocked by the model-provider-only policy.

The controller allows two concurrent workers by default, shared across all projects, planning, questions, implementation, repairs, verification, release assessments, and harness probes. Set `ENGINEERING_TEAM_MAX_WORKERS` in `.env` to a positive integer and recreate the controller to change the limit. Additional requests receive a busy response and can be retried after a worker finishes; they are not automatically queued. A busy controller does not trigger provider fallback or automatic code repairs.

Slots remain occupied through repository preparation, execution, and cleanup. Cancellation or a disconnected caller prevents pending workers from starting and removes active containers. If removal cannot be confirmed, new runs are blocked while cleanup retries every five seconds. Before accepting requests after a restart, the controller removes leftover containers labeled for its worktree volume. Use one controller per worktree volume; separate application stacks have independent limits.

Token usage and any reported costs remain available as run evidence, without token or spending caps. Project settings contain no token or cost targets. Database upgrades remove the retired settings columns; historical run records remain intact.

Planning, consultation, and coding workers use a per-run Unix socket to reach a provider proxy in the trusted controller. ChatGPT tokens, API keys, and AWS credentials never enter worker mounts or process environments. The worker's Codex home is an empty temporary filesystem. The proxy permits only model discovery, Responses, and compaction requests to the selected provider; it signs or authenticates requests in the controller, rejects redirects, and closes when the run ends. Refreshed ChatGPT tokens are cached at `/provider-auth` in the persistent `engineering-team-provider-auth` volume, mounted only by the controller, with directory mode `0700` and file mode `0600`. Replacing the configured host auth file starts a new credential cache. Repository commands can use their run's model proxy while it is active, so this boundary protects credentials but does not enforce a token or spending budget.

## Operate it

### Local voice control (V1–V4.4)

Start the optional voice profile on the developer's own machine:

```bash
docker compose --profile voice up --build --detach
```

The first build compiles pinned sherpa-onnx browser keyword spotting and whisper.cpp CPU transcription engines. Setup downloads a checksum-verified English `base.en` transcription model (148 MB) into the `engineering-team-speech-models` volume and an English LJSpeech synthesis model (67 MB download) into `engineering-team-tts-models`. Subsequent starts reuse them, including offline starts after the images and models have been installed. Speech runtimes have no published ports and run on an internal Docker network without internet access. Separate model-setup services can download files and initialize fresh volumes; runtime services use the models read-only as an unprivileged user.

Open the app at <http://127.0.0.1:4318>, select **Enable voice**, and allow microphone access. Once it says **Listening for ‘Hey Dev Team’**, say the phrase followed by your request. Pause for about 1.2 seconds to finish; the request is limited to 30 seconds. The transcript appears below the voice controls. **Turn off microphone** stops capture and releases the microphone. Listening starts only through that button and requires the app to stay open.

Say “Hey Dev Team. Architect, what is blocking progress?” to ask that agent. For a new conversation, “Hey Dev Team. What should we focus on?” asks the Project Manager for the team. During an active follow-up window, unnamed questions stay with the displayed agent; naming another role or saying “Team” selects that recipient explicitly. Clear questions are sent automatically. Unknown recipients or unclear wording open an editable question and recipient selector. Configure the recipient's Codex planning harness and supported OpenAI or Bedrock model first. Questions use a separate read-only worker with a timestamped snapshot of recorded tasks, dependencies, active runs, and pending approvals; they do not inspect a busy agent's live working copy. They cannot create plans, change standing directives or context, or interrupt tasks.

Accepted question text and answers are saved in that agent's conversation history. Listening pauses while a question is being clarified or answered and resumes afterward. If the connection drops, **Retry question** reconnects using the same request ID, so a lost response does not create duplicate work. Terminal failed or cancelled questions are not restarted by retries. Each agent can answer one question at a time alongside its existing work. The text chat also provides **Ask question — work continues**; **Send guidance** explicitly stops and restarts the active stage.

Work requests and instructions open an editable action form. **Review action** shows the exact recipient, instruction, and effect; a separate **Confirm** button applies that reviewed action. Examples:

- “Hey Dev Team. Frontend, build a settings page.” requests a new plan from the Project Manager for the named role. It still requires plan approval before execution.
- “Hey Dev Team. Backend, for your current task, keep the API backwards compatible.” selects task guidance. Review the running task before confirming; if its run changes after review, the request is rejected without interrupting the replacement.
- “Hey Dev Team. Team, from now on always document relevant tests.” saves the instruction for all ten agents. Name an agent to restrict its scope. Instructions apply to future conversations and task stages, including verification and release; existing workers retain their original instructions.
- “Hey Dev Team. Team, remove the instruction to always document relevant tests.” opens removal. Select the exact saved instruction and review its recipients before confirming.

Standing instructions are saved without a model call. New work uses the existing Project Manager worker, and guidance uses the existing cancellation/recovery workflow. Integration approvals still apply. Retrying a lost response reuses the original action; it cannot save instructions twice, launch a second planner, or redirect a replacement run. Reviewed actions are stored on the server, with their ID remembered in the browser so a reload can restore the review or result. If the app restarts during dispatch, it marks the action interrupted and does not replay it automatically: inspect the conversation and task recovery before making another request. Guidance saved before an uncertain worker stop remains available through the task's Resume workflow control.

Audio stays on the machine, is processed in memory, and is not saved to the database or recordings. Wake detection and transcription need no speech accounts, API keys, or cloud fallback. Accepted text goes to the agent's configured model provider, which may be remote. Unreviewed clarification drafts remain only in the current page. Reviewed actions and accepted text are durable. Turning off the microphone releases capture; an already accepted question continues and can be cancelled separately on the agent card.

The implementation uses a fixed English wake phrase, an English transcription model, and an adjustable local silence threshold. Accents, microphone quality, background noise, and technical names need testing on your hardware; recognition is not guaranteed to be exact. GPU acceleration and browser-closed listening remain future work. See the **Voice milestones** in [the project plan](ENGINEERING_TEAM_PLAN.md#voice-milestones).

To stop the speech services:

```bash
docker compose --profile voice stop speech tts
```

Audio unit tests and API regression tests run with `npm test`. An opt-in real browser/model smoke test is in `scripts/voice-browser-smoke.mjs`; it requires Playwright, a running isolated app with local speech enabled, and `VOICE_TEST_AUDIO` pointing to a WAV containing initial silence, “Hey Dev Team. Architect, what is blocking progress?”, and trailing silence. Set `VOICE_TEST_URL` to that app. This test blocks external browser requests, checks the real wake-to-transcript path, verifies exactly one routed question with a stubbed agent answer (no model-provider calls), and checks microphone cleanup. It supplements human microphone trials rather than measuring real-world wake accuracy. `scripts/voice-questions-browser-smoke.mjs` separately checks routing, clarification, history, lost-response retries, task visibility, and typed questions with deterministic speech inputs; use an isolated app with all roles configured, a running Backend Developer task, and a test consultation executor. After `npm run build`, start the supplied disposable fixture with `node scripts/voice-question-fixture.mjs`, then run `VOICE_TEST_URL=http://127.0.0.1:14318 node scripts/voice-questions-browser-smoke.mjs` with Playwright installed. Stop the fixture with Ctrl-C to remove its temporary database. `scripts/voice-commands-browser-smoke.mjs` uses that same fixture to check V3 review, confirmation, reload recovery, team/role directives, plan approval, and task guidance. These browser scripts do not call a paid agent model.

### Local speech output backend (V4.1)

The voice profile includes a CPU-only `tts` service. Its Node 22 image pins `sherpa-onnx-node` and its Linux native packages to 1.13.8 using a separate lockfile in `docker/tts`. This version includes the phonemizer expected by the selected Piper model; upgrading to 2.x requires revisiting that integration. The [upstream model archive](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-ljspeech-medium.tar.bz2) is SHA-256 pinned in `docker/download-tts-model.sh`. Setup retains the upstream `MODEL_CARD` (which identifies public-domain source recordings) and checks a file manifest on cached starts. The model remains loaded between successful requests.

`GET /api/voice/tts/status` reports availability and the installed voice. `POST /api/voice/tts/synthesize` accepts JSON with `text`, optional `voice: "en_US-ljspeech-medium"`, and optional numeric `speed` from 0.75 to 1.5 (default 1), returning mono 22,050 Hz, 16-bit PCM WAV. Requests are limited to 2,000 characters and 16 KiB; output is limited to 90 seconds. One synthesis can run at a time across app instances, with busy responses using HTTP 429. Native generation has a 45-second deadline and the HTTP route a 60-second deadline. Disconnecting the caller stops the native worker; capacity stays occupied until cleanup and model reload finish. An idle worker crash is also recovered. Text and audio stay in memory, responses use `Cache-Control: no-store`, and there is no cloud fallback. TTS availability is separate from microphone/transcription availability.

To check the backend with its actual cached model:

```bash
docker compose --profile voice exec -T -e TTS_TEST_VERIFY_WORKER=1 tts node --input-type=module < scripts/tts-service-smoke.mjs
TTS_TEST_URL=http://127.0.0.1:4318/api/voice/tts node scripts/tts-service-smoke.mjs
```

The first command also verifies native-process replacement after cancellation and idle crashes. Run it when speech output is idle. These checks make no agent-provider requests. Compose defaults to a 2-CPU synthesis quota and a 4-CPU transcription quota, with 2 GiB memory and 128 PIDs per speech service. On a local Docker host that reports no CPU quota support, set `ENGINEERING_TEAM_SPEECH_CPUS=0` and `ENGINEERING_TEAM_TTS_CPUS=0` in `.env`, then recreate the same stack. Zero disables those CPU quotas; it does not restore missing host support for memory or PID enforcement. The speech engines still use their configured thread counts and the controller retains its worker concurrency limit. Keep the default quotas on hosts that support them. Set `COMPOSE_PROFILES=voice` in `.env` to include voice in ordinary `docker compose up --build --detach` commands. Native development may set `ENGINEERING_TEAM_TTS_URL` to a separately started service on loopback; Compose supplies the internal URL automatically.

### Spoken replies (V4.2)

Check **Speak replies** in the voice panel to hear newly completed voice answers and short acknowledgements for confirmed actions. All agents share the installed English voice; question replies begin with the agent's name. Speech defaults to off for each page session. Enabling it does not read an existing answer, and restored action receipts stay silent after reload. The full answer and action result remain visible even if synthesis or playback fails.

**Replay reply** speaks the latest reply on demand, including when automatic speech or the microphone is off. **Stop speaking** or **Escape** cancels speech preparation or playback; it does not cancel an agent's work. Turning off **Speak replies**, clearing the current request, hiding/leaving the page, or changing projects also stops playback. Failed or cancelled questions and unconfirmed actions never receive automatic speech. Retrying a lost action response can acknowledge it once; speech failures require an explicit Replay rather than an automatic retry.

Wake listening pauses while speech is prepared and played. After playback or interruption, a 400 ms settling period drops speaker-tail audio, then capture/resampler and wake-detector buffers reset before listening resumes. Stale queued frames and wake results cannot trigger a new request. If the microphone was turned off, it stays off. Long answers use a bounded prose excerpt (up to 120 words and 850 characters before the role and notice); fenced code and raw URLs stay on screen. A notice identifies shortened spoken replies. No extra model call is used to summarize text.

The browser's audio context is initialized from the checkbox or Replay click, following [Web Audio playback guidance](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices). Browser playback restrictions or an unavailable local TTS service show a separate speech error and leave the answer readable. Additional voices remain future work; broader room-noise/device testing is V4.5.

`scripts/voice-replies-browser-smoke.mjs` tests actual browser audio playback with deterministic microphone/wake inputs and the disposable agent fixture. Set `VOICE_TEST_TTS_AUDIO` to a locally generated WAV, or start `scripts/voice-question-fixture.mjs` with `VOICE_TEST_TTS_URL` pointing to a local TTS service and run the browser script with `VOICE_TEST_REAL_TTS=1`. `VOICE_TEST_URL` selects the fixture, and `VOICE_PLAYWRIGHT_MODULE` optionally locates an external Playwright installation. The script checks opt-in behavior, natural completion, Stop/Escape, late responses, stale microphone frames, failed/cancelled questions, action-review gating, retry deduplication, reload silence, and microphone cleanup without paid model calls. To exercise real wake detection and Whisper as well, configure the fixture's `VOICE_TEST_SPEECH_URL` and run `scripts/voice-browser-smoke.mjs` with recorded `VOICE_TEST_AUDIO` and `VOICE_TEST_SPOKEN_REPLY=1`.

### Voice follow-ups (V4.3)

After a voice answer completes while the microphone is enabled, the panel shows its agent and a two-minute countdown. During that window, say “Hey Dev Team. And why?” or “Hey Dev Team. What about the tests?” to continue with that agent. Repeat the wake phrase for each question. Explicitly naming another agent or saying “Team” overrides the remembered recipient; a different recipient starts a fresh conversation. Each completed answer renews the window.

**New conversation** stops current speech playback and clears follow-up context without cancelling an accepted question or deleting saved history. A late answer or retry cannot undo that reset. Clearing the request, turning off or losing the microphone, changing projects, reloading, or starting an action also resets the context. Once the window expires, unnamed new questions default to the Project Manager; ambiguous fragments still require clarification. Failed/cancelled answers do not establish a new window. Spoken-reply playback does not extend expiry.

Follow-ups carry at most three earlier question-and-answer pairs, with each earlier message capped at 2,000 characters. The current question is included separately. The server reads this history from saved question receipts for the same project and agent. Fresh voice questions omit previous conversation history while retaining configured project context, standing instructions, and the current activity snapshot. Typed-chat history behavior is unchanged.

Question requests may include `followUpTo`, the prior voice request ID. Migration 30 adds the durable parent link. The server accepts new follow-ups only while the prior voice answer is completed and unexpired, and rejects other projects, other agents, typed questions, and unfinished/failed answers. Request retries preserve the same parent and remain idempotent after expiry. A rejected context offers **Review as new question**; the app never silently drops the context and resubmits.

Work requests and standing instructions continue through their existing recipient selection and explicit reviews; they do not inherit question history. “Yes”, “Do that”, and “Go ahead” require clarification and cannot authorize work. Plan, integration, and task-guidance approval behavior is unchanged.

For an isolated browser check, run `VOICE_TEST_FOLLOW_UP_CONTEXT=1 node scripts/voice-question-fixture.mjs` after building, then `node scripts/voice-follow-ups-browser-smoke.mjs` with Playwright available. The fixture uses a temporary database and simulated agent answers. Tests cover recipient/history continuity, explicit overrides, expiry, rejection recovery, lost-response retries, reset races, microphone shutdown, reload, and preserved action gates. The normal `npm test` suite covers migration, server-side admission and history bounds, and client routing.

### Voice controls and tuning (V4.4)

Open **Voice settings** in the voice panel. Preferences are saved only in this browser and apply across projects. They never enable listening or spoken replies automatically.

- **Microphone:** choose System default or a specific input while the microphone is off. [Device labels depend on microphone permission](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices); enable once to grant permission, then turn capture off to change devices. An unavailable saved device produces a reconnect/default-device message rather than silently selecting another microphone. Unplugging an active input stops capture and clears follow-up context.
- **Pause to finish:** select 0.8, 1.2 (default), or 1.8 seconds. Use a longer pause if requests end before you finish speaking. The 30-second request cap remains in force.
- **Speech sensitivity:** High recognizes quieter speech; Low ignores more background noise when deciding whether a request has finished. Normal preserves the original threshold. These settings affect endpointing after the wake phrase, not the wake detector itself. Capture settings are locked while listening is enabled.
- **Speaking speed:** 0.75×–1.5×, applied to the next reply or Replay using the local synthesizer's [native speed parameter](https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/api_offline_tts.html). Changing it does not restart a reply already in preparation or playback.
- **Reply volume:** 0–100%, applied immediately through a browser gain node. Muting retains the same listening pause and Stop/Escape behavior. All agents currently share the one installed LJSpeech voice; additional or per-agent voices are not available yet.

The input meter runs while listening and shows level and clipping. The diagnostics also show the active microphone, audio-context sample rate, and reported input channels. Multichannel input is mixed to mono before resampling to 16 kHz. Start with Normal sensitivity and pause; speak at your usual distance, check for clipping, and try a headset or closer microphone in a noisy room. Human recognition accuracy, pronunciation, and speaker/headphone trials remain part of V4.5; automated fixtures cannot calibrate your physical microphone.

Rebuild both the app and TTS service when upgrading to V4.4; older TTS services reject the new `speed` field. `docker compose --profile voice up --build --detach` rebuilds the matching services using the local CPU quota settings described above.

After building, start the disposable fixture with `node scripts/voice-question-fixture.mjs`, then run `VOICE_TEST_TTS_AUDIO=/path/to/local-speech.wav node scripts/voice-settings-browser-smoke.mjs` with Playwright available. The browser test checks real device selection constraints, capture timing, diagnostics, speed requests, live volume, playback interlocks, saved preferences, removed devices, and microphone cleanup after late permission resolution. The backend smoke script also compares real model output at both speed limits, with networking disabled when run in an offline container. No paid model requests are needed.

### Voice validation (V4.5 — automated checks passed; hardware trials pending)

The complete voice path passed in three Linux browser engines on 2026-11-09. These are the exact bundled Playwright 1.56.1 versions tested, not a claim that current Chrome, Edge, Safari, or every desktop OS has been validated. In particular, [Playwright WebKit is a test build, not the Safari application](https://playwright.dev/docs/browsers#webkit).

| Browser engine | Full voice flow | Transcription API | Synthesis API | Escape → listening |
| --- | --- | --- | --- | --- |
| Chromium 141.0.7390.37 | Passed | 1.43 s | 0.70 s | 0.42 s |
| Firefox 142.0.1 | Passed | 1.05 s | 0.39 s | 0.41 s |
| WebKit 26.0 | Passed | 1.59 s | 0.81 s | 0.42 s |

These single-run timings came from an Intel Core Ultra 7 265U host, using four Whisper threads and two synthesis threads, with a fixed three-second simulated agent response. They are integration measurements, not hardware performance guarantees. Wake detection took approximately 1.2 seconds from the start of the recorded phrase. CPU inference is verified; GPU acceleration is not implemented or validated.

The test keeps the real AudioWorklet, resampling, WASM wake detector, Whisper service, question routes/receipts, local synthesis, and browser playback. Only the physical microphone source and agent executor are substituted. It checks speech without a wake phrase, exactly one question per utterance, feedback of the actual spoken reply, feedback of a known wake-positive recording during Replay, a 120 ms simulated audio tail, Escape, microphone release, reopening capture, and a repeat with deterministic low-level noise. The identical positive recording must wake when listening resumes. Tasks, directives, and approval state must remain unchanged. The generated voice itself was not recognized reliably as a wake-positive control, which is why the known recording is also required. This is not a measurement of wake accuracy with human voices or real room noise.

Both services started using verified cached models on an internal Docker network with no internet access. Browser requests outside the app origin were blocked. The app's optional Google Fonts request was blocked too; fallback fonts worked. No cloud speech or paid agent requests were made. Microphone startup now times out after five seconds if the browser audio backend never starts, closes its audio context, and allows retry; a separate browser check verifies cancellation and late completion cannot acquire the microphone afterward.

To reproduce the full test, build the project and run the disposable fixture with loopback URLs for separately started local speech services:

```bash
VOICE_TEST_SPEECH_URL=http://127.0.0.1:14320 \
VOICE_TEST_TTS_URL=http://127.0.0.1:14321 \
VOICE_TEST_ECHO_REPLY=1 node scripts/voice-question-fixture.mjs
```

The fixture at `http://127.0.0.1:14318` uses its own temporary repository/database and simulated agents. Its answer deliberately contains the wake phrase for feedback testing. Stop it with Ctrl-C to delete its test data. Use an isolated fixture, not your real project, for automated tests. In another terminal, with Playwright and the matching browsers installed:

```bash
VOICE_TEST_BROWSER=chromium \
VOICE_TEST_AUDIO=/path/to/wake-question.wav \
VOICE_TEST_NEGATIVE_AUDIO=/path/to/speech-without-wake.wav \
VOICE_TEST_REPORT=/tmp/voice-chromium.json \
node scripts/voice-end-to-end-browser.mjs
```

Repeat with `firefox` and `webkit`. The positive WAV should contain “Hey Dev Team. Architect, what is blocking progress?” and the negative WAV ordinary speech without the wake phrase. `VOICE_PLAYWRIGHT_MODULE` can locate a separate Playwright installation. `scripts/voice-startup-browser-smoke.mjs` checks audio-startup failure and cleanup against the same fixture without speech models. Headless Linux environments without an audio device can build `docker/voice-test.Dockerfile`; its entrypoint starts a virtual PulseAudio output for the real browser audio engine. This test image is separate from the app and speech images. The cached test services on this host ran temporarily without resource quotas because the host cannot enforce the configured limits; normal Compose limits remain unchanged.

For the remaining hands-on trial, use your actual desktop browser and record its version, OS, microphone, output device, and voice settings:

1. Start with headphones. Enable voice and Speak replies. Try ten named/team questions at your normal speaking distance. Record missed wakes, transcription errors, wrong recipients, and time to hear the answer. Each utterance should produce one question and one reply.
2. Say “Hey Dev Team. And why?” after an Architect answer, then use **New conversation** and ask an unnamed question. Confirm the displayed recipient and follow-up reset. Spoken acknowledgements such as “Do that” must still require review.
3. Repeat with speakers at your usual volume, including replies containing “Hey Dev Team”. Let some replies finish; interrupt others with Stop/Escape. Leave a short quiet interval after each. Playback and its tail must not submit another request, and turning off the microphone must keep it off.
4. Repeat several phrases with ordinary keyboard/fan/room noise, then speak without the wake phrase. Record false wakes and requests that end too early or never finish. Adjust sensitivity/pause using the input meter, and repeat under the same conditions.
5. Deny permission, unplug/reconnect the microphone, and reload the page. Check actionable errors, released microphone indicators, saved settings, and listening/spoken replies remaining off after reload.
6. After models are installed, disconnect internet access and repeat using the simulated-agent fixture. Speech should continue locally; real remote agent providers are not expected to work offline. Before closing V4.5, also listen to a real agent answer with spoken playback in the updated application using your local Docker configuration.

The live upgrade was completed on 2026-11-09: one Compose stack serves the latest application and real agents at `http://localhost:4318`, with transcription and synthesis included. The temporary app and service forwarders on ports 14318, 14320, and 14321 were stopped. A real Architect question and synthesis of its answer passed; project data and credentials were retained. Test fixtures remain opt-in tools and should be stopped after testing. Keep V4.5 open for the remaining physical-device trials: the automated engine matrix does not certify headphone/speaker acoustics, human recognition accuracy, or native Windows/macOS browser behavior.

### Service commands

```bash
docker compose ps
docker compose logs --follow app controller
docker compose restart app
docker compose down
```

The SQLite database is stored at `/data/engineering-team.db` in the `engineering-team-data` named volume. `docker compose down` preserves named volumes, including the controller's refreshed credentials. Running `docker compose down --volumes` permanently deletes the application database, worktrees, cached provider credentials, and downloaded speech models.

## Verify the source

The verification image contains all development dependencies, so tests require only Docker:

```bash
docker compose --profile test run --rm test
```

This runs the database, API, and microphone audio tests, TypeScript typecheck, and production web/server build.

With development dependencies installed on the host and the controller image built, run `ENGINEERING_TEAM_TEST_DOCKER_IMAGE=local/engineering-team-controller:latest npm test` to include real Docker checks for network isolation, worker cleanup and restart recovery, and credential persistence across container recreation. These use disposable containers, a temporary named volume, and fake providers; they make no paid model calls.

## Stop and update

When upgrading from the version that cached credentials in `/tmp/engineering-team-provider-auth`, first let all active workers finish and avoid starting new runs until the update completes. While the old controller is still running, export its temporary cache into the existing persistent worktree volume:

```bash
docker compose exec -T controller node --input-type=module < scripts/preserve-controller-auth.mjs
```

The helper prints only the number of preserved entries, never credentials. It does nothing when no temporary cache exists. The new controller automatically imports matching legacy entries into its private volume, preferring existing private entries over migration copies. Older `/worktrees/.provider-auth` caches are imported automatically. If the temporary-cache controller has already stopped or been recreated, its lost rotated credentials cannot be recovered by this helper; signing in again may be necessary.

After exporting any temporary credentials, update normally:

```bash
docker compose down
docker compose up --build --detach
```

Rebuilding preserves both the SQLite and provider-credential volumes. A controller run outside Compose must also keep `ENGINEERING_TEAM_PROVIDER_AUTH_ROOT` (default `/provider-auth`) on persistent, controller-only storage.
