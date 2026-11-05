import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ApplyCodingRunRequest, ApplyCodingRunResponse } from "@engineering-team/contracts";
import { runCaptureGit } from "./worker-checkout.js";

interface Receipt {
  request: ApplyCodingRunRequest;
  applied: ApplyCodingRunResponse["applied"];
}

// The single trusted controller serializes integrations across tasks. Its receipts live
// outside worker mounts and survive both controller and API restarts.
export function createIntegrationApplier(
  workspaceRoot: string, receiptRoot: string, git: typeof runCaptureGit = runCaptureGit,
): (request: ApplyCodingRunRequest) => Promise<ApplyCodingRunResponse> {
  let queue: Promise<unknown> = Promise.resolve();
  return (input) => {
    const request = JSON.parse(JSON.stringify(input)) as ApplyCodingRunRequest;
    const result = queue.then(() => apply(request));
    queue = result.catch(() => undefined);
    return result;
  };

  async function apply(request: ApplyCodingRunRequest): Promise<ApplyCodingRunResponse> {
    if (!/^[a-f0-9-]{36}$/i.test(request.approvalId)) throw new Error("Invalid integration approval ID");
    if (new Set(request.repositories.map((repo) => repo.repositoryId)).size !== request.repositories.length) {
      throw new Error("Duplicate integration repository");
    }
    await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
    const receiptPath = join(receiptRoot, `${request.approvalId}.json`);
    let receipt: Receipt;
    try {
      receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Receipt;
      if (JSON.stringify(receipt.request) !== JSON.stringify(request)) {
        throw new Error("This approval already identifies a different integration request");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      receipt = { request, applied: [] };
      await saveReceipt(receiptPath, receipt);
    }
    if (receipt.applied.length === request.repositories.length) return { applied: receipt.applied };

    const root = await realpath(workspaceRoot);
    const prepared: Array<{ repository: ApplyCodingRunRequest["repositories"][number]; sourcePath: string; alreadyApplied: boolean }> = [];
    const paths = new Set<string>();
    // Check all remaining repositories before mutating any. A receipt also covers a
    // partially applied multi-repository operation; completed repositories are never replayed.
    for (const repository of request.repositories) {
      if (receipt.applied.some((item) => item.repositoryId === repository.repositoryId)) continue;
      const sourcePath = await realpath(repository.sourcePath);
      const subpath = relative(root, sourcePath);
      if (subpath === ".." || subpath.startsWith(`..${sep}`) || isAbsolute(subpath)) {
        throw new Error("Integration repository is outside the workspace");
      }
      if (paths.has(sourcePath)) throw new Error("Integration repositories must have distinct paths");
      paths.add(sourcePath);
      const alreadyApplied = await validate(repository, sourcePath);
      prepared.push({ repository, sourcePath, alreadyApplied });
    }
    for (const { repository, sourcePath, alreadyApplied } of prepared) {
      // Recheck after preflight, then merge the approved SHA rather than a mutable ref.
      if (!alreadyApplied && !await validate(repository, sourcePath)) {
        await git(["-C", sourcePath, "merge", "--ff-only", "--no-edit", repository.sha], [sourcePath]);
      }
      const { repositoryId, branch, sha, targetBranch } = repository;
      receipt.applied.push({ repositoryId, branch, sha, targetBranch });
      await saveReceipt(receiptPath, receipt);
    }
    return { applied: receipt.applied };
  }

  async function validate(repository: ApplyCodingRunRequest["repositories"][number], sourcePath: string): Promise<boolean> {
    const run = (...args: string[]) => git(["-C", sourcePath, ...args], [sourcePath]);
    let targetBranch: string;
    try {
      targetBranch = (await run("symbolic-ref", "--quiet", "--short", "HEAD")).trim();
    } catch {
      throw new Error(`${repository.name} must have the approved target branch checked out`);
    }
    if (targetBranch !== repository.targetBranch) throw new Error(`${repository.name} is no longer on approved target branch ${repository.targetBranch}`);
    let currentSha: string | null = null;
    try { currentSha = (await run("rev-parse", "--verify", "HEAD")).trim(); } catch {
      // Only an unborn branch may lack HEAD; later Git checks still fail closed.
    }
    if (currentSha === repository.sha) return true;
    if (currentSha) {
      try {
        await run("merge-base", "--is-ancestor", repository.sha, currentSha);
        return true; // Recover a crash after Git succeeded but before the receipt was saved.
      } catch { /* The approved commit has not been integrated. */ }
    }
    if ((await run("status", "--porcelain")).trim()) throw new Error(`${repository.name} has uncommitted or untracked changes. Clean the working tree before resuming integration.`);
    const branchSha = (await run("rev-parse", "--verify", `refs/heads/${repository.branch}^{commit}`)).trim();
    if (branchSha !== repository.sha) throw new Error(`Reviewed branch ${repository.branch} changed after approval`);
    if (currentSha !== (repository.baseCommit === "unborn" ? null : repository.baseCommit)) {
      throw new Error(`${repository.name} changed after this task started; the approved base no longer matches`);
    }
    if (currentSha) await run("merge-base", "--is-ancestor", currentSha, repository.sha);
    return false;
  }

  async function saveReceipt(path: string, receipt: Receipt): Promise<void> {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(receipt)); await file.sync(); } finally { await file.close(); }
      await rename(temporaryPath, path);
      const directory = await open(receiptRoot, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
