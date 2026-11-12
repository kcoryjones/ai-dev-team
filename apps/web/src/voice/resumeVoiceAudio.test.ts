import assert from "node:assert/strict";
import { it } from "node:test";
import { resumeVoiceAudio } from "./resumeVoiceAudio";

it("bounds a stalled desktop audio backend and cannot succeed on late resolution", async () => {
  let resolve!: () => void;
  const context = { state: "suspended" as AudioContextState, resume: () => new Promise<void>(done => { resolve = done; }) };
  await assert.rejects(resumeVoiceAudio(context, new AbortController().signal, 10), /audio did not start/);
  context.state = "running"; resolve();
  await resumeVoiceAudio({ state: "running", resume: async () => {} }, new AbortController().signal);
});

it("cancels pending audio startup immediately and rejects an already cancelled attempt", async () => {
  const abort = new AbortController(); let calls = 0;
  const context = { state: "suspended" as AudioContextState, resume() { calls++; return new Promise<void>(() => {}); } };
  const pending = resumeVoiceAudio(context, abort.signal);
  abort.abort(); await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(resumeVoiceAudio(context, abort.signal), { name: "AbortError" });
  assert.equal(calls, 1);
});

it("does not treat a resolved resume as usable audio while still suspended", async () => {
  await assert.rejects(resumeVoiceAudio({ state: "suspended", resume: async () => {} }, new AbortController().signal), /audio is unavailable/);
});
