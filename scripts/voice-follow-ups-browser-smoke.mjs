// Use a fresh voice-question-fixture with VOICE_TEST_FOLLOW_UP_CONTEXT=1.
// Real request/receipt/worker-context flow; deterministic voice inputs and agent.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { installVoiceInputStubs } from "./voice-input-test-stubs.mjs";
const { chromium } = await import(process.env.VOICE_PLAYWRIGHT_MODULE || "playwright");
const url = process.env.VOICE_TEST_URL || "http://127.0.0.1:14318";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 1000 } });
await context.route("**/*", route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
await context.addInitScript(installVoiceInputStubs);
const page = await context.newPage(), questions = [], errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("request", request => {
  if (request.method() === "POST" && request.url().endsWith("/questions")) questions.push({ path: new URL(request.url()).pathname, ...request.postDataJSON() });
});
let transcript = "Architect, what is blocking the design?", rejectNext = false, loseNext = false;
await page.route("**/api/voice/status", route => route.fulfill({ json: { ready: true } }));
await page.route("**/api/voice/transcribe", route => route.fulfill({ json: { text: transcript } }));
await page.route("**/agents/*/questions", async route => {
  if (rejectNext) { rejectNext = false; return route.fulfill({ status: 409, json: { error: "follow_up_unavailable", message: "Follow-up context expired. Review this as a new question." } }); }
  if (loseNext) { loseNext = false; await route.fetch(); return route.abort("connectionreset"); }
  return route.continue();
});
const panel = page.locator(".voice-panel");
const listening = () => page.waitForFunction(() => document.querySelector(".voice-controls strong")?.textContent.startsWith("Listening for"));
async function until(predicate) { const deadline = Date.now() + 15_000; while (!(await predicate())) { assert.ok(Date.now() < deadline, "Timed out waiting for request"); await sleep(25); } }
async function say(text) { transcript = text; await listening(); await page.evaluate(() => window.__say()); }
async function ask(text) {
  const before = questions.length; await say(text); await until(() => questions.length > before);
  await panel.locator(".voice-answer").waitFor(); await listening(); return questions.at(-1);
}
const fresh = async () => assert.match(await panel.locator(".voice-follow-up").innerText(), /New questions go to the Project Manager/);
try {
  await page.goto(url);
  const projectId = (await (await page.request.get(`${url}/api/projects`)).json()).projects[0].id;
  const state = async () => (await (await page.request.get(`${url}/api/projects/${projectId}/orchestration`)).json()).state;
  const initial = await state();
  await panel.getByRole("button", { name: "Enable voice", exact: true }).click();
  const first = await ask("Architect, what is blocking the design?");
  assert.match(first.path, /\/architect\/questions$/); assert.equal(first.followUpTo, undefined);
  assert.match(await panel.locator(".voice-follow-up").innerText(), /Follow-ups: Architect/);
  assert.match(await panel.locator(".voice-answer").innerText(), /Earlier questions: \(none\)/);
  const second = await ask("And why?");
  assert.match(second.path, /\/architect\/questions$/); assert.equal(second.followUpTo, first.requestId);
  assert.match(await panel.locator(".voice-answer").innerText(), /Earlier questions: what is blocking the design\?/);
  const backend = await ask("Backend, what is blocking the API?");
  assert.equal(backend.followUpTo, undefined); assert.match(backend.path, /\/backend_developer\/questions$/);
  assert.match(await panel.locator(".voice-answer").innerText(), /Earlier questions: \(none\)/);
  const team = await ask("Team, what should we focus on?");
  assert.equal(team.followUpTo, undefined); assert.match(team.path, /\/project_manager\/questions$/);
  assert.equal((await ask("What about tests?")).followUpTo, team.requestId);
  await panel.getByRole("button", { name: "New conversation", exact: true }).click(); await fresh();
  assert.equal((await ask("What is next?")).followUpTo, undefined);
  assert.match(await panel.locator(".voice-answer").innerText(), /Earlier questions: \(none\)/);

  // Advance only the browser clock. Routing must check actual time, not a stale
  // rendered countdown; server expiry is separately covered by API tests.
  const expiring = await ask("Architect, what needs review?");
  const receipt = (await (await page.request.get(`${url}/api/projects/${projectId}/questions/${expiring.requestId}`)).json());
  await page.evaluate(time => { window.__originalNow = Date.now; Date.now = () => time; }, Date.parse(receipt.followUpExpiresAt) + 1);
  await panel.getByText(/Follow-up context expired/).waitFor();
  const beforeExpiry = questions.length; await say("What is next after expiry?"); await until(() => questions.length > beforeExpiry);
  await page.evaluate(() => { Date.now = window.__originalNow; });
  assert.equal(questions.at(-1).followUpTo, undefined); assert.match(questions.at(-1).path, /\/project_manager\/questions$/);
  await panel.locator(".voice-answer").waitFor(); await listening();

  rejectNext = true; await say("And why?");
  await panel.getByRole("button", { name: "Review as new question" }).click();
  const rejectedId = questions.at(-1).requestId;
  await panel.getByLabel("Question recipient").selectOption("architect");
  await panel.getByLabel("Voice question").fill("What should I review now?");
  await panel.getByRole("button", { name: "Ask question", exact: true }).click();
  await panel.locator(".voice-answer").waitFor(); await listening();
  assert.notEqual(questions.at(-1).requestId, rejectedId); assert.equal(questions.at(-1).followUpTo, undefined);

  // Lose an accepted response. New conversation must remain reset even when
  // Retry reconnects to that old request and receives its completed answer.
  loseNext = true; await say("And what about the risks?");
  await panel.getByRole("button", { name: "Retry question" }).waitFor();
  const lost = questions.at(-1);
  await panel.getByRole("button", { name: "New conversation", exact: true }).click();
  await panel.getByRole("button", { name: "Retry question" }).click();
  await panel.locator(".voice-answer").waitFor(); await listening();
  assert.equal(questions.at(-1).requestId, lost.requestId); assert.equal(questions.at(-1).followUpTo, lost.followUpTo); await fresh();

  await say("Architect, how should we test this?");
  await panel.getByText(/Waiting for Architect/).waitFor();
  await panel.getByRole("button", { name: "Turn off microphone" }).click();
  await panel.locator(".voice-answer").waitFor(); await fresh();
  await panel.getByRole("button", { name: "Enable voice", exact: true }).click();
  await ask("Architect, what is next before work?");
  const beforeAction = questions.length;
  await say("Do that.");
  await panel.getByLabel("Voice question").waitFor();
  assert.equal(questions.length, beforeAction); await fresh();
  assert.match(await panel.innerText(), /spoken acknowledgement does not approve or start work/);
  await panel.getByRole("button", { name: "Discard transcript" }).click();
  await ask("Architect, what instruction should we use?");
  await say("Team, from now on always document tests.");
  await panel.getByRole("button", { name: "Review action", exact: true }).click();
  await panel.getByRole("button", { name: "Confirm save standing instruction" }).waitFor(); await fresh();
  assert.deepEqual((await state()).directives, initial.directives);
  await panel.getByRole("button", { name: "Clear request", exact: true }).click();
  await ask("Architect, what should we check before reload?");
  if (process.env.VOICE_SCREENSHOT) await page.screenshot({ path: process.env.VOICE_SCREENSHOT, fullPage: true });
  await page.reload(); await panel.getByRole("button", { name: "Enable voice", exact: true }).waitFor(); await fresh();
  const final = await state();
  assert.deepEqual(final.tasks, initial.tasks); assert.deepEqual(final.directives, initial.directives); assert.deepEqual(final.approvals, initial.approvals);
  assert.deepEqual(errors, []);
  console.log("PASS: follow-up recipient/history, explicit overrides, expiry, reset, retry races, microphone shutdown, reload isolation, and unchanged approval gates.");
} catch (error) {
  console.error(await panel.innerText().catch(() => "No voice panel")); throw error;
} finally { await browser.close(); }
