import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkDeletableVariant,
  deleteModProjects,
  deleteVariantProject,
  findGitHistory,
} from "../src/workspace/delete.js";
import { setProjectsRoot, setRepoRoot } from "../src/workspace/paths.js";
import { deleteVariantMeta, writeVariantMeta } from "../src/workspace/project-meta.js";

let root: string;
let projectsRoot: string;
let trashed: string[];
const trash = async (target: string) => {
  trashed.push(path.resolve(target));
  fs.rmSync(target, { recursive: true, force: true });
};

function makeVariant(dir: string, opts: { scaffold?: boolean; git?: "none" | "empty" | "history" | "file" } = {}): string {
  fs.mkdirSync(path.join(dir, "src", "main", "java"), { recursive: true });
  fs.writeFileSync(path.join(dir, "build.gradle"), "plugins {}\n");
  fs.writeFileSync(path.join(dir, "gradlew.bat"), "@echo off\n");
  if (opts.scaffold) {
    fs.mkdirSync(path.join(dir, ".dmcl"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".dmcl", "scaffold.json"), "{}\n");
  }
  const git = opts.git ?? "none";
  if (git === "file") fs.writeFileSync(path.join(dir, ".git"), "gitdir: ../.git/worktrees/x\n");
  if (git === "empty" || git === "history") {
    fs.mkdirSync(path.join(dir, ".git", "refs", "heads"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".git", "objects", "info"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  }
  if (git === "history") fs.writeFileSync(path.join(dir, ".git", "refs", "heads", "main"), "0".repeat(40) + "\n");
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-delete-"));
  projectsRoot = path.join(root, "repo", "projects");
  fs.mkdirSync(projectsRoot, { recursive: true });
  setRepoRoot(path.join(root, "repo"));
  setProjectsRoot(projectsRoot);
  trashed = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("variant deletion safety", () => {
  it("never deletes an imported project (no scaffold marker)", async () => {
    const variant = makeVariant(path.join(projectsRoot, "mymod", "fabric-1.21.1"));
    await assert.rejects(
      deleteVariantProject(variant, path.dirname(variant), [variant], { trash }),
      /scaffold\.json/,
    );
    assert.ok(fs.existsSync(path.join(variant, "build.gradle")));
    assert.deepEqual(trashed, []);
  });

  it("refuses a DMCL project once it holds Git history, or is a worktree", async () => {
    const withHistory = makeVariant(path.join(projectsRoot, "a", "fabric-1.21.1"), { scaffold: true, git: "history" });
    const worktree = makeVariant(path.join(projectsRoot, "b", "fabric-1.21.1"), { scaffold: true, git: "file" });
    const nested = makeVariant(path.join(projectsRoot, "c", "fabric-1.21.1"), { scaffold: true });
    makeVariant(path.join(nested, "src", "vendored"), { git: "history" });
    for (const dir of [withHistory, worktree, nested]) {
      assert.match(checkDeletableVariant(dir, [dir]).reason ?? "", /Git/);
      await assert.rejects(deleteVariantProject(dir, undefined, [dir], { trash }), /Git/);
      assert.ok(fs.existsSync(dir));
    }
    assert.deepEqual(trashed, []);
  });

  it("moves a DMCL-generated variant with only its own empty git init to the trash", async () => {
    const modDir = path.join(projectsRoot, "mymod");
    const variant = makeVariant(path.join(modDir, "fabric-1.21.1"), { scaffold: true, git: "empty" });
    const sibling = makeVariant(path.join(modDir, "forge-1.20.1"), { scaffold: true });
    fs.writeFileSync(path.join(modDir, "dmcl.mod.json"), "{}");
    assert.equal(findGitHistory(variant), null);
    await deleteVariantProject(variant, modDir, [variant, sibling], { trash });
    assert.deepEqual(trashed, [path.resolve(variant)]);
    assert.ok(fs.existsSync(sibling), "sibling variant stays");
    assert.ok(fs.existsSync(modDir), "mod folder with another variant stays");
  });

  it("removes the mod folder only when nothing but dmcl.mod.json is left", async () => {
    const modDir = path.join(projectsRoot, "solo");
    const variant = makeVariant(path.join(modDir, "neoforge-1.21.1"), { scaffold: true });
    fs.writeFileSync(path.join(modDir, "dmcl.mod.json"), "{}");
    await deleteVariantProject(variant, modDir, [variant], { trash });
    assert.ok(!fs.existsSync(modDir));
    assert.deepEqual(trashed, [path.resolve(variant), path.resolve(modDir)]);

    const keepDir = path.join(projectsRoot, "keep");
    const v2 = makeVariant(path.join(keepDir, "fabric-1.21.1"), { scaffold: true });
    fs.writeFileSync(path.join(keepDir, "notes.txt"), "mine");
    await deleteVariantProject(v2, keepDir, [v2], { trash });
    assert.ok(fs.existsSync(path.join(keepDir, "notes.txt")));
  });

  it("rejects unregistered paths and protected roots", () => {
    const stray = makeVariant(path.join(projectsRoot, "x", "fabric-1.21.1"), { scaffold: true });
    assert.equal(checkDeletableVariant(stray, []).ok, false);
    for (const target of [projectsRoot, path.join(root, "repo"), os.homedir(), path.parse(root).root]) {
      assert.equal(checkDeletableVariant(target, [target]).ok, false, target);
    }
    // A registered path that contains the projects root is never deletable either.
    assert.equal(checkDeletableVariant(path.join(root, "repo"), [path.join(root, "repo")]).ok, false);
  });

  it("deleting a Linker-style mod removes nothing: imported variants inside a Git repository", async () => {
    const linker = path.join(projectsRoot, "linker");
    makeVariant(linker, { git: "history" });
    const minecraft = path.join(linker, "apps", "minecraft");
    const variants = ["fabric-1.20.1", "neoforge-1.21.1"].map((name) => makeVariant(path.join(minecraft, name)));
    fs.writeFileSync(path.join(minecraft, "dmcl.mod.json"), "{}");

    const progress: number[] = [];
    const result = await deleteModProjects(minecraft, variants, (done) => progress.push(done), { trash });
    assert.deepEqual(result.deleted, []);
    assert.equal(result.skipped.length, 2);
    assert.deepEqual(progress, [1, 2]);
    assert.deepEqual(trashed, []);
    for (const v of variants) assert.ok(fs.existsSync(path.join(v, "build.gradle")));
    assert.ok(fs.existsSync(path.join(linker, ".git", "refs", "heads", "main")));
    assert.ok(fs.existsSync(path.join(minecraft, "dmcl.mod.json")));
  });

  it("deleteModProjects trashes DMCL variants, keeps imported ones and reports why", async () => {
    const modDir = path.join(projectsRoot, "mixed");
    const generated = makeVariant(path.join(modDir, "fabric-1.21.1"), { scaffold: true });
    const imported = makeVariant(path.join(modDir, "forge-1.20.1"));
    const result = await deleteModProjects(modDir, [generated, imported], undefined, { trash });
    assert.deepEqual(result.deleted, [path.resolve(generated)]);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /scaffold/);
    assert.ok(fs.existsSync(imported));
    assert.ok(fs.existsSync(modDir));
  });

  it("does not fall back to a permanent delete when the trash fails", async () => {
    const variant = makeVariant(path.join(projectsRoot, "m", "fabric-1.21.1"), { scaffold: true });
    await assert.rejects(
      deleteVariantProject(variant, undefined, [variant], { trash: async () => { throw new Error("no trash"); } }),
      /no trash/,
    );
    assert.ok(fs.existsSync(variant));
  });
});

describe("remove registration", () => {
  it("forgets variant.json only and keeps the rest of .dmcl", () => {
    const variant = makeVariant(path.join(projectsRoot, "m", "fabric-1.21.1"), { scaffold: true });
    writeVariantMeta(variant, { id: "v1", buildStatus: "unknown", source: "imported", createdAt: "now" });
    fs.writeFileSync(path.join(variant, ".dmcl", "toolchain.json"), "{}");
    fs.mkdirSync(path.join(variant, ".dmcl", "sources"), { recursive: true });
    deleteVariantMeta(variant);
    assert.ok(!fs.existsSync(path.join(variant, ".dmcl", "variant.json")));
    for (const kept of ["toolchain.json", "sources", "scaffold.json"]) {
      assert.ok(fs.existsSync(path.join(variant, ".dmcl", kept)), kept);
    }
  });
});
