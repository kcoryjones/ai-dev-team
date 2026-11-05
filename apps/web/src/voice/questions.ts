import type { AgentQuestionInput, AgentQuestionResponse, AgentRole } from "@engineering-team/contracts";

export interface QuestionDraft { requestId: string; recipient: AgentRole; body: string; source: "voice" | "text" }

export async function submitQuestion(projectId: string, question: QuestionDraft, signal?: AbortSignal): Promise<AgentQuestionResponse> {
  const payload: AgentQuestionInput = { requestId: question.requestId, body: question.body, source: question.source };
  const response = await fetch(`/api/projects/${projectId}/agents/${question.recipient}/questions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), ...(signal ? { signal } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "Unable to ask this question.");
  return data as AgentQuestionResponse;
}

export async function readQuestion(projectId: string, requestId: string, signal: AbortSignal): Promise<AgentQuestionResponse> {
  const response = await fetch(`/api/projects/${projectId}/questions/${requestId}`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error("Unable to retrieve the answer. Retry to reconnect to the same question.");
  return await response.json() as AgentQuestionResponse;
}

export function questionPending(question: AgentQuestionResponse): boolean {
  return ["queued", "provisioning", "running", "waiting"].includes(question.run.status);
}

export function waitForQuestionPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Cancelled")); return; }
    const abort = () => { clearTimeout(timer); reject(new Error("Cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1500);
    signal.addEventListener("abort", abort, { once: true });
  });
}
