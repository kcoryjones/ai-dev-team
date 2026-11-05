import assert from "node:assert/strict";
import test from "node:test";
import { parseCodingJsonLines } from "./coding-result.js";

const run = { acceptanceCriteria: ["Feature works", "Regression covered"] };
function report() {
  return { summary: "Verified", checks: [{ command: "npm test", status: "passed" }],
    acceptanceCriteria: run.acceptanceCriteria.map(criterion => ({ criterion, satisfied: true, evidence: "Test passed" })),
    questions: [], risks: [] };
}
function message(value: unknown) {
  return JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } });
}

test("complete evidence is matched by exact criterion text, regardless of response order", () => {
  const value = report();
  value.acceptanceCriteria.reverse();
  const output = ["not JSON", "null", '{"type":"thread.started","thread_id":"preserved-thread"}', message(value),
    '{"type":"turn.completed","usage":{"input_tokens":123,"output_tokens":45}}'].join("\n");
  const parsed = parseCodingJsonLines(output, run);
  assert.equal(parsed.summary, "Verified");
  assert.deepEqual(parsed.acceptanceCriteria, report().acceptanceCriteria);
  assert.deepEqual(parsed.checks, value.checks);
  assert.equal(parsed.threadId, "preserved-thread");
  assert.deepEqual(parsed.usage, { inputTokens: 123, outputTokens: 45 });
});

for (const scenario of ["missing one", "missing all", "duplicate replacing another", "extra duplicate", "unrelated replacing another", "extra unrelated", "unsatisfied", "empty evidence", "whitespace evidence", "paraphrased", "case changed", "extra spaces"] as const) {
  test(`${scenario} acceptance evidence cannot pass a task report`, () => {
    const value = report();
    if (scenario === "missing one") value.acceptanceCriteria.pop();
    if (scenario === "missing all") value.acceptanceCriteria = [];
    if (scenario === "duplicate replacing another") value.acceptanceCriteria[1] = { ...value.acceptanceCriteria[0]! };
    if (scenario === "extra duplicate") value.acceptanceCriteria.push({ ...value.acceptanceCriteria[0]! });
    if (scenario === "unrelated replacing another") value.acceptanceCriteria[1]!.criterion = "An unrelated concern";
    if (scenario === "extra unrelated") value.acceptanceCriteria.push({ criterion: "An unrelated concern", satisfied: true, evidence: "Inspected" });
    if (scenario === "unsatisfied") value.acceptanceCriteria[1]!.satisfied = false;
    if (scenario === "empty evidence") value.acceptanceCriteria[1]!.evidence = "";
    if (scenario === "whitespace evidence") value.acceptanceCriteria[1]!.evidence = " \n\t ";
    if (scenario === "paraphrased") value.acceptanceCriteria[1]!.criterion = "Regressions seem covered";
    if (scenario === "case changed") value.acceptanceCriteria[1]!.criterion = "regression covered";
    if (scenario === "extra spaces") value.acceptanceCriteria[1]!.criterion += " ";
    const parsed = parseCodingJsonLines(message(value), run);
    assert.deepEqual(parsed.acceptanceCriteria.map(item => item.criterion), run.acceptanceCriteria);
    assert(parsed.checks.some(check => check.status === "failed"));
    assert.match(parsed.summary, /Task report validation failed/);
    if (scenario !== "extra unrelated") assert(parsed.acceptanceCriteria.some(item => !item.satisfied));
    if (["missing one", "unrelated replacing another", "paraphrased", "case changed", "extra spaces"].includes(scenario)) {
      assert.equal(parsed.acceptanceCriteria[0]?.satisfied, true);
      assert.equal(parsed.acceptanceCriteria[1]?.satisfied, false);
      assert.match(parsed.acceptanceCriteria[1]!.evidence, /No evidence reported/);
    }
  });
}

for (const patch of [
  { acceptanceCriteria: [{ criterion: "Feature works", satisfied: "true", evidence: "Tested" }] },
  { acceptanceCriteria: [{ criterion: "Feature works", satisfied: "false", evidence: "Tested" }] },
  { acceptanceCriteria: [{ criterion: "Feature works", satisfied: 1, evidence: "Tested" }] },
  { acceptanceCriteria: [{ criterion: "Feature works", satisfied: true, evidence: null }] },
  { acceptanceCriteria: [{ criterion: "Feature works", satisfied: true }] },
  { acceptanceCriteria: [null] },
  { acceptanceCriteria: ["Feature works"] },
  { acceptanceCriteria: {} },
  { checks: [{ command: "test", status: "unknown" }] },
  { checks: [{ command: " ", status: "passed" }] },
  { checks: [null] },
  { summary: " \n " },
  { questions: [1] },
  { risks: "none" },
  { unexpected: "field" },
]) {
  test(`malformed task reports are rejected: ${JSON.stringify(patch)}`, () => {
    assert.throws(() => parseCodingJsonLines(message({ ...report(), ...patch }), run), /invalid structured task report/);
  });
}

for (const status of ["missing", "skipped", "failed"] as const) {
  test(`${status} checks cannot pass despite complete acceptance evidence`, () => {
    const value = report();
    value.checks = status === "missing" ? [] : [{ command: "test", status }];
    const parsed = parseCodingJsonLines(message(value), run);
    assert(parsed.checks.some(check => check.status === "failed"));
  });
}

test("the final report cannot borrow evidence from an earlier complete message", () => {
  const incomplete = report();
  incomplete.acceptanceCriteria.pop();
  const parsed = parseCodingJsonLines([message(report()), message(incomplete)].join("\n"), run);
  assert.equal(parsed.acceptanceCriteria[1]?.satisfied, false);
  assert.throws(() => parseCodingJsonLines([message(report()), message(null)].join("\n"), run), /invalid structured task report/);
});

test("blank or duplicate required criteria fail instead of sharing evidence", () => {
  for (const acceptanceCriteria of [[], [" "], ["Feature works", "Feature works"], ["Feature works", " Feature works "]]) {
    assert.throws(() => parseCodingJsonLines(message(report()), { acceptanceCriteria }));
  }
});
