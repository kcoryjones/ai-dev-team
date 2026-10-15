import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createRepository,
  discoverRepositories,
  inspectRepository,
} from "./repository.js";

describe("repository workspace boundary", () => {
  it("discovers Git repositories beneath the configured root", () => {
    const workspace = mkdtempSync(join(tmpdir(), "engineering-team-workspace-"));
    const repositoryPath = join(workspace, "customer-portal");
    mkdirSync(repositoryPath);
    execFileSync("git", ["init", "--quiet", repositoryPath]);
    execFileSync("git", ["-C", repositoryPath, "remote", "add", "origin", "git@example.com:team/customer-portal.git"]);

    const repositories = discoverRepositories(workspace);

    assert.equal(repositories.length, 1);
    assert.equal(repositories[0]?.name, "customer-portal");
    assert.equal(repositories[0]?.relativePath, "customer-portal");
    assert.equal(repositories[0]?.remoteUrl, "git@example.com:team/customer-portal.git");
    assert.equal(repositories[0]?.available, true);
    rmSync(workspace, { recursive: true, force: true });
  });

  it("rejects a repository outside the configured root", () => {
    const workspace = mkdtempSync(join(tmpdir(), "engineering-team-workspace-"));
    const externalRepository = mkdtempSync(join(tmpdir(), "engineering-team-external-"));
    execFileSync("git", ["init", "--quiet", externalRepository]);

    assert.throws(
      () => inspectRepository(externalRepository, workspace),
      /outside the configured workspace root/,
    );

    rmSync(workspace, { recursive: true, force: true });
    rmSync(externalRepository, { recursive: true, force: true });
  });

  it("creates a new Git repository directly beneath the workspace root", () => {
    const workspace = mkdtempSync(join(tmpdir(), "engineering-team-workspace-"));

    const repository = createRepository(workspace, "greenfield-app");

    assert.equal(repository.name, "greenfield-app");
    assert.equal(repository.relativePath, "greenfield-app");
    assert.equal(repository.defaultBranch, "main");
    assert.equal(discoverRepositories(workspace)[0]?.relativePath, repository.relativePath);
    assert.throws(
      () => createRepository(workspace, "../escape"),
      /Folder name must be/,
    );
    assert.throws(
      () => createRepository(workspace, "greenfield-app"),
      /already exists/,
    );

    rmSync(workspace, { recursive: true, force: true });
  });

  it("does not offer the Engineering Team control repository as a project", () => {
    const workspace = mkdtempSync(join(tmpdir(), "engineering-team-workspace-"));
    const controlRepository = join(workspace, "engineering-team");
    const productRepository = join(workspace, "product");
    mkdirSync(controlRepository);
    mkdirSync(productRepository);
    execFileSync("git", ["init", "--quiet", controlRepository]);
    execFileSync("git", ["init", "--quiet", productRepository]);
    writeFileSync(join(controlRepository, ".engineering-team-root"), "marker\n");

    const repositories = discoverRepositories(workspace);

    assert.deepEqual(repositories.map((repository) => repository.name), ["product"]);
    rmSync(workspace, { recursive: true, force: true });
  });
});
