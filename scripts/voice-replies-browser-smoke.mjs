// V4.2 integration: deterministic voice inputs and agent answers, real Web Audio.
// Use the disposable voice-question-fixture. Optional VOICE_TEST_REAL_TTS=1
// exercises its configured local TTS backend instead of a prerecorded WAV.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { installVoiceInputStubs } from "./voice-input-test-stubs.mjs";
const { chromium } = await import(process.env.VOICE_PLAYWRIGHT_MODULE || "playwright");
const url = process.env.VOICE_TEST_URL || "http://127.0.0.1:14318";
const realTts = process.env.VOICE_TEST_REAL_TTS === "1";
const wave = realTts ? null : await readFile(process.env.VOICE_TEST_TTS_AUDIO);
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 1100 } });
await context.route("**/*", route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
await context.addInitScript(installVoiceInputStubs);
const page = await context.newPage(), errors = [], syntheses = [], questions = [];
page.on("pageerror", error => errors.push(error.message));
page.on("request", request => {
  if (request.method() === "POST" && request.url().endsWith("/questions")) questions.push(request.postDataJSON());
});
let transcript = "Architect, what is blocking progress?", mode = "ok", terminal = null;
await page.route("**/api/voice/status", route => route.fulfill({ json: { ready: true } }));
await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: transcript } }));
await page.route("**/api/voice/tts/synthesize", async route => {
  syntheses.push(route.request().postDataJSON());
  if (mode === "unavailable") return route.fulfill({ status: 503, json: { message: "Unavailable" } });
  if (mode === "slow") await new Promise(resolve => setTimeout(resolve, 1000));
  if (realTts) return route.continue().catch(() => {});
  return route.fulfill({ body: wave, contentType: "audio/wav" }).catch(() => {});
});
await page.route("**/questions/*", async route => {
  if (!terminal) return route.continue();
  const response = await route.fetch(), result = await response.json();
  if (result.run?.status === "completed") { result.run.status = terminal; result.run.result.summary = `Question ${terminal}.`; }
  await route.fulfill({ json: result });
});
const panel = page.locator(".voice-panel");
const listening = () => page.waitForFunction(() => document.querySelector(".voice-controls strong")?.textContent.startsWith("Listening for"));
const playing = () => panel.getByText("Speaking reply…", { exact: true }).waitFor();
const stopped = () => panel.getByRole("button", { name: /Stop speaking/ }).waitFor({ state: "hidden" });
const playbacks = () => page.evaluate(() => window.__playbacks);
async function say(text = transcript) { transcript = text; await listening(); await page.evaluate(() => window.__say()); }
async function question(text = transcript) { await say(text); await panel.locator(".voice-answer").waitFor(); }
try {
  await page.goto(url);
  assert.equal(await panel.getByLabel("Speak replies", { exact: true }).isChecked(), false);
  await panel.getByRole("button", { name: "Enable voice", exact: true }).click();
  await question();
  assert.equal(syntheses.length, 0); assert.equal(await playbacks(), 0);
  await panel.getByLabel("Speak replies", { exact: true }).check();
  assert.equal(syntheses.length, 0, "enabling must not read an old answer");

  await panel.getByRole("button", { name: "Replay reply", exact: true }).click(); await playing();
  assert.match(await panel.innerText(), /Listening paused for speech/);
  const oldEpoch = await page.evaluate(() => window.__capture.epoch);
  await page.evaluate(() => window.__say());
  assert.equal(questions.length, 1, "speaker audio cannot dispatch a question");
  await page.keyboard.press("Escape"); await stopped(); await listening();
  await page.evaluate(epoch => { window.__lateWake(epoch); return window.__say(epoch); }, oldEpoch);
  assert.equal(questions.length, 1, "queued wake results and audio must be discarded after playback");
  assert.equal(await playbacks(), 1);

  await question("Architect, what should we focus on?"); await playing();
  const automatic = syntheses.length;
  assert.equal(automatic, 2);
  assert.match(syntheses.at(-1).text, /^Architect\./);
  await listening(); // Natural end, including the speaker-tail pause.
  assert.equal(syntheses.length, automatic, "polls and rerenders must not repeat completed replies");

  await panel.getByRole("button", { name: "Replay reply" }).click(); await playing();
  await panel.getByRole("button", { name: "New conversation", exact: true }).click(); await stopped(); await listening();
  assert.match(await panel.locator(".voice-follow-up").innerText(), /New questions go to the Project Manager/);

  mode = "slow";
  await panel.getByRole("button", { name: "Replay reply" }).click();
  await panel.getByText("Preparing speech locally…", { exact: true }).waitFor();
  await panel.getByRole("button", { name: /Stop speaking/ }).click(); await listening();
  const playedBeforeLateResponse = await playbacks();
  await page.waitForTimeout(1200);
  assert.equal(await playbacks(), playedBeforeLateResponse, "Stop must defeat a late synthesis response");

  mode = "unavailable";
  await question("Architect, what is next?");
  await panel.getByText(/Local speech output is unavailable/).waitFor(); await listening();
  assert.ok(await panel.locator(".voice-answer").textContent());
  const failedRequestCount = syntheses.length;
  mode = "ok";
  await panel.getByRole("button", { name: "Replay reply" }).click(); await playing();
  assert.equal(syntheses.length, failedRequestCount + 1);
  await panel.getByLabel("Speak replies", { exact: true }).uncheck(); await stopped(); await listening();
  await panel.getByLabel("Speak replies", { exact: true }).check();
  assert.equal(syntheses.length, failedRequestCount + 1);

  for (terminal of ["failed", "cancelled"]) {
    const count = syntheses.length;
    await say(`Architect, what is the ${terminal} question status?`);
    await panel.getByText(`Question ${terminal}.`, { exact: true }).waitFor(); await listening();
    assert.equal(syntheses.length, count, "failed or cancelled questions cannot speak");
  }
  terminal = null;

  await say("Team, from now on always document relevant tests.");
  const beforeAction = syntheses.length;
  await panel.getByRole("button", { name: "Review action", exact: true }).click();
  await panel.getByRole("button", { name: "Confirm save standing instruction" }).waitFor();
  assert.equal(syntheses.length, beforeAction, "unconfirmed actions cannot be acknowledged");
  let lost = false;
  await page.route("**/voice/commands/*/confirm", async route => {
    if (!lost) { lost = true; await route.fetch(); await route.abort("connectionreset"); } else await route.continue();
  });
  await panel.getByRole("button", { name: "Confirm save standing instruction" }).click();
  await panel.getByRole("button", { name: "Retry action" }).click(); await playing();
  assert.equal(syntheses.length, beforeAction + 1);
  assert.equal(syntheses.at(-1).text, "Standing instruction saved.");
  await page.reload();
  await panel.getByText(/Saved the standing instruction for 10 agents/).waitFor();
  assert.equal(await panel.getByLabel("Speak replies", { exact: true }).isChecked(), false);
  await panel.getByLabel("Speak replies", { exact: true }).check();
  assert.equal(syntheses.length, beforeAction + 1, "restoring a receipt cannot autoplay");

  // Manual replay works without a microphone. Enabling capture during playback
  // must begin paused; stopping capture must stay stopped after speech finishes.
  await panel.getByRole("button", { name: "Replay reply" }).click(); await playing();
  await panel.getByRole("button", { name: "Enable voice", exact: true }).click();
  await page.waitForFunction(() => !!window.__capture);
  assert.match(await panel.innerText(), /Listening paused for speech/);
  const beforeMicFrames = questions.length;
  await page.evaluate(() => window.__say()); assert.equal(questions.length, beforeMicFrames);
  await panel.getByRole("button", { name: "Turn off microphone" }).click();
  await stopped();
  assert.equal(await page.evaluate(() => window.__tracks.every(track => track.readyState === "ended")), true);
  assert.match(await panel.innerText(), /Voice off/);
  assert.deepEqual(errors, []);
  if (process.env.VOICE_SCREENSHOT) await page.screenshot({ path: process.env.VOICE_SCREENSHOT, fullPage: true });
  console.log("PASS: opt-in replies, real audio playback, Stop/Escape, stale-frame rejection, natural resume, failure/replay, action acknowledgement, reload silence, and microphone cleanup.");
} catch (error) {
  console.error(await panel.innerText().catch(() => "No voice panel")); throw error;
} finally { await browser.close(); }
