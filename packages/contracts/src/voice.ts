import type { AgentRole } from "./index.js";

export const voiceRoleLabels: Record<AgentRole, string> = {
  project_manager: "Project Manager", architect: "Architect", tech_lead: "Tech Lead",
  backend_developer: "Backend Developer", frontend_developer: "Frontend Developer",
  devops_database_engineer: "DevOps / DB Engineer", qa_engineer: "QA Engineer",
  code_reviewer: "Code Reviewer", security_reviewer: "Security", release_manager: "Release Manager",
};

const aliases: Array<[AgentRole, string[]]> = [
  ["project_manager", ["project manager", "project management", "pm", "team", "everyone", "dev team"]],
  ["architect", ["architect", "architecture"]],
  ["tech_lead", ["tech lead", "technical lead"]],
  ["backend_developer", ["backend developer", "back end developer", "backend", "back end"]],
  ["frontend_developer", ["frontend developer", "front end developer", "frontend", "front end"]],
  ["devops_database_engineer", ["devops database engineer", "dev ops database engineer", "database engineer", "devops", "dev ops", "db engineer"]],
  ["qa_engineer", ["qa engineer", "q a engineer", "quality assurance", "qa", "q a"]],
  ["code_reviewer", ["code reviewer", "code review"]],
  ["security_reviewer", ["security reviewer", "security"]],
  ["release_manager", ["release manager", "release management"]],
];
const addresses = aliases.flatMap(([role, names]) => names.map(name => ({ role, name }))).sort((a, b) => b.name.length - a.name.length);
const questionStart = /^(?:what|what's|whats|why|how|when|where|who|whose|which|is|are|was|were|do|does|did|has|have|had|can|could|would|should|will)\b/i;
const informationRequest = /^(?:(?:please\s+)?(?:tell me|explain|summari[sz]e|describe|compare|give me (?:a |an )?(?:status|update|summary)))\b/i;
const workRequest = /^(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:fix|implement|build|create|add|remove|delete|deploy|release|merge|commit|push|cancel|stop|restart|resume|start|prioriti[sz]e|change|update|remember|forget|always|never)\b|^from now on\b/i;

export interface VoiceQuestionRoute {
  status: "ready" | "clarify";
  recipient: AgentRole | null;
  question: string;
  reason: string | null;
}

/** Deliberately conservative local routing; only leading role names are addresses. */
export function routeVoiceQuestion(transcript: string): VoiceQuestionRoute {
  let question = transcript.trim().replace(/^hey[,\s]+dev\s+team\b[\s,.:!?-]*/i, "").trim();
  const address = addresses.find(({ name }) => question.toLowerCase() === name || question.toLowerCase().startsWith(`${name} `) || new RegExp(`^${name}[,:.!?-]`, "i").test(question));
  let recipient: AgentRole | null = address?.role ?? "project_manager";
  if (address) question = question.slice(address.name.length).replace(/^[\s,.:!?-]+/, "");
  if (address && /^(?:(?:and|or)\b|\/)/i.test(question)) {
    recipient = null;
    return { status: "clarify", recipient, question: transcript.trim(), reason: "Choose one agent, or choose the Project Manager to answer for the team." };
  }
  if (question.length > 2000) return { status: "clarify", recipient, question, reason: "Please shorten this question to 2,000 characters before sending." };
  if (!question) return { status: "clarify", recipient, question, reason: "What would you like to ask?" };
  if (workRequest.test(question)) return { status: "clarify", recipient, question, reason: "Review this as a work request or standing instruction, or rephrase it as a question." };
  if (!questionStart.test(question) && !informationRequest.test(question)) {
    if (!address && /^[^,.:!?]{1,60}[,.:]\s+/.test(question)) recipient = null;
    return { status: "clarify", recipient, question, reason: recipient === null
      ? "I couldn’t identify the addressed agent. Choose a recipient and check the question."
      : "Please check or rephrase this as a question before sending." };
  }
  return { status: "ready", recipient, question, reason: null };
}

export type VoiceRecipient = AgentRole | "team";
export type VoiceCommandAction = "new_work" | "guidance" | "directive_add" | "directive_remove";
export interface VoiceCommandInput {
  requestId: string;
  action: VoiceCommandAction;
  recipient: VoiceRecipient;
  body: string;
  taskId?: string;
}
export interface VoiceCommandPreview {
  summary: string;
  conversationRole: AgentRole;
  taskId: string | null;
  expectedRunId: string | null;
  directives: Array<{ id: string; role: AgentRole; content: string }>;
}
export interface VoiceCommandReceipt {
  projectId: string;
  input: VoiceCommandInput;
  preview: VoiceCommandPreview;
  status: "prepared" | "dispatching" | "applied" | "failed" | "interrupted";
  message: string;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface VoiceRequestRoute {
  intent: "question" | VoiceCommandAction | null;
  recipient: VoiceRecipient | null;
  body: string;
  reason: string | null;
  autoSubmit: boolean;
}

/** Actions are reviewed on screen; only unambiguous questions auto-submit. */
export function routeVoiceRequest(transcript: string): VoiceRequestRoute {
  const text = transcript.trim().replace(/^hey[,\s]+dev\s+team\b[\s,.:!?-]*/i, "").trim();
  const address = addresses.find(({ name }) => text.toLowerCase() === name || text.toLowerCase().startsWith(`${name} `) || new RegExp(`^${name}[,:.!?-]`, "i").test(text));
  const body = address ? text.slice(address.name.length).replace(/^[\s,.:!?-]+/, "") : text;
  const recipient: VoiceRecipient = address && !["team", "everyone", "dev team"].includes(address.name) ? address.role : "team";
  const question = routeVoiceQuestion(transcript);
  if (question.recipient === null || !body || body.length > 2000) return { intent: null, recipient: question.recipient === null ? null : recipient, body: question.question, reason: question.reason, autoSubmit: false };
  const removal = body.match(/^(?:please\s+)?(?:forget|remove|delete)\s+(?:(?:the|my)\s+)?(?:(?:standing\s+)?(?:instruction|directive)\s*(?:(?:to|that|about)\s+)?)(.*)$/i);
  if (removal) return { intent: "directive_remove", recipient, body: removal[1]!.trim(), reason: "Select the saved instruction to remove, then review the affected agents.", autoSubmit: false };
  if (/^(?:please\s+)?(?:from now on\b|always\b|never\b|remember\b)/i.test(body)) {
    return { intent: "directive_add", recipient, body: body.replace(/^(?:please\s+)?(?:from now on[,\s:]+|remember(?: that)?\s+)/i, "").trim(), reason: "Review the standing instruction and its recipients before saving.", autoSubmit: false };
  }
  if (/^(?:(?:on|for)\s+(?:(?:your|the|this)\s+)?(?:current|active)\s+task\b|instead\b)/i.test(body)) {
    return { intent: "guidance", recipient, body, reason: "Choose the running task. Applying guidance stops its worker and restarts the current stage.", autoSubmit: false };
  }
  if (/^(?:please\s+)?(?:cancel|stop|restart|resume|approve|reject|forget)\b/i.test(body)) {
    return { intent: null, recipient, body, reason: "Use the task or approval controls for this action, or choose a supported voice action.", autoSubmit: false };
  }
  if (workRequest.test(body) || /^(?:please\s+)?(?:plan|design|refactor|test|investigate)\b/i.test(body)) {
    return { intent: "new_work", recipient, body, reason: "The Project Manager will propose a plan for approval. Choose task guidance if you mean to change active work.", autoSubmit: false };
  }
  return { intent: question.status === "ready" ? "question" : null, recipient, body, reason: question.reason, autoSubmit: question.status === "ready" };
}
