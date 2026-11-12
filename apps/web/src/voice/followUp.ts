import { addressedVoiceRecipient, routeVoiceRequest, type AgentQuestionResponse, type AgentRole, type VoiceRequestRoute } from "@engineering-team/contracts";
import type { QuestionDraft } from "./questions";

export interface VoiceFollowUpContext { requestId: string; recipient: AgentRole; expiresAt: number }
export type FollowUpRoute = VoiceRequestRoute & { followUpTo?: string };

export function routeVoiceFollowUp(text: string, context: VoiceFollowUpContext | null, now = Date.now()): FollowUpRoute {
  const active = context && context.expiresAt > now ? context : null;
  const addressed = addressedVoiceRecipient(text);
  const body = text.trim().replace(/^hey[,\s]+dev\s+team\b[\s,.:!?-]*/i, "");
  // Recognize "And why?" only while an unnamed question has a live recipient.
  // Work requests still use normal review routing and never inherit this chain.
  const normalized = active && !addressed ? body.replace(/^(?:and|also)[,\s]+/i, "") : body;
  const route = routeVoiceRequest(normalized);
  if (normalized !== body) route.body = body;
  const role = route.recipient === "team" ? "project_manager" : route.recipient;
  if (active && route.intent === "question" && route.autoSubmit && (!addressed || role === active.recipient)) {
    return { ...route, recipient: addressed ? route.recipient : active.recipient, followUpTo: active.requestId };
  }
  return route;
}

/** Page-local intent only. The server supplies and validates actual history. */
export class VoiceFollowUps {
  context: VoiceFollowUpContext | null = null;
  generation = 0;
  active(now = Date.now()) { return this.context && this.context.expiresAt > now ? this.context : null; }
  reset() { this.context = null; this.generation++; }
  route(text: string, now = Date.now()): FollowUpRoute {
    const route = routeVoiceFollowUp(text, this.context, now);
    if (!route.followUpTo) this.reset();
    return route;
  }
  complete(question: QuestionDraft, receipt: AgentQuestionResponse, generation: number, now = Date.now()) {
    if (generation !== this.generation || question.source !== "voice" || receipt.run.status !== "completed") return;
    const expiresAt = Date.parse(receipt.followUpExpiresAt ?? "");
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return;
    this.context = { requestId: question.requestId, recipient: question.recipient, expiresAt };
  }
}
