import workletUrl from "./capture-worklet.js?worker&url";
import { encodeVoiceWave, VoiceSegment } from "./audio";

export type VoicePhase = "off" | "loading" | "armed" | "capturing" | "transcribing" | "review";
interface Callbacks {
  phase: (phase: VoicePhase) => void;
  transcript: (text: string, utteranceId: string) => void;
  notice: (message: string) => void;
  error: (message: string) => void;
}

export class LocalVoiceSession {
  private stopped = false;
  private abort = new AbortController();
  private microphone?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private capture?: AudioWorkletNode;
  private worker?: Worker;
  private phase: VoicePhase = "off";
  private preRoll: Float32Array[] = [];
  private segment: VoiceSegment | undefined;
  private workerBusy = false;
  private pending: Float32Array[] = [];
  constructor(private callbacks: Callbacks) {}

  private setPhase(phase: VoicePhase) {
    this.phase = phase;
    if (!this.stopped) this.callbacks.phase(phase);
  }

  async start(): Promise<void> {
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access requires localhost or HTTPS in a supported browser.");
      }
      this.setPhase("loading");
      this.context = new AudioContext();
      await this.context.resume();
      if (this.stopped) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      if (this.stopped) { stream.getTracks().forEach(track => track.stop()); return; }
      this.microphone = stream;
      stream.getTracks().forEach(track => track.addEventListener("ended", () => this.fail("Microphone disconnected. Enable voice to reconnect.")));
      const response = await fetch("/api/voice/status", { signal: this.abort.signal });
      const status = await response.json() as { ready?: boolean; message?: string };
      if (!response.ok || !status.ready) throw new Error(status.message ?? "Local voice is unavailable.");
      await this.loadWakeDetector();
      if (this.stopped) return;
      await this.context.audioWorklet.addModule(workletUrl);
      if (this.stopped) return;
      this.source = this.context.createMediaStreamSource(stream);
      this.capture = new AudioWorkletNode(this.context, "voice-capture");
      this.capture.port.onmessage = event => this.onFrame(event.data as Float32Array);
      this.capture.onprocessorerror = () => this.fail("Microphone processing stopped. Enable voice to reconnect.");
      this.context.onstatechange = () => {
        if (!this.stopped && this.context?.state === "suspended") this.fail("Your browser paused the microphone. Enable voice to reconnect.");
      };
      this.source.connect(this.capture);
      this.capture.connect(this.context.destination);
      this.setPhase("armed");
    } catch (error) {
      if (!this.stopped) this.fail(error instanceof Error ? error.message : "Unable to start local voice.");
    }
  }

  private loadWakeDetector(): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker("/voice/wake-worker.js");
      this.worker = worker;
      const timer = setTimeout(() => reject(new Error("Loading the local wake-word model timed out.")), 60_000);
      const cancel = () => { clearTimeout(timer); reject(new Error("Cancelled")); };
      this.abort.signal.addEventListener("abort", cancel, { once: true });
      worker.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Unable to load the local wake-word engine."));
        this.fail("The local wake-word engine stopped. Enable voice to retry.");
      };
      worker.onmessage = event => {
        if (this.stopped) return;
        const message = event.data as { type: string; message?: string; wake?: boolean };
        if (message.type === "ready") {
          clearTimeout(timer);
          this.abort.signal.removeEventListener("abort", cancel);
          resolve();
        } else if (message.type === "error") {
          clearTimeout(timer);
          reject(new Error(message.message ?? "Wake-word detection failed."));
          this.fail(message.message ?? "Wake-word detection failed.");
        } else if (message.type === "processed") {
          this.workerBusy = false;
          if (message.wake && this.phase === "armed") {
            this.pending = [];
            this.segment = new VoiceSegment(this.preRoll);
            this.callbacks.notice("");
            this.setPhase("capturing");
          }
          if (this.phase === "armed") this.sendNextFrame();
        }
      };
    });
  }

  private onFrame(frame: Float32Array) {
    if (this.stopped) return;
    if (this.phase === "armed") {
      this.preRoll.push(frame);
      if (this.preRoll.length > 20) this.preRoll.shift(); // Two seconds preserve words spoken immediately after waking.
      this.pending.push(frame);
      if (this.pending.length > 20) {
        this.fail("Wake-word detection cannot keep up on this device. Try closing other busy applications.");
        return;
      }
      this.sendNextFrame();
    } else if (this.phase === "capturing" && this.segment) {
      const result = this.segment.push(frame);
      if (result === "complete") void this.transcribe(this.segment.samples());
      else if (result === "empty") {
        this.callbacks.notice("No request followed the wake phrase. Try again after saying ‘Hey Dev Team’.");
        this.rearm();
      }
    }
  }

  private sendNextFrame() {
    if (this.workerBusy || !this.pending.length) return;
    const samples = this.pending.shift()!;
    this.workerBusy = true;
    this.worker?.postMessage({ type: "audio", samples });
  }

  private async transcribe(samples: Float32Array) {
    this.setPhase("transcribing");
    this.segment = undefined;
    try {
      const response = await fetch("/api/voice/transcribe", {
        method: "POST", headers: { "Content-Type": "audio/wav" }, body: encodeVoiceWave(samples), signal: this.abort.signal,
      });
      const result = await response.json() as { text?: string; message?: string };
      if (this.stopped) return;
      if (!response.ok || typeof result.text !== "string") throw new Error(result.message ?? "Local transcription failed.");
      const text = result.text.replace(/^\s*hey[,\s]+dev\s+team[\s,.:!?-]*/i, "").trim();
      if (text) {
        this.setPhase("review"); this.preRoll = [];
        this.callbacks.transcript(text, crypto.randomUUID());
      } else {
        this.callbacks.notice("Only the wake phrase was heard. Say your request after ‘Hey Dev Team’.");
        this.rearm();
      }
    } catch (error) {
      if (!this.stopped) this.fail(error instanceof Error ? error.message : "Local transcription failed.");
    }
  }

  resume() {
    if (!this.stopped && this.phase === "review") this.rearm();
  }

  private rearm() {
    this.preRoll = [];
    this.pending = [];
    this.segment = undefined;
    this.worker?.postMessage({ type: "reset" });
    this.setPhase("armed");
  }

  private fail(message: string) {
    if (this.stopped) return;
    this.stop();
    this.callbacks.error(message);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.worker?.terminate();
    this.capture?.port.close();
    this.capture?.disconnect();
    this.source?.disconnect();
    this.microphone?.getTracks().forEach(track => track.stop());
    if (this.context && this.context.state !== "closed") void this.context.close().catch(() => {});
    this.preRoll = []; this.pending = []; this.segment = undefined;
    this.callbacks.phase("off");
  }
}
