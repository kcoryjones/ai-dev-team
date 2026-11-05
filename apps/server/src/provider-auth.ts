import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { Sha256 } from "@smithy/core/checksum";
import { SignatureV4 } from "@smithy/signature-v4";
import type { BrainProfileRef } from "@engineering-team/contracts";

export interface ProviderConnection {
  providerId: "openai" | "amazon-bedrock" | "amazon-bedrock-runtime";
  region: string;
  baseUrl: string;
  model: string | undefined;
  headers(url: URL, body: Buffer, headers: Record<string, string>, method: string): Promise<Record<string, string>>;
  refresh?(rejectedAuthorization: string | undefined): Promise<void>;
}

interface StoredAuth {
  OPENAI_API_KEY?: string;
  tokens?: { access_token: string; refresh_token?: string; account_id?: string; id_token?: string };
}

// A shared entry serializes refreshes across concurrent runs. Rotated credentials
// live in a controller-only directory; the host's read-only auth file stays intact.
export class CodexCredentialStore {
  private entries = new Map<string, Promise<{ auth: StoredAuth; refresh: (rejected: string | undefined) => Promise<void> }>>();

  constructor(private cacheDirectory: string, private fetchToken: typeof fetch = fetch) {}

  async load(authFile: string) {
    const source = await readFile(authFile);
    const fingerprint = createHash("sha256").update(source).digest("hex");
    let entry = this.entries.get(fingerprint);
    if (!entry) {
      entry = this.loadEntry(source, fingerprint);
      this.entries.set(fingerprint, entry);
      void entry.catch(() => this.entries.delete(fingerprint));
    }
    return await entry;
  }

  private async loadEntry(source: Buffer, fingerprint: string) {
    await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.cacheDirectory, 0o700);
    const cachePath = join(this.cacheDirectory, `${fingerprint}.json`);
    let auth = parseAuth(source.toString("utf8"));
    try {
      auth = parseAuth(await readFile(cachePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let refreshing: Promise<void> | undefined;
    const refresh = async (rejected: string | undefined) => {
      if (!auth.tokens?.refresh_token || rejected !== `Bearer ${auth.tokens.access_token}`) return;
      refreshing ??= (async () => {
        // Matches the pinned Codex OAuth grant in codex-rs/login/src/auth/manager.rs:
        // https://github.com/openai/codex/tree/rust-v0.162.1/codex-rs/login/src/auth
        const response = await this.fetchToken("https://auth.openai.com/oauth/token", {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grant_type: "refresh_token", client_id: "app_EMoamEEZ73f0CkXaXp7hrann", refresh_token: auth.tokens!.refresh_token }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("ChatGPT authentication could not be refreshed; sign in again and update CODEX_AUTH_FILE");
        }
        const updated = await response.json() as Record<string, unknown>;
        if (typeof updated.access_token !== "string" || !updated.access_token) throw new Error("Invalid ChatGPT token refresh response");
        const tokens = { ...auth.tokens!, access_token: updated.access_token };
        if (typeof updated.refresh_token === "string") tokens.refresh_token = updated.refresh_token;
        if (typeof updated.id_token === "string") tokens.id_token = updated.id_token;
        // Update in memory even if persistence fails: never reuse a rotated token.
        auth.tokens = tokens;
        const temporary = `${cachePath}.${randomUUID()}`;
        await writeFile(temporary, JSON.stringify(auth), { mode: 0o600, flag: "wx" });
        await rename(temporary, cachePath);
      })().finally(() => { refreshing = undefined; });
      await refreshing;
    };
    return { auth, refresh };
  }
}

function parseAuth(raw: string): StoredAuth {
  let auth: StoredAuth;
  try { auth = JSON.parse(raw) as StoredAuth; } catch { throw new Error("CODEX_AUTH_FILE is not valid JSON"); }
  if (auth && (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY || typeof auth.tokens?.access_token === "string" && auth.tokens.access_token)) return auth;
  throw new Error("CODEX_AUTH_FILE must contain a ChatGPT session or an OpenAI API key");
}

function accountHeaders(token: string | undefined, accountId?: string): Record<string, string> {
  if (!accountId && token) {
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
      const id: unknown = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
      if (typeof id === "string") accountId = id;
    } catch { /* Opaque tokens have no account claim. */ }
  }
  return accountId ? { "chatgpt-account-id": accountId } : {};
}

export async function resolveProviderConnection(
  profile: BrainProfileRef,
  authFile: string | undefined,
  credentialStore: CodexCredentialStore,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProviderConnection> {
  const model = profile.model;
  if (profile.provider === "aws-bedrock") {
    const { awsProfile, awsRegion, bedrockEndpoint } = profile.configuration ?? {};
    if (typeof awsProfile !== "string" || !awsProfile || typeof awsRegion !== "string" || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(awsRegion) || !["runtime", "mantle"].includes(String(bedrockEndpoint))) {
      throw new Error("Amazon Bedrock runtime configuration is missing a valid AWS profile, Region, or endpoint");
    }
    const credentials = fromNodeProviderChain({ profile: awsProfile, clientConfig: { region: awsRegion } });
    await credentials(); // Fail before provisioning a worker; the provider refreshes later as needed.
    return bedrockProviderConnection(bedrockEndpoint === "runtime", awsRegion, model, credentials);
  }
  if (profile.provider !== "openai") throw new Error(`Codex worker provider ${profile.provider} is not implemented`);
  if (profile.credentialRef === "CODEX_ACCESS_TOKEN" && authFile) {
    const entry = await credentialStore.load(authFile);
    const apiKey = entry.auth.OPENAI_API_KEY;
    return {
      providerId: "openai", region: "", model,
      baseUrl: apiKey ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api/codex",
      headers: async (_url, _body, headers) => ({
        ...headers, authorization: `Bearer ${apiKey || entry.auth.tokens!.access_token}`,
        ...(!apiKey ? accountHeaders(entry.auth.tokens?.id_token, entry.auth.tokens?.account_id) : {}),
      }),
      refresh: entry.refresh,
    };
  }
  const credential = environment[profile.credentialRef]?.trim();
  if (!credential) throw new Error(`Credential environment variable ${profile.credentialRef} is not available to the worker controller`);
  return {
    providerId: "openai", region: "", model,
    baseUrl: profile.credentialRef === "CODEX_ACCESS_TOKEN" ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1",
    headers: async (_url, _body, headers) => ({
      ...headers, authorization: `Bearer ${credential}`,
      ...(profile.credentialRef === "CODEX_ACCESS_TOKEN" ? accountHeaders(credential) : {}),
    }),
  };
}

export function bedrockProviderConnection(
  runtime: boolean,
  region: string,
  model: string | undefined,
  credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>,
): ProviderConnection {
  // Endpoint paths and signing services match the pinned Codex adapters:
  // https://github.com/openai/codex/tree/rust-v0.162.1/codex-rs/model-provider/src/amazon_bedrock
  const signer = new SignatureV4({ credentials, region, service: runtime ? "bedrock" : "bedrock-mantle", sha256: Sha256 });
  return {
    providerId: runtime ? "amazon-bedrock-runtime" : "amazon-bedrock", region, model,
    baseUrl: runtime ? `https://bedrock-runtime.${region}.amazonaws.com/openai/v1` : `https://bedrock-mantle.${region}.api.aws/openai/v1`,
    headers: async (url, body, headers, method) => (await signer.sign({
      protocol: url.protocol, hostname: url.hostname, path: url.pathname, method,
      query: Object.fromEntries(url.searchParams), headers: { ...headers, host: url.host }, body,
    })).headers,
  };
}
