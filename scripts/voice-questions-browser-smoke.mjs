// Opt-in V2 browser test. Use ONLY an isolated app with all roles configured,
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
const errors = [], submissions = [], mutations = [];
page.on("pageerror", error => errors.push(error.message));
page.on("request", request => {
  if (request.method() !== "POST") return;
  const path = new URL(request.url()).pathname; mutations.push(path);
  if (path.endsWith("/questions")) submissions.push({ path, body: request.postDataJSON() });
});
let transcript = "Backend, what is blocking progress?";
await page.route("**/api/voice/status", route => route.fulfill({ json: { ready: true } }));
await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: transcript } }));
try {
  await page.goto(url);
  const panel = page.locator(".voice-panel");
  await page.getByRole("button", { name: "Enable voice", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".voice-controls strong")?.textContent.startsWith("Listening for"));
  mutations.length = 0;
  await page.evaluate(() => window.__say());
  await page.getByText("Also answering your question", { exact: true }).waitFor();
  const backend = page.locator(".agent-card").filter({ has: page.getByText("Backend Developer", { exact: true }) });
  assert.match(await backend.innerText(), /Build the backend/);
  assert.match(await panel.innerText(), /Listening paused/);
  await page.evaluate(() => window.__say()); // Frames while answering must not create a second utterance.
  assert.equal(submissions.length, 1);
  await panel.locator(".voice-answer").waitFor();
  assert.match(await panel.locator(".voice-answer").innerText(), /backend_developer/);
  await panel.getByRole("button", { name: "Open conversation" }).click();
  await page.locator(".message-list").getByText("what is blocking progress?", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Conversation mode").inputValue(), "question");
  await page.getByRole("button", { name: "Close agent panel" }).click();

  // Unknown name requires recipient selection and editable text; nothing auto-sends.
  transcript = "Sam, what is next?";
  await page.evaluate(() => window.__say());
  await panel.getByLabel("Question recipient").waitFor();
  assert.equal(await panel.getByLabel("Question recipient").inputValue(), "");
  assert.equal(submissions.length, 1);
  await panel.getByLabel("Question recipient").selectOption("architect");
  await panel.getByLabel("Voice action").selectOption("question");
  await panel.getByLabel("Voice question").fill("What is next?");
  await panel.getByRole("button", { name: "Ask question", exact: true }).click();
  await panel.locator(".voice-answer").waitFor();
  assert.match(await panel.locator(".voice-answer").innerText(), /architect/);

  // Team questions go to the PM. Lose the first POST response after the server
  // accepts it, then retry: same ID, one saved transcript and one agent reply.
  transcript = "Team, what should we focus on?";
  let lost = false;
  await page.route("**/agents/project_manager/questions", async route => {
    if (!lost) { lost = true; await route.fetch(); await route.abort("connectionreset"); }
    else await route.continue();
  });
  await page.evaluate(() => window.__say());
  await panel.getByRole("button", { name: "Retry question" }).click();
  await panel.locator(".voice-answer").waitFor();
  assert.equal(submissions.length, 4);
  assert.equal(submissions[2].body.requestId, submissions[3].body.requestId);
  assert.match(submissions[2].path, /project_manager\/questions$/);
  await panel.getByRole("button", { name: "Open conversation" }).click();
  assert.equal(await page.locator(".message-list").getByText("what should we focus on?", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "Close agent panel" }).click();

  transcript = "Backend, fix the API";
  await page.evaluate(() => window.__say());
  await panel.getByLabel("Voice question").waitFor();
  assert.equal(submissions.length, 4);
  assert.match(await panel.innerText(), /propose a plan for approval/);
  await panel.getByRole("button", { name: "Discard transcript" }).click();
  await page.getByRole("button", { name: "Turn off microphone" }).click();
  assert.equal(await page.evaluate(() => window.__tracks.every(track => track.readyState === "ended")), true);

  // Typed questions use the same non-interrupting path; guidance stays explicit.
  await backend.locator(".agent-card-main").click();
  assert.equal(await page.getByLabel("Conversation mode").inputValue(), "question");
  await page.locator(".chat-composer textarea").fill("How is the backend progressing?");
  await page.locator(".chat-composer").getByRole("button", { name: "Ask question" }).click();
  await page.locator(".message-list").getByText("How is the backend progressing?", { exact: true }).waitFor();
  assert.equal(submissions.at(-1).body.source, "text");
  assert.equal(mutations.some(path => /\/(redirect|messages|cancel)$/.test(path)), false);
  assert.match(await backend.innerText(), /Build the backend/);
  assert.deepEqual(errors, []);
  if (process.env.VOICE_SCREENSHOT) await page.screenshot({ path: process.env.VOICE_SCREENSHOT, fullPage: true });
  console.log("PASS: busy-agent questions, task visibility, clarification, team routing, retry deduplication, history, typed questions, pause/resume and microphone cleanup.");
} catch (error) {
  console.error(await page.locator(".voice-panel").innerText().catch(() => "No voice panel"));
  throw error;
} finally { await browser.close(); }
