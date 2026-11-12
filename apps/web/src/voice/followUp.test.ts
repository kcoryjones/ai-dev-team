import assert from "node:assert/strict";
import test from "node:test";
import { voiceFollowUpTtlMs, type AgentQuestionResponse } from "@engineering-team/contracts";
import { routeVoiceFollowUp, VoiceFollowUps, type VoiceFollowUpContext } from "./followUp";
import { submitQuestion, type QuestionDraft } from "./questions";

const now = Date.parse("2026-11-09T12:00:00Z");
const context: VoiceFollowUpContext = { recipient: "architect", requestId: "previous", expiresAt: now + voiceFollowUpTtlMs };

test("unnamed follow-up questions retain their recipient, while explicit addresses override it", () => {
  for (const text of ["Hey Dev Team. And why?", "What about the tests?", "Tell me more.", "Architect, can you explain that?"]) {
    const route = routeVoiceFollowUp(text, context, now);
    assert.equal(route.recipient, "architect"); assert.equal(route.followUpTo, "previous"); assert.equal(route.autoSubmit, true);
  }
  assert.equal(routeVoiceFollowUp("And why?", context, now).body, "And why?");
  for (const [text, recipient] of [["Backend, what is next?", "backend_developer"], ["Back in developer, what is next?", "backend_developer"], ["Team, what is next?", "team"]]) {
    const route = routeVoiceFollowUp(text!, context, now);
    assert.equal(route.recipient, recipient); assert.equal(route.followUpTo, undefined);
  }
  for (const text of ["Sam, what is next?", "Architect and backend, what is next?"]) {
    const route = routeVoiceFollowUp(text, context, now);
    assert.equal(route.autoSubmit, false); assert.equal(route.followUpTo, undefined);
  }
});

test("expiry and reset restore fresh-question routing without resurrecting a pending answer", () => {
  const session = new VoiceFollowUps();
  const question: QuestionDraft = { requestId: "question", recipient: "architect", body: "What is next?", source: "voice" };
  const result = { run: { status: "completed" }, followUpExpiresAt: new Date(context.expiresAt).toISOString() } as AgentQuestionResponse;
  const generation = session.generation;
  session.complete(question, result, generation, now);
  assert.equal(session.route("Why?", now).followUpTo, "question");
  assert.equal(session.route("Why?", context.expiresAt).followUpTo, undefined);
  assert.equal(session.route("Why?", context.expiresAt).recipient, "team");
  session.reset(); session.complete(question, result, generation, now);
  assert.equal(session.context, null, "a late result or retry cannot undo New conversation");
  for (const invalid of [undefined, "invalid", new Date(now - 1).toISOString()]) {
    session.complete(question, { ...result, followUpExpiresAt: invalid ?? null }, session.generation, now);
    assert.equal(session.context, null);
  }
  session.complete(question, { ...result, run: { ...result.run, status: "failed" } }, session.generation, now);
  assert.equal(session.context, null);
  session.complete({ ...question, source: "text" }, result, session.generation, now);
  assert.equal(session.context, null);
});

test("action requests and spoken approvals never inherit or bypass follow-up question routing", () => {
  for (const text of ["Yes.", "Do that.", "Go ahead.", "Approve all plans.", "And implement that.", "Always run tests.", "Backend, for your current task, change it."]) {
    const session = new VoiceFollowUps(); session.context = context;
    const route = session.route(text, now);
    assert.equal(route.followUpTo, undefined, text); assert.equal(route.autoSubmit, false, text); assert.equal(session.context, null, text);
  }
  assert.equal(routeVoiceFollowUp("Always run tests.", context, now).recipient, "team");
  assert.equal(routeVoiceFollowUp("And why?", null, now).autoSubmit, false);
});

test("the question client sends a stable parent ID and no browser-supplied conversation", async t => {
  const bodies: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body))); return Response.json({ run: { status: "running" } });
  });
  const question: QuestionDraft = { requestId: "new", recipient: "architect", body: "Why?", source: "voice", followUpTo: "previous" };
  await submitQuestion("project", question); await submitQuestion("project", question);
  assert.deepEqual(bodies, [{ requestId: "new", body: "Why?", source: "voice", followUpTo: "previous" }, { requestId: "new", body: "Why?", source: "voice", followUpTo: "previous" }]);
});
