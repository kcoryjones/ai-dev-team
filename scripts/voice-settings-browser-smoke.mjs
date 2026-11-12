// Disposable voice-question-fixture; deterministic inputs, real browser media
// permission/device enumeration and Web Audio. No paid agent calls.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { installVoiceInputStubs } from "./voice-input-test-stubs.mjs";
const { chromium } = await import(process.env.VOICE_PLAYWRIGHT_MODULE || "playwright");
const url = process.env.VOICE_TEST_URL || "http://127.0.0.1:14318";
const wave = await readFile(process.env.VOICE_TEST_TTS_AUDIO);
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 1100 } });
await context.route("**/*", route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
await context.addInitScript(installVoiceInputStubs);
const page = await context.newPage(), errors = [], syntheses = [];
page.on("pageerror", error => errors.push(error.message));
let transcriptions = 0;
await page.route("**/api/voice/status", route => route.fulfill({ json: { ready: true } }));
await page.route("**/api/voice/transcribe", route => { transcriptions++; return route.fulfill({ json: { text: "Architect, what is blocking progress?" } }); });
await page.route("**/api/voice/tts/synthesize", route => {
  syntheses.push(route.request().postDataJSON()); return route.fulfill({ body: wave, contentType: "audio/wav" });
});
const panel = page.locator(".voice-panel"), settings = panel.locator(".voice-settings");
const listening = () => page.waitForFunction(() => document.querySelector(".voice-controls strong")?.textContent.startsWith("Listening for"));
const playing = () => panel.getByText("Speaking reply…", { exact: true }).waitFor();
const enable = () => panel.getByRole("button", { name: "Enable voice", exact: true }).click();
const stopMic = () => panel.getByRole("button", { name: "Turn off microphone", exact: true }).click();
try {
  await page.goto(url); await settings.locator("summary").click();
  assert.equal(await page.evaluate(() => window.__tracks.length), 0);
  await page.waitForFunction(() => document.querySelector('select[aria-label="Microphone"]').options.length > 1);
  const id = await page.evaluate(() => document.querySelector('select[aria-label="Microphone"]').options[1].value);
  await panel.getByLabel("Microphone", { exact: true }).selectOption(id);
  await panel.getByLabel("Pause to finish").selectOption("1.8");
  await panel.getByLabel("Speech sensitivity").selectOption("0.006");
  await panel.getByLabel("Speaking speed").fill("1.25");
  await panel.getByLabel("Reply volume").fill("0.4");
  await panel.getByLabel("Speak replies", { exact: true }).check();
  await enable(); await listening();
  assert.equal(await panel.getByLabel("Microphone", { exact: true }).isDisabled(), true);
  assert.equal(await panel.getByLabel("Pause to finish").isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.__micConstraints.at(-1).audio.deviceId), { exact: id });
  assert.match(await panel.getByLabel("Microphone diagnostics").innerText(), /kHz capture/);

  // Real microphone meter callback and selected endpoint pause. A 1.3-second
  // gap must not finish a request configured to wait for 1.8 seconds.
  await page.evaluate(() => window.__say());
  assert.equal(transcriptions, 0);
  assert.ok(Number(await panel.getByRole("meter").getAttribute("value")) > -60);
  await page.evaluate(() => {
    for (let i = 0; i < 6; i++) window.__capture.port.onmessage({ data: { epoch: window.__capture.epoch, samples: new Float32Array(1600) } });
  });
  await playing(); assert.equal(transcriptions, 1); assert.equal(syntheses.at(-1).speed, 1.25);
  assert.ok(Math.abs(await page.evaluate(() => window.__gains.at(-1).gain.value) - 0.4) < 0.001);
  await panel.getByLabel("Reply volume").fill("0");
  await page.waitForFunction(() => window.__gains.at(-1).gain.value < 0.001);
  await panel.getByLabel("Speaking speed").fill("0.75");
  assert.equal(syntheses.length, 1, "changes must not restart a reply");
  assert.match(await panel.innerText(), /Listening paused for speech/);
  await page.keyboard.press("Escape"); await listening();
  await panel.getByRole("button", { name: "Replay reply", exact: true }).click(); await playing();
  assert.equal(syntheses.at(-1).speed, 0.75);
  assert.equal(await page.evaluate(() => window.__gains.at(-1).gain.value), 0);
  await stopMic(); await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => window.__tracks.every(track => track.readyState === "ended")), true);
  assert.equal(await panel.getByLabel("Microphone", { exact: true }).isEnabled(), true);
  await page.reload(); await settings.locator("summary").click();
  assert.equal(await panel.getByLabel("Speak replies", { exact: true }).isChecked(), false);
  assert.equal(await page.evaluate(() => window.__tracks.length), 0);
  assert.equal(await panel.getByLabel("Speaking speed").inputValue(), "0.75");
  assert.equal(await panel.getByLabel("Reply volume").inputValue(), "0");
  assert.equal(await panel.getByLabel("Microphone", { exact: true }).inputValue(), id);

  // The saved exact device must fail clearly if removed, without silently
  // choosing another microphone. Returning to System default recovers.
  await page.evaluate(() => {
    const key = "local-voice-settings:v1", saved = JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify({ ...saved, deviceId: "removed-microphone" }));
  });
  await page.reload(); await settings.locator("summary").click();
  await enable(); await panel.getByText(/selected microphone is unavailable/).waitFor();
  await panel.getByLabel("Microphone", { exact: true }).selectOption("");
  await enable(); await listening();
  assert.equal(await page.evaluate(() => window.__micConstraints.at(-1).audio.deviceId), undefined);
  await page.evaluate(() => window.__tracks.at(-1).dispatchEvent(new Event("ended")));
  await panel.getByText(/Microphone disconnected/).waitFor();
  assert.equal(await page.evaluate(() => window.__tracks.every(track => track.readyState === "ended")), true);

  // Cancelling during permission resolution must release late-arriving tracks.
  await page.evaluate(() => {
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await get(constraints);
      await new Promise(resolve => { window.__releaseMicrophone = resolve; }); return stream;
    };
  });
  await enable(); await page.waitForFunction(() => !!window.__releaseMicrophone);
  await stopMic(); await page.evaluate(() => window.__releaseMicrophone());
  await page.waitForFunction(() => window.__tracks.every(track => track.readyState === "ended"));
  assert.match(await panel.innerText(), /Voice off/);
  assert.deepEqual(errors, []);
  if (process.env.VOICE_SCREENSHOT) await page.screenshot({ path: process.env.VOICE_SCREENSHOT, fullPage: true });
  console.log("PASS: microphone selection, endpoint tuning, input diagnostics, native-speed requests, live volume, playback interlock, preferences, unplug recovery, and late-permission cleanup.");
} catch (error) { console.error(await panel.innerText().catch(() => "No voice panel")); throw error; }
finally { await browser.close(); }
