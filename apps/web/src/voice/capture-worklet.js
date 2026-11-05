import { VoiceResampler } from "./audio";

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new VoiceResampler(sampleRate);
    this.frame = new Float32Array(1600);
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (const sample of this.resampler.push(channel)) {
        this.frame[this.offset++] = sample;
        if (this.offset === this.frame.length) {
          this.port.postMessage(this.frame, [this.frame.buffer]);
          this.frame = new Float32Array(1600);
          this.offset = 0;
        }
      }
    }
    // Output remains silent; connecting the node keeps capture active without feedback.
    return true;
  }
}
registerProcessor("voice-capture", VoiceCaptureProcessor);
