import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";
import { WorkerAdmissionError, WorkerConcurrency } from "./worker-concurrency.js";
import { recoverControllerWorkers, runWorkerContainer, workerOwnerLabel } from "./worker-runtime.js";

const execFileAsync = promisify(execFile);

test("worker admission defaults to two, rejects invalid limits and duplicate runs, and retains cancelled slots until released", () => {
  for (const invalid of ["", "0", "-1", "1.5", "2x", "Infinity"]) assert.throws(() => new WorkerConcurrency(invalid), /positive integer/);
  const workers = new WorkerConcurrency();
  assert.equal(workers.limit, 2);
  const first = workers.acquire("first"), second = workers.acquire("second");
  assert.throws(() => workers.acquire("first"), { code: "worker_run_active" });
  assert.throws(() => workers.acquire("third"), { code: "worker_limit_reached" });
  assert(workers.cancel("first"));
  assert(first.signal.aborted);
  assert.throws(() => workers.acquire("third"), WorkerAdmissionError);
  first.release();
  const replacement = workers.acquire("first");
  first.release(); // A stale release cannot discard the replacement's reservation.
  assert.throws(() => workers.acquire("third"), WorkerAdmissionError);
  second.release(); replacement.release();
  workers.pendingCleanup.add("uncertain-container");
  assert.throws(() => workers.acquire("next"), { code: "worker_cleanup_pending" });
  workers.pendingCleanup.clear();
  workers.acquire("next").release();
});

test("real containers are removed before releasing workers after success, failure, timeout, and cancellation", {
  skip: !process.env.ENGINEERING_TEAM_TEST_DOCKER_IMAGE, timeout: 30_000,
}, async () => {
  const workers = new WorkerConcurrency("1"), owner = `fixture-${randomUUID()}`;
  for (const scenario of ["success", "failure", "timeout", "cancel"] as const) {
    const workerId = `engineering-team-runtime-test-${randomUUID()}`, slot = workers.acquire(workerId);
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const code = scenario === "success" ? "console.log('completed')" : scenario === "failure" ? "process.exit(7)" : "setInterval(() => {}, 1000)";
    try {
      const result = runWorkerContainer(["run", "--rm", "--name", workerId, "--network", "none", "--entrypoint", "node",
        process.env.ENGINEERING_TEAM_TEST_DOCKER_IMAGE!, "-e", code], {}, scenario === "timeout" ? 200 : 5_000, workerId, slot.signal, owner, workers);
      if (scenario === "cancel") abortTimer = setTimeout(() => slot.cancel(), 300);
      if (scenario === "success") assert.match((await result).stdout, /completed/);
      else await assert.rejects(result, scenario === "failure" ? /status 7/ : scenario === "timeout" ? /timed out/ : /cancelled/);
      await assert.rejects(execFileAsync("docker", ["inspect", workerId]));
      assert.equal(workers.pendingCleanup.size, 0);
    } finally {
      clearTimeout(abortTimer); slot.release();
      await execFileAsync("docker", ["rm", "--force", workerId]).catch(() => undefined);
    }
  }
});

test("controller restart cleans up only containers owned by its persistent worktree volume", {
  skip: !process.env.ENGINEERING_TEAM_TEST_DOCKER_IMAGE, timeout: 15_000,
}, async () => {
  const workers = new WorkerConcurrency("1"), owner = `fixture-${randomUUID()}`;
  const own = `engineering-team-owned-test-${randomUUID()}`, other = `engineering-team-other-test-${randomUUID()}`;
  try {
    for (const [name, label] of [[own, owner], [other, `${owner}-other`]]) {
      await execFileAsync("docker", ["create", "--name", name!, "--network", "none", "--label", `${workerOwnerLabel}=${label}`,
        "--entrypoint", "node", process.env.ENGINEERING_TEAM_TEST_DOCKER_IMAGE!, "-e", "setInterval(() => {}, 1000)"]);
      await execFileAsync("docker", ["start", name!]);
    }
    await recoverControllerWorkers(owner, workers);
    await assert.rejects(execFileAsync("docker", ["inspect", own]));
    assert.equal((await execFileAsync("docker", ["inspect", other, "--format", "{{.State.Running}}"])).stdout.trim(), "true");
  } finally {
    await Promise.all([own, other].map(name => execFileAsync("docker", ["rm", "--force", name]).catch(() => undefined)));
  }
});
