import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { resolveDmclHome } from "../src/core/dmcl-home.js";
import { MappingsCache, resolveMappings } from "../src/meta/mappings-cache.js";
import { usesLegacyForgeMcp } from "../src/meta/mc-version.js";
import {
  getMinecraftSourceUnitDir,
  listMinecraftSourceEntries,
  sourceUnitReady,
} from "../src/sources/paths.js";
import {
  detectProjectMapping,
  getMinecraftSourceStatus,
  materializeMinecraftSourcesFromProject,
  startMinecraftSourceTask,
} from "../src/sources/service.js";

const cleanup: string[] = [];
const originalDmclHome = process.env.DMCL_HOME;

afterEach(() => {
  if (originalDmclHome === undefined) delete process.env.DMCL_HOME;
  else process.env.DMCL_HOME = originalDmclHome;
  while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("DMCL data root", () => {
  it("uses an explicit home and supports portable EXE layout", () => {
    assert.equal(
      resolveDmclHome({ env: { DMCL_HOME: "D:\\DMCL-Data" }, execPath: "C:\\Apps\\DMCL.exe" }),
      path.resolve("D:\\DMCL-Data"),
    );
    assert.equal(
      resolveDmclHome({
        env: {},
        platform: "win32",
        execPath: "C:\\Portable\\DMCL.exe",
        fileExists: (file) => file.endsWith("portable.flag"),
      }),
      path.join("C:\\Portable", "data"),
    );
  });
});

describe("legacy Forge mappings", () => {
  it("selects MCP before Forge 1.16.5", async () => {
    assert.equal(usesLegacyForgeMcp("1.16.4"), true);
    assert.equal(usesLegacyForgeMcp("1.16.5"), false);
    const entry = await resolveMappings("forge", "1.12.2");
    assert.equal(entry.default, "mcp");
    assert.deepEqual(entry.options.map((option) => option.id), ["mcp"]);
    const cache = new MappingsCache();
    assert.equal(cache.isIncomplete({
      loader: "forge",
      mcVersion: "1.12.2",
      options: [{ id: "mojmap", label: "官方默认", available: true }],
      default: "mojmap",
      updatedAt: new Date().toISOString(),
    }), true);
  });

  it("reads snapshot and official mappings from generated MDKs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-forge-mapping-"));
    cleanup.push(dir);
    const fallback = { loader: "forge" as const, mcVersion: "1.12.2", mapping: "mcp" as const, mappingVersion: "1.12.2" };
    fs.writeFileSync(path.join(dir, "build.gradle"), "minecraft { mappings channel: 'snapshot', version: '20171003-1.12' }");
    assert.deepEqual(detectProjectMapping(dir, fallback), {
      mapping: "mcp",
      mappingVersion: "snapshot_20171003-1.12",
    });
    fs.writeFileSync(path.join(dir, "build.gradle"), "minecraft { mappings channel: 'official', version: '1.16.5' }");
    assert.deepEqual(detectProjectMapping(dir, { ...fallback, mcVersion: "1.16.5", mapping: "mojmap" }), {
      mapping: "mojmap",
      mappingVersion: "official_1.16.5",
    });
  });
});

describe("Minecraft source vault", () => {
  it("materializes loader sources into the stable relative hierarchy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-sources-"));
    cleanup.push(root);
    process.env.DMCL_HOME = path.join(root, "data");
    const project = path.join(root, "project");
    const archive = path.join(
      project,
      ".gradle", "loom-cache", "minecraftMaven", "net", "minecraft", "test",
      "minecraft-common-1.20.1-sources.jar",
    );
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(path.join(project, "gradle.properties"), "loader_version=0.16.10\n");
    const zip = new AdmZip();
    for (let index = 0; index < 101; index++) {
      zip.addFile(`net/minecraft/test/Class${index}.java`, Buffer.from(`package net.minecraft.test; public class Class${index} {}`));
    }
    zip.writeZip(archive);

    const entry = await materializeMinecraftSourcesFromProject({
      projectPath: project,
      loader: "fabric",
      mcVersion: "1.20.1",
      mapping: "yarn",
      mappingVersion: "1.20.1+build.10",
    });
    const expectedUnit = path.join(
      process.env.DMCL_HOME,
      "sources", "v1", "minecraft", "fabric", "1.20.1", "yarn",
    );
    assert.equal(getMinecraftSourceUnitDir("fabric", "1.20.1", "yarn"), expectedUnit);
    assert.equal(entry.sourcePath, path.join(expectedUnit, "src"));
    assert.equal(entry.javaFiles, 101);
    assert.equal(sourceUnitReady(expectedUnit), true);
    assert.equal(fs.existsSync(path.join(entry.sourcePath, "net", "minecraft", "test", "Class100.java")), true);
    assert.equal(listMinecraftSourceEntries().length, 1);
  });

  it("projects cached MC and dependency sources into .dmcl without Git tracking", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-project-sources-"));
    cleanup.push(root);
    process.env.DMCL_HOME = path.join(root, "data");
    const project = path.join(root, "project");
    fs.mkdirSync(path.join(project, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(project, ".git", "info", "exclude"), "", "utf8");
    fs.writeFileSync(path.join(project, "gradle.properties"), "minecraft_version=1.20.1\nyarn_mappings=1.20.1+build.10\n", "utf8");

    const modJar = path.join(root, "helper-1.0.0.jar");
    const modZip = new AdmZip();
    modZip.addFile("fabric.mod.json", Buffer.from(JSON.stringify({ id: "helper", name: "Helper", version: "1.0.0" })));
    modZip.addFile("com/example/helper/Helper.class", Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
    modZip.writeZip(modJar);
    const escapedBatchJar = modJar.replace(/\|/g, "^|");
    fs.writeFileSync(
      path.join(project, "gradlew.bat"),
      `@echo off\r\necho DMCL_DEP^|com.example^|helper^|1.0.0^|${escapedBatchJar}\r\n`,
      "utf8",
    );
    const shellWrapper = path.join(project, "gradlew");
    fs.writeFileSync(shellWrapper, `#!/bin/sh\nprintf '%s\\n' 'DMCL_DEP|com.example|helper|1.0.0|${modJar}'\n`, "utf8");
    fs.chmodSync(shellWrapper, 0o755);

    const mcUnit = getMinecraftSourceUnitDir("fabric", "1.20.1", "yarn");
    fs.mkdirSync(path.join(mcUnit, "src", "net", "minecraft"), { recursive: true });
    fs.writeFileSync(path.join(mcUnit, "src", "net", "minecraft", "Minecraft.java"), "package net.minecraft; class Minecraft {}", "utf8");
    const generatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(mcUnit, "manifest.json"), JSON.stringify({
      schema: 1,
      minecraftVersion: "1.20.1",
      loader: "fabric",
      mapping: "yarn",
      mappingVersion: "1.20.1+build.10",
      sourceKind: "loader-sources",
      javaFiles: 1,
      generatedAt,
      relativeSourcePath: "src",
      artifacts: [],
    }), "utf8");
    fs.writeFileSync(path.join(mcUnit, "READY"), generatedAt, "utf8");

    const dependencySources = path.join(
      process.env.DMCL_HOME,
      "cache", "source-gradle", "caches", "modules-2", "files-2.1",
      "com.example", "helper", "1.0.0", "source-hash", "helper-1.0.0-sources.jar",
    );
    fs.mkdirSync(path.dirname(dependencySources), { recursive: true });
    const sourceZip = new AdmZip();
    sourceZip.addFile("com/example/helper/Helper.java", Buffer.from("package com.example.helper; public class Helper {}"));
    sourceZip.writeZip(dependencySources);

    startMinecraftSourceTask({
      scope: "single",
      loader: "fabric",
      mcVersion: "1.20.1",
      mapping: "yarn",
      projectPath: project,
      includeDependencies: true,
    });
    for (let attempt = 0; attempt < 200 && getMinecraftSourceStatus().task?.state === "running"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const task = getMinecraftSourceStatus().task;
    assert.equal(task?.state, "completed");
    assert.equal(task?.dependenciesPrepared, 1);
    assert.equal(task?.outputPath, path.join(project, ".dmcl", "sources"));
    assert.equal(fs.existsSync(path.join(project, ".dmcl", "sources", "minecraft", "src", "net", "minecraft", "Minecraft.java")), true);
    assert.equal(fs.existsSync(path.join(project, ".dmcl", "sources", "mods", "helper", "1.0.0", "src", "com", "example", "helper", "Helper.java")), true);
    assert.match(fs.readFileSync(path.join(project, ".git", "info", "exclude"), "utf8"), /\/\.dmcl\//);
  });
});
