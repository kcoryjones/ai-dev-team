import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import type { Socket } from "node:net";
import type { ProviderConnection } from "./provider-auth.js";

export type ProviderTransport = (url: URL, headers: Record<string, string>, body: Buffer, method: string, signal: AbortSignal) => Promise<IncomingMessage>;

const sendUpstream: ProviderTransport = (url, headers, body, method, signal) => new Promise((resolve, reject) => {
  // node:https never follows redirects. In particular, signed requests cannot be
  // redirected to a caller-selected host or returned to the worker as headers.
  const request = httpsRequest(url, { method, headers, signal }, resolve);
  request.on("error", reject);
  request.end(body);
});

export async function startProviderProxy(
  root: string,
  connection: ProviderConnection,
  transport: ProviderTransport = sendUpstream,
) {
  const directory = await mkdtemp(join(root, "provider-"));
  const socketPath = join(directory, "proxy.sock");
  const sockets = new Set<Socket>();
  const requests = new Set<AbortController>();
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else reply(response, 502, "Provider request failed");
    });
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  server.requestTimeout = 60_000;

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const route = request.url ?? "";
    const method = request.method ?? "";
    if (!(method === "POST" && ["/v1/responses", "/v1/responses/compact"].includes(route)) &&
        !(method === "GET" && /^\/v1\/models(?:\?client_version=[a-zA-Z0-9._+-]{1,100})?$/.test(route))) {
      reply(response, 403, "Provider endpoint is not allowed"); return;
    }
    if (requests.size >= 4) { reply(response, 429, "Too many provider requests"); return; }
    const abort = new AbortController();
    requests.add(abort);
    response.on("close", () => abort.abort());
    const timeout = setTimeout(() => abort.abort(), 10 * 60_000);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) { reply(response, 413, "Provider request is too large"); return; }
        chunks.push(chunk);
      }
      let body = Buffer.concat(chunks);
      if (method === "POST") {
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>; } catch { reply(response, 400, "Invalid JSON"); return; }
        if (!payload || Array.isArray(payload) || typeof payload !== "object" || connection.model && payload.model !== connection.model) {
          reply(response, 400, "Invalid model request"); return;
        }
        // ChatGPT and Bedrock require non-persistent Responses requests.
        if (route === "/v1/responses") payload.store = false;
        body = Buffer.from(JSON.stringify(payload));
      }
      const url = new URL(`${connection.baseUrl}${route.slice("/v1".length)}`);
      if (url.protocol !== "https:") throw new Error("Provider must use HTTPS");
      const safeHeaders: Record<string, string> = { "content-type": "application/json", "accept": "text/event-stream, application/json" };
      for (const name of ["user-agent", "originator", "version", "session_id", "openai-beta", "x-codex-turn-metadata", "x-codex-turn-state", "x-codex-parent-thread-id"]) {
        const value = request.headers[name];
        if (typeof value === "string") safeHeaders[name] = value;
      }
      let headers = await connection.headers(url, body, safeHeaders, method);
      let upstream = await transport(url, headers, body, method, abort.signal);
      if (upstream.statusCode === 401 && connection.refresh) {
        upstream.destroy();
        await connection.refresh(headers.authorization);
        headers = await connection.headers(url, body, safeHeaders, method);
        upstream = await transport(url, headers, body, method, abort.signal);
      }
      const status = upstream.statusCode ?? 502;
      if (status < 200 || status >= 300) {
        upstream.destroy();
        // Upstream errors can echo request headers/signing details. Never expose
        // those bodies or response headers to a repository-controlled client.
        reply(response, status >= 400 ? status : 502, `Provider returned HTTP ${status}`); return;
      }
      response.writeHead(status, { "content-type": upstream.headers["content-type"] ?? "application/json" });
      await new Promise<void>((resolve, reject) => {
        upstream.on("error", reject);
        upstream.on("end", resolve);
        upstream.on("close", () => { if (!upstream.complete) reject(new Error("Provider disconnected")); });
        upstream.pipe(response);
      });
    } finally {
      clearTimeout(timeout);
      abort.abort();
      requests.delete(abort);
    }
  }

  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    // Only this directory is mounted in this run; it contains no credentials.
    await chmod(directory, 0o755);
    await chmod(socketPath, 0o666);
  } catch (error) {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    socketPath,
    async close() {
      for (const request of requests) request.abort();
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function reply(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { "content-type": "application/json", "connection": "close" });
  response.end(JSON.stringify({ error: { message } }));
}
