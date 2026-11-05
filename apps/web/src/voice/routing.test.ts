import assert from "node:assert/strict";
import test from "node:test";
import { agentRoles, routeVoiceQuestion, routeVoiceRequest } from "@engineering-team/contracts";

test("spoken role names route to every agent and team questions default to the PM", () => {
  const names = ["Project Manager", "Architect", "Tech Lead", "Backend Developer", "Frontend Developer", "Dev Ops Database Engineer", "QA Engineer", "Code Reviewer", "Security Reviewer", "Release Manager"];
  for (const [index, name] of names.entries()) {
    const result = routeVoiceQuestion(`Hey Dev Team. ${name}, what is blocking progress?`);
    assert.equal(result.status, "ready", name);
    assert.equal(result.recipient, agentRoles[index], name);
    assert.equal(result.question, "what is blocking progress?");
  }
  for (const input of ["What’s the status?", "Team, what is blocked?", "Everyone. Summarize progress.", "Please tell me about the backend."]) {
    assert.equal(routeVoiceQuestion(input).recipient, "project_manager");
    assert.equal(routeVoiceQuestion(input).status, "ready", input);
  }
  assert.equal(routeVoiceQuestion("Back end, could you explain the API?").recipient, "backend_developer");
  assert.equal(routeVoiceQuestion("Q A, is testing finished?").recipient, "qa_engineer");
  assert.equal(routeVoiceQuestion("What does the architect think?").recipient, "project_manager");
});

test("unclear recipients, statements and work directives wait for clarification", () => {
  for (const input of ["Sam, what is blocked?", "Architect and Backend, what is blocked?", "Architect or Backend, what is blocked?", "Architect", "", "Please fix the API", "Can you deploy the app?", "Backend, from now on always run tests", "Architect, build a new system", "The release is probably ready."]) {
    assert.equal(routeVoiceQuestion(input).status, "clarify", input);
  }
  assert.equal(routeVoiceQuestion("Sam, what is blocked?").recipient, null);
  assert.equal(routeVoiceQuestion("Architect and Backend, what is blocked?").recipient, null);
  assert.equal(routeVoiceQuestion("What " + "x".repeat(2000)).status, "clarify");
  assert.equal(routeVoiceQuestion("Architect, how should we fix the API?").status, "ready");
});

test("voice work, guidance and standing instructions require review and preserve scope", () => {
  for (const [text, action, recipient] of [
    ["Hey Dev Team. Backend, build a health endpoint.", "new_work", "backend_developer"],
    ["Architect, design the auth boundary.", "new_work", "architect"],
    ["Backend, for your current task, keep the API compatible.", "guidance", "backend_developer"],
    ["Team, from now on always document tests.", "directive_add", "team"],
    ["Project Manager, always ask about missing requirements.", "directive_add", "project_manager"],
    ["Security, never log credentials.", "directive_add", "security_reviewer"],
    ["Team, remove the instruction to always document tests.", "directive_remove", "team"],
  ] as const) {
    const route = routeVoiceRequest(text);
    assert.equal(route.intent, action, text); assert.equal(route.recipient, recipient, text); assert.equal(route.autoSubmit, false);
  }
  assert.equal(routeVoiceRequest("Team, from now on always document tests.").body, "always document tests.");
  for (const text of ["Sam, build an endpoint.", "Architect and Backend, build an endpoint.", "Approve all plans.", "Cancel the task."]) assert.equal(routeVoiceRequest(text).autoSubmit, false);
  assert.equal(routeVoiceRequest("How is the team doing?").autoSubmit, true);
  assert.equal(routeVoiceRequest("Architect, can you explain the design?").intent, "question");
});
