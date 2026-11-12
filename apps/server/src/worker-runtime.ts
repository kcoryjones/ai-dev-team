import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { WorkerAdmissionError, type WorkerConcurrency } from "./worker-concurrency.js";

const execFileAsync = promisify(execFile);
export const workerOwnerLabel = "com.engineering-team.controller";

export async function removeWorker(workerId: string, workers: WorkerConcurrency): Promise<boolean> {
  let existed = true;
  try { await execFileAsync("docker", ["rm", "--force", workerId], { timeout: 10_000 }); }
  catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
    if (!stderr.includes("No such container")) {
      workers.pendingCleanup.add(workerId);
      throw new WorkerAdmissionError("worker_cleanup_pending", "Worker cleanup could not be confirmed. New runs are blocked until cleanup succeeds.");
    }
    existed = false;
  }
  workers.pendingCleanup.delete(workerId);
  return existed;
}

export async function recoverControllerWorkers(owner: string, workers: WorkerConcurrency): Promise<void> {
  const { stdout } = await execFileAsync("docker", ["ps", "--all", "--filter", `label=${workerOwnerLabel}=${owner}`, "--format", "{{.ID}}"], { timeout: 10_000 });
  for (const id of stdout.trim().split(/\s+/).filter(Boolean)) await removeWorker(id, workers);
}

export async function runWorkerContainer(
  args: string[], environment: Record<string, string>, timeoutMs: number, workerId: string,
  signal: AbortSignal, owner: string, workers: WorkerConcurrency, onStdoutLine?: (line: string) => void,
): Promise<{ stdout: string; stderr: string }> {
  signal.throwIfAborted();
  try {
    // Create before starting: cancellation during creation can remove the known
    // container without a later Docker run unexpectedly starting a new worker.
    await execFileAsync("docker", ["create", "--label", `${workerOwnerLabel}=${owner}`, ...args.slice(1).filter(arg => arg !== "--rm")], {
      env: { ...process.env, ...environment }, timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const child = spawn("docker", ["start", "--attach", workerId], { env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", pendingStdout = "", timedOut = false;
      const cancel = () => { child.kill("SIGKILL"); };
      const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      const append = (current: string, chunk: Buffer) => (current + chunk.toString("utf8")).slice(-10 * 1024 * 1024);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
        pendingStdout += chunk.toString("utf8");
        const lines = pendingStdout.split(/\r?\n/);
        pendingStdout = lines.pop() ?? "";
        for (const line of lines) if (line) onStdoutLine?.(line);
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.once("error", error => { finish(); reject(error); });
      child.once("close", code => {
        finish();
        if (pendingStdout) onStdoutLine?.(pendingStdout);
        if (signal.aborted) reject(signal.reason);
        else if (timedOut) reject(new Error("Worker execution timed out"));
        else if (code === 0) resolve({ stdout, stderr });
        else reject(Object.assign(new Error(`Codex worker exited with status ${code}`), { stdout, stderr }));
      });
    });
  } finally { await removeWorker(workerId, workers); }
}
