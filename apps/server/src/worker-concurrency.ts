export type WorkerAdmissionCode = "worker_limit_reached" | "worker_run_active" | "worker_cleanup_pending";

export class WorkerAdmissionError extends Error {
  constructor(readonly code: WorkerAdmissionCode, message: string) { super(message); }
}

export function isWorkerAdmissionCode(code: unknown): code is WorkerAdmissionCode {
  return code === "worker_limit_reached" || code === "worker_run_active" || code === "worker_cleanup_pending";
}

export class WorkerConcurrency {
  readonly limit: number;
  private active = new Map<string, AbortController>();
  readonly pendingCleanup = new Set<string>();

  constructor(configured = "2") {
    this.limit = Number(configured);
    if (!/^[1-9]\d*$/.test(configured) || !Number.isSafeInteger(this.limit)) {
      throw new Error("ENGINEERING_TEAM_MAX_WORKERS must be a positive integer");
    }
  }

  acquire(runId: string) {
    if (this.pendingCleanup.size) throw new WorkerAdmissionError("worker_cleanup_pending", "A previous worker is awaiting cleanup. New runs can start once cleanup succeeds.");
    if (this.active.has(runId)) throw new WorkerAdmissionError("worker_run_active", "This worker run is already active.");
    if (this.active.size >= this.limit) throw new WorkerAdmissionError("worker_limit_reached", `All ${this.limit} worker slots are occupied. Wait for a running worker to finish, then retry.`);
    const controller = new AbortController();
    this.active.set(runId, controller);
    return {
      signal: controller.signal,
      cancel: () => controller.abort(new Error("Worker run was cancelled")),
      release: () => { if (this.active.get(runId) === controller) this.active.delete(runId); },
    };
  }

  cancel(runId: string): boolean {
    const controller = this.active.get(runId);
    controller?.abort(new Error("Worker run was cancelled"));
    return Boolean(controller);
  }
}
