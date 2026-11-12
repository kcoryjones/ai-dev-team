// Run inside the OLD, idle controller before recreating it; see README.md.
// Only built-ins are used so this also runs in images predating this helper.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function preserve() {
  const source = join(tmpdir(), "engineering-team-provider-auth");
  const destination = join(process.env.ENGINEERING_TEAM_WORKTREE_ROOT ?? "/worktrees", ".provider-auth");
  let entries;
  try { entries = await readdir(source, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.log("No temporary provider credentials to preserve.");
    return;
  }
  const credentials = [];
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    if (!entry.isFile()) throw new Error("Expected a regular credential cache file.");
    const raw = await readFile(join(source, entry.name), "utf8");
    let auth;
    try { auth = JSON.parse(raw); } catch { throw new Error("Temporary credential cache is invalid."); }
    if (!(typeof auth?.tokens?.access_token === "string" && auth.tokens.access_token ||
          typeof auth?.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY)) {
      throw new Error("Temporary credential cache is invalid.");
    }
    credentials.push({ name: entry.name, raw });
  }
  if (credentials.length) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await chmod(destination, 0o700);
  }
  for (const { name, raw } of credentials) {
    const target = join(destination, name), temporary = `${target}.${randomUUID()}`;
    try {
      await writeFile(temporary, raw, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  console.log(`Preserved ${credentials.length} provider credential cache(s) in the existing worktree volume.`);
}

await preserve().catch(() => {
  console.error("Unable to preserve provider credentials. Keep the old controller running and check cache access before upgrading.");
  process.exitCode = 1;
});
