import workletUrl from "./capture-worklet.js?worker&url";
import { encodeVoiceWave, VoiceSegment } from "./audio";
import { defaultVoiceSettings, inputLevel, microphoneConstraints, normalizeVoiceSettings, type VoiceSettings } from "./voiceSettings";
import { resumeVoiceAudio } from "./resumeVoiceAudio";

export interface MicrophoneInfo { label: string; sampleRate: number; channels: number | undefined }

export type VoicePhase = "off" | "loading" | "armed" | "capturing" | "transcribing" | "review" | "speaking";
interface Callbacks {
  phase: (phase: VoicePhase) => void;
  transcript: (text: string, utteranceId: string) => void;
  notice: (message: string) => void;
  error: (message: string) => void;
  microphone?: (info: MicrophoneInfo | null) => void;
  level?: (level: ReturnType<typeof inputLevel> | null) => void;
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
  private audioEpoch = 0;
  private speechPaused = false;
  private speechTail: ReturnType<typeof setTimeout> | undefined;
  private transcription: AbortController | undefined;
  private levelAt = 0;
  private settings: VoiceSettings;
  constructor(private callbacks: Callbacks, settings: VoiceSettings = defaultVoiceSettings) {
    this.settings = normalizeVoiceSettings(settings);
  }

  private setPhase(phase: VoicePhase) {
    this.phase = phase;
    if (this.speechPaused || !["armed", "capturing"].includes(phase)) this.callbacks.level?.(null);
    if (!this.stopped) this.callbacks.phase(this.speechPaused ? "speaking" : phase);
  }

  async start(): Promise<void> {
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access requires localhost or HTTPS in a supported browser.");
      }
      this.setPhase("loading");
      this.context = new AudioContext();
      await resumeVoiceAudio(this.context, this.abort.signal);
      if (this.stopped) return;
      const stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(this.settings.deviceId));
      if (this.stopped) { stream.getTracks().forEach(track => track.stop()); return; }
      this.microphone = stream;
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error("The selected device did not provide microphone audio.");
      const actual = track.getSettings();
      this.callbacks.microphone?.({ label: track.label || "Microphone", sampleRate: this.context.sampleRate, channels: actual.channelCount });
      stream.getTracks().forEach(track => track.addEventListener("ended", () => this.fail("Microphone disconnected. Enable voice to reconnect.")));
      const response = await fetch("/api/voice/status", { signal: this.abort.signal });
      const status = await response.json() as { ready?: boolean; message?: string };
      if (!response.ok || !status.ready) throw new Error(status.message ?? "Local voice is unavailable.");
      await this.loadWakeDetector();
      if (this.stopped) return;
      await this.context.audioWorklet.addModule(workletUrl);
      if (this.stopped) return;
      this.source = this.context.createMediaStreamSource(stream);
      // Downmix devices that ignore the mono request before the worklet reads channel 0.
      this.capture = new AudioWorkletNode(this.context, "voice-capture", { channelCount: 1, channelCountMode: "explicit" });
      this.capture.port.onmessage = event => {
        const message = event.data as { epoch: number; samples: Float32Array };
        if (message.epoch === this.audioEpoch) this.onFrame(message.samples);
      };
      this.capture.onprocessorerror = () => this.fail("Microphone processing stopped. Enable voice to reconnect.");
      this.context.onstatechange = () => {
        if (!this.stopped && this.context?.state === "suspended") this.fail("Your browser paused the microphone. Enable voice to reconnect.");
      };
      this.source.connect(this.capture);
      this.capture.connect(this.context.destination);
      this.rearm();
    } catch (error) {
      if (!this.stopped) this.fail(error instanceof Error && ["NotFoundError", "OverconstrainedError"].includes(error.name)
        ? "The selected microphone is unavailable. Choose System default or reconnect it, then enable voice."
        : error instanceof Error && error.name === "NotAllowedError" ? "Microphone access was denied. Allow it in your browser, then enable voice."
        : error instanceof Error ? error.message : "Unable to start local voice.");
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
        const message = event.data as { type: string; message?: string; wake?: boolean; epoch?: number };
        if (message.type === "ready") {
          clearTimeout(timer);
          this.abort.signal.removeEventListener("abort", cancel);
          resolve();
        } else if (message.type === "error") {
          clearTimeout(timer);
          reject(new Error(message.message ?? "Wake-word detection failed."));
          this.fail(message.message ?? "Wake-word detection failed.");
        } else if (message.type === "processed") {
          if (message.epoch !== this.audioEpoch || this.speechPaused) return;
          this.workerBusy = false;
          if (message.wake && this.phase === "armed") {
            this.pending = [];
            this.segment = new VoiceSegment(this.preRoll, this.settings.threshold, this.settings.silenceSeconds);
            this.callbacks.notice("");
            this.setPhase("capturing");
          }
          if (this.phase === "armed") this.sendNextFrame();
        }
      };
    });
  }

  private onFrame(frame: Float32Array) {
    if (this.stopped || this.speechPaused) return;
    const now = performance.now();
    if (["armed", "capturing"].includes(this.phase) && now - this.levelAt >= 250) {
      this.levelAt = now; this.callbacks.level?.(inputLevel(frame));
    }
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
    this.worker?.postMessage({ type: "audio", samples, epoch: this.audioEpoch });
  }

  private async transcribe(samples: Float32Array) {
    const controller = new AbortController(); this.transcription = controller;
    this.setPhase("transcribing");
    this.segment = undefined;
    try {
      const response = await fetch("/api/voice/transcribe", {
        method: "POST", headers: { "Content-Type": "audio/wav" }, body: encodeVoiceWave(samples), signal: controller.signal,
      });
      const result = await response.json() as { text?: string; message?: string };
      if (this.stopped || controller.signal.aborted) return;
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
      if (!this.stopped && !controller.signal.aborted) this.fail(error instanceof Error ? error.message : "Local transcription failed.");
    } finally { if (this.transcription === controller) this.transcription = undefined; }
  }

  resume() {
    if (!this.stopped && this.phase === "review") this.rearm();
  }

  private rearm() {
    this.resetAudio();
    this.setPhase("armed");
  }

  private resetAudio() {
    this.audioEpoch++;
    this.preRoll = [];
    this.pending = [];
    this.segment = undefined;
    this.workerBusy = false;
    this.capture?.port.postMessage({ type: "reset", epoch: this.audioEpoch, paused: this.speechPaused });
    this.worker?.postMessage({ type: "reset" });
  }

  pauseForSpeech() {
    if (this.stopped) return;
    clearTimeout(this.speechTail);
    this.speechPaused = true;
    this.transcription?.abort();
    this.resetAudio();
    // A partial utterance must never survive a played reply. Preserve a review
    // pause, however, so Replay cannot submit or dismiss an unconfirmed action.
    this.setPhase(this.phase === "capturing" || this.phase === "transcribing" ? "armed" : this.phase);
  }

  finishSpeech() {
    if (this.stopped || !this.speechPaused) return;
    clearTimeout(this.speechTail);
    // Drop speaker/device tail audio before resetting both resampler and KWS.
    this.speechTail = setTimeout(() => {
      if (this.stopped) return;
      this.speechPaused = false;
      this.resetAudio();
      this.setPhase(this.phase);
    }, 400);
  }

  private fail(message: string) {
    if (this.stopped) return;
    this.stop();
    this.callbacks.error(message);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.speechTail);
    this.abort.abort();
    this.transcription?.abort();
    this.worker?.terminate();
    this.capture?.port.close();
    this.capture?.disconnect();
    this.source?.disconnect();
    this.microphone?.getTracks().forEach(track => track.stop());
    if (this.context && this.context.state !== "closed") void this.context.close().catch(() => {});
    this.preRoll = []; this.pending = []; this.segment = undefined;
    this.callbacks.microphone?.(null); this.callbacks.level?.(null);
    this.callbacks.phase("off");
  }
}
