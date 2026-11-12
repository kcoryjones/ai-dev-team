import { serve } from "@hono/node-server";
import { ProcessTtsEngine } from "./tts-engine.js";
import { createTtsServiceRoutes } from "./tts-routes.js";

const engine = new ProcessTtsEngine();
await engine.start();
const server = serve({ fetch: createTtsServiceRoutes(engine).fetch,
  hostname: process.env.ENGINEERING_TEAM_TTS_HOST ?? "127.0.0.1", port: Number(process.env.ENGINEERING_TEAM_TTS_PORT ?? "4321"),
}, () => console.info("Local speech synthesis is ready."));
// Recover an idle native-worker crash as well as failures during a request.
let stopping = false;
let recovering = false;
const recovery = setInterval(async () => {
  if (stopping || recovering || engine.ready || engine.busy) return;
  recovering = true;
  try { await engine.start(); } catch { /* Health remains unavailable until recovery succeeds. */ }
  finally { recovering = false; }
}, 5000);
recovery.unref();
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(recovery);
  server.close();
  if ("closeAllConnections" in server) server.closeAllConnections();
  await engine.close();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
