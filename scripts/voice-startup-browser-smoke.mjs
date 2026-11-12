// Regression for desktop audio backends that never settle AudioContext.resume().
import assert from "node:assert/strict";
const { chromium } = await import(process.env.VOICE_PLAYWRIGHT_MODULE || "playwright");
const url = process.env.VOICE_TEST_URL || "http://127.0.0.1:14318";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const context = await browser.newContext({ permissions: ["microphone"] });
await context.route("**/*", route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
await context.addInitScript(() => {
  const NativeContext = window.AudioContext;
  window.__resumeMode = "hang"; window.__microphoneCalls = 0; window.__closedAudio = 0; window.__tracks = [];
  window.AudioContext = class extends NativeContext {
    get state() { return window.__resumeMode === "suspended" ? "suspended" : super.state; }
    resume() {
      if (window.__resumeMode === "hang") return new Promise(resolve => { window.__lateResume = resolve; });
      if (window.__resumeMode === "suspended") return Promise.resolve();
      return super.resume();
    }
    close() { window.__closedAudio++; return super.close(); }
  };
  const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => {
    window.__microphoneCalls++; const stream = await get(constraints); window.__tracks.push(...stream.getTracks()); return stream;
  };
});
const page = await context.newPage(), errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/api/voice/status", route => route.fulfill({ json: { ready: false, message: "Fixture speech unavailable." } }));
const panel = page.locator(".voice-panel");
const enable = () => panel.getByRole("button", { name: "Enable voice", exact: true }).click();
try {
  await page.goto(url); await enable();
  await panel.getByRole("alert").filter({ hasText: "Microphone audio did not start" }).waitFor({ timeout: 8000 });
  assert.equal(await panel.locator(".voice-controls strong").innerText(), "Voice off");
  assert.equal(await page.evaluate(() => window.__microphoneCalls), 0);
  assert.equal(await page.evaluate(() => window.__closedAudio), 1);
  await page.evaluate(() => window.__lateResume());
  assert.equal(await page.evaluate(() => window.__microphoneCalls), 0);
  await page.evaluate(() => { window.__resumeMode = "suspended"; });
  await enable(); await panel.getByRole("alert").filter({ hasText: "Microphone audio is unavailable" }).waitFor();
  await page.evaluate(() => { window.__resumeMode = "hang"; window.__lateResume = null; });
  await enable(); await page.waitForFunction(() => !!window.__lateResume);
  await panel.getByRole("button", { name: "Turn off microphone", exact: true }).click();
  await page.evaluate(() => window.__lateResume());
  assert.equal(await page.evaluate(() => window.__microphoneCalls), 0);
  assert.equal(await panel.locator(".voice-error").count(), 0);
  await page.evaluate(() => { window.__resumeMode = "normal"; });
  await enable(); await panel.getByRole("alert").filter({ hasText: "Fixture speech unavailable" }).waitFor();
  assert.equal(await page.evaluate(() => window.__microphoneCalls), 1);
  assert.equal(await page.evaluate(() => window.__tracks.every(track => track.readyState === "ended")), true);
  assert.equal(await page.evaluate(() => window.__closedAudio), 4);
  assert.deepEqual(errors, []);
  console.log("PASS: audio startup timeout, late completion, suspended backend, cancellation, retry, and resource cleanup.");
} finally { await browser.close(); }
