// Run against the local service, or set TTS_TEST_URL=http://127.0.0.1:4318/api/voice/tts.
// This exercises synthesis only; no agent/provider requests or saved conversations.
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const base = process.env.TTS_TEST_URL ?? "http://127.0.0.1:4321";
const text = "Architect here. The API migration is ready for review. I recommend running the tests before merging the changes.";
const post = (text, signal, speed = 1) => fetch(`${base}/synthesize`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, speed }),
  signal: signal ?? AbortSignal.timeout(60_000),
});
const status = async () => (await fetch(`${base}/status`, { signal: AbortSignal.timeout(5000) })).json();
async function waitFor(predicate) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(20); }
  throw new Error("Speech service did not reach the expected state.");
}
async function workerPid() {
  if (process.env.TTS_TEST_VERIFY_WORKER !== "1") return undefined;
  const pids = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const command = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
    if (command.split("\0").some(arg => arg.endsWith("/tts-worker.js"))) pids.push(Number(entry));
  }
  assert.equal(pids.length, 1, "exactly one native synthesis worker must exist");
  return pids[0];
}

await waitFor(async () => (await status()).ready);
const initial = await status();
assert.equal(initial.voices[0].id, "en_US-ljspeech-medium");
const originalPid = await workerPid();
for (let index = 0; index < 2; index++) {
  const start = performance.now();
  const response = await post(text);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "audio/wav");
  const wave = Buffer.from(await response.arrayBuffer());
  assert.equal(wave.toString("ascii", 0, 4), "RIFF");
  assert.equal(wave.readUInt32LE(24), 22050);
  assert.equal(wave.readUInt16LE(22), 1);
  assert.equal(wave.readUInt16LE(34), 16);
  assert.equal(wave.readUInt32LE(40), wave.length - 44);
  assert.ok(wave.length > 44 && wave.length <= 44 + 22050 * 2 * 90);
  assert.ok(wave.subarray(44).some(value => value !== 0), "speech must not be silent");
  assert.equal(await workerPid(), originalPid, "successful requests reuse the warm worker");
  console.log(JSON.stringify({ synthesisMs: Math.round(performance.now() - start), audioSeconds: (wave.length - 44) / 44100 }));
  if (index === 0 && process.env.TTS_TEST_OUTPUT) await writeFile(process.env.TTS_TEST_OUTPUT, wave);
}
const durations = [];
for (const speed of [0.75, 1.5]) {
  const response = await post(text, undefined, speed);
  assert.equal(response.status, 200);
  const wave = Buffer.from(await response.arrayBuffer());
  assert.equal(wave.readUInt32LE(24), 22050);
  assert.ok(wave.subarray(44).some(value => value !== 0));
  durations.push((wave.length - 44) / 44100);
}
assert.ok(durations[0] > durations[1] * 1.5, "native synthesis must honor speaking speed");
console.log(JSON.stringify({ speed075Seconds: durations[0], speed150Seconds: durations[1] }));
assert.equal((await post("x".repeat(2001))).status, 400);
const abort = new AbortController();
const active = post("Please review the implementation and run the regression tests. ".repeat(30), abort.signal).catch(error => error);
try {
  await waitFor(async () => (await status()).busy);
  const busy = await post("This must not run concurrently.");
  assert.equal(busy.status, 429);
  await busy.body?.cancel();
} finally { abort.abort(); await active; }
await waitFor(async () => { const result = await status(); return result.ready && !result.busy; });
if (originalPid !== undefined) {
  assert.throws(() => process.kill(originalPid, 0), { code: "ESRCH" });
  assert.notEqual(await workerPid(), originalPid, "cancellation must replace the native worker");
}
const recovered = await post("Speech synthesis has recovered.");
assert.equal(recovered.status, 200);
await recovered.arrayBuffer();
if (originalPid !== undefined) {
  const idlePid = await workerPid();
  process.kill(idlePid, "SIGKILL");
  await waitFor(async () => !(await status()).ready);
  await waitFor(async () => (await status()).ready);
  assert.notEqual(await workerPid(), idlePid, "an idle worker crash must recover without a request");
}
console.log("Local synthesis, warm reuse, bounds, busy admission, cancellation, and recovery passed.");
