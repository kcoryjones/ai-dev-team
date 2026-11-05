import { Hono } from "hono";

const sampleRate = 16_000;
export const maxVoiceBytes = 44 + sampleRate * 2 * 30;
const assets = new Map([
  ["sherpa-onnx-kws.js", "text/javascript"],
  ["sherpa-onnx-wasm-kws-main.js", "text/javascript"],
  ["sherpa-onnx-wasm-kws-main.wasm", "application/wasm"],
  ["sherpa-onnx-wasm-kws-main.data", "application/octet-stream"],
]);

/** Accept only the bounded mono PCM format produced by our microphone client. */
export function validateVoiceWave(bytes: Uint8Array): void {
  const wav = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (wav.length < 44 + sampleRate / 2 || wav.length > maxVoiceBytes ||
      wav.toString("ascii", 0, 4) !== "RIFF" || wav.readUInt32LE(4) !== wav.length - 8 ||
      wav.toString("ascii", 8, 16) !== "WAVEfmt " || wav.readUInt32LE(16) !== 16 ||
      wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1 ||
      wav.readUInt32LE(24) !== sampleRate || wav.readUInt32LE(28) !== sampleRate * 2 ||
      wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16 ||
      wav.toString("ascii", 36, 40) !== "data" || wav.readUInt32LE(40) !== wav.length - 44 ||
      (wav.length - 44) % 2 !== 0) {
    throw new Error("Expected 0.25–30 seconds of mono 16 kHz PCM WAV audio.");
  }
  let peak = 0;
  for (let offset = 44; offset < wav.length; offset += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)));
  if (peak < 100) throw new Error("No audible speech was captured. Please try again.");
}

export function createVoiceRoutes(serviceUrl?: string, fetcher: typeof fetch = fetch): Hono {
  const app = new Hono();
  const base = serviceUrl ? new URL(serviceUrl) : null;
  if (base && (base.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]", "speech"].includes(base.hostname) ||
      base.username || base.password || base.pathname !== "/" || base.search || base.hash)) {
    throw new Error("The speech service must be a local HTTP endpoint (localhost or the speech Compose service).");
  }
  let busy = false;

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/status", async (context) => {
    if (!base) return context.json({ ready: false, message: "Local voice is not configured. Start the voice profile to enable it." });
    try {
      const response = await fetcher(new URL("/health", base), { signal: AbortSignal.timeout(3_000), redirect: "error" });
      const health = await response.json() as { status?: string };
      if (response.ok && health.status === "ok") return context.json({ ready: true, wakePhrase: "Hey Dev Team", model: "base.en" });
    } catch { /* Service startup and disabled profile are normal states. */ }
    return context.json({ ready: false, message: "Local voice is unavailable. Start the voice profile and wait for the speech model to load." });
  });

  app.get("/assets/:name", async (context) => {
    const name = context.req.param("name");
    const contentType = assets.get(name);
    if (!contentType) return context.json({ message: "Unknown voice asset." }, 404);
    if (!base) return context.json({ message: "Local voice is not configured." }, 503);
    try {
      const upstream = await fetcher(new URL(`/${name}`, base), { signal: AbortSignal.timeout(60_000), redirect: "error" });
      if (!upstream.ok) throw new Error("Unavailable asset");
      return new Response(upstream.body, { headers: { "Content-Type": contentType, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" } });
    } catch {
      return context.json({ message: "Unable to load the local wake-word model. Check the speech service." }, 503);
    }
  });

  app.post("/transcribe", async (context) => {
    if (!base) return context.json({ message: "Local voice is not configured." }, 503);
    if (context.req.header("content-type")?.split(";")[0]?.trim() !== "audio/wav") {
      return context.json({ message: "Send audio/wav." }, 415);
    }
    if (busy) return context.json({ message: "A voice request is already being transcribed. Please wait." }, 429);
    busy = true;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    context.req.raw.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => abort.abort(), 60_000);
    try {
      const reader = context.req.raw.body?.getReader();
      if (!reader) return context.json({ message: "Audio is required." }, 400);
      const chunks: Uint8Array[] = [];
      let total = 0;
      const cancelRead = () => { void reader.cancel().catch(() => {}); };
      abort.signal.addEventListener("abort", cancelRead, { once: true });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxVoiceBytes) {
            await reader.cancel();
            return context.json({ message: "Voice requests are limited to 30 seconds." }, 413);
          }
          chunks.push(value);
        }
      } finally {
        abort.signal.removeEventListener("abort", cancelRead);
        reader.releaseLock();
      }
      if (abort.signal.aborted) throw new Error("Request cancelled");
      const wave = Buffer.concat(chunks);
      try { validateVoiceWave(wave); } catch (error) {
        return context.json({ message: (error as Error).message }, 400);
      }
      const form = new FormData();
      form.append("file", new Blob([wave], { type: "audio/wav" }), "request.wav");
      form.append("response_format", "json");
      form.append("temperature", "0");
      form.append("temperature_inc", "0");
      const response = await fetcher(new URL("/inference", base), {
        method: "POST", body: form, signal: abort.signal, redirect: "error",
      });
      if (!response.ok) throw new Error("Transcription service failed");
      const result = await response.json() as { text?: unknown };
      if (typeof result.text !== "string" || result.text.length > 8_000) throw new Error("Invalid transcript");
      const text = result.text.trim();
      if (!text) return context.json({ message: "No speech was recognized. Please try again." }, 422);
      // Preview only: no database writes, agent calls, or audio persistence.
      return context.json({ text });
    } catch {
      return context.json({ message: abort.signal.aborted
        ? "Transcription timed out or was cancelled. Try a shorter request."
        : "Local transcription failed. Check the speech service and try again." }, 503);
    } finally {
      clearTimeout(timer);
      context.req.raw.signal.removeEventListener("abort", onAbort);
      busy = false;
    }
  });
  return app;
}
