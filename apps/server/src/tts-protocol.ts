import { ttsVoice, ttsSpeedRange, maxTtsTextCharacters, maxTtsRequestBytes, maxTtsAudioBytes } from "@engineering-team/contracts";
export { ttsVoice, maxTtsTextCharacters, maxTtsRequestBytes, maxTtsAudioSeconds, maxTtsAudioBytes } from "@engineering-team/contracts";
export const ttsGenerationTimeoutMs = 45_000;

export class TtsError extends Error {
  constructor(readonly status: 400 | 413 | 415 | 429 | 503 | 504, message: string) { super(message); }
}

export function parseTtsRequest(value: unknown): { text: string; voice: typeof ttsVoice.id; speed: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TtsError(400, "Provide text to speak.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "text" && key !== "voice" && key !== "speed") ||
      typeof input.text !== "string" || !input.text.trim() || input.text.length > maxTtsTextCharacters ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text) ||
      (input.voice !== undefined && input.voice !== ttsVoice.id)) {
    throw new TtsError(400, `Provide 1–${maxTtsTextCharacters} characters and a supported voice.`);
  }
  const speed = input.speed === undefined ? ttsSpeedRange.default : input.speed;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed < ttsSpeedRange.min || speed > ttsSpeedRange.max) {
    throw new TtsError(400, `Speaking speed must be between ${ttsSpeedRange.min} and ${ttsSpeedRange.max}.`);
  }
  return { text: input.text.trim(), voice: ttsVoice.id, speed };
}

/** All synthesized audio uses one bounded PCM format, independent of browser decoding. */
export function validateTtsWave(bytes: Uint8Array): Buffer {
  const wave = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (wave.length <= 44 || wave.length > maxTtsAudioBytes || wave.toString("ascii", 0, 4) !== "RIFF" ||
      wave.readUInt32LE(4) !== wave.length - 8 || wave.toString("ascii", 8, 16) !== "WAVEfmt " ||
      wave.readUInt32LE(16) !== 16 || wave.readUInt16LE(20) !== 1 || wave.readUInt16LE(22) !== 1 ||
      wave.readUInt32LE(24) !== ttsVoice.sampleRate || wave.readUInt32LE(28) !== ttsVoice.sampleRate * 2 ||
      wave.readUInt16LE(32) !== 2 || wave.readUInt16LE(34) !== 16 || wave.toString("ascii", 36, 40) !== "data" ||
      wave.readUInt32LE(40) !== wave.length - 44 || (wave.length - 44) % 2) {
    throw new TtsError(503, "Local speech synthesis returned invalid audio.");
  }
  return wave;
}

export function ttsDeadline(parent: AbortSignal, milliseconds: number) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new TtsError(503, "Speech synthesis was cancelled."));
  const timer = setTimeout(() => controller.abort(new TtsError(504, "Local speech synthesis timed out.")), milliseconds);
  parent.addEventListener("abort", cancel, { once: true });
  if (parent.aborted) cancel();
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener("abort", cancel); } };
}

export async function readTtsBytes(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  if (!body) throw new TtsError(400, "A request body is required.");
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new TtsError(413, "Speech request or audio exceeds the size limit."); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

export async function readTtsInput(request: Request, signal: AbortSignal) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new TtsError(415, "Send application/json.");
  const bytes = await readTtsBytes(request.body, maxTtsRequestBytes, signal);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new TtsError(400, "Invalid speech request JSON."); }
  return parseTtsRequest(value);
}
