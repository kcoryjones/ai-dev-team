import { Hono } from "hono";
import type { TtsEngine } from "./tts-engine.js";
import { maxTtsAudioBytes, maxTtsTextCharacters, readTtsBytes, readTtsInput, TtsError, ttsDeadline, ttsVoice, validateTtsWave } from "./tts-protocol.js";

function localTtsUrl(url?: string): URL | null {
  if (!url) return null;
  const base = new URL(url);
  if (base.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]", "tts"].includes(base.hostname) ||
      base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error("TTS must use a local HTTP endpoint.");
  return base;
}

const unavailable = { ready: false, voices: [], message: "Local speech output is unavailable. Start the voice profile and wait for its model to load." };

export function createTtsRoutes(serviceUrl?: string, fetcher: typeof fetch = fetch, timeoutMs = 60_000): Hono {
  const base = localTtsUrl(serviceUrl);
  return ttsRoutes({
    async status(signal) {
      if (!base) return unavailable;
      try {
        const response = await fetcher(new URL("/health", base), { signal, redirect: "error" });
        const bytes = await readTtsBytes(response.body, 4096, signal);
        const status = JSON.parse(bytes.toString("utf8")) as { ready?: boolean; busy?: boolean };
        return response.ok && status.ready === true ? { ready: true, busy: status.busy === true, voices: [ttsVoice], maxTextCharacters: maxTtsTextCharacters } : unavailable;
      } catch { return unavailable; }
    },
    async synthesize(input, signal) {
      if (!base) throw new TtsError(503, unavailable.message);
      const response = await fetcher(new URL("/synthesize", base), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal, redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw response.status === 429 ? new TtsError(429, "Local speech synthesis is busy. Please retry shortly.")
          : response.status === 504 ? new TtsError(504, "Local speech synthesis timed out.") : new TtsError(503, unavailable.message);
      }
      if (response.headers.get("content-type")?.split(";")[0] !== "audio/wav") { await response.body?.cancel(); throw new TtsError(503, "Invalid speech audio format."); }
      return validateTtsWave(await readTtsBytes(response.body, maxTtsAudioBytes, signal));
    },
  }, timeoutMs);
}

export function createTtsServiceRoutes(engine: TtsEngine): Hono {
  const app = ttsRoutes({
    async status() { return { ready: engine.ready, busy: engine.busy, voices: [ttsVoice], maxTextCharacters: maxTtsTextCharacters }; },
    async synthesize(input, signal) { return engine.generate(input.text, signal, input.speed); },
  }, 60_000);
  app.get("/health", context => context.json({ ready: engine.ready, busy: engine.busy }));
  return app;
}

function ttsRoutes(backend: {
  status(signal: AbortSignal): Promise<unknown>;
  synthesize(input: { text: string; voice: typeof ttsVoice.id; speed: number }, signal: AbortSignal): Promise<Buffer>;
}, timeoutMs: number) {
  const app = new Hono();
  let busy = false;
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.get("/status", async context => {
    const deadline = ttsDeadline(context.req.raw.signal, 3000);
    try { return context.json(await backend.status(deadline.signal)); }
    finally { deadline.dispose(); }
  });
  app.post("/synthesize", async context => {
    if (busy) return context.json({ message: "Local speech synthesis is busy. Please retry shortly." }, 429);
    busy = true;
    const deadline = ttsDeadline(context.req.raw.signal, timeoutMs);
    try {
      const input = await readTtsInput(context.req.raw, deadline.signal);
      const wave = validateTtsWave(await backend.synthesize(input, deadline.signal));
      deadline.signal.throwIfAborted();
      return new Response(new Uint8Array(wave), { headers: { "Content-Type": "audio/wav", "Content-Length": String(wave.length), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    } catch (error) {
      const failure = deadline.signal.aborted ? deadline.signal.reason : error;
      return context.json({ message: failure instanceof TtsError ? failure.message : "Local speech synthesis failed." }, failure instanceof TtsError ? failure.status : 503);
    } finally { deadline.dispose(); busy = false; }
  });
  return app;
}
