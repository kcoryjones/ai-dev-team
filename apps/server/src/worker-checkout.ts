import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, rm, symlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorkerCheckout {
  workerRoot: string;
  workerPath: string;
  capturePath: string;
  sourcePath: string;
  baseCommit: string;
  branch: string;
}

// Only call this on controller-owned metadata. In particular, never use a
// worker checkout as Git's cwd or --git-dir, even with hooks disabled.
export async function runCaptureGit(args: string[], safeDirectories: string[] = []): Promise<string> {
  const configuration = {
    "core.hooksPath": "/dev/null",
    "core.fsmonitor": "false",
    "core.attributesFile": "/dev/null",
    "core.autocrlf": "false",
    "credential.helper": "",
    "protocol.allow": "never",
    "protocol.file.allow": "always",
    "commit.gpgSign": "false",
    "user.name": "Engineering Team Agent",
    "user.email": "agent@engineering-team.local",
    "safe.directory": "",
  };
  const entries = [...Object.entries(configuration), ...safeDirectories.map((path) => ["safe.directory", path] as const)];
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  const { stdout } = await execFileAsync("git", args, {
    cwd: "/",
    env,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export async function prepareWorkerCheckout(checkout: WorkerCheckout): Promise<void> {
  const captureFromWorker = relative(resolve(checkout.workerRoot), resolve(checkout.capturePath));
  if (!isOutside(captureFromWorker)) throw new Error("Capture checkout must be outside the worker mount");

  // This clone and its Git metadata are never exposed to a worker. The worker
  // gets a separate clone with independent objects and its own disposable .git.
  await runCaptureGit(["clone", "--quiet", "--no-hardlinks", "--no-checkout", "--", checkout.sourcePath, checkout.capturePath], [checkout.sourcePath]);
  await runCaptureGit(checkout.baseCommit === "unborn"
    ? ["-C", checkout.capturePath, "checkout", "--quiet", "--orphan", checkout.branch]
    : ["-C", checkout.capturePath, "checkout", "--quiet", "-b", checkout.branch, checkout.baseCommit]);
  await runCaptureGit(["clone", "--quiet", "--no-hardlinks", "--", checkout.capturePath, checkout.workerPath]);
}

/** The worker must have stopped before its files are captured. No worker Git
 * metadata, index, objects, hooks, or configuration is ever opened by Git. */
export async function captureWorkerCheckout(
  checkout: WorkerCheckout,
  commitMessage: string,
  commitChanges: boolean,
  comparisonBase = checkout.baseCommit,
): Promise<{ sha: string | null; changedFiles: string[] }> {
  await assertWorkerDirectory(checkout.workerRoot, checkout.workerPath);
  const trackedPaths = (await runCaptureGit(["-C", checkout.capturePath, "ls-files", "--cached", "-z"]))
    .split("\0").filter(Boolean);
  for (const entry of await readdir(checkout.capturePath)) {
    if (entry !== ".git") await rm(join(checkout.capturePath, entry), { recursive: true, force: true });
  }
  await copyWorkingTree(checkout.workerPath, checkout.capturePath, checkout.capturePath, trackedPaths);

  if (commitChanges) {
    await runCaptureGit(["-C", checkout.capturePath, "add", "--all"]);
    const staged = await runCaptureGit(["-C", checkout.capturePath, "diff", "--cached", "--name-only", "-z"]);
    if (staged) await runCaptureGit(["-C", checkout.capturePath, "commit", "--quiet", "-m", commitMessage]);
  }
  let sha: string;
  try {
    sha = (await runCaptureGit(["-C", checkout.capturePath, "rev-parse", "--verify", "HEAD"])).trim();
  } catch (error) {
    if (checkout.baseCommit !== "unborn") throw error;
    return { sha: null, changedFiles: [] };
  }
  if (sha === comparisonBase) return { sha: null, changedFiles: [] };
  const files = await runCaptureGit(comparisonBase === "unborn"
    ? ["-C", checkout.capturePath, "ls-tree", "-r", "--name-only", "-z", "HEAD"]
    : ["-C", checkout.capturePath, "diff", "--no-ext-diff", "--name-only", "-z", `${comparisonBase}..HEAD`]);
  return { sha, changedFiles: files.split("\0").filter(Boolean) };
}

export async function publishCapturedCheckout(checkout: WorkerCheckout): Promise<void> {
  // Fetch from the private clean clone. A local push launches receive-pack in
  // the source repository after Git strips configuration overrides from its
  // environment, which could re-enable receiving hooks there.
  await runCaptureGit([
    "-C", checkout.sourcePath, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules",
    "--no-auto-maintenance", "--no-write-fetch-head", "--", checkout.capturePath,
    `refs/heads/${checkout.branch}:refs/heads/${checkout.branch}`,
  ], [checkout.sourcePath]);
}

function isOutside(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

async function assertWorkerDirectory(workerRoot: string, workerPath: string): Promise<void> {
  const path = relative(resolve(workerRoot), resolve(workerPath));
  if (!path || isOutside(path)) throw new Error("Worker checkout is outside its assigned mount");
  let current = resolve(workerRoot);
  for (const segment of ["", ...path.split(sep)]) {
    current = join(current, segment);
    if (!(await lstat(current)).isDirectory()) {
      throw new Error("Worker replaced an assigned checkout directory with a non-directory");
    }
  }
}

async function copyWorkingTree(source: string, destination: string, captureRoot: string, trackedPaths: string[]): Promise<void> {
  // Install each directory's ignore rules before considering its children.
  // This avoids duplicating dependency/build directories that Git won't save.
  const entries = (await readdir(source)).sort((left, right) => left === ".gitignore" ? -1 : right === ".gitignore" ? 1 : left.localeCompare(right));
  for (const entry of entries) {
    // Skip nested Git metadata too: copying an embedded repository would give
    // git-add another opportunity to discover worker-supplied configuration.
    if (entry.toLowerCase() === ".git") continue;
    const from = join(source, entry);
    const to = join(destination, entry);
    const info = await lstat(from);
    if (info.isSymbolicLink()) {
      // Git records symlinks as link text. Never read the target on the host.
      await symlink(await readlink(from), to);
    } else if (info.isDirectory()) {
      const path = relative(captureRoot, to);
      const hasTrackedFiles = trackedPaths.some((tracked) => tracked === path || tracked.startsWith(`${path}/`));
      if (!hasTrackedFiles && await isIgnoredDirectory(captureRoot, path)) continue;
      await mkdir(to, { mode: 0o755 });
      await copyWorkingTree(from, to, captureRoot, trackedPaths);
    } else if (info.isFile()) {
      // O_NOFOLLOW prevents a file replacement from turning a copy into a host
      // read; O_NONBLOCK lets us reject special files without hanging on a FIFO.
      const input = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const openedInfo = await input.stat();
        if (!openedInfo.isFile()) throw new Error("Worker output must contain only regular files, directories, or symlinks");
        const output = await open(to, "wx", openedInfo.mode & 0o111 ? 0o755 : 0o644);
        try {
          await pipeline(input.createReadStream(), output.createWriteStream());
        } finally {
          await output.close();
        }
      } finally {
        await input.close();
      }
    } else {
      throw new Error("Worker output must contain only regular files, directories, or symlinks");
    }
  }
}

async function isIgnoredDirectory(captureRoot: string, path: string): Promise<boolean> {
  try {
    await runCaptureGit(["-C", captureRoot, "check-ignore", "--quiet", "--no-index", "--", `${path}/`]);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 1) return false;
    throw error;
  }
}
