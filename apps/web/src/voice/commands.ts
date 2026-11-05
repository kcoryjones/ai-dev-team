import type { VoiceCommandInput, VoiceCommandReceipt } from "@engineering-team/contracts";

async function commandRequest(path: string, signal: AbortSignal, body?: unknown): Promise<VoiceCommandReceipt> {
  const response = await fetch(path, { signal, cache: "no-store", ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "Unable to process this voice action.");
  return data as VoiceCommandReceipt;
}
export const previewCommand = (projectId: string, input: VoiceCommandInput, signal: AbortSignal) => commandRequest(`/api/projects/${projectId}/voice/commands/preview`, signal, input);
export const readCommand = (projectId: string, requestId: string, signal: AbortSignal) => commandRequest(`/api/projects/${projectId}/voice/commands/${requestId}`, signal);
export const confirmCommand = (projectId: string, requestId: string, signal: AbortSignal) => commandRequest(`/api/projects/${projectId}/voice/commands/${requestId}/confirm`, signal, { confirmed: true });
