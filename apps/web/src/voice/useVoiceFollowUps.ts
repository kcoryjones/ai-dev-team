import { useEffect, useRef, useState } from "react";
import type { AgentQuestionResponse } from "@engineering-team/contracts";
import { VoiceFollowUps, type VoiceFollowUpContext } from "./followUp";
import type { QuestionDraft } from "./questions";

export function useVoiceFollowUps() {
  const session = useRef(new VoiceFollowUps());
  const [context, setContext] = useState<VoiceFollowUpContext | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!context) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [context]);
  useEffect(() => () => session.current.reset(), []);
  const remaining = context ? Math.max(0, Math.ceil((context.expiresAt - now) / 1000)) : 0;
  return {
    context, remaining,
    generation() { return session.current.generation; },
    active() { return session.current.active(); },
    reset() { session.current.reset(); setContext(null); },
    route(text: string) { const route = session.current.route(text); setContext(session.current.context); return route; },
    complete(question: QuestionDraft, receipt: AgentQuestionResponse, generation: number) {
      session.current.complete(question, receipt, generation); setContext(session.current.context); setNow(Date.now());
    },
  };
}
