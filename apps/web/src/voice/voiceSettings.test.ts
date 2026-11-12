import assert from "node:assert/strict";
import { it } from "node:test";
import { defaultVoiceSettings, inputLevel, microphoneConstraints, normalizeVoiceSettings } from "./voiceSettings";
import { VoiceSegment } from "./audio";

it("rejects corrupt stored settings without enabling listening or speech", () => {
  for (const value of [null, [], "bad", { deviceId: 3, speed: Infinity, volume: -1, threshold: 0, silenceSeconds: 100, enabled: true }]) {
    assert.deepEqual(normalizeVoiceSettings(value), defaultVoiceSettings);
  }
  assert.deepEqual(normalizeVoiceSettings({ deviceId: "usb-mic", speed: 1.5, volume: 0, threshold: 0.006, silenceSeconds: 1.8, enabled: true }),
    { deviceId: "usb-mic", speed: 1.5, volume: 0, threshold: 0.006, silenceSeconds: 1.8 });
  assert.equal((microphoneConstraints("").audio as MediaTrackConstraints).deviceId, undefined);
  assert.deepEqual((microphoneConstraints("usb-mic").audio as MediaTrackConstraints).deviceId, { exact: "usb-mic" });
});

it("tunes endpoint sensitivity and silence without extending the capture cap", () => {
  const speech = new Float32Array(1600).fill(0.008), quiet = new Float32Array(1600);
  const sensitive = new VoiceSegment([], 0.006, 0.8), normal = new VoiceSegment([], 0.012, 1.2);
  for (let i = 0; i < 5; i++) { sensitive.push(speech); normal.push(speech); }
  for (let i = 0; i < 7; i++) assert.equal(sensitive.push(quiet), "continue");
  assert.equal(sensitive.push(quiet), "complete");
  for (let i = 0; i < 44; i++) assert.equal(normal.push(quiet), "continue");
  assert.equal(normal.push(quiet), "empty");
  const noisy = new VoiceSegment([], 0.006, 1.8);
  for (let i = 0; i < 299; i++) assert.equal(noisy.push(speech), "continue");
  assert.equal(noisy.push(speech), "complete"); assert.equal(noisy.samples().length, 30 * 16000);
});

it("reports silence, ordinary levels, and clipping without retaining audio", () => {
  assert.deepEqual(inputLevel(new Float32Array(1600)), { db: -60, clipping: false });
  assert.ok(Math.abs(inputLevel(new Float32Array(1600).fill(0.1)).db + 20) < 0.001);
  assert.deepEqual(inputLevel(new Float32Array(1600).fill(1)), { db: 0, clipping: true });
});
