import { agentRoles, voiceRoleLabels, type VoiceCommandInput, type VoiceCommandPreview, type VoiceCommandReceipt } from "@engineering-team/contracts";
import type { TeamDatabase } from "@engineering-team/database";
import type { Hono } from "hono";
import { z } from "zod";

const inputSchema = z.object({
  requestId: z.string().uuid(), action: z.enum(["new_work", "guidance", "directive_add", "directive_remove"]),
  recipient: z.union([z.enum(agentRoles), z.literal("team")]), body: z.string().trim().min(1).max(2000), taskId: z.string().uuid().optional(),
}).strict().refine(input => input.action === "guidance" || !input.taskId, "Only guidance can select a task");
const normalized = (text: string) => text.trim().replace(/[.!?]+$/, "").replace(/\s+/g, " ").toLowerCase();

export function registerVoiceCommands(app: Hono, database: TeamDatabase, dispatch: (command: VoiceCommandReceipt) => Promise<{ message: string; runId?: string }>) {
  const base = "/api/projects/:projectId/voice/commands";
  app.get(`${base}/:requestId`, context => {
    const command = database.getVoiceCommand(context.req.param("projectId"), context.req.param("requestId"));
    if (!command) return context.json({ message: "Voice action not found" }, 404);
    context.header("Cache-Control", "no-store");
    return context.json(command);
  });
  app.post(`${base}/preview`, async context => {
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ message: "Expected valid JSON" }, 400); }
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success) return context.json({ message: parsed.error.issues[0]?.message ?? "Invalid voice action" }, 400);
    const { taskId, ...fields } = parsed.data;
    const input: VoiceCommandInput = { ...fields, ...(taskId ? { taskId } : {}) };
    const projectId = context.req.param("projectId");
    try {
      const previous = database.getVoiceCommand(projectId, input.requestId);
      if (previous) return context.json(database.prepareVoiceCommand(projectId, input, previous.preview));
      const state = database.getOrchestrationState(projectId);
      if (!state) return context.json({ message: "Project not found" }, 404);
      const recipient = input.recipient === "team" ? "the whole team" : voiceRoleLabels[input.recipient];
      const preview: VoiceCommandPreview = { summary: "", conversationRole: input.recipient === "team" ? "project_manager" : input.recipient, taskId: null, expectedRunId: null, directives: [] };
      if (input.action === "new_work") {
        preview.conversationRole = "project_manager";
        preview.summary = `Ask the Project Manager to propose new work for ${recipient}. The plan requires approval before execution.`;
      } else if (input.action === "guidance") {
        const candidates = state.activeRuns.filter(run => run.taskId && (input.recipient === "team" || run.agentRole === input.recipient) && (!input.taskId || run.taskId === input.taskId));
        if (candidates.length !== 1) return context.json({ message: candidates.length ? "Choose one running task to guide." : "No matching task is running. Choose new work or select a running task." }, 409);
        const run = candidates[0]!;
        const task = state.tasks.find(task => task.id === run.taskId)!;
        preview.taskId = task.id; preview.expectedRunId = run.id; preview.conversationRole = run.agentRole;
        preview.summary = `Guide ${voiceRoleLabels[run.agentRole]} on “${task.title}”. Stop this worker and restart its current stage with the guidance. Existing approval gates still apply.`;
      } else if (input.action === "directive_add") {
        preview.summary = `Save this standing instruction for ${recipient}. It applies to future turns and task stages; current work continues.`;
      } else {
        preview.directives = state.directives.filter(directive => (input.recipient === "team" || directive.agentRole === input.recipient) && normalized(directive.content) === normalized(input.body))
          .map(directive => ({ id: directive.id, role: directive.agentRole, content: directive.content }));
        if (!preview.directives.length) return context.json({ message: "No matching saved instruction. Select its exact text before reviewing removal." }, 409);
        preview.summary = `Remove the selected instruction from ${[...new Set(preview.directives.map(directive => voiceRoleLabels[directive.role]))].join(", ")}. Current work continues.`;
      }
      return context.json(database.prepareVoiceCommand(projectId, input, preview), 201);
    } catch (error) { return context.json({ message: error instanceof Error ? error.message : "Unable to review voice action" }, 409); }
  });
  app.post(`${base}/:requestId/confirm`, async context => {
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ message: "Expected valid JSON" }, 400); }
    if (!z.object({ confirmed: z.literal(true) }).strict().safeParse(body).success) return context.json({ message: "Confirm the reviewed action on screen first." }, 400);
    const projectId = context.req.param("projectId"), requestId = context.req.param("requestId");
    const command = database.getVoiceCommand(projectId, requestId);
    if (!command) return context.json({ message: "Voice action not found" }, 404);
    // Claim before any await or side effect. Retries cannot repeat a redirect or
    // dispatch another planner, even if the first HTTP response is lost.
    if (!database.claimVoiceCommand(projectId, requestId)) return context.json(database.getVoiceCommand(projectId, requestId)!);
    try {
      if (command.input.action === "directive_add" || command.input.action === "directive_remove") return context.json(database.applyVoiceDirectiveCommand(projectId, requestId));
      const result = await dispatch(command);
      return context.json(database.finishVoiceCommand(projectId, requestId, "applied", result.message, result.runId ?? null));
    } catch (error) {
      return context.json(database.finishVoiceCommand(projectId, requestId, "failed", error instanceof Error ? error.message : "Unable to apply the action"));
    }
  });
}
