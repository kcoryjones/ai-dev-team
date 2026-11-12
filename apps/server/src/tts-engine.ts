import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { TtsError, ttsDeadline, ttsGenerationTimeoutMs, validateTtsWave } from "./tts-protocol.js";

export interface TtsEngine {
  readonly ready: boolean;
  readonly busy: boolean;
  generate(text: string, signal: AbortSignal, speed?: number): Promise<Buffer>;
}

/** Keep the native model warm, but isolate it so cancellation can stop CPU work. */
export class ProcessTtsEngine implements TtsEngine {
  ready = false;
  busy = false;
  private child: ChildProcess | undefined;
  private closed = false;
  private pending: { id: string; resolve: (wave: Buffer) => void; reject: (error: unknown) => void } | undefined;

  constructor(private worker: URL = new URL("./tts-worker.js", import.meta.url),
    private timeoutMs = ttsGenerationTimeoutMs, private startupMs = 30_000) {}

  async start(): Promise<void> {
    if (this.closed) throw new TtsError(503, "Local speech synthesis is stopped.");
    const child = fork(this.worker, [], { serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"] });
    this.child = child;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new TtsError(503, "The local voice model did not load in time.")), this.startupMs);
        const stopped = () => {
          clearTimeout(timer);
          if (this.child === child) { this.ready = false; this.pending?.reject(new TtsError(503, "The speech worker stopped.")); }
          reject(new TtsError(503, "Unable to load the local voice model."));
        };
        child.once("error", stopped);
        child.once("close", stopped);
        child.on("message", (message: { type?: string; id?: string; wave?: unknown }) => {
          if (this.child !== child) return;
          if (message.type === "ready") { clearTimeout(timer); this.ready = true; resolve(); return; }
          if (!this.pending || message.id !== this.pending.id) return;
          try {
            if (message.type !== "audio" || !Buffer.isBuffer(message.wave)) throw new TtsError(503, "Local speech synthesis failed.");
            this.pending.resolve(validateTtsWave(message.wave));
          } catch (error) { this.pending.reject(error); }
        });
      });
    } catch (error) { await this.stopChild(); throw error; }
  }

  async generate(text: string, signal: AbortSignal, speed = 1): Promise<Buffer> {
    signal.throwIfAborted();
    if (this.busy) throw new TtsError(429, "Local speech synthesis is busy. Please retry shortly.");
    if (!this.ready || !this.child || this.closed) throw new TtsError(503, "The local voice model is unavailable or loading.");
    this.busy = true;
    const deadline = ttsDeadline(signal, this.timeoutMs);
    const cancel = () => this.pending?.reject(deadline.signal.reason);
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const id = randomUUID();
        this.pending = { id, resolve, reject };
        deadline.signal.addEventListener("abort", cancel, { once: true });
        if (deadline.signal.aborted) { cancel(); return; }
        this.child!.send({ id, text, speed }, error => { if (error) reject(new TtsError(503, "Unable to reach the speech worker.")); });
      });
    } catch (error) {
      // Admission remains busy until the old process has exited and replacement
      // has loaded. Native inference cannot continue after a cancelled request.
      await this.stopChild();
      if (!this.closed) await this.start().catch(() => {});
      throw error;
    } finally {
      deadline.signal.removeEventListener("abort", cancel); deadline.dispose();
      this.pending = undefined; this.busy = false;
    }
  }

  private async stopChild() {
    const child = this.child;
    this.ready = false;
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close").catch(() => {});
      child.kill("SIGKILL");
      await closed;
    }
    if (this.child === child) this.child = undefined;
  }

  async close() {
    this.closed = true;
    this.pending?.reject(new TtsError(503, "Local speech synthesis is stopping."));
    await this.stopChild();
  }
}
