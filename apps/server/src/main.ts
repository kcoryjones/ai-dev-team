import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { TeamDatabase } from "@engineering-team/database";
import { createApp } from "./app.js";
import { HttpPlanningExecutor } from "./planning.js";
import { createRunRecovery } from "./run-recovery.js";

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
const recoverRuns = createRunRecovery(database, controllerClient);
await recoverRuns(true);
let recoveryInProgress = Promise.resolve();
const recoveryTimer = setInterval(() => {
  recoveryInProgress = recoverRuns().catch(error => console.error("Unable to reconcile interrupted runs", error));
}, 30_000);
recoveryTimer.unref();
const app = createApp(database, {
  workspaceRoot,
  workspaceName,
  ...(staticRoot ? { staticRoot } : {}),
  ...(process.env.ENGINEERING_TEAM_SPEECH_URL ? { speechUrl: process.env.ENGINEERING_TEAM_SPEECH_URL } : {}),
  ...(controllerClient ? { planningExecutor: controllerClient, taskExecutor: controllerClient, harnessInspector: controllerClient } : {}),
});
const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.info(`Engineering Team server listening at http://${info.address}:${info.port}`);
});

const shutdown = () => {
  clearInterval(recoveryTimer);
  server.close(() => {
    void recoveryInProgress.finally(() => database.close());
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function findControlRepositoryRoot(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".engineering-team-root"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
