import { z } from "zod";
import type { CodingRunRequest, RunResult } from "@engineering-team/contracts";

// Exact, unique criterion text identifies evidence without changing stored plans
// or introducing a second identifier that workers could mismatch.
export const taskAcceptanceCriteriaSchema = z.array(z.string().trim().min(1).max(500)).min(1).max(20)
  .refine(criteria => new Set(criteria).size === criteria.length, "Acceptance criteria must be unique");

const codingReportSchema = z.object({
  summary: z.string().trim().min(1).max(8_000),
  checks: z.array(z.object({
    command: z.string().trim().min(1).max(500),
    status: z.enum(["passed", "failed", "skipped"]),
  }).strict()).max(30),
  acceptanceCriteria: z.array(z.object({
    criterion: z.string().min(1).max(500),
    satisfied: z.boolean(),
    // Empty evidence is handled below so the failed result names the criterion.
    evidence: z.string().max(2_000),
  }).strict()).max(20),
  questions: z.array(z.string().max(1_000)).max(20),
  risks: z.array(z.string().max(1_000)).max(20),
}).strict();

export function parseCodingJsonLines(output: string, run: Pick<CodingRunRequest["run"], "acceptanceCriteria">): {
  threadId: string | null;
  summary: string;
  checks: RunResult["checks"];
  acceptanceCriteria: RunResult["acceptanceCriteria"];
  questions: string[];
  risks: string[];
  usage?: RunResult["usage"];
} {
  let threadId: string | null = null;
  let finalMessage: string | null = null;
  let usage: RunResult["usage"] | undefined;
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "thread.started" && typeof event.thread_id === "string") threadId = event.thread_id;
      if (event.type === "turn.completed" && typeof event.usage === "object" && event.usage !== null) {
        const raw = event.usage as Record<string, unknown>;
        usage = {
          ...(typeof raw.input_tokens === "number" ? { inputTokens: raw.input_tokens } : {}),
          ...(typeof raw.cached_input_tokens === "number" ? { cachedInputTokens: raw.cached_input_tokens } : {}),
          ...(typeof raw.output_tokens === "number" ? { outputTokens: raw.output_tokens } : {}),
          ...(typeof raw.reasoning_output_tokens === "number" ? { reasoningOutputTokens: raw.reasoning_output_tokens } : {}),
        };
      }
      if (event.type === "item.completed" && typeof event.item === "object" && event.item !== null) {
        const item = event.item as Record<string, unknown>;
        if (item.type === "agent_message" && typeof item.text === "string") finalMessage = item.text;
      }
    } catch {
      continue;
    }
  }
  if (!finalMessage) throw new Error("Codex completed without a structured task report");
  const parsed = codingReportSchema.safeParse(JSON.parse(finalMessage));
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`Codex returned an invalid structured task report: ${issue.path.join(".") || "report"}: ${issue.message}`);
  }
  // Validate direct callers as well as the HTTP boundary. Do not collapse two
  // requirements into one or match paraphrases, case changes, or extra spaces.
  const required = taskAcceptanceCriteriaSchema.parse(run.acceptanceCriteria);
  const report = parsed.data;
  const issues: string[] = [];
  const acceptanceCriteria = required.map(criterion => {
    const matches = report.acceptanceCriteria.filter(item => item.criterion === criterion);
    let problem: string | undefined;
    if (matches.length === 0) problem = "No evidence reported for this criterion";
    else if (matches.length !== 1) problem = "Duplicate evidence reported for this criterion";
    else if (!matches[0]!.evidence.trim()) problem = "Nonempty evidence is required for this criterion";
    if (problem) {
      issues.push(`${criterion}: ${problem}`);
      return { criterion, satisfied: false, evidence: problem };
    }
    const evidence = matches[0]!;
    if (!evidence.satisfied) issues.push(`${criterion}: Reported as unsatisfied`);
    return { ...evidence, evidence: evidence.evidence.trim() };
  });
  for (const item of report.acceptanceCriteria) {
    if (!required.includes(item.criterion)) issues.push(`Unexpected acceptance criterion: ${item.criterion}`);
  }
  if (!report.checks.length) issues.push("At least one passing check is required");
  if (report.checks.some(check => check.status !== "passed")) issues.push("Every reported check must pass");
  return {
    threadId,
    summary: issues.length ? `${report.summary}\n\nTask report validation failed:\n${issues.map(issue => `- ${issue}`).join("\n")}` : report.summary,
    checks: issues.length ? [...report.checks, { command: "validate_task_report", status: "failed" }] : report.checks,
    acceptanceCriteria,
    questions: report.questions,
    risks: report.risks,
    ...(usage ? { usage } : {}),
  };
}
