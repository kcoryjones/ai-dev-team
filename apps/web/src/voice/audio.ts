export const voiceSampleRate = 16_000;
export const maxVoiceSamples = voiceSampleRate * 30;

/** Stateful area-average resampling, including partial samples across worklet frames. */
export class VoiceResampler {
  private remaining: number;
  private sum = 0;
  private readonly ratio: number;
  constructor(inputRate: number) {
    if (!Number.isFinite(inputRate) || inputRate < voiceSampleRate) throw new Error("Unsupported microphone sample rate.");
    this.ratio = inputRate / voiceSampleRate;
    this.remaining = this.ratio;
  }
  push(input: Float32Array): Float32Array {
    const output: number[] = [];
    for (const raw of input) {
      const sample = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      let available = 1;
      while (available > 1e-8) {
        const weight = Math.min(available, this.remaining);
        this.sum += sample * weight;
        available -= weight;
        this.remaining -= weight;
        if (this.remaining < 1e-8) {
          output.push(this.sum / this.ratio);
          this.sum = 0;
          this.remaining = this.ratio;
        }
      }
    }
    return Float32Array.from(output);
  }
}

export function encodeVoiceWave(samples: Float32Array): ArrayBuffer {
  if (samples.length > maxVoiceSamples) throw new Error("Voice requests are limited to 30 seconds.");
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const label = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  label(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true);
  label(8, "WAVEfmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, voiceSampleRate, true); view.setUint32(28, voiceSampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((raw, index) => {
    const sample = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  });
  return buffer;
}

/** Silence endpoint for V1; thresholds can be tuned after microphone trials. */
export class VoiceSegment {
  private chunks: Float32Array[];
  private count: number;
  private elapsed = 0;
  private quiet = 0;
  private speech = 0;
  constructor(preRoll: Float32Array[]) {
    this.chunks = preRoll.slice();
    this.count = preRoll.reduce((total, frame) => total + frame.length, 0);
  }
  push(frame: Float32Array): "continue" | "complete" | "empty" {
    const chunk = frame.slice(0, Math.max(0, maxVoiceSamples - this.count));
    this.chunks.push(chunk);
    this.count += chunk.length;
    this.elapsed += frame.length;
    const rms = Math.sqrt(frame.reduce((total, sample) => total + sample * sample, 0) / Math.max(1, frame.length));
    if (rms >= 0.012) { this.speech += frame.length; this.quiet = 0; }
    else this.quiet += frame.length;
    if (this.speech >= voiceSampleRate * 0.12 && this.quiet >= voiceSampleRate * 1.2) return "complete";
    if (this.count >= maxVoiceSamples) return "complete";
    if (this.elapsed >= voiceSampleRate * 5 && this.speech === 0) return "empty";
    return "continue";
  }
  samples(): Float32Array {
    const samples = new Float32Array(this.count);
    let offset = 0;
    for (const chunk of this.chunks) { samples.set(chunk, offset); offset += chunk.length; }
    return samples;
  }
}
