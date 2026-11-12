// Use a disposable voice-question-fixture with real local speech/TTS services
// and VOICE_TEST_ECHO_REPLY=1. Recorded input and the agent executor are fixtures;
// the browser audio pipeline, wake detection, transcription, receipts and TTS are real.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { installControlledMicrophone } from "./voice-controlled-microphone.mjs";
const playwright = await import(process.env.VOICE_PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.VOICE_TEST_BROWSER || "chromium";
if (!["chromium", "firefox", "webkit"].includes(engine)) throw new Error("Use chromium, firefox, or webkit.");
const url = process.env.VOICE_TEST_URL || "http://127.0.0.1:14318";
const positive = await readFile(process.env.VOICE_TEST_AUDIO);
const negative = await readFile(process.env.VOICE_TEST_NEGATIVE_AUDIO);
const browser = await playwright[engine].launch({ headless: true, ...(engine === "chromium" ? { args: ["--no-sandbox"] } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const blocked = [], errors = [], questions = [], transcriptions = [], syntheses = [], phases = [];
const started = performance.now();
await context.route("**/*", route => {
  if (new URL(route.request().url()).origin === new URL(url).origin) return route.continue();
  blocked.push(route.request().url()); return route.abort();
});
await context.addInitScript(installControlledMicrophone);
const page = await context.newPage();
page.setDefaultTimeout(65_000);
page.on("pageerror", error => errors.push(error.message));
page.on("request", request => {
  if (request.method() !== "POST") return;
  const path = new URL(request.url()).pathname, at = performance.now() - started;
  if (path.endsWith("/questions")) questions.push({ path, at, body: request.postDataJSON() });
  if (path === "/api/voice/transcribe") transcriptions.push({ at });
  if (path === "/api/voice/tts/synthesize") syntheses.push({ at, body: request.postDataJSON() });
});
page.on("response", response => {
  const path = new URL(response.url()).pathname;
  if (path === "/api/voice/transcribe") transcriptions.at(-1).responseAt = performance.now() - started;
  if (path === "/api/voice/tts/synthesize") syntheses.at(-1).responseAt = performance.now() - started;
});
const panel = page.locator(".voice-panel");
const listening = () => page.waitForFunction(() => document.querySelector(".voice-controls strong")?.textContent.startsWith("Listening for"));
const speaking = () => panel.getByText("Speaking reply…", { exact: true }).waitFor();
async function feed(bytes, noiseRms = 0) {
  return page.evaluate(({ base64, noiseRms }) => window.__feedVoice(base64, noiseRms), { base64: bytes.toString("base64"), noiseRms });
}
try {
  await page.goto(url);
  await panel.getByRole("button", { name: "Enable voice", exact: true }).waitFor();
  await page.exposeFunction("voicePhase", phase => phases.push({ phase, at: performance.now() - started }));
  await page.evaluate(() => {
    const element = document.querySelector(".voice-controls strong");
    new MutationObserver(() => window.voicePhase(element.textContent)).observe(element, { childList: true, subtree: true, characterData: true });
  });
  const projectId = (await (await page.request.get(`${url}/api/projects`)).json()).projects[0].id;
  const state = async () => (await (await page.request.get(`${url}/api/projects/${projectId}/orchestration`)).json()).state;
  const before = await state();
  await panel.getByLabel("Speak replies", { exact: true }).check();
  await panel.getByRole("button", { name: "Enable voice", exact: true }).click();
  await listening();
  console.log(`${engine}: local voice ready`);
  assert.equal(await panel.locator(".voice-error").count(), 0, await panel.innerText());

  const control = await feed(negative);
  await page.waitForTimeout((control.duration + 2) * 1000);
  assert.equal(transcriptions.length, 0, "speech without the wake phrase must not transcribe");
  console.log(`${engine}: negative control passed`);
  const inputAt = performance.now() - started;
  const positiveInput = await feed(positive);
  await speaking();
  console.log(`${engine}: real question and synthesized reply received`);
  assert.match(await panel.locator(".voice-transcript > p").first().innerText(), /architect.*progress/is);
  assert.equal(questions.length, 1); assert.match(questions[0].path, /\/architect\/questions$/);
  assert.equal(transcriptions.length, 1); assert.equal(syntheses.length, 1);
  assert.match(syntheses[0].body.text, /Hey Dev Team/);
  await listening();
  await page.waitForTimeout(2000);
  assert.equal(await page.evaluate(() => window.__voiceEchoCopies), 1);
  assert.equal(transcriptions.length, 1, "a reply containing the wake phrase must not wake its own listener");
  assert.equal(questions.length, 1);
  console.log(`${engine}: natural playback did not self-wake`);

  // Also inject a recording already proven to activate this detector. A
  // synthesized voice can be missed even when it contains the wake words;
  // real-reply feedback alone would therefore be an insufficient control.
  await page.evaluate(base64 => window.__setEchoControl(base64), positive.toString("base64"));
  await panel.getByRole("button", { name: "Replay reply", exact: true }).click(); await speaking();
  await page.waitForTimeout((positiveInput.duration + 0.25) * 1000);
  assert.equal(transcriptions.length, 1, "a known wake-positive recording must be ignored during playback");
  const interruptAt = performance.now(); await page.keyboard.press("Escape"); await listening();
  const interruptMs = performance.now() - interruptAt;
  await page.waitForTimeout(1800);
  assert.equal(questions.length, 1); assert.equal(transcriptions.length, 1);
  assert.equal(await page.evaluate(() => window.__voicePlaybacks.length), 2);

  // The identical control recording must wake after listening resumes.
  // Stop before dispatch so the control cannot create another question.
  await feed(positive);
  await panel.getByText("Listening to your request…", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Turn off microphone" }).click();
  await page.waitForFunction(() => window.__voiceTracks.every(track => track.readyState === "ended"));
  assert.equal(questions.length, 1);

  // Reopen capture, retaining preferences but clearing conversation context.
  // A modest deterministic noise mix is a repeatable integration check only.
  await panel.getByRole("button", { name: "Enable voice", exact: true }).click(); await listening();
  await feed(positive, 0.003);
  await speaking();
  assert.equal(questions.length, 2); assert.equal(questions[1].body.followUpTo, undefined);
  assert.equal(transcriptions.length, 2);
  await panel.getByRole("button", { name: /Stop speaking/ }).click(); await listening();
  await panel.getByRole("button", { name: "Turn off microphone" }).click();
  await page.waitForFunction(() => window.__voiceTracks.every(track => track.readyState === "ended"));
  const after = await state();
  assert.deepEqual(after.tasks, before.tasks); assert.deepEqual(after.directives, before.directives); assert.deepEqual(after.approvals, before.approvals);
  assert.deepEqual(errors, []);
  const firstCapture = phases.find(event => event.at >= inputAt && event.phase === "Listening to your request…");
  const firstSpeech = phases.find(event => event.at >= inputAt && event.phase === "Listening paused for speech");
  const result = { engine, browserVersion: browser.version(), passed: true, inputToWakeMs: Math.round(firstCapture.at - inputAt),
    transcriptionMs: Math.round(transcriptions[0].responseAt - transcriptions[0].at), synthesisMs: Math.round(syntheses[0].responseAt - syntheses[0].at),
    inputToSpeechPreparationMs: Math.round(firstSpeech.at - inputAt), interruptToListeningMs: Math.round(interruptMs),
    questions: questions.length, transcriptions: transcriptions.length, syntheses: syntheses.length, simulatedEcho: ["actual reply", "known wake-positive recording"], noiseRms: 0.003, blockedExternalRequests: blocked,
    limitations: "Controlled input and 3-second simulated agent answers; physical microphone permissions, speakers/headphones, room noise and GPU performance are not measured." };
  if (process.env.VOICE_TEST_REPORT) await writeFile(process.env.VOICE_TEST_REPORT, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
  console.log("PASS: real capture/wake/Whisper/question receipts/TTS/playback, negative control, self-echo and positive control, interruption, synthetic noise, microphone cleanup, and unchanged tasks/approvals.");
} catch (error) {
  console.error(await panel.innerText().catch(() => "No voice panel"));
  console.error(JSON.stringify({ engine, errors, phases, questions, transcriptions, syntheses, blocked })); throw error;
} finally { await page.evaluate(() => window.__closeVoiceInputs()).catch(() => {}); await browser.close(); }
