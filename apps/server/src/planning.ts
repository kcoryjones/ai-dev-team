import type { ApplyCodingRunRequest, ApplyCodingRunResponse, CodingRunRequest, CodingRunResponse, PlanningRunRequest, PlanningRunResponse } from "@engineering-team/contracts";

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
}

export interface TaskExecutor {
  executeTask(request: CodingRunRequest): Promise<CodingRunResponse>;
  applyTask(request: ApplyCodingRunRequest): Promise<ApplyCodingRunResponse>;
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

  async executeTask(request: CodingRunRequest): Promise<CodingRunResponse> {
    const timeoutMs = (request.run.limits.timeoutSeconds + 30) * 1_000;
    const response = await fetch(new URL("/task-runs", this.controllerUrl), {
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
