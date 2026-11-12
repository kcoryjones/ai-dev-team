import { maxTtsAudioBytes, maxTtsAudioSeconds } from "@engineering-team/contracts";
import { normalizeVoiceSettings } from "./voiceSettings";

export type SpeechPhase = "idle" | "preparing" | "playing";
interface Callbacks {
  phase: (phase: SpeechPhase) => void;
  active: (active: boolean) => void;
  error: (message: string) => void;
}

export class LocalSpeechPlayer {
  private context: AudioContext | undefined;
  private source: AudioBufferSourceNode | undefined;
  private gain: GainNode | undefined;
  private speed = 1;
  private volume = 1;
  private request: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private disposed = false;
  private active = false;
  constructor(private callbacks: Callbacks, private fetcher: typeof fetch = (input, init) => fetch(input, init),
    private createContext: () => AudioContext = () => new AudioContext(), private requestTimeout = 65_000) {}

  configure(settings: { speed: number; volume: number }) {
    const { speed, volume } = normalizeVoiceSettings(settings);
    this.speed = speed; this.volume = volume;
    if (this.gain && this.context) {
      this.gain.gain.cancelScheduledValues(this.context.currentTime);
      this.gain.gain.setTargetAtTime(volume, this.context.currentTime, 0.015);
    }
  }

  /** Called directly from a click so the browser can authorize audio playback. */
  async prepare() {
    if (this.disposed) return;
    const context = this.context ??= this.createContext();
    context.onstatechange = () => {
      if (this.context === context && this.active && context.state !== "running") {
        this.finish(this.generation, "Your browser paused speech. Use Replay reply to try again.");
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([context.resume(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Audio playback is blocked. Use Replay reply to try again.")), 3000);
      })]);
      if (context.state !== "running") throw new Error("Audio playback is unavailable. Use Replay reply to try again.");
    } finally { clearTimeout(timer); }
  }

  async speak(text: string, userGesture = false) {
    if (this.disposed) return;
    this.cancelResources();
    const generation = ++this.generation;
    const speed = this.speed; // Changes apply to the next request, including Replay.
    const request = new AbortController(); this.request = request;
    this.active = true; this.callbacks.active(true); this.callbacks.error(""); this.callbacks.phase("preparing");
    this.timer = setTimeout(() => this.finish(generation, "Local speech timed out. Use Replay reply to try again."), this.requestTimeout);
    try {
      if (userGesture) await this.prepare();
      if (!this.current(generation)) return;
      const context = this.context;
      if (!context || context.state !== "running") throw new Error("Audio playback needs a click. Use Replay reply to continue.");
      const response = await this.fetcher("/api/voice/tts/synthesize", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, speed }), signal: request.signal, cache: "no-store",
      });
      if (!this.current(generation)) { await response.body?.cancel(); return; }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(response.status === 429 ? "Local speech is busy. Use Replay reply shortly." : "Local speech output is unavailable. Check the speech service, then use Replay reply.");
      }
      if (response.headers.get("content-type")?.split(";")[0] !== "audio/wav" || !response.body) {
        await response.body?.cancel(); throw new Error("The speech service returned invalid audio.");
      }
      const bytes = await readSpeechAudio(response.body, request.signal);
      if (!this.current(generation)) return;
      const buffer = await context.decodeAudioData(bytes);
      if (!this.current(generation)) return;
      if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > maxTtsAudioSeconds || buffer.numberOfChannels !== 1) throw new Error("The speech service returned invalid audio.");
      if (context.state !== "running") throw new Error("Your browser paused speech. Use Replay reply to try again.");
      const source = context.createBufferSource(); this.source = source;
      const gain = context.createGain(); this.gain = gain;
      gain.gain.setValueAtTime(this.volume, context.currentTime);
      source.buffer = buffer; source.connect(gain); gain.connect(context.destination);
      source.onended = () => this.finish(generation);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.finish(generation, "Playback stopped responding. Use Replay reply to try again."), (buffer.duration + 3) * 1000);
      source.start(); this.callbacks.phase("playing");
    } catch (error) {
      if (this.current(generation)) this.finish(generation, error instanceof Error ? error.message : "Unable to play the reply.");
    }
  }

  private current(generation: number) { return !this.disposed && this.active && generation === this.generation; }
  private cancelResources() {
    clearTimeout(this.timer); this.timer = undefined;
    this.request?.abort(); this.request = undefined;
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch { /* Already ended. */ }
      this.source.disconnect(); this.source = undefined;
    }
    this.gain?.disconnect(); this.gain = undefined;
  }
  private finish(generation: number, message?: string) {
    if (!this.current(generation)) return;
    this.cancelResources(); this.active = false;
    this.callbacks.phase("idle"); this.callbacks.active(false);
    if (message) this.callbacks.error(message);
  }
  stop() { this.finish(this.generation); this.generation++; }
  disable() {
    this.stop();
    const context = this.context; this.context = undefined;
    if (context) { context.onstatechange = null; void context.close().catch(() => {}); }
  }
  dispose() { this.disable(); this.disposed = true; }
}

async function readSpeechAudio(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<ArrayBuffer> {
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.length;
      if (length > maxTtsAudioBytes) { await reader.cancel(); throw new Error("The speech audio exceeds the size limit."); }
      chunks.push(value);
    }
    if (length <= 44) throw new Error("The speech service returned empty audio.");
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes.buffer;
  } finally { reader.releaseLock(); signal.removeEventListener("abort", cancel); }
}
