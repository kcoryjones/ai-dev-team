import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { maxTtsAudioBytes, type VoiceCommandReceipt } from "@engineering-team/contracts";
import { LocalSpeechPlayer, type SpeechPhase } from "./LocalSpeechPlayer";
import { spokenAnswer, spokenAcknowledgement, SpokenReplyHistory } from "./spokenReply";
import { VoiceResampler } from "./audio";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const audio = () => new Response(new Uint8Array(100), { headers: { "Content-Type": "audio/wav" } });
const decoded = { duration: 1, numberOfChannels: 1 } as AudioBuffer;
function fixture(fetcher: typeof fetch = async () => audio(), timeout = 65_000) {
  const phases: SpeechPhase[] = [], active: boolean[] = [], errors: string[] = [];
  const sources: Array<{ onended: (() => void) | null; stopped: boolean; started: boolean; disconnected: boolean }> = [];
  const gains: Array<{ gain: { value: number }; disconnected: boolean }> = [];
  const context = {
    state: "running", destination: {}, currentTime: 0, onstatechange: null as (() => void) | null,
    createGain() {
      const node = { disconnected: false, connect() {}, disconnect() { this.disconnected = true; },
        gain: { value: 1, cancelScheduledValues() {}, setValueAtTime(value: number) { this.value = value; }, setTargetAtTime(value: number) { this.value = value; } } };
      gains.push(node); return node;
    },
    async resume() {}, async close() { this.state = "closed"; }, async decodeAudioData(_bytes: ArrayBuffer): Promise<AudioBuffer> { return decoded; },
    createBufferSource() {
      const node = { buffer: null, onended: null, stopped: false, started: false, disconnected: false,
        connect() {}, disconnect() { this.disconnected = true; }, start() { this.started = true; }, stop() { this.stopped = true; } };
      sources.push(node); return node;
    },
  };
  const player = new LocalSpeechPlayer({ phase: value => phases.push(value), active: value => active.push(value), error: value => errors.push(value) }, fetcher, () => context as unknown as AudioContext, timeout);
  return { player, context, phases, active, errors, sources, gains };
}

it("plays only local audio and releases the listening pause after completion", async () => {
  const f = fixture(async (url, init) => {
    assert.equal(url, "/api/voice/tts/synthesize");
    assert.deepEqual(JSON.parse(String(init?.body)), { text: "Architect. Ready.", speed: 1 });
    assert.equal(init?.cache, "no-store"); return audio();
  });
  try {
    await f.player.speak("Architect. Ready.", true);
    assert.deepEqual(f.phases, ["preparing", "playing"]);
    assert.deepEqual(f.active, [true]);
    f.sources[0]!.onended!();
    assert.deepEqual(f.active, [true, false]);
    assert.equal(f.sources[0]!.disconnected, true);
  } finally { f.player.dispose(); }
  assert.equal(f.context.state, "closed");
});

it("updates volume immediately and speed only on the next synthesis, releasing gain nodes on Stop", async () => {
  const speeds: number[] = [];
  const f = fixture(async (_url, init) => { speeds.push(JSON.parse(String(init?.body)).speed); return audio(); });
  try {
    f.player.configure({ speed: 0.75, volume: 0.5 });
    await f.player.speak("hello", true);
    assert.equal(f.gains[0]!.gain.value, 0.5);
    f.player.configure({ speed: 1.5, volume: 0 });
    assert.equal(f.gains[0]!.gain.value, 0);
    assert.deepEqual(speeds, [0.75]); assert.equal(f.sources[0]!.stopped, false);
    f.player.stop(); assert.equal(f.gains[0]!.disconnected, true);
    await f.player.speak("replay", true);
    assert.deepEqual(speeds, [0.75, 1.5]); assert.equal(f.gains[1]!.gain.value, 0);
  } finally { f.player.dispose(); }
  assert.equal(f.gains[1]!.disconnected, true);
});

it("Stop aborts synthesis and rejects a late response even if transport ignores abort", async () => {
  const response = deferred<Response>(), entered = deferred<void>(); let signal: AbortSignal | undefined;
  const f = fixture(async (_url, init) => { signal = init?.signal ?? undefined; entered.resolve(); return response.promise; });
  const pending = f.player.speak("hello", true);
  await entered.promise; f.player.stop();
  assert.equal(signal?.aborted, true);
  response.resolve(audio()); await pending;
  assert.equal(f.sources.length, 0);
  assert.deepEqual(f.active, [true, false]);
  assert.equal(f.errors.filter(Boolean).length, 0);
  f.player.dispose();
});

it("replacement and cancellation during decoding cannot play stale audio", async () => {
  const f = fixture(), decode = deferred<AudioBuffer>(), entered = deferred<void>(); let calls = 0;
  f.context.decodeAudioData = async () => { if (++calls === 1) { entered.resolve(); return decode.promise; } return decoded; };
  try {
    const old = f.player.speak("old", true); await entered.promise;
    await f.player.speak("new", true);
    decode.resolve(decoded); await old;
    assert.equal(f.sources.length, 1);
    assert.equal(f.sources[0]!.started, true);
    const ended = f.sources[0]!.onended!;
    f.player.stop(); ended();
    assert.deepEqual(f.active, [true, true, false]);
    assert.equal(f.sources[0]!.stopped, true);
  } finally { f.player.dispose(); }
});

it("unavailable, busy, malformed, and excessive audio leave text usable and listening released", async () => {
  let cancelled = false;
  const oversized = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(maxTtsAudioBytes + 1)); }, cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "audio/wav" } });
  for (const response of [new Response("secret", { status: 503 }), new Response("busy", { status: 429 }), new Response("bad"), oversized]) {
    const f = fixture(async () => response);
    try {
      await f.player.speak("hello", true);
      assert.deepEqual(f.active, [true, false]);
      assert.equal(f.sources.length, 0);
      assert.ok(f.errors.at(-1)); assert.doesNotMatch(f.errors.at(-1)!, /secret/);
    } finally { f.player.dispose(); }
  }
  assert.equal(cancelled, true);
  const f = fixture(); f.context.decodeAudioData = async () => { throw new Error("Malformed WAV"); };
  await f.player.speak("hello", true);
  assert.deepEqual(f.active, [true, false]); f.player.dispose();
});

it("a stalled response body times out, cancels its stream, and permits replay", async () => {
  let cancelled = false, calls = 0;
  const f = fixture(async () => ++calls === 1 ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "audio/wav" } }) : audio(), 20);
  try {
    await f.player.speak("hello", true);
    assert.equal(cancelled, true); assert.match(f.errors.at(-1)!, /timed out/);
    await f.player.speak("retry", true);
    assert.equal(f.sources.length, 1);
  } finally { f.player.dispose(); }
});

it("browser audio restrictions and suspended playback release listening without automatic retry", async () => {
  const f = fixture();
  try {
    f.context.resume = async () => { throw new Error("Playback blocked"); };
    await f.player.speak("blocked", true);
    assert.deepEqual(f.active, [true, false]); assert.equal(f.sources.length, 0);
    f.context.resume = async () => {};
    await f.player.speak("replay", true);
    f.context.state = "suspended"; f.context.onstatechange!();
    assert.equal(f.sources[0]!.stopped, true);
    assert.match(f.errors.at(-1)!, /browser paused/);
  } finally { f.player.dispose(); }
});

it("spoken excerpts bound long answers and omit code while identifying the agent", () => {
  const reply = spokenAnswer("q1", "architect", "## Ready\nUse [the guide](https://example.com).\n```ts\nsecret_code()\n```\n" + "More details. ".repeat(200));
  assert.ok(reply.text.length < 1000);
  assert.equal(reply.shortened, true);
  assert.match(reply.text, /^Architect\./); assert.match(reply.text, /Full reply is shown on screen/);
  assert.doesNotMatch(reply.text, /secret_code|https|```|##/);
  assert.equal(spokenAnswer("q2", "architect", "Ready.").shortened, false);
  const history = new SpokenReplyHistory();
  assert.equal(history.accept("q1"), true); assert.equal(history.accept("q1"), false);
  assert.equal(history.accept("q2"), true);
});

it("only applied actions have short acknowledgements and never claim work is complete", () => {
  const receipt = { status: "prepared", input: { action: "new_work", requestId: "r1", body: "private directive" } } as VoiceCommandReceipt;
  assert.equal(spokenAcknowledgement(receipt), null);
  receipt.status = "failed"; assert.equal(spokenAcknowledgement(receipt), null);
  receipt.status = "applied";
  const reply = spokenAcknowledgement(receipt)!;
  assert.match(reply.text, /accepted/); assert.doesNotMatch(reply.text, /complete|private directive/);
});

it("the real capture worklet drops partial audio and emits only the new generation after speech", async () => {
  const messages: Array<{ epoch: number; samples: Float32Array }> = [];
  let Processor: any;
  const source = await readFile(new URL("./capture-worklet.js", import.meta.url), "utf8");
  runInNewContext(source.replace(/^import[^\n]+\n/, ""), {
    sampleRate: 16000, Float32Array, VoiceResampler,
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (value: { epoch: number; samples: Float32Array }) => messages.push(value) }; },
    registerProcessor(_name: string, processor: unknown) { Processor = processor; },
  });
  const processor = new Processor();
  processor.process([[new Float32Array(800).fill(0.9)]]);
  processor.port.onmessage({ data: { type: "reset", epoch: 1, paused: true } });
  processor.process([[new Float32Array(3200).fill(0.9)]]);
  assert.equal(messages.length, 0);
  processor.port.onmessage({ data: { type: "reset", epoch: 2, paused: false } });
  processor.process([[new Float32Array(1600).fill(0.2)]]);
  assert.equal(messages.length, 1); assert.equal(messages[0]!.epoch, 2);
  assert.ok(messages[0]!.samples.every(sample => Math.abs(sample - 0.2) < 0.0001));
});
