import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { TeamDatabase } from "@engineering-team/database";
import { createApp } from "./app.js";
import { HttpPlanningExecutor } from "./planning.js";

const host = process.env.ENGINEERING_TEAM_HOST ?? "127.0.0.1";
const port = Number(process.env.ENGINEERING_TEAM_PORT ?? "4317");
const databasePath =
  process.env.ENGINEERING_TEAM_DATABASE ??
  resolve(process.cwd(), ".engineering-team-data", "team.db");
const controlRepositoryRoot = findControlRepositoryRoot(process.cwd());
const workspaceRoot =
  process.env.ENGINEERING_TEAM_WORKSPACE_ROOT ??
  (controlRepositoryRoot ? dirname(controlRepositoryRoot) : resolve(process.cwd(), ".."));
const workspaceName =
  process.env.ENGINEERING_TEAM_PROJECT_NAME?.trim() ||
  (workspaceRoot === "/workspaces" ? "Project" : basename(workspaceRoot)) ||
  "Project";
const staticRoot = process.env.ENGINEERING_TEAM_WEB_ROOT;
const controllerUrl = process.env.ENGINEERING_TEAM_CONTROLLER_URL;
const controllerClient = controllerUrl ? new HttpPlanningExecutor(controllerUrl) : null;

const database = new TeamDatabase(databasePath);
const startupRecoveries = database.reconcileInterruptedTaskRuns(new Date().toISOString(), true);
if (startupRecoveries.length > 0) {
  console.info(`Marked ${startupRecoveries.length} interrupted task workflow${startupRecoveries.length === 1 ? "" : "s"} as resumable`);
}
await stopRecoveredWorkers(startupRecoveries);
const recoveryTimer = setInterval(async () => {
  const recoveries = database.reconcileInterruptedTaskRuns(new Date().toISOString());
  if (recoveries.length > 0) {
    console.warn(`Recovered ${recoveries.length} task workflow${recoveries.length === 1 ? "" : "s"} with expired leases`);
    await stopRecoveredWorkers(recoveries);
  }
}, 30_000);
recoveryTimer.unref();
const app = createApp(database, {
  workspaceRoot,
  workspaceName,
  ...(staticRoot ? { staticRoot } : {}),
  ...(controllerClient ? { planningExecutor: controllerClient, taskExecutor: controllerClient, harnessInspector: controllerClient } : {}),
});
const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.info(`Engineering Team server listening at http://${info.address}:${info.port}`);
});

const shutdown = () => {
  clearInterval(recoveryTimer);
  server.close(() => {
    database.close();
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function stopRecoveredWorkers(recoveries: typeof startupRecoveries): Promise<void> {
  if (!controllerClient?.stopTaskWorker) return;
  for (const recovery of recoveries) {
    try {
      await controllerClient.stopTaskWorker(recovery.interruptedRunId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown controller error";
      console.warn(`Could not stop interrupted worker for run ${recovery.interruptedRunId}: ${message}`);
    }
  }
}

function findControlRepositoryRoot(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".engineering-team-root"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
