import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export interface InspectedRepository {
  relativePath: string;
  name: string;
  defaultBranch: string | null;
  remoteUrl: string | null;
  description: string;
  enabled: boolean;
  available: boolean;
}

export function inspectRepository(
  candidatePath: string,
  workspaceRoot: string,
): InspectedRepository {
  const absolutePath = realpath(candidatePath);
  assertInsideWorkspace(absolutePath, workspaceRoot);

  let root: string;
  try {
    root = execFileSync("git", ["-C", absolutePath, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("The selected path is not a readable Git repository");
  }

  let defaultBranch: string | null = null;
  try {
    defaultBranch = execFileSync(
      "git",
      ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    // Detached HEAD and new repositories are valid registrations.
  }

  let remoteUrl: string | null = null;
  try {
    remoteUrl = execFileSync(
      "git",
      ["-C", root, "config", "--get", "remote.origin.url"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim() || null;
  } catch {
    // A local-only repository does not need a remote.
  }

  return {
    relativePath: relative(realpath(workspaceRoot), realpath(root)),
    name: basename(root),
    defaultBranch,
    remoteUrl,
    description: "",
    enabled: true,
    available: true,
  };
}

export function discoverRepositories(
  workspaceRoot: string,
  maxDepth = 2,
): InspectedRepository[] {
  let root: string;
  try {
    root = realpath(workspaceRoot);
  } catch {
    return [];
  }

  const discovered = new Map<string, InspectedRepository>();
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    if (existsSync(join(current.path, ".engineering-team-root"))) {
      continue;
    }

    if (isGitRepository(current.path)) {
      try {
        const repository = inspectRepository(current.path, root);
        discovered.set(repository.relativePath, repository);
      } catch {
        // A repository can disappear or become unreadable during discovery.
      }
      continue;
    }

    if (current.depth >= maxDepth) continue;

    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipDirectory(entry.name)) continue;
      queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
    }
  }

  return [...discovered.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export function createRepository(
  workspaceRoot: string,
  directoryName: string,
): InspectedRepository {
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,62}[a-zA-Z0-9])?$/.test(directoryName)) {
    throw new Error(
      "Folder name must be 1–64 characters using letters, numbers, dots, dashes, or underscores",
    );
  }

  const root = realpath(workspaceRoot);
  const repositoryPath = resolve(root, directoryName);
  const pathFromRoot = relative(root, repositoryPath);
  if (
    pathFromRoot === "" ||
    pathFromRoot.startsWith("..") ||
    isAbsolute(pathFromRoot) ||
    pathFromRoot.includes("/") ||
    pathFromRoot.includes("\\")
  ) {
    throw new Error("The new repository must be a direct child of the workspace root");
  }
  if (existsSync(repositoryPath)) {
    throw new Error("A file or folder with this name already exists");
  }

  try {
    mkdirSync(repositoryPath, { mode: 0o775 });
  } catch {
    throw new Error("The workspace root is not writable by the application user");
  }

  try {
    execFileSync(
      "git",
      ["-C", repositoryPath, "init", "--quiet", "--initial-branch=main"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    rmSync(repositoryPath, { recursive: true, force: true });
    throw new Error("The project folder was created, but Git initialization failed");
  }

  return inspectRepository(repositoryPath, root);
}

export function getRepositoryHead(repositoryPath: string, workspaceRoot: string): string {
  const absolutePath = resolveRepositoryPath(workspaceRoot, repositoryPath);
  inspectRepository(absolutePath, workspaceRoot);
  try {
    return execFileSync("git", ["-C", absolutePath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "unborn";
  }
}

export function resolveRepositoryPath(workspaceRoot: string, relativePath: string): string {
  const root = realpath(workspaceRoot);
  const candidate = resolve(root, relativePath);
  const pathFromRoot = relative(root, candidate);
  if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error("The repository path must remain inside the configured workspace root");
  }
  return candidate;
}

function assertInsideWorkspace(candidatePath: string, workspaceRoot: string): void {
  const root = realpath(workspaceRoot);
  const candidate = realpath(candidatePath);
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))) {
    return;
  }
  throw new Error("The selected repository is outside the configured workspace root");
}

function isGitRepository(candidatePath: string): boolean {
  try {
    execFileSync("git", ["-C", candidatePath, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function shouldSkipDirectory(name: string): boolean {
  return name === ".git" || name === "node_modules" || name.startsWith(".");
}

function realpath(candidatePath: string): string {
  try {
    return realpathSync(resolve(candidatePath));
  } catch {
    throw new Error("The selected path does not exist or is not readable");
  }
}
