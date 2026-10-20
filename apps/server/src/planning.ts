import type { ApplyCodingRunRequest, ApplyCodingRunResponse, CodingRunRequest, CodingRunResponse, ConsultationRunRequest, ConsultationRunResponse, PlanningRunRequest, PlanningRunResponse, RunEvent } from "@engineering-team/contracts";

export interface TaskExecutionEvent {
  type: RunEvent["type"];
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface WorkerHarnessCapability {
  adapter: string;
  executable: string;
  installed: boolean;
  version: string | null;
}

export interface WorkerControllerCapabilities {
  workerImage: string;
  imageDigest: string | null;
  harnesses: WorkerHarnessCapability[];
}

export interface WorkerHarnessPreflight {
  adapter: string;
  state: "ready" | "not-configured" | "failed";
  version: string | null;
  workerImage: string;
  message: string;
}

export interface HarnessInspector {
  getCapabilities(): Promise<WorkerControllerCapabilities>;
  preflightCodex?(): Promise<WorkerHarnessPreflight>;
}

export interface PlanningExecutor {
  execute(request: PlanningRunRequest): Promise<PlanningRunResponse>;
  consult?(request: ConsultationRunRequest, onEvent?: (event: TaskExecutionEvent) => void): Promise<ConsultationRunResponse>;
  stopAgentWorker?(runId: string): Promise<void>;
}

export interface TaskExecutor {
  executeTask(request: CodingRunRequest, onEvent?: (event: TaskExecutionEvent) => void): Promise<CodingRunResponse>;
  applyTask(request: ApplyCodingRunRequest): Promise<ApplyCodingRunResponse>;
  stopTaskWorker?(runId: string): Promise<void>;
}

export class HttpPlanningExecutor implements PlanningExecutor, TaskExecutor, HarnessInspector {
  constructor(private readonly controllerUrl: string) {}

  async execute(request: PlanningRunRequest): Promise<PlanningRunResponse> {
    const timeoutMs = (request.run.limits.timeoutSeconds + 30) * 1_000;
    const response = await fetch(new URL("/runs", this.controllerUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Worker controller returned an invalid response (${response.status})`);
    }
    if (!response.ok) {
      const message = typeof body === "object" && body !== null && "message" in body
        ? String(body.message)
        : `Worker controller failed with status ${response.status}`;
      throw new Error(message);
    }
    return body as PlanningRunResponse;
  }

  async consult(request: ConsultationRunRequest, onEvent?: (event: TaskExecutionEvent) => void): Promise<ConsultationRunResponse> {
    const timeoutMs = (request.run.limits.timeoutSeconds + 30) * 1_000;
    let finished = false;
    let cursor = 0;
    const responsePromise = fetch(new URL("/consultation-runs", this.controllerUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const poll = async () => {
      try {
        const response = await fetch(new URL(`/task-workers/${encodeURIComponent(request.run.runId)}/events?after=${cursor}`, this.controllerUrl), { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) return;
        const body = await response.json() as { events?: Array<TaskExecutionEvent & { sequence: number }> };
        for (const event of body.events ?? []) {
          cursor = Math.max(cursor, event.sequence);
          onEvent?.({ type: event.type, message: event.message, payload: event.payload, createdAt: event.createdAt });
        }
      } catch {
        // Event polling is observational; the consultation response remains authoritative.
      }
    };
    const polling = (async () => {
      while (!finished) {
        await poll();
        if (!finished) await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
      }
    })();
    let response: Response;
    try {
      response = await responsePromise;
    } finally {
      finished = true;
      await polling;
      await poll();
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Worker controller returned an invalid consultation response (${response.status})`);
    }
    if (!response.ok) {
      const message = typeof body === "object" && body !== null && "message" in body
        ? String(body.message)
        : `Worker controller consultation failed with status ${response.status}`;
      throw new Error(message);
    }
    return body as ConsultationRunResponse;
  }

  async stopAgentWorker(runId: string): Promise<void> {
    await this.stopTaskWorker(runId);
  }

  async executeTask(request: CodingRunRequest, onEvent?: (event: TaskExecutionEvent) => void): Promise<CodingRunResponse> {
    const timeoutMs = (request.run.limits.timeoutSeconds + 30) * 1_000;
    let finished = false;
    let cursor = 0;
    const responsePromise = fetch(new URL("/task-runs", this.controllerUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const poll = async () => {
      try {
        const response = await fetch(new URL(`/task-workers/${encodeURIComponent(request.run.runId)}/events?after=${cursor}`, this.controllerUrl), {
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) return;
        const body = await response.json() as { events?: Array<TaskExecutionEvent & { sequence: number }> };
        for (const event of body.events ?? []) {
          cursor = Math.max(cursor, event.sequence);
          onEvent?.({ type: event.type, message: event.message, payload: event.payload, createdAt: event.createdAt });
        }
      } catch {
        // Event polling is observational; the task response remains authoritative.
      }
    };
    const polling = (async () => {
      while (!finished) {
        await poll();
        if (!finished) await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
      }
    })();
    let response: Response;
    try {
      response = await responsePromise;
    } finally {
      finished = true;
      await polling;
      await poll();
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Worker controller returned an invalid task response (${response.status})`);
    }
    if (!response.ok) {
      const message = typeof body === "object" && body !== null && "message" in body
        ? String(body.message)
        : `Worker controller task failed with status ${response.status}`;
      throw new Error(message);
    }
    return body as CodingRunResponse;
  }

  async applyTask(request: ApplyCodingRunRequest): Promise<ApplyCodingRunResponse> {
    const response = await fetch(new URL("/task-runs/apply", this.controllerUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Worker controller returned an invalid apply response (${response.status})`);
    }
    if (!response.ok) {
      const message = typeof body === "object" && body !== null && "message" in body
        ? String(body.message)
        : `Worker controller apply failed with status ${response.status}`;
      throw new Error(message);
    }
    return body as ApplyCodingRunResponse;
  }

  async stopTaskWorker(runId: string): Promise<void> {
    const response = await fetch(new URL(`/task-workers/${encodeURIComponent(runId)}`, this.controllerUrl), {
      method: "DELETE",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return;
    const text = await response.text();
    let message = `Worker controller failed to stop the interrupted worker (${response.status})`;
    try {
      const body = text ? JSON.parse(text) as { message?: unknown } : {};
      if (typeof body.message === "string") message = body.message;
    } catch {
      // Keep the status-based message when the controller response is not JSON.
    }
    throw new Error(message);
  }

  async getCapabilities(): Promise<WorkerControllerCapabilities> {
    const response = await fetch(new URL("/capabilities", this.controllerUrl), {
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Worker controller returned invalid capabilities (${response.status})`);
    }
    if (!response.ok) {
      const message = typeof body === "object" && body !== null && "message" in body
        ? String(body.message)
        : `Worker controller capability check failed with status ${response.status}`;
      throw new Error(message);
    }
    return body as WorkerControllerCapabilities;
  }

  async preflightCodex(): Promise<WorkerHarnessPreflight> {
    const response = await fetch(new URL("/preflight/codex", this.controllerUrl), {
      method: "POST",
      signal: AbortSignal.timeout(45_000),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Worker controller returned an invalid Codex preflight response (${response.status})`);
    }
    if (!response.ok) {
      const message = typeof body === "object" && body !== null && "message" in body
        ? String(body.message)
        : `Worker controller Codex preflight failed with status ${response.status}`;
      throw new Error(message);
    }
    return body as WorkerHarnessPreflight;
  }
}
