import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createVoiceRoutes, maxVoiceBytes, validateVoiceWave } from "./voice.js";

function wave(seconds = 1, amplitude = 2000): Buffer {
  const samples = Math.floor(seconds * 16_000);
  const result = Buffer.alloc(44 + samples * 2);
  result.write("RIFF"); result.writeUInt32LE(result.length - 8, 4); result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16000, 24); result.writeUInt32LE(32000, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
  result.write("data", 36); result.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) result.writeInt16LE(Math.round(Math.sin(i / 10) * amplitude), 44 + i * 2);
  return result;
}
const audioRequest = (body: Uint8Array = wave()) => ({ method: "POST", headers: { "Content-Type": "audio/wav" }, body: new Uint8Array(body).buffer });

describe("local voice API", () => {
  it("is optional and never substitutes a cloud provider", async () => {
    const app = createVoiceRoutes(undefined, async () => { throw new Error("Must not fetch"); });
    assert.equal((await (await app.request("/status")).json()).ready, false);
    assert.equal((await app.request("/transcribe", audioRequest())).status, 503);
    for (const url of ["https://example.com", "http://example.com", "http://user:pass@localhost", "http://localhost/path"]) {
      assert.throws(() => createVoiceRoutes(url), /local HTTP endpoint/);
    }
  });
  it("checks local service readiness and handles failures", async () => {
    const app = createVoiceRoutes("http://speech:4320", async (url, init) => {
      assert.equal(String(url), "http://speech:4320/health");
      assert.equal(init?.redirect, "error");
      return Response.json({ status: "ok" });
    });
    assert.equal((await (await app.request("/status")).json()).ready, true);
    const down = createVoiceRoutes("http://speech:4320", async () => { throw new Error("offline"); });
    assert.equal((await (await down.request("/status")).json()).ready, false);
  });
  it("returns a transcript using only the bounded local inference endpoint", async () => {
    const app = createVoiceRoutes("http://localhost:4320", async (url, init) => {
      assert.equal(String(url), "http://localhost:4320/inference");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      const form = init?.body as FormData;
      assert.equal(form.get("response_format"), "json");
      assert.equal(form.get("temperature"), "0");
      assert.deepEqual(Buffer.from(await (form.get("file") as Blob).arrayBuffer()), wave());
      return Response.json({ text: " Architect, what is blocked? \n" });
    });
    const response = await app.request("/transcribe", audioRequest());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { text: "Architect, what is blocked?" });
  });
  it("rejects malformed, silent, truncated, oversized, or wrong-format audio before inference", async () => {
    let calls = 0;
    const app = createVoiceRoutes("http://speech:4320", async () => { calls++; return Response.json({ text: "unexpected" }); });
    const stereo = wave(); stereo.writeUInt16LE(2, 22);
    const badRate = wave(); badRate.writeUInt32LE(48000, 24);
    for (const invalid of [Buffer.alloc(0), wave(0.1), wave(1, 0), stereo, badRate, wave().subarray(0, 200)]) {
      assert.equal((await app.request("/transcribe", audioRequest(invalid))).status, 400);
    }
    assert.equal((await app.request("/transcribe", audioRequest(Buffer.alloc(maxVoiceBytes + 1)))).status, 413);
    assert.equal((await app.request("/transcribe", { method: "POST", body: "not WAV" })).status, 415);
    assert.equal(calls, 0);
    assert.doesNotThrow(() => validateVoiceWave(wave(30)));
  });
  it("bounds streamed uploads even without Content-Length", async () => {
    const app = createVoiceRoutes("http://speech:4320", async () => { throw new Error("Must not fetch"); });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(64_000)); },
      cancel() { cancelled = true; },
    });
    const request = new Request("http://localhost/transcribe", {
      method: "POST", headers: { "Content-Type": "audio/wav" }, body, duplex: "half",
    } as RequestInit);
    assert.equal((await app.request(request)).status, 413);
    assert.equal(cancelled, true);
  });
  it("permits one transcription at a time and releases the slot after failure", async () => {
    let finish!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    const app = createVoiceRoutes("http://speech:4320", async () => {
      calls++;
      if (calls === 1) { started(); await pending; throw new Error("service failed"); }
      return Response.json({ text: "Recovered" });
    });
    const first = app.request("/transcribe", audioRequest());
    await entered;
    assert.equal((await app.request("/transcribe", audioRequest())).status, 429);
    finish();
    assert.equal((await first).status, 503);
    assert.equal((await app.request("/transcribe", audioRequest())).status, 200);
  });
  it("rejects empty and malformed service output", async () => {
    for (const [result, status] of [[{ text: " " }, 422], [{ text: 123 }, 503], [{ text: "a".repeat(8001) }, 503]] as const) {
      const app = createVoiceRoutes("http://speech:4320", async () => Response.json(result));
      assert.equal((await app.request("/transcribe", audioRequest())).status, status);
    }
  });
  it("serves only the four known local wake assets", async () => {
    const app = createVoiceRoutes("http://speech:4320", async (url) => {
      assert.equal(String(url), "http://speech:4320/sherpa-onnx-wasm-kws-main.wasm");
      return new Response(new Uint8Array([0, 97, 115, 109]));
    });
    const response = await app.request("/assets/sherpa-onnx-wasm-kws-main.wasm");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/wasm");
    assert.equal((await app.request("/assets/load")).status, 404);
    assert.equal((await app.request("/assets/secrets.json")).status, 404);
  });
});
