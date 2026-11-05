// Opt-in integration test: real local wake detector + Whisper, synthetic microphone input.
// Install Playwright separately; point VOICE_TEST_URL at an isolated test app/database.
// Stub the agent answer so this speech integration check makes no model-provider calls.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.VOICE_PLAYWRIGHT_MODULE || "playwright");
const url = process.env.VOICE_TEST_URL || "http://127.0.0.1:4318";
const audio = process.env.VOICE_TEST_AUDIO;
if (!audio) throw new Error("Set VOICE_TEST_AUDIO to a WAV with initial silence, ‘Hey Dev Team. Architect, what is blocking progress?’, and trailing silence.");
const browser = await chromium.launch({ headless: true, args: [
  "--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
  `--use-file-for-fake-audio-capture=${audio}`,
] });
const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 900 } });
await context.route("**/*", route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
await context.addInitScript(() => {
  window.__voiceTracks = [];
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => {
    const stream = await original(constraints);
    window.__voiceTracks.push(...stream.getTracks());
    if (window.__delayMicrophone) await new Promise(resolve => setTimeout(resolve, 600));
    return stream;
  };
});
await context.route("**/agents/architect/questions", route => route.fulfill({ status: 202, json: {
  duplicate: false, message: { body: route.request().postDataJSON().body },
  run: { status: "completed", result: { summary: "Speech integration fixture answer." } },
} }));
const page = await context.newPage();
page.on("pageerror", error => console.error("Browser error:", error.message));
page.on("console", message => { if (message.type() === "error") console.error("Console:", message.text()); });
const mutations = [];
page.on("request", request => { if (request.method() === "POST") mutations.push(new URL(request.url()).pathname); });
try {
  await page.goto(url);
  await page.getByRole("button", { name: "Enable voice", exact: true }).waitFor();
  mutations.length = 0;
  const started = Date.now();
  await page.getByRole("button", { name: "Enable voice", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".voice-controls strong")?.textContent?.startsWith("Listening for") || document.querySelector(".voice-error"), undefined, { timeout: 65_000 });
  assert.equal(await page.locator(".voice-error").count(), 0, await page.locator(".voice-panel").innerText());
  await page.locator(".voice-transcript > p").first().waitFor({ timeout: 60_000 });
  const transcript = await page.locator(".voice-transcript > p").first().innerText();
  assert.match(transcript, /architect/i);
  assert.match(transcript, /progress/i);
  await page.locator(".voice-answer").waitFor();
  await page.getByRole("button", { name: "Turn off microphone" }).click();
  await page.waitForFunction(() => window.__voiceTracks.every(track => track.readyState === "ended"));
  assert.equal(mutations.length, 2, "A clear utterance must transcribe and ask exactly once.");
  assert.equal(mutations[0], "/api/voice/transcribe");
  assert.match(mutations[1], /\/agents\/architect\/questions$/);
  console.log(JSON.stringify({ transcript, elapsedMs: Date.now() - started, mutations }));
  if (process.env.VOICE_SCREENSHOT) await page.screenshot({ path: process.env.VOICE_SCREENSHOT, fullPage: true });

  // Late permission results must also release the microphone after cancellation.
  await page.reload();
  await page.getByRole("button", { name: "Enable voice", exact: true }).waitFor();
  await page.evaluate(() => { window.__delayMicrophone = true; });
  await page.getByRole("button", { name: "Enable voice", exact: true }).click();
  await page.waitForFunction(() => window.__voiceTracks.length > 0);
  await page.getByRole("button", { name: "Turn off microphone" }).click();
  await page.waitForFunction(() => window.__voiceTracks.every(track => track.readyState === "ended"));
  assert.equal(await page.locator(".voice-controls strong").innerText(), "Voice off");

  await page.evaluate(() => { window.__delayMicrophone = false; });
  await page.route("**/api/voice/status", route => route.fulfill({ json: { ready: false, message: "Speech service is unavailable." } }));
  await page.getByRole("button", { name: "Enable voice", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Speech service is unavailable." }).waitFor();
  await page.waitForFunction(() => window.__voiceTracks.every(track => track.readyState === "ended"));
  console.log("PASS: real wake/transcription, one question submission with a stub answer, microphone stop, cancelled startup, unavailable service.");
} catch (error) {
  console.error("Voice panel:", await page.locator(".voice-panel").innerText().catch(() => "unavailable"));
  throw error;
} finally {
  await browser.close();
}
