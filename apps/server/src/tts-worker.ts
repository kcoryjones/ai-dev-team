import { createRequire } from "node:module";
import { join } from "node:path";
import { maxTtsAudioSeconds, parseTtsRequest, ttsVoice, validateTtsWave } from "./tts-protocol.js";

// The native addon is installed only in the dedicated TTS image.
const requireTts = createRequire(process.env.ENGINEERING_TEAM_TTS_RUNTIME ?? "/opt/tts/package.json");
const sherpa = requireTts("sherpa-onnx-node") as {
  OfflineTts: new (config: unknown) => { generate(input: { text: string; sid: number; speed: number }): { samples: Float32Array; sampleRate: number } };
};
const root = join(process.env.ENGINEERING_TEAM_TTS_MODEL_ROOT ?? "/models", "vits-piper-en_US-ljspeech-medium");
const engine = new sherpa.OfflineTts({ model: {
  vits: { model: join(root, `${ttsVoice.id}.onnx`), tokens: join(root, "tokens.txt"), dataDir: join(root, "espeak-ng-data") },
  numThreads: 2, provider: "cpu", debug: false,
}, maxNumSentences: 1 });

process.on("message", (input: { id: string; text: string; speed?: number }) => {
  try {
    const { text, speed } = parseTtsRequest({ text: input.text, speed: input.speed });
    const audio = engine.generate({ text, sid: 0, speed });
    if (audio.sampleRate !== ttsVoice.sampleRate || audio.samples.length > audio.sampleRate * maxTtsAudioSeconds) throw new Error("Audio limit");
    const wave = Buffer.alloc(44 + audio.samples.length * 2);
    wave.write("RIFF"); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8);
    wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(audio.sampleRate, 24); wave.writeUInt32LE(audio.sampleRate * 2, 28);
    wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
    audio.samples.forEach((sample, index) => {
      if (!Number.isFinite(sample)) throw new Error("Invalid audio sample");
      const value = Math.max(-1, Math.min(1, sample));
      wave.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), 44 + index * 2);
    });
    process.send?.({ type: "audio", id: input.id, wave: validateTtsWave(wave) });
  } catch { process.send?.({ type: "error", id: input.id }); }
});
process.send?.({ type: "ready" });
