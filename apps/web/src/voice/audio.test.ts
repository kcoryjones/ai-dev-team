import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeVoiceWave, maxVoiceSamples, VoiceResampler, VoiceSegment } from "./audio";

describe("local microphone audio", () => {
  for (const rate of [16_000, 44_100, 48_000]) {
    it(`preserves duration and continuity at ${rate} Hz across worklet frames`, () => {
      const input = Float32Array.from({ length: rate }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / rate));
      const expected = new VoiceResampler(rate).push(input);
      const resampler = new VoiceResampler(rate);
      const chunks: number[] = [];
      for (let i = 0; i < input.length; i += 128) chunks.push(...resampler.push(input.subarray(i, i + 128)));
      assert.equal(chunks.length, 16_000);
      assert.deepEqual(Float32Array.from(chunks), expected);
      const rms = Math.sqrt(chunks.reduce((sum, n) => sum + n * n, 0) / chunks.length);
      assert.ok(rms > 0.69 && rms < 0.72);
    });
  }
  it("encodes a bounded standard PCM wave and clamps non-finite microphone values", () => {
    const view = new DataView(encodeVoiceWave(new Float32Array([-2, -1, 0, 1, 2, NaN])));
    assert.equal(view.byteLength, 56);
    assert.equal(view.getUint32(24, true), 16_000);
    assert.equal(view.getUint32(40, true), 12);
    assert.deepEqual(Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true)), [-32768, -32768, 0, 32767, 32767, 0]);
    assert.throws(() => encodeVoiceWave(new Float32Array(maxVoiceSamples + 1)), /30 seconds/);
    assert.throws(() => new VoiceResampler(0), /sample rate/);
  });
  it("keeps pre-roll, tolerates a short pause, and finishes after sustained silence", () => {
    const segment = new VoiceSegment([new Float32Array(1600).fill(0.1)]);
    const speech = new Float32Array(1600).fill(0.2);
    const silence = new Float32Array(1600);
    segment.push(speech); segment.push(speech);
    for (let i = 0; i < 8; i++) assert.equal(segment.push(silence), "continue");
    assert.equal(segment.push(speech), "continue");
    for (let i = 0; i < 11; i++) assert.equal(segment.push(silence), "continue");
    assert.equal(segment.push(silence), "complete");
    assert.ok(Math.abs(segment.samples()[0]! - 0.1) < 0.001);
  });
  it("times out an empty wake and caps continuous speech at 30 seconds", () => {
    const empty = new VoiceSegment([]);
    for (let i = 0; i < 49; i++) assert.equal(empty.push(new Float32Array(1600)), "continue");
    assert.equal(empty.push(new Float32Array(1600)), "empty");
    const long = new VoiceSegment([new Float32Array(32000)]);
    let result = "continue";
    while (result === "continue") result = long.push(new Float32Array(1600).fill(0.2));
    assert.equal(result, "complete");
    assert.equal(long.samples().length, maxVoiceSamples);
  });
});
