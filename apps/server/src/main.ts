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
  server.close(() => {
    database.close();
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
