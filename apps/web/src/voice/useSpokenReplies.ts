import { useEffect, useRef, useState, type RefObject } from "react";
import type { LocalVoiceSession } from "./LocalVoiceSession";
import { LocalSpeechPlayer, type SpeechPhase } from "./LocalSpeechPlayer";
import { SpokenReplyHistory, type SpokenReply } from "./spokenReply";

export function useSpokenReplies(session: RefObject<LocalVoiceSession | undefined>, settings: { speed: number; volume: number }) {
  const player = useRef<LocalSpeechPlayer | undefined>(undefined);
  const enabledRef = useRef(false);
  const active = useRef(false);
  const history = useRef(new SpokenReplyHistory());
  const [enabled, setEnabled] = useState(false);
  const [phase, setPhase] = useState<SpeechPhase>("idle");
  const [error, setError] = useState("");
  const [reply, setReply] = useState<SpokenReply | null>(null);
  useEffect(() => {
    const next = new LocalSpeechPlayer({ phase: setPhase, error: setError, active(value) {
      active.current = value;
      if (value) session.current?.pauseForSpeech(); else session.current?.finishSpeech();
    } });
    player.current = next;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && active.current) { event.preventDefault(); next.stop(); } };
    const hidden = () => { if (document.hidden) next.stop(); };
    const leave = () => next.stop();
    window.addEventListener("keydown", escape, true);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    return () => {
      enabledRef.current = false;
      window.removeEventListener("keydown", escape, true); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", leave);
      next.dispose(); player.current = undefined;
    };
  }, [session]);
  useEffect(() => { player.current?.configure(settings); }, [settings.speed, settings.volume]);
  function toggle(value: boolean) {
    enabledRef.current = value; setEnabled(value); setError("");
    if (value) void player.current?.prepare().catch(failure => { if (enabledRef.current) setError(failure instanceof Error ? failure.message : "Audio playback is unavailable."); });
    else player.current?.disable();
  }
  return { enabled, phase, error, reply, toggle, active,
    offer(next: SpokenReply, automatic = true) {
      setReply(next);
      if (history.current.accept(next.id) && automatic && enabledRef.current && !document.hidden) void player.current?.speak(next.text);
    },
    replay() { if (reply) void player.current?.speak(reply.text, true); },
    stop() { player.current?.stop(); },
    clear() { player.current?.stop(); setReply(null); setError(""); },
  };
}
