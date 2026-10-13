import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertFreshScaffoldTarget,
  scaffoldProject,
} from "../src/core/scaffold.js";
import { scanDirectory } from "../src/workspace/detect.js";
import { syncWorkspaceFromDisk } from "../src/workspace/sync-from-disk.js";
import { ensureFabricApiVersion } from "../src/loaders/fabric-toolchain.js";

describe("project scaffold boundary", () => {
  it("refuses to overlay a template on an imported project", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-scaffold-existing-"));
    try {
      const sourceDir = path.join(root, "src", "main", "java", "io", "example");
      fs.mkdirSync(sourceDir, { recursive: true });
      const sourceFile = path.join(sourceDir, "ExistingMod.java");
      const original = "package io.example; public final class ExistingMod {}\n";
      fs.writeFileSync(sourceFile, original, "utf8");

      await assert.rejects(
        scaffoldProject({
          loader: "neoforge",
          mcVersion: "1.21.1",
          modId: "replacement",
          displayName: "Replacement",
          className: "Replacement",
          group: "com.example.replacement",
          targetDir: root,
          mirror: false,
          mappings: "mojmap",
        }, () => {}),
        /refusing to modify existing project/,
      );
      assert.equal(fs.readFileSync(sourceFile, "utf8"), original);
      assert.equal(fs.existsSync(path.join(root, "src", "main", "java", "com")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows a genuinely new or empty target", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-scaffold-new-"));
    try {
      assert.doesNotThrow(() => assertFreshScaffoldTarget(path.join(parent, "new-project")));
      const empty = path.join(parent, "empty-project");
      fs.mkdirSync(empty);
      assert.doesNotThrow(() => assertFreshScaffoldTarget(empty));
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not write into an imported project's source tree during startup sync", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-scan-readonly-"));
    const projectPath = path.join(parent, "external-linker");
    try {
      const javaRoot = path.join(projectPath, "src", "main", "java", "io", "github", "example");
      fs.mkdirSync(javaRoot, { recursive: true });
      fs.writeFileSync(path.join(javaRoot, "ExternalMod.java"), "package io.github.example; class ExternalMod {}\n", "utf8");
      fs.writeFileSync(path.join(projectPath, "gradlew.bat"), "@echo off\r\n", "utf8");
      fs.writeFileSync(path.join(projectPath, "build.gradle"), "plugins { id 'net.neoforged.moddev' version '2.0.141' }\n", "utf8");
      fs.writeFileSync(path.join(projectPath, "gradle.properties"), [
        "minecraft_version=1.21.1",
        "neo_version=21.1.233",
        "mod_id=external_linker",
        "mod_group_id=io.github.example",
      ].join("\n") + "\n", "utf8");
      const sourceTree = path.join(projectPath, "src", "main", "java");
      const before = fs.readdirSync(sourceTree, { recursive: true }).map(String).sort();

      assert.equal(scanDirectory(parent).length, 1);
      const synchronized = syncWorkspaceFromDisk({
        getScanDirs: () => [parent],
        isPathExcluded: () => false,
      } as never);

      assert.equal(synchronized.length, 1);
      assert.deepEqual(fs.readdirSync(sourceTree, { recursive: true }).map(String).sort(), before);
      assert.equal(fs.existsSync(path.join(sourceTree, "com")), false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
  it("leaves an imported Fabric project's build files alone (no Fabric API rewrite)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-fabric-imported-"));
    try {
      fs.writeFileSync(path.join(root, "gradlew.bat"), "@echo off\n");
      const props = ["minecraft_version=1.20.1", "fabric_api_version=0.0.1-bogus", "mod_id=imported", ""].join("\r\n");
      const build = "plugins { id 'fabric-loom' version '1.14.10' }\n";
      fs.writeFileSync(path.join(root, "gradle.properties"), props);
      fs.writeFileSync(path.join(root, "build.gradle"), build);
      const originalFetch = globalThis.fetch;
      let fetched = false;
      globalThis.fetch = (async () => { fetched = true; throw new Error("offline"); }) as typeof fetch;
      try {
        assert.equal(await ensureFabricApiVersion(root, () => {}), false);
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.equal(fetched, false, "no network lookup for imported projects");
      assert.equal(fs.readFileSync(path.join(root, "gradle.properties"), "utf8"), props);
      assert.equal(fs.readFileSync(path.join(root, "build.gradle"), "utf8"), build);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
