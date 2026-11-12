import { voiceRoleLabels, type AgentRole, type VoiceCommandReceipt } from "@engineering-team/contracts";

export interface SpokenReply { id: string; text: string; shortened: boolean }

/** Read a short prose excerpt. Full answers, code, and links remain on screen. */
export function spokenAnswer(id: string, role: AgentRole, answer: string): SpokenReply {
  let omitted = false;
  const plain = answer.replace(/```[\s\S]*?(?:```|$)/g, () => { omitted = true; return " "; })
    .replace(/!\[[^\]]*\]\([^)]*\)/g, () => { omitted = true; return " "; })
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, () => { omitted = true; return " "; })
    .replace(/^[\t ]*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_`~]/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const words = plain.split(" ");
  const excerpt = words.slice(0, 120).join(" ").slice(0, 850);
  const shortened = omitted || excerpt.length < plain.length;
  const clipped = excerpt.length < plain.length ? excerpt.slice(0, excerpt.lastIndexOf(" ")).replace(/[,:;.!?]+$/, "") + "." : excerpt;
  return { id, shortened, text: `${voiceRoleLabels[role]}. ${clipped || "The reply is ready."}${shortened ? " Full reply is shown on screen." : ""}` };
}

export function spokenAcknowledgement(receipt: VoiceCommandReceipt): SpokenReply | null {
  if (receipt.status !== "applied") return null;
  // The receipt message describes acceptance; it must not imply that a queued
  // plan or implementation has finished. Never read the directive back aloud.
  const messages = {
    new_work: "Work request accepted. Check the conversation for planning progress and any required approval.",
    guidance: "Task guidance accepted. Check the task for progress.",
    directive_add: "Standing instruction saved.",
    directive_remove: "Standing instruction removed.",
  };
  return { id: `command:${receipt.input.requestId}`, text: messages[receipt.input.action], shortened: false };
}

/** Receipts are consumed even when audio is off or fails; only Replay retries. */
export class SpokenReplyHistory {
  private seen = new Set<string>();
  accept(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value!);
    return true;
  }
}
