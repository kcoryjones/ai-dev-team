import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer, request } from "node:http";
import { pathToFileURL } from "node:url";

// The launcher and the entire worker deliberately have no provider credentials.
// Local HTTP adapts Codex's base_url to the run's mounted Unix socket.
export async function startWorkerRelay(socketPath: string) {
  const server = createServer((incoming, outgoing) => {
    const upstream = request({ socketPath, method: incoming.method, path: incoming.url, headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.on("error", () => outgoing.destroy());
      response.pipe(outgoing);
    });
    upstream.on("error", () => { if (outgoing.headersSent) outgoing.destroy(); else { outgoing.writeHead(502); outgoing.end("Provider proxy unavailable"); } });
    outgoing.on("close", () => upstream.destroy());
    incoming.on("error", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Worker relay did not bind");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, close: () => { server.closeAllConnections(); server.close(); } };
}

export function workerCodexConfiguration(providerId: string, region: string, baseUrl: string) {
  if (!["openai", "amazon-bedrock", "amazon-bedrock-runtime"].includes(providerId)) throw new Error("Unsupported worker provider");
  const environment: Record<string, string> = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/codex-home", CODEX_HOME: "/codex-home",
  };
  if (providerId !== "openai") {
    // This public placeholder only selects Codex's built-in Bedrock behavior.
    // The controller discards it and signs with its own AWS credentials.
    environment.AWS_BEARER_TOKEN_BEDROCK = "controller-managed";
    environment.AWS_REGION = region;
    environment.AWS_DEFAULT_REGION = region;
  }
  const selectedProvider = providerId === "openai" ? "controller-openai" : providerId;
  return {
    environment,
    arguments: [
      "--config", `model_provider=${JSON.stringify(selectedProvider)}`,
      ...(providerId === "openai" ? ["--config", 'model_providers.controller-openai.name="OpenAI"'] : []),
      "--config", `model_providers.${selectedProvider}.base_url=${JSON.stringify(baseUrl)}`,
      "--config", `model_providers.${selectedProvider}.requires_openai_auth=false`,
      "--config", `model_providers.${selectedProvider}.supports_websockets=false`,
      "--config", "features.enable_request_compression=false",
      "--config", `web_search=${JSON.stringify(providerId === "amazon-bedrock-runtime" ? "disabled" : "cached")}`,
    ],
  };
}

async function main() {
  const [providerId = "", region = "", ...args] = process.argv.slice(2);
  const relay = await startWorkerRelay("/provider/proxy.sock");
  try {
    const config = workerCodexConfiguration(providerId, region, relay.baseUrl);
    await mkdir(config.environment.HOME!, { mode: 0o700, recursive: true });
    const child = spawn("codex", ["exec", ...config.arguments, ...args], { env: config.environment, stdio: "inherit" });
    process.on("SIGTERM", () => child.kill("SIGTERM"));
    process.on("SIGINT", () => child.kill("SIGINT"));
    process.exitCode = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code ?? 1)); });
  } finally { relay.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { console.error("Worker launcher failed"); process.exitCode = 1; });
}
