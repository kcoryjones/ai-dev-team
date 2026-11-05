import { useEffect, useRef, useState } from "react";
import { agentRoles, routeVoiceRequest, voiceRoleLabels, type AgentQuestionResponse, type AgentRole, type OrchestrationState, type VoiceCommandAction, type VoiceCommandInput, type VoiceCommandReceipt, type VoiceRecipient } from "@engineering-team/contracts";
import { LocalVoiceSession, type VoicePhase } from "./LocalVoiceSession";
import { questionPending, readQuestion, submitQuestion, waitForQuestionPoll, type QuestionDraft } from "./questions";
import { confirmCommand, previewCommand, readCommand } from "./commands";

const labels: Record<VoicePhase, string> = {
  off: "Voice off", loading: "Preparing local voice…", armed: "Listening for ‘Hey Dev Team’",
  capturing: "Listening to your request…", transcribing: "Transcribing locally…", review: "Listening paused for this request",
};
const actionLabels: Record<VoiceCommandAction, string> = {
  new_work: "Request new work", guidance: "Guide a running task", directive_add: "Save standing instruction", directive_remove: "Remove standing instruction",
};

export function VoicePanel({ projectId, orchestration, onConversationChange }: {
  projectId: string; orchestration: OrchestrationState | null; onConversationChange: (role: AgentRole, open: boolean) => void;
}) {
  const session = useRef<LocalVoiceSession | undefined>(undefined);
  const request = useRef<AbortController | undefined>(undefined);
  const seen = useRef(new Set<string>());
  const submitted = useRef<QuestionDraft | null>(null);
  const submittedCommand = useRef<VoiceCommandInput | null>(null);
  const callbacks = useRef(onConversationChange);
  callbacks.current = onConversationChange;
  const storageKey = `voice-action:${projectId}`;
  const [phase, setPhase] = useState<VoicePhase>("off");
  const [draft, setDraft] = useState("");
  const [recipient, setRecipient] = useState<VoiceRecipient | "">("");
  const [intent, setIntent] = useState<"question" | VoiceCommandAction | "">("");
  const [taskId, setTaskId] = useState("");
  const [requestId, setRequestId] = useState("");
  const [receipt, setReceipt] = useState<AgentQuestionResponse | null>(null);
  const [command, setCommand] = useState<VoiceCommandReceipt | null>(null);
  const [commandStep, setCommandStep] = useState<"preview" | "confirm" | "read" | null>(null);
  const [sending, setSending] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [transcript, setTranscript] = useState("");
  const tasks = (orchestration?.activeRuns ?? []).filter(run => run.taskId && (recipient === "team" || run.agentRole === recipient));
  const selectedTaskId = tasks.some(run => run.taskId === taskId) ? taskId : tasks.length === 1 ? tasks[0]!.taskId! : "";
  const directives = [...new Set((orchestration?.directives ?? []).filter(directive => recipient === "team" || directive.agentRole === recipient).map(directive => directive.content))];
  function remember(id: string | null) {
    try { if (id) localStorage.setItem(storageKey, id); else localStorage.removeItem(storageKey); } catch { /* Storage can be disabled; server receipts still deduplicate retries. */ }
  }
  useEffect(() => {
    let id: string | null = null;
    try { id = localStorage.getItem(storageKey); } catch { /* Optional convenience. */ }
    if (id) void runCommand("read", undefined, id);
    return () => { session.current?.stop(); request.current?.abort(); };
  }, [projectId]);

  async function ask(question: QuestionDraft) {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    submitted.current = question;
    setAttempted(true); setSending(true); setError(""); setNotice("");
    try {
      let result = await submitQuestion(projectId, question, controller.signal);
      if (controller.signal.aborted) return;
      setReceipt(result); callbacks.current(question.recipient, false);
      while (questionPending(result)) {
        await waitForQuestionPoll(controller.signal);
        result = await readQuestion(projectId, question.requestId, controller.signal);
        if (controller.signal.aborted) return;
        setReceipt(result);
      }
      callbacks.current(question.recipient, false);
      if (result.run.status !== "completed") setError(result.run.result?.summary ?? `Question ${result.run.status.replaceAll("_", " ")}. See the conversation for details.`);
      session.current?.resume();
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to ask the question. Retry to reconnect.");
    } finally { if (!controller.signal.aborted) setSending(false); }
  }

  async function runCommand(step: "preview" | "confirm" | "read", input?: VoiceCommandInput, restoredId?: string) {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    if (input) submittedCommand.current = input;
    const id = input?.requestId ?? restoredId ?? command?.input.requestId ?? submittedCommand.current?.requestId ?? (requestId || undefined);
    if (!id) return;
    setRequestId(id); remember(id); setSending(true); setCommandStep(step); setError(""); setNotice("");
    try {
      let result = step === "preview" ? await previewCommand(projectId, submittedCommand.current!, controller.signal)
        : step === "confirm" ? await confirmCommand(projectId, id, controller.signal) : await readCommand(projectId, id, controller.signal);
      if (controller.signal.aborted) return;
      submittedCommand.current = result.input;
      setCommand(result); setTranscript(current => current || result.input.body);
      setDraft(result.input.body); setRecipient(result.input.recipient); setIntent(result.input.action); setRequestId(id);
      while (result.status === "dispatching") {
        await waitForQuestionPoll(controller.signal);
        result = await readCommand(projectId, id, controller.signal);
        if (controller.signal.aborted) return;
        setCommand(result);
      }
      if (result.status !== "prepared") {
        callbacks.current(result.preview.conversationRole, false);
        if (result.status !== "applied") setError(result.message);
        session.current?.resume();
      }
      setCommandStep(null);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to process voice action. Retry to reconnect.");
    } finally { if (!controller.signal.aborted) setSending(false); }
  }

  function receiveTranscript(text: string, id: string) {
    if (seen.current.has(id)) return;
    seen.current.add(id);
    if (seen.current.size > 128) seen.current.delete(seen.current.values().next().value!);
    request.current?.abort(); remember(null);
    const route = routeVoiceRequest(text);
    setTranscript(text); setDraft(route.body); setRecipient(route.recipient ?? ""); setIntent(route.intent ?? ""); setRequestId(id); setTaskId("");
    setReceipt(null); setCommand(null); setCommandStep(null); setAttempted(false); setSending(false);
    submitted.current = null; submittedCommand.current = null; setError(""); setNotice(route.reason ?? "");
    if (route.autoSubmit && route.recipient) void ask({ requestId: id, recipient: route.recipient === "team" ? "project_manager" : route.recipient, body: route.body, source: "voice" });
  }
  function enable() {
    session.current?.stop(); setError("");
    const next = new LocalVoiceSession({ phase: setPhase, transcript: receiveTranscript, notice: setNotice, error: setError });
    session.current = next; void next.start();
  }
  function edit() {
    remember(null); setCommand(null); setCommandStep(null); submittedCommand.current = null;
    setRequestId(crypto.randomUUID()); setError("");
  }
  function clear() {
    request.current?.abort(); setSending(false); setAttempted(false); submitted.current = null;
    edit(); setTranscript(""); setDraft(""); setReceipt(null); setNotice(""); session.current?.resume();
  }
  function submitDraft() {
    if (!recipient || !intent || !draft.trim() || draft.length > 2000) return;
    if (intent === "question") void ask({ requestId, recipient: recipient === "team" ? "project_manager" : recipient, body: draft.trim(), source: "voice" });
    else void runCommand("preview", { requestId, action: intent, recipient, body: draft.trim(), ...(intent === "guidance" && selectedTaskId ? { taskId: selectedTaskId } : {}) });
  }
  const conversationRole = command?.preview.conversationRole ?? (recipient === "team" || !recipient ? "project_manager" : recipient);
  return <section className="voice-panel" aria-label="Local voice control">
    <div className="voice-controls">
      <span className={`voice-indicator voice-${phase}`} aria-hidden="true" />
      <strong role="status">{labels[phase]}</strong>
      <button type="button" disabled={phase === "off" && sending} onClick={phase === "off" ? enable : () => session.current?.stop()}>{phase === "off" ? "Enable voice" : "Turn off microphone"}</button>
    </div>
    <p>Say “Hey Dev Team”, then address the team or an agent. Clear questions send automatically. Review work requests and standing instructions before applying them.</p>
    {error && <p className="voice-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {transcript && <div className="voice-transcript">
      <span>Heard</span><p>{transcript}</p>
      {!attempted && !command && !commandStep && <form onSubmit={event => { event.preventDefault(); submitDraft(); }}>
        <label>Action <select aria-label="Voice action" value={intent} onChange={event => setIntent(event.target.value as typeof intent)} required>
          <option value="" disabled>Choose an action…</option><option value="question">Ask question</option>
          {Object.entries(actionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>Recipient <select aria-label="Question recipient" value={recipient} onChange={event => { setRecipient(event.target.value as VoiceRecipient | ""); setTaskId(""); }} required>
          <option value="" disabled>Choose an agent…</option><option value="team">{intent === "question" ? "Team (Project Manager)" : "Whole team"}</option>
          {agentRoles.map(role => <option key={role} value={role}>{voiceRoleLabels[role]}</option>)}
        </select></label>
        {intent === "guidance" && <label>Running task <select aria-label="Running task" value={selectedTaskId} onChange={event => setTaskId(event.target.value)} required>
          <option value="" disabled>Choose a running task…</option>{tasks.map(run => <option key={run.id} value={run.taskId!}>{orchestration?.tasks.find(task => task.id === run.taskId)?.title ?? run.taskId} · {voiceRoleLabels[run.agentRole]}</option>)}
        </select></label>}
        {intent === "directive_remove" && <label>Saved instruction <select aria-label="Saved instruction" value={directives.includes(draft) ? draft : ""} onChange={event => setDraft(event.target.value)} required>
          <option value="" disabled>Select the instruction to remove…</option>{directives.map(content => <option key={content} value={content}>{content}</option>)}
        </select></label>}
        <label>{intent === "question" ? "Question" : "Request"} <textarea aria-label="Voice question" value={draft} onChange={event => setDraft(event.target.value)} maxLength={2000} required /></label>
        <button type="submit" disabled={sending || !recipient || !intent || !draft.trim() || draft.length > 2000 || (intent === "guidance" && !selectedTaskId)}>{intent === "question" ? "Ask question" : "Review action"}</button>
      </form>}
      {attempted && <p role="status">{sending ? receipt ? "Waiting for" : "Sending to" : "Question for"} {voiceRoleLabels[conversationRole]}{sending ? "…" : ""}</p>}
      {command && <div className="voice-action-review">
        <strong>{actionLabels[command.input.action]}</strong><p>{command.preview.summary}</p><blockquote>{command.input.body}</blockquote>
        <p role="status">{command.message}</p>
        {command.status === "prepared" && !commandStep && <><button type="button" disabled={sending} onClick={() => void runCommand("confirm")}>Confirm {actionLabels[command.input.action].toLowerCase()}</button><button type="button" disabled={sending} onClick={edit}>Edit request</button></>}
      </div>}
      {commandStep && sending && <p role="status">{commandStep === "preview" ? "Preparing review…" : "Checking action status…"}</p>}
      {commandStep && !sending && error && <button type="button" onClick={() => void runCommand(commandStep)}>Retry {commandStep === "preview" ? "review" : "action"}</button>}
      {commandStep === "preview" && !sending && error && <button type="button" onClick={edit}>Edit request</button>}
      {receipt?.run.status === "completed" && <div className="voice-answer"><span>Answer</span><p>{receipt.run.result?.summary}</p></div>}
      {attempted && !sending && error && (!receipt || questionPending(receipt)) && <button type="button" onClick={() => { if (submitted.current) void ask(submitted.current); }}>Retry question</button>}
      {(receipt || (command && command.status !== "prepared")) && <button type="button" onClick={() => callbacks.current(conversationRole, true)}>Open conversation</button>}
      <button type="button" disabled={sending} onClick={clear}>{attempted || command ? "Clear request" : "Discard transcript"}</button>
    </div>}
  </section>;
}
