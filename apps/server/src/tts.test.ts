import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createTtsRoutes, createTtsServiceRoutes } from "./tts-routes.js";
import { maxTtsAudioBytes, maxTtsRequestBytes, ttsVoice } from "./tts-protocol.js";

function wave(): Buffer {
  const result = Buffer.alloc(44 + 22050 * 2);
  result.write("RIFF"); result.writeUInt32LE(result.length - 8, 4); result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(22050, 24); result.writeUInt32LE(44100, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
  result.write("data", 36); result.writeUInt32LE(result.length - 44, 40);
  return result;
}
const request = (value: unknown = { text: "Architect here." }): RequestInit => ({
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
});
const audio = (bytes = wave()) => new Response(new Uint8Array(bytes), { headers: { "Content-Type": "audio/wav" } });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("local speech synthesis API", () => {
  it("is optional, restricted to local endpoints, and independent of transcription", async () => {
    const app = createTtsRoutes(undefined, async () => { throw new Error("Must not fetch"); });
    assert.equal((await (await app.request("/status")).json()).ready, false);
    assert.equal((await app.request("/synthesize", request())).status, 503);
    for (const url of ["https://localhost", "http://example.com", "http://user:pass@localhost", "http://localhost/path", "http://localhost?key=secret", "http://localhost#fragment"]) {
      assert.throws(() => createTtsRoutes(url), /local HTTP endpoint/);
    }
    for (const url of ["http://localhost:4321", "http://127.0.0.1:4321", "http://[::1]:4321", "http://tts:4321"]) {
      assert.doesNotThrow(() => createTtsRoutes(url));
    }
  });
  it("reports the installed voice and sanitizes unavailable status", async () => {
    const app = createTtsRoutes("http://tts:4321", async (url, init) => {
      assert.equal(String(url), "http://tts:4321/health");
      assert.equal(init?.redirect, "error");
      return Response.json({ ready: true, busy: true, secret: "never expose" });
    });
    assert.deepEqual(await (await app.request("/status")).json(), { ready: true, busy: true, voices: [ttsVoice], maxTextCharacters: 2000 });
    for (const fetcher of [async () => { throw new Error("secret"); }, async () => new Response("not json"), async () => Response.json({ ready: true }, { status: 500 })]) {
      const result = await createTtsRoutes("http://tts:4321", fetcher).request("/status");
      assert.equal((await result.json()).ready, false);
    }
  });
  it("returns bounded PCM audio without caching text or speech", async () => {
    const app = createTtsRoutes("http://tts:4321", async (url, init) => {
      assert.equal(String(url), "http://tts:4321/synthesize");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { text: "Architect here.", voice: ttsVoice.id, speed: 1 });
      return audio();
    });
    const response = await app.request("/synthesize", request({ text: "  Architect here.\n" }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "audio/wav");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), wave());
  });
  it("rejects invalid text, voices, JSON, and oversized uploads before synthesis", async () => {
    let calls = 0;
    const app = createTtsRoutes("http://tts:4321", async () => { calls++; return audio(); });
    for (const value of [null, [], {}, { text: " " }, { text: 42 }, { text: "x".repeat(2001) }, { text: "a\0b" }, { text: "hi", voice: "remote" }, { text: "hi", extra: true }]) {
      assert.equal((await app.request("/synthesize", request(value))).status, 400);
    }
    assert.equal((await app.request("/synthesize", { ...request(), body: "{" })).status, 400);
    assert.equal((await app.request("/synthesize", { method: "POST", body: "hi" })).status, 415);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(maxTtsRequestBytes + 1)); }, cancel() { cancelled = true; } });
    const streamed = new Request("http://localhost/synthesize", { ...request(), body, duplex: "half" } as RequestInit);
    assert.equal((await app.request(streamed)).status, 413);
    assert.equal(cancelled, true);
    assert.equal(calls, 0);
  });
  it("validates speed at both HTTP boundaries and forwards it to the engine", async () => {
    const speeds: number[] = [];
    const service = createTtsServiceRoutes({ ready: true, busy: false, async generate(_text, _signal, speed) { speeds.push(speed!); return wave(); } });
    const proxy = createTtsRoutes("http://tts:4321", async (_url, init) => service.request("/synthesize", init));
    for (const app of [proxy, service]) {
      for (const speed of [null, "1", 0, -1, 0.74, 1.51, 100]) assert.equal((await app.request("/synthesize", request({ text: "Hi", speed }))).status, 400);
      for (const speed of [undefined, 0.75, 1.25, 1.5]) {
        assert.equal((await app.request("/synthesize", request({ text: "Hi", speed }))).status, 200);
        assert.equal(speeds.at(-1), speed ?? 1);
      }
    }
    assert.equal(speeds.length, 8);
  });
  it("bounds and validates upstream audio and sanitizes service failures", async () => {
    const stereo = wave(); stereo.writeUInt16LE(2, 22);
    const rate = wave(); rate.writeUInt32LE(16000, 24);
    for (const bytes of [Buffer.alloc(0), Buffer.from("not audio"), stereo, rate, wave().subarray(0, 100)]) {
      assert.equal((await createTtsRoutes("http://tts:4321", async () => audio(bytes)).request("/synthesize", request())).status, 503);
    }
    assert.equal((await createTtsRoutes("http://tts:4321", async () => new Response("oops")).request("/synthesize", request())).status, 503);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(maxTtsAudioBytes + 1)); }, cancel() { cancelled = true; } });
    const oversized = createTtsRoutes("http://tts:4321", async () => new Response(body, { headers: { "Content-Type": "audio/wav" } }));
    assert.equal((await oversized.request("/synthesize", request())).status, 413);
    assert.equal(cancelled, true);
    for (const [upstream, expected] of [[429, 429], [504, 504], [500, 503], [302, 503]] as const) {
      const response = await createTtsRoutes("http://tts:4321", async () => new Response("secret", { status: upstream })).request("/synthesize", request());
      assert.equal(response.status, expected);
      assert.doesNotMatch(await response.text(), /secret/);
    }
  });
  it("admits one synthesis and releases capacity after failure", async () => {
    const started = deferred(), finish = deferred();
    let calls = 0;
    const app = createTtsRoutes("http://tts:4321", async () => {
      if (++calls === 1) { started.resolve(); await finish.promise; throw new Error("failed"); }
      return audio();
    });
    const first = app.request("/synthesize", request());
    await started.promise;
    assert.equal((await app.request("/synthesize", request())).status, 429);
    finish.resolve();
    assert.equal((await first).status, 503);
    assert.equal((await app.request("/synthesize", request())).status, 200);
  });
  it("cancels a stalled response body at the deadline and allows retry", async () => {
    let cancelled = false, calls = 0;
    const app = createTtsRoutes("http://tts:4321", async () => {
      if (++calls > 1) return audio();
      return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "audio/wav" } });
    }, 30);
    assert.equal((await app.request("/synthesize", request())).status, 504);
    assert.equal(cancelled, true);
    assert.equal((await app.request("/synthesize", request())).status, 200);
  });
  it("propagates a real client disconnect through the proxy to synthesis", { timeout: 10_000 }, async () => {
    const started = deferred(), cancelled = deferred();
    const service = serve({ hostname: "127.0.0.1", port: 0, fetch: createTtsServiceRoutes({
      ready: true, busy: false,
      async generate(_text, signal) {
        started.resolve();
        return new Promise<Buffer>((_resolve, reject) => {
          signal.addEventListener("abort", () => { cancelled.resolve(); reject(signal.reason); }, { once: true });
        });
      },
    }).fetch });
    await once(service, "listening");
    const serviceAddress = service.address(); assert.ok(serviceAddress && typeof serviceAddress !== "string");
    const proxy = serve({ hostname: "127.0.0.1", port: 0, fetch: createTtsRoutes(`http://127.0.0.1:${serviceAddress.port}`).fetch });
    await once(proxy, "listening");
    try {
      const address = proxy.address(); assert.ok(address && typeof address !== "string");
      const abort = new AbortController();
      const response = fetch(`http://127.0.0.1:${address.port}/synthesize`, { ...request(), signal: abort.signal }).catch(error => error);
      await started.promise;
      abort.abort();
      await response;
      await cancelled.promise;
    } finally {
      for (const server of [proxy, service]) { server.close(); if ("closeAllConnections" in server) server.closeAllConnections(); }
    }
  });
});
