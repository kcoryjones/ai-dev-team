// Opt-in V3 browser test. Use ONLY an isolated app with all roles configured,
// a running Backend Developer task, and a test consultation executor (no paid model).
// Start that fixture with: node scripts/voice-question-fixture.mjs
// Speech inputs are deterministic stubs; voice-browser-smoke.mjs covers real speech models.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.VOICE_PLAYWRIGHT_MODULE || "playwright");
const url = process.env.VOICE_TEST_URL || "http://127.0.0.1:14318";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 1000 } });
await context.route("**/*", route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
await context.addInitScript(() => {
  window.__tracks = [];
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => {
    const stream = await getUserMedia(constraints); window.__tracks.push(...stream.getTracks()); return stream;
  };
  // Keep the actual LocalVoiceSession capture/endpoint/pause state machine, with
  // deterministic frames and wake results instead of platform audio timing.
  window.AudioContext = class {
    state = "running"; destination = {}; audioWorklet = { addModule: async () => {} };
    async resume() {} async close() { this.state = "closed"; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  };
  window.AudioWorkletNode = class {
    port = { onmessage: null, close() {} };
    constructor() { window.__capture = this; } connect() {} disconnect() {}
  };
  window.Worker = class {
    constructor() { queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } })); }
    postMessage(message) { if (message.type === "audio") queueMicrotask(() => this.onmessage?.({ data: { type: "processed", wake: true } })); }
    terminate() { this.onmessage = null; }
  };
  window.__say = async () => {
    const frame = level => window.__capture.port.onmessage({ data: new Float32Array(1600).fill(level) });
    frame(0.1); await new Promise(resolve => setTimeout(resolve, 0));
    for (let n = 0; n < 5; n++) frame(0.1);
    for (let n = 0; n < 13; n++) frame(0);
  };
});
const page = await context.newPage();
const errors = [], confirms = [];
page.on("pageerror", error => errors.push(error.message));
page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/confirm")) confirms.push(request.url()); });
let transcript = "Team, from now on always document relevant tests.";
await page.route("**/api/voice/status", route => route.fulfill({ json: { ready: true } }));
await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: transcript } }));
const panel = page.locator(".voice-panel");
async function listen() {
  await page.getByRole("button", { name: "Enable voice", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".voice-controls strong")?.textContent.startsWith("Listening for"));
}
async function say(text) {
  transcript = text;
  await page.evaluate(() => window.__say());
  await panel.getByRole("button", { name: "Review action", exact: true }).waitFor();
}
let projectId;
const state = async () => (await (await page.request.get(`${url}/api/projects/${projectId}/orchestration`)).json()).state;
try {
  await page.goto(url);
  await page.getByRole("button", { name: "Enable voice", exact: true }).waitFor();
  projectId = (await (await page.request.get(`${url}/api/projects`)).json()).projects[0].id;
  const initial = await state(), activeTask = initial.activeRuns.find(run => run.taskId);
  await listen(); await say(transcript);
  assert.equal(await panel.getByLabel("Voice action").inputValue(), "directive_add");
  assert.equal(await panel.getByLabel("Question recipient").inputValue(), "team");
  assert.equal((await state()).directives.length, 0);
  await panel.getByRole("button", { name: "Review action" }).click();
  await panel.getByRole("button", { name: "Confirm save standing instruction" }).waitFor();
  assert.equal((await state()).directives.length, 0);
  assert.equal(confirms.length, 0);
  assert.match(await panel.innerText(), /future turns and task stages/);
  // Review survives a page reload, still requiring an explicit click.
  await page.reload();
  await panel.getByRole("button", { name: "Confirm save standing instruction" }).waitFor();
  assert.equal((await state()).directives.length, 0);
  let lost = false;
  await page.route("**/voice/commands/*/confirm", async route => {
    if (!lost) { lost = true; await route.fetch(); await route.abort("connectionreset"); }
    else await route.continue();
  });
  await panel.getByRole("button", { name: "Confirm save standing instruction" }).click();
  await panel.getByRole("button", { name: "Retry action" }).click();
  await panel.getByText(/Saved the standing instruction for 10 agents/).waitFor();
  assert.equal(confirms.length, 2); assert.equal(confirms[0], confirms[1]);
  assert.equal((await state()).directives.length, 10);
  assert((await state()).activeRuns.some(run => run.id === activeTask.id));
  await panel.getByRole("button", { name: "Clear request" }).click();
  await listen();

  await say("Architect, remember that public APIs must remain compatible.");
  await panel.getByRole("button", { name: "Review action" }).click();
  await panel.getByRole("button", { name: "Confirm save standing instruction" }).click();
  await panel.getByText(/Saved the standing instruction for 1 agent\./).waitFor();
  assert.equal((await state()).directives.filter(directive => directive.agentRole === "architect").length, 2);
  await panel.getByRole("button", { name: "Clear request" }).click();

  await say("Team, remove the instruction to always document relevant tests.");
  await panel.getByLabel("Saved instruction").selectOption("always document relevant tests.");
  await panel.getByRole("button", { name: "Review action" }).click();
  await panel.getByRole("button", { name: "Confirm remove standing instruction" }).click();
  await panel.getByText(/Removed the standing instruction for 10 agents/).waitFor();
  assert.equal((await state()).directives.length, 1);
  await panel.getByRole("button", { name: "Clear request" }).click();

  await say("Frontend, build a settings page.");
  assert.equal(await panel.getByLabel("Voice action").inputValue(), "new_work");
  await panel.getByRole("button", { name: "Review action" }).click();
  await panel.getByRole("button", { name: "Confirm request new work" }).waitFor();
  assert.match(await panel.innerText(), /Project Manager.*Frontend Developer/);
  await panel.getByRole("button", { name: "Confirm request new work" }).click();
  await panel.getByText(/Sent to the Project Manager/).waitFor();
  const planned = await state();
  assert(planned.approvals.some(approval => approval.status === "pending"));
  assert(planned.tasks.some(task => task.status === "draft"));
  assert(planned.activeRuns.some(run => run.id === activeTask.id));
  await panel.getByRole("button", { name: "Clear request" }).click();

  await say("Backend, for your current task, keep the API backwards compatible.");
  assert.equal(await panel.getByLabel("Voice action").inputValue(), "guidance");
  assert.equal(await panel.getByLabel("Running task").inputValue(), activeTask.taskId);
  await panel.getByRole("button", { name: "Review action" }).click();
  await panel.getByRole("button", { name: "Confirm guide a running task" }).waitFor();
  assert.match(await panel.innerText(), /Stop this worker and restart its current stage/);
  if (process.env.VOICE_SCREENSHOT) await page.screenshot({ path: process.env.VOICE_SCREENSHOT, fullPage: true });
  await panel.getByRole("button", { name: "Confirm guide a running task" }).click();
  await panel.getByText(/Guidance saved and the interrupted task stage restarted/).waitFor();
  const guided = await state();
  assert.equal(guided.runs.find(run => run.id === activeTask.id).status, "cancelled");
  assert(guided.integrationProposals.some(proposal => proposal.status === "pending"));
  await page.getByRole("button", { name: "Turn off microphone" }).click();
  assert.equal(await page.evaluate(() => window.__tracks.every(track => track.readyState === "ended")), true);
  assert.deepEqual(errors, []);
  console.log("PASS: reviewed actions, reload recovery, lost-response deduplication, team/role instructions, exact removal, approved planning flow, bound task guidance and microphone cleanup.");
} catch (error) { console.error(await panel.innerText().catch(() => "No voice panel")); throw error; }
finally { await browser.close(); }
