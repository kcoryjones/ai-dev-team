import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "node:test";
import { ProcessTtsEngine } from "./tts-engine.js";

async function fixture(timeout = 2000, workerOverride?: string) {
  const root = await mkdtemp(join(tmpdir(), "engineering-tts-test-"));
  const worker = join(root, "worker.mjs");
  await writeFile(worker, workerOverride ?? `
    import { writeFileSync } from "node:fs";
    writeFileSync(new URL("./pid", import.meta.url), String(process.pid));
    process.on("message", ({id, text, speed}) => {
      writeFileSync(new URL("./speed", import.meta.url), String(speed));
      if (text === "block") { while (true) {} }
      if (text === "crash") process.exit(1);
      if (text === "invalid") { process.send({type: "audio", id, wave: Buffer.from("bad")}); return; }
      const wave = Buffer.alloc(46);
      wave.write("RIFF"); wave.writeUInt32LE(38, 4); wave.write("WAVEfmt ", 8);
      wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
      wave.writeUInt32LE(22050, 24); wave.writeUInt32LE(44100, 28);
      wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(2, 40);
      process.send({type: "audio", id, wave});
    });
    process.send({type: "ready"});
  `);
  const engine = new ProcessTtsEngine(pathToFileURL(worker), timeout, 2000);
  return { engine, pid: async () => Number(await readFile(join(root, "pid"), "utf8")),
    speed: async () => Number(await readFile(join(root, "speed"), "utf8")),
    async close() { await engine.close(); await rm(root, { recursive: true, force: true }); } };
}
const signal = () => new AbortController().signal;
const gone = (pid: number) => assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });

it("keeps a warm speech worker and kills it on shutdown", async () => {
  const f = await fixture();
  try {
    await f.engine.start(); const pid = await f.pid();
    assert.equal(f.engine.ready, true);
    for (let i = 0; i < 2; i++) assert.equal((await f.engine.generate("hello", signal())).length, 46);
    assert.equal(await f.pid(), pid);
    await f.engine.close(); gone(pid);
    assert.equal(f.engine.ready, false);
    await assert.rejects(f.engine.generate("hello", signal()), /unavailable/);
  } finally { await f.close(); }
});

it("carries speaking speed across the native worker process boundary", async () => {
  const f = await fixture();
  try {
    await f.engine.start();
    for (const speed of [0.75, 1, 1.5]) { await f.engine.generate("hello", signal(), speed); assert.equal(await f.speed(), speed); }
  } finally { await f.close(); }
});

it("hard-cancels native work, rejects concurrent synthesis, and reloads before releasing capacity", async () => {
  const f = await fixture();
  try {
    await f.engine.start(); const pid = await f.pid();
    const abort = new AbortController();
    const pending = f.engine.generate("block", abort.signal);
    const rejected = assert.rejects(pending, /cancelled/);
    await assert.rejects(f.engine.generate("hello", signal()), { status: 429 });
    abort.abort();
    assert.equal(f.engine.busy, true);
    await rejected;
    gone(pid);
    assert.notEqual(await f.pid(), pid);
    assert.equal(f.engine.ready, true);
    assert.equal(f.engine.busy, false);
    assert.equal((await f.engine.generate("hello", signal())).length, 46);
  } finally { await f.close(); }
});

it("recovers from generation deadlines, crashed workers, and malformed replies", async () => {
  const f = await fixture(100);
  try {
    await f.engine.start();
    for (const [text, status] of [["block", 504], ["crash", 503], ["invalid", 503]] as const) {
      const pid = await f.pid();
      await assert.rejects(f.engine.generate(text, signal()), { status });
      gone(pid);
      assert.equal(f.engine.ready, true);
      assert.equal((await f.engine.generate("hello", signal())).length, 46);
    }
  } finally { await f.close(); }
});

it("does not restart a cancelled worker during shutdown", async () => {
  const f = await fixture();
  try {
    await f.engine.start(); const pid = await f.pid();
    const pending = assert.rejects(f.engine.generate("block", signal()), /stopping/);
    await f.engine.close(); await pending;
    gone(pid);
    assert.equal(await f.pid(), pid);
    assert.equal(f.engine.ready, false);
    assert.equal(f.engine.busy, false);
  } finally { await f.close(); }
});

it("reports startup failure without admitting requests", async () => {
  const f = await fixture(100, "process.exit(1)");
  try {
    await assert.rejects(f.engine.start(), /Unable to load/);
    await assert.rejects(f.engine.generate("hello", signal()), { status: 503 });
    assert.equal(f.engine.ready, false);
  } finally { await f.close(); }
});
