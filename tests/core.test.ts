import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { injectBuildscriptMirrors } from "../src/core/maven.js";
import { mojangLibraryAppliesToCurrentOs } from "../src/core/forge-mavenizer.js";
import { pascalCase } from "../src/core/scaffold.js";
import { serializeMatrixResult } from "../src/workspace/matrix.js";
import { inferModDir } from "../src/workspace/project-meta.js";
import {
  neoMdkFallbackCandidates,
  neoMdkTemplateFamily,
  neoMdkZipCandidates,
} from "../src/meta/neoforge.js";

describe("Gradle process logging", () => {
  it("buffers split stdout and stderr chunks into complete lines", async () => {
    const { attachLineStream } = await import("../src/core/gradle.js");
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const lines: string[] = [];
    attachLineStream({ stdout, stderr } as never, (line) => lines.push(line));

    stdout.write("Caused by: split");
    stdout.write(" exception\r\nnext line\n");
    stderr.write("stderr detail");
    stdout.end();
    stderr.end();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(lines, [
      "Caused by: split exception",
      "next line",
      "stderr detail",
    ]);
  });

  it("discovers ModDevGradle and NeoGradle client logs", async () => {
    const { findClientLatestLogs } = await import("../src/core/gradle.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-client-logs-"));
    const nested = path.join(dir, "runs", "client", "logs", "latest.log");
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, "started", "utf8");
    assert.ok(findClientLatestLogs(dir).includes(nested));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Mojang library OS rules", () => {
  it("includes unrestricted libraries and filters foreign natives", () => {
    assert.equal(mojangLibraryAppliesToCurrentOs({}), true);
    const foreignOs = process.platform === "darwin" ? "windows" : "osx";
    assert.equal(mojangLibraryAppliesToCurrentOs({
      rules: [{ action: "allow", os: { name: foreignOs } }],
    }), false);
  });
});

describe("pascalCase", () => {
  it("converts display names", () => {
    assert.equal(pascalCase("my cool mod"), "MyCoolMod");
    assert.equal(pascalCase("123"), "Mod123");
  });
});

describe("NeoForge MDK template compatibility", () => {
  it("uses NeoGradle through Minecraft 1.20.5", () => {
    assert.equal(neoMdkTemplateFamily("1.20.5"), "NeoGradle");
    assert.match(neoMdkZipCandidates("1.20.5")[0], /MDK-1\.20\.5-NeoGradle/);
  });

  it("uses ModDevGradle from Minecraft 1.20.6", () => {
    assert.equal(neoMdkTemplateFamily("1.20.6"), "ModDevGradle");
    assert.match(neoMdkZipCandidates("1.20.6")[0], /MDK-1\.20\.6-ModDevGradle/);
  });

  it("keeps historical fallback templates on NeoGradle", () => {
    assert.match(neoMdkFallbackCandidates("1.20.3")[0], /MDK-1\.20\.2-NeoGradle/);
  });
});

describe("inferModDir", () => {
  it("uses parent for standard layout", () => {
    const p = path.join("D:", "projects", "aw", "fabric-1.21");
    assert.equal(inferModDir(p, "aw"), path.join("D:", "projects", "aw"));
  });

  it("uses project root for single-dir layout", () => {
    const p = path.join("D:", "mods", "standalone");
    assert.equal(inferModDir(p, "standalone"), path.resolve(p));
  });
});

describe("syncWorkspaceFromDisk mod grouping", () => {
  it("keeps same modId in different folders as separate mods", async () => {
    const { WorkspaceStore } = await import("../src/workspace/store.js");
    const { syncWorkspaceFromDisk } = await import("../src/workspace/sync-from-disk.js");
    const { writeModMeta, writeVariantMeta } = await import("../src/workspace/project-meta.js");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-modgroup-"));
    for (const [modFolder, mc] of [["waew", "26.2"], ["modid", "1.21.7"]] as const) {
      const projectPath = path.join(root, modFolder, `fabric-${mc}`);
      fs.mkdirSync(path.join(projectPath, "gradle", "wrapper"), { recursive: true });
      fs.writeFileSync(path.join(projectPath, "gradlew.bat"), "");
      fs.writeFileSync(path.join(projectPath, "gradle.properties"), [
        "mod_id=waew",
        "minecraft_version=" + mc,
        "loader_version=0.16.0",
      ].join("\n"));
      fs.mkdirSync(path.join(projectPath, "src", "main", "resources"), { recursive: true });
      fs.writeFileSync(path.join(projectPath, "src", "main", "resources", "fabric.mod.json"), JSON.stringify({
        schemaVersion: 1,
        id: "waew",
        name: "waew",
        version: "1.0.0",
      }));
      writeModMeta(path.join(root, modFolder), {
        id: modFolder === "waew" ? "uuid-waew" : "uuid-modid",
        displayName: modFolder,
        status: "active",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
      });
      writeVariantMeta(projectPath, {
        id: `variant-${modFolder}`,
        buildStatus: "unknown",
        source: "dmcl",
        createdAt: "2020-01-01T00:00:00.000Z",
      });
    }

    const store = new WorkspaceStore();
    const prevScanDirs = store.getScanDirs();
    try {
      store.setScanDirs([root]);
      const mods = syncWorkspaceFromDisk(store);
      assert.equal(mods.length, 2);
      const waew = mods.find((m) => m.id === "uuid-waew");
      const modid = mods.find((m) => m.id === "uuid-modid");
      assert.ok(waew);
      assert.ok(modid);
      assert.equal(waew!.variants.length, 1);
      assert.equal(modid!.variants.length, 1);
    } finally {
      store.setScanDirs(prevScanDirs);
    }
  });
});

describe("WorkspaceStore scan dir pruning", () => {
  it("drops missing and test temp scan directories", async () => {
    const { WorkspaceStore } = await import("../src/workspace/store.js");
    const store = new WorkspaceStore();
    const prev = store.getScanDirs();
    const tmpTest = path.join(os.tmpdir(), "dmcl-sync-testprune");
    const keepDir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-keep-"));
    fs.mkdirSync(tmpTest, { recursive: true });
    try {
      store.setScanDirs([
        path.join("D:", "nonexistent-dmcl-mod-dir"),
        tmpTest,
        keepDir,
      ]);
      store.refresh({ force: true });
      const dirs = store.getScanDirs();
      assert.ok(!dirs.some((d) => d.toLowerCase().includes("nonexistent-dmcl-mod-dir")));
      assert.ok(!dirs.some((d) => normalizePath(d) === normalizePath(tmpTest)));
      assert.ok(dirs.some((d) => normalizePath(d) === normalizePath(keepDir)));
    } finally {
      fs.rmSync(tmpTest, { recursive: true, force: true });
      fs.rmSync(keepDir, { recursive: true, force: true });
      store.setScanDirs(prev);
    }
  });
});

function normalizePath(p: string): string {
  return path.resolve(p).toLowerCase();
}

describe("applyProjectIdentity", () => {
  it("overwrites template Example Mod after source copy", async () => {
    const { applyProjectIdentity } = await import("../src/core/project-identity.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-id-"));
    const resDir = path.join(root, "src", "main", "resources");
    fs.mkdirSync(resDir, { recursive: true });
    fs.writeFileSync(path.join(root, "gradle.properties"), "mod_id=modid\nmod_name=Example Mod\n");
    fs.writeFileSync(path.join(resDir, "fabric.mod.json"), JSON.stringify({
      schemaVersion: 1,
      id: "modid",
      name: "Example Mod",
      version: "1.0.0",
    }, null, 2));

    await applyProjectIdentity({
      targetDir: root,
      modId: "awa",
      displayName: "awa",
      group: "com.example.awa",
      loader: "fabric",
    });

    const props = fs.readFileSync(path.join(root, "gradle.properties"), "utf8");
    assert.match(props, /mod_id=awa/);
    assert.match(props, /mod_name=awa/);
    const fabric = JSON.parse(fs.readFileSync(path.join(resDir, "fabric.mod.json"), "utf8"));
    assert.equal(fabric.id, "awa");
    assert.equal(fabric.name, "awa");
  });
});

describe("forge MDK URL resolution", () => {
  it("lists BMCL mirror before official when mirror enabled", async () => {
    const { forgeMdkCandidates } = await import("../src/meta/forge.js");
    const urls = forgeMdkCandidates("26.2", "65.0.0", true);
    assert.equal(urls.length, 2);
    assert.match(urls[0], /bmclapi2\.bangbang93\.com/);
    assert.match(urls[1], /maven\.minecraftforge\.net/);
    assert.match(urls[1], /forge-26\.2-65\.0\.0-mdk\.zip$/);
  });
});

describe("matrix serialization", () => {
  it("serializeMatrixResult converts Set to arrays", () => {
    const matrix = {
      loaders: [
        { id: "fabric" as const, label: "Fabric" },
        { id: "forge" as const, label: "Forge" },
        { id: "neoforge" as const, label: "NeoForge" },
      ],
      versions: ["1.21"],
      cells: [{
        loader: "fabric" as const,
        mcVersion: "1.21",
        status: "verified" as const,
        verification: {
          state: "verified" as const,
          buildVerified: true,
          clientVerified: true,
          updatedAt: "2020-01-01",
        },
      }],
      supported: {
        fabric: new Set(["1.21"]),
        forge: new Set<string>(),
        neoforge: new Set<string>(),
      },
    };
    const json = serializeMatrixResult(matrix);
    assert.ok(Array.isArray(json.supported.fabric));
    assert.equal(json.cells[0].verification?.state, "verified");
  });
});

describe("injectBuildscriptMirrors", () => {
  it("preserves buildscript dependencies block", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-maven-"));
    const buildFile = path.join(dir, "build.gradle");
    const original = `buildscript {
    repositories {
        mavenCentral()
    }
    dependencies {
        classpath 'net.minecraftforge.gradle:ForgeGradle:6.0.24'
    }
}
`;
    fs.writeFileSync(buildFile, original);
    const logs: string[] = [];
    await injectBuildscriptMirrors(dir, (m) => logs.push(m));
    const content = fs.readFileSync(buildFile, "utf8");
    assert.match(content, /dependencies\s*\{/);
    assert.match(content, /ForgeGradle/);
    assert.match(content, /maven\.aliyun\.com/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("mc version helpers", () => {
  it("detects unobfuscated 26.x", async () => {
    const { isUnobfuscatedMc, mcFeatureNumber } = await import("../src/meta/mc-version.js");
    assert.equal(mcFeatureNumber("1.21.4"), 21);
    assert.equal(mcFeatureNumber("26.1.2"), 26);
    assert.equal(isUnobfuscatedMc("26.1.2"), true);
    assert.equal(isUnobfuscatedMc("1.21.4"), false);
  });
});

describe("fabric toolchain version helpers", () => {
  it("handles 26.x split sources and loom plugin", async () => {
    const {
      supportsSplitSources,
      usesRemapLoom,
      usesLegacyFabricApi,
    } = await import("../src/loaders/fabric-toolchain.js");
    assert.equal(supportsSplitSources("26.1.2"), true);
    assert.equal(usesRemapLoom("26.1.2"), false);
    assert.equal(usesLegacyFabricApi("26.1.2"), false);
    assert.equal(usesLegacyFabricApi("1.19.1"), true);
    assert.equal(usesLegacyFabricApi("1.20.1"), false);
  });

  it("keeps plain implementation dependencies for unobfuscated MC", async () => {
    const { patchBuildGradle } = await import("../src/loaders/fabric-toolchain.js");
    const patched = patchBuildGradle(`
plugins {
  id 'net.fabricmc.fabric-loom' version "\${loom_version}"
}

dependencies {
  minecraft "com.mojang:minecraft:\${project.minecraft_version}"
  mappings loom.officialMojangMappings()
  implementation "net.fabricmc:fabric-loader:\${project.loader_version}"
  implementation "net.fabricmc.fabric-api:fabric-api:\${project.fabric_api_version}"
}
`, {
      loader: "fabric",
      mcVersion: "26.2",
      modId: "test",
      displayName: "Test",
      className: "Test",
      group: "com.test",
      targetDir: "/tmp/test",
      mirror: false,
      mappings: "mojmap",
    });

    assert.doesNotMatch(patched, /officialMojangMappings|modImplementation/);
    assert.match(patched, /implementation "net\.fabricmc:fabric-loader/);
  });
});

describe("side layout helpers", () => {
  it("defaults to unified for all loaders", async () => {
    const { defaultSideLayout, effectiveSideLayout, parseSideLayout, wantsSplitSources } = await import("../src/core/side-layout.js");
    assert.equal(defaultSideLayout("fabric", "1.21.4"), "unified");
    assert.equal(defaultSideLayout("fabric", "1.17.1"), "unified");
    assert.equal(defaultSideLayout("forge", "1.21.4"), "unified");
    assert.equal(parseSideLayout("client"), "client");
    assert.equal(parseSideLayout("bogus"), null);

    const base = {
      loader: "fabric" as const,
      mcVersion: "1.21.4",
      modId: "test",
      displayName: "Test",
      className: "Test",
      group: "com.test",
      targetDir: "/tmp/test",
      mirror: false,
      mappings: "yarn" as const,
    };
    assert.equal(effectiveSideLayout({ ...base, sideLayout: "split" }), "split");
    assert.equal(effectiveSideLayout({ ...base, mcVersion: "1.17.1", sideLayout: "split" }), "unified");
    assert.equal(wantsSplitSources({ ...base, sideLayout: "split" }), true);
    assert.equal(wantsSplitSources({ ...base, sideLayout: "unified" }), false);
    assert.equal(wantsSplitSources({ ...base, sideLayout: "client" }), true);
    assert.equal(wantsSplitSources({ ...base, sideLayout: "server" }), false);
  });

  it("removes demo mixins and syncs mixin config for unified fabric layout", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { applySideLayout } = await import("../src/core/side-layout.js");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-side-"));
    const res = path.join(dir, "src", "main", "resources");
    const java = path.join(dir, "src", "main", "java", "com", "example", "aaa", "mixin");
    fs.mkdirSync(res, { recursive: true });
    fs.mkdirSync(java, { recursive: true });
    fs.writeFileSync(path.join(java, "ExampleMixin.java"), "package com.example.aaa.mixin;\n");
    fs.writeFileSync(path.join(res, "aaa.mixins.json"), JSON.stringify({
      required: true,
      package: "com.example.aaa.mixin",
      compatibilityLevel: "JAVA_21",
      mixins: ["ExampleMixin"],
    }, null, "\t") + "\n");
    fs.writeFileSync(path.join(res, "fabric.mod.json"), JSON.stringify({
      schemaVersion: 1,
      id: "aaa",
      mixins: ["aaa.mixins.json"],
    }, null, "\t") + "\n");

    await applySideLayout({
      loader: "fabric",
      mcVersion: "1.21.4",
      modId: "aaa",
      displayName: "Aaa",
      className: "Aaa",
      group: "com.example.aaa",
      targetDir: dir,
      mirror: false,
      mappings: "yarn",
      sideLayout: "unified",
    }, () => {});

    assert.equal(fs.existsSync(path.join(java, "ExampleMixin.java")), false);
    assert.equal(fs.existsSync(path.join(res, "aaa.mixins.json")), false);
    const modJson = JSON.parse(fs.readFileSync(path.join(res, "fabric.mod.json"), "utf8")) as { mixins?: unknown[] };
    assert.equal(modJson.mixins, undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("resolveMappings for unobfuscated fabric", () => {
  it("returns implicit mojmap for 26.x", async () => {
    const { resolveMappings } = await import("../src/meta/mappings-cache.js");
    const entry = await resolveMappings("fabric", "26.1.2");
    assert.equal(entry.default, "mojmap");
    assert.equal(entry.options.length, 1);
    assert.equal(entry.options[0].label, "官方未混淆");
  });
});

describe("NeoForge version mapping", () => {
  it("maps calver MC 26.1 to 26.1.0.x and MC 26.1.2 to 26.1.2.x", async () => {
    const { neoPrefixFor, pickNeoForgeVersion } = await import("../src/meta/neoforge.js");
    const versions = [
      "21.11.42",
      "26.1.0.19-beta",
      "26.1.2.75",
      "26.1.2.76",
      "26.2.0.6-beta",
    ];

    assert.equal(neoPrefixFor("1.21.11"), "21.11");
    assert.equal(neoPrefixFor("26.1"), "26.1.0");
    assert.equal(neoPrefixFor("26.1.2"), "26.1.2");
    assert.equal(neoPrefixFor("26.2"), "26.2.0");

    assert.equal(pickNeoForgeVersion(versions, "1.21.11"), "21.11.42");
    assert.equal(pickNeoForgeVersion(versions, "26.1"), "26.1.0.19-beta");
    assert.equal(pickNeoForgeVersion(versions, "26.1.2"), "26.1.2.76");
    assert.equal(pickNeoForgeVersion(versions, "26.2"), "26.2.0.6-beta");
  });
});

describe("loader support computation", () => {
  it("derives loader MC lists from upstream metadata in release order", async () => {
    const { computeLoaderVersions, forgeMcVersionFromPromoKey } = await import("../src/meta/loader-support.js");
    const result = computeLoaderVersions(
      ["26.1.2", "1.21.4", "1.20.1", "1.7.10"],
      ["1.21.4", "26.1.2"],
      {
        "1.20.1-latest": "47.4.0",
        "1.7.10-recommended": "10.13.4.1614",
      },
      ["21.4.123", "26.1.2.1"],
    );

    assert.deepEqual(result.fabric, ["26.1.2", "1.21.4"]);
    assert.deepEqual(result.forge, ["1.20.1", "1.7.10"]);
    assert.deepEqual(result.neoforge, ["26.1.2", "1.21.4"]);
    assert.equal(forgeMcVersionFromPromoKey("1.20.1-latest"), "1.20.1");
  });
});

describe("MetaCache staleness", () => {
  it("uses caller maxAge and treats invalid timestamps as stale", async () => {
    const { MetaCache } = await import("../src/meta/meta-cache.js");
    const cache = new MetaCache();
    const base = {
      version: 1 as const,
      releaseVersions: [],
      fabricGameVersions: [],
      fabricLoaderVersion: "0.0.0",
      forgePromos: {},
      neoforgeVersions: [],
      loaderVersions: { fabric: [], forge: [], neoforge: [] },
    };

    assert.equal(cache.isStale({ ...base, updatedAt: new Date().toISOString() }, 60_000), false);
    assert.equal(cache.isStale({ ...base, updatedAt: new Date(Date.now() - 120_000).toISOString() }, 60_000), true);
    assert.equal(cache.isStale({ ...base, updatedAt: "not-a-date" }, 60_000), true);
  });

  it("forge MDK probe list only includes new or unknown versions", async () => {
    const { forgeVersionsNeedingMdkProbe, setForgeMdkCached } = await import("../src/meta/forge-mdk-cache.js");
    setForgeMdkCached("1.20.1", true);
    setForgeMdkCached("1.12.2", false);
    setForgeMdkCached("1.19.4", true);
    const probe = forgeVersionsNeedingMdkProbe(
      ["1.21.1", "1.20.1", "1.12.2", "1.19.4"],
      new Set(["1.21.1"]),
    );
    assert.deepEqual(probe, ["1.21.1"]);
  });

  it("shards isolated Gradle home when project JDK is detectable", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { findCachedJdk, detectJavaMajorAt } = await import("../src/core/jdk.js");
    const { getIsolatedGradleHome } = await import("../src/core/gradle.js");
    const cached = findCachedJdk(21) ?? findCachedJdk(17) ?? findCachedJdk(8);
    if (!cached) return;

    const major = detectJavaMajorAt(cached);
    if (!major) return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-gradle-home-"));
    try {
      const escaped = cached.replace(/\\/g, "/");
      fs.writeFileSync(path.join(dir, "gradle.properties"), `org.gradle.java.home=${escaped}\n`, "utf8");
      assert.match(getIsolatedGradleHome(dir), new RegExp(`jvm-${major}$`));
      assert.doesNotMatch(getIsolatedGradleHome(), new RegExp(`jvm-${major}$`));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recommends conservative Gradle build concurrency for batch safety", async () => {
    const { recommendGradleBuildConcurrency } = await import("../gui/cpu-concurrency.js");
    assert.equal(recommendGradleBuildConcurrency(16), 6);
    assert.equal(recommendGradleBuildConcurrency(8), 4);
    assert.equal(recommendGradleBuildConcurrency(4), 2);
    assert.equal(recommendGradleBuildConcurrency(1), 1);
  });
});

describe("project JDK resolution", () => {
  function writeGradleProject(
    dir: string,
    gradleVersion: string,
    mcVersion: string,
    withLoom = true,
  ): void {
    fs.mkdirSync(path.join(dir, "gradle", "wrapper"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "gradle", "wrapper", "gradle-wrapper.properties"),
      `distributionUrl=https\\://services.gradle.org/distributions/gradle-${gradleVersion}-bin.zip\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "gradle.properties"),
      `minecraft_version=${mcVersion}\n${withLoom ? "loom_version=1.16-SNAPSHOT\n" : ""}`,
      "utf8",
    );
  }

  it("uses exact Gradle runtime compatibility and no phantom Loom requirement", async () => {
    const { gradleJvmRange, pickJdkMajor } = await import("../src/core/jdk.js");
    assert.deepEqual(gradleJvmRange("8.1.1"), { min: 17, max: 19 });
    assert.deepEqual(gradleJvmRange("8.5"), { min: 17, max: 21 });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-jdk-"));
    writeGradleProject(dir, "8.1.1", "1.20", false);
    assert.equal(pickJdkMajor("1.20", dir), 17);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("includes the Minecraft compile target in managed JDK selection", async () => {
    const { pickJdkMajor, resolveProjectJdkNeed } = await import("../src/core/jdk.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-jdk-"));
    writeGradleProject(dir, "9.4.1", "26.1.2");

    assert.equal(pickJdkMajor("26.1.2", dir), 25);
    assert.equal(resolveProjectJdkNeed(dir, "26.1.2").incompatibleReason, undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports incompatible Gradle and Minecraft Java requirements", async () => {
    const { resolveProjectJdkNeed } = await import("../src/core/jdk.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-jdk-"));
    writeGradleProject(dir, "8.14.3", "26.1.2");

    assert.match(resolveProjectJdkNeed(dir, "26.1.2").incompatibleReason ?? "", /Java 25/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads Minecraft version from ForgeGradle 7 dependency syntax", async () => {
    const { readMcVersionFromProject } = await import("../src/core/jdk.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-forge-mc-"));
    fs.writeFileSync(
      path.join(dir, "build.gradle"),
      "dependencies { implementation minecraft.dependency('net.minecraftforge:forge:26.1.2-64.0.9') }\n",
      "utf8",
    );

    assert.equal(readMcVersionFromProject(dir), "26.1.2");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reuses a higher compatible JDK when already configured", async () => {
    const { injectJdkHome, projectJdkIsReady, findCachedJdk } = await import("../src/core/jdk.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-jdk-reuse-"));
    writeGradleProject(dir, "8.14.3", "1.21.1", false);

    const jdk21 = findCachedJdk(21);
    if (!jdk21) {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
    await injectJdkHome(dir, jdk21);
    assert.equal(projectJdkIsReady(dir, 17, "1.21.1"), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("legacy ForgeGradle projects target Java 8 runtime", async () => {
    const { pickJdkMajor } = await import("../src/core/jdk.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-forge-legacy-"));
    writeGradleProject(dir, "4.10.3", "1.12.2", false);
    fs.writeFileSync(
      path.join(dir, "build.gradle"),
      "buildscript { dependencies { classpath 'net.minecraftforge.gradle:ForgeGradle:2.3-SNAPSHOT' } }\n",
      "utf8",
    );
    assert.equal(pickJdkMajor("1.12.2", dir), 8);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("legacy ForgeGradle with Gradle 8 wrapper still picks Java 8", async () => {
    const { pickJdkMajor } = await import("../src/core/jdk.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-forge-legacy-g8-"));
    writeGradleProject(dir, "8.14.3", "1.12.2", false);
    fs.writeFileSync(
      path.join(dir, "build.gradle"),
      "buildscript { dependencies { classpath 'net.minecraftforge.gradle:ForgeGradle:2.3-SNAPSHOT' } }\n",
      "utf8",
    );
    assert.equal(pickJdkMajor("1.12.2", dir), 8);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("project toolchain resolver", () => {
  function writeGradleProject(
    dir: string,
    gradleVersion: string,
    mcVersion: string,
    withLoom = true,
  ): void {
    fs.mkdirSync(path.join(dir, "gradle", "wrapper"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "gradle", "wrapper", "gradle-wrapper.properties"),
      `distributionUrl=https\\://services.gradle.org/distributions/gradle-${gradleVersion}-bin.zip\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "gradle.properties"),
      `minecraft_version=${mcVersion}\n${withLoom ? "loom_version=1.16-SNAPSHOT\n" : ""}`,
      "utf8",
    );
  }

  it("recommends Gradle upgrade when wrapper is too old for MC Java level", async () => {
    const { resolveProjectToolchain, minimumGradleForJvm } = await import("../src/core/toolchain.js");
    assert.equal(minimumGradleForJvm(17), "7.3.3");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-toolchain-"));
    writeGradleProject(dir, "7.2", "1.17.1", false);
    const profile = resolveProjectToolchain(dir)!;
    assert.equal(profile.compileJavaMajor, 17);
    assert.equal(profile.gradleUpgradeRecommended, "7.3.3");
    assert.match(profile.incompatibleReason ?? "", /7\.3\.3/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("auto-upgrades Gradle wrapper when ensureGradleWrapperCompatibility runs", async () => {
    const {
      ensureGradleWrapperCompatibility,
      resolveProjectToolchain,
      writeScaffoldMarker,
    } = await import("../src/core/toolchain.js");
    const { readGradleVersion } = await import("../src/core/jdk.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-toolchain-upgrade-"));
    writeGradleProject(dir, "7.2", "1.17.1", false);
    await writeScaffoldMarker(dir, "fabric", "1.17.1");
    const profile = resolveProjectToolchain(dir)!;
    const logs: string[] = [];
    assert.equal(await ensureGradleWrapperCompatibility(dir, profile, (m) => logs.push(m)), true);
    assert.equal(readGradleVersion(dir), "7.3.3");
    const after = resolveProjectToolchain(dir)!;
    assert.equal(after.incompatibleReason, undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolveVersionToolchain answers JDK and Gradle without a project", async () => {
    const { resolveVersionToolchain } = await import("../src/core/version-toolchain.js");
    const fabric = resolveVersionToolchain("fabric", "1.21.1");
    assert.equal(fabric.compileJavaMajor, 21);
    assert.equal(fabric.gradleRuntimeJdkMajor, 21);
    assert.match(fabric.recommendedGradleVersion, /^8\./);

    const legacyForge = resolveVersionToolchain("forge", "1.12.2");
    assert.equal(legacyForge.compileJavaMajor, 8);
    assert.equal(legacyForge.gradleRuntimeJdkMajor, 8);
    assert.equal(legacyForge.legacyForgeGradle, true);
  });

  it("skips Gradle auto-upgrade for external projects", async () => {
    const {
      ensureGradleWrapperCompatibility,
      resolveProjectToolchain,
    } = await import("../src/core/toolchain.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-toolchain-external-"));
    writeGradleProject(dir, "7.2", "1.17.1", false);
    const profile = resolveProjectToolchain(dir)!;
    const logs: string[] = [];
    assert.equal(await ensureGradleWrapperCompatibility(dir, profile, (m) => logs.push(m)), false);
    assert.match(logs.join("\n"), /外部导入/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Forge Mavenizer auxiliary JDK detection", () => {
  it("detects ForgeGradle projects and uses isolated Gradle home", async () => {
    const {
      forgeMavenizerCacheDir,
      usesForgeGradle,
    } = await import("../src/core/forge-mavenizer.js");
    const { getIsolatedGradleHome } = await import("../src/core/gradle.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-forge-mavenizer-"));

    fs.writeFileSync(path.join(dir, "build.gradle"), "plugins { id 'net.minecraftforge.gradle' version '[7.0,8)' }\n");
    assert.equal(usesForgeGradle(dir), true);
    assert.equal(
      forgeMavenizerCacheDir(),
      path.join(getIsolatedGradleHome(), "caches", "minecraftforge", "forgegradle", "mavenizer", "caches"),
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("version verification index", () => {
  it("tracks build-only, full client verification, and failures per loader version", async () => {
    const file = path.join(os.tmpdir(), `dmcl-verification-${Date.now()}.json`);
    process.env.DMCL_VERSION_VERIFICATION_FILE = file;
    const {
      getVersionVerificationSummary,
      readVersionVerificationIndex,
      recordVersionVerification,
    } = await import("../src/workspace/version-verification.js");

    recordVersionVerification({
      loader: "fabric",
      mcVersion: "26.2",
      jobType: "build",
      buildSuccess: true,
      at: "2020-01-01T00:00:00.000Z",
    });
    assert.equal(getVersionVerificationSummary("fabric", "26.2").state, "build-only");

    recordVersionVerification({
      loader: "fabric",
      mcVersion: "26.2",
      jobType: "build+run",
      buildSuccess: true,
      clientSuccess: true,
      at: "2020-01-02T00:00:00.000Z",
    });
    assert.equal(getVersionVerificationSummary("fabric", "26.2").state, "verified");

    recordVersionVerification({
      loader: "fabric",
      mcVersion: "26.2",
      jobType: "run",
      clientSuccess: false,
      failureSummary: "client failed",
      at: "2020-01-02T01:00:00.000Z",
    });
    assert.equal(getVersionVerificationSummary("fabric", "26.2").state, "failed");

    recordVersionVerification({
      loader: "forge",
      mcVersion: "1.20.1",
      jobType: "build+run",
      buildSuccess: false,
      failureSummary: "BUILD FAILED",
      at: "2020-01-03T00:00:00.000Z",
    });
    const failed = getVersionVerificationSummary("forge", "1.20.1");
    assert.equal(failed.state, "failed");
    assert.equal(failed.failureSummary, "BUILD FAILED");
    assert.equal(Object.keys(readVersionVerificationIndex().records).length, 2);

    delete process.env.DMCL_VERSION_VERIFICATION_FILE;
    fs.rmSync(file, { force: true });
  });
});

describe("version verification planning", () => {
  it("plans unverified supported loader versions in release order", async () => {
    const { buildVersionVerificationPlan } = await import("../src/workspace/version-verifier.js");
    const meta = {
      releaseVersions: ["26.2", "26.1.2", "1.21.4"],
      loaderVersions: {
        fabric: ["26.2", "26.1.2"],
        forge: ["26.1.2"],
        neoforge: ["1.21.4"],
      },
    };
    const index = {
      version: 1 as const,
      records: {
        "fabric:26.2": {
          loader: "fabric" as const,
          mcVersion: "26.2",
          buildVerified: true,
          clientVerified: true,
          lastResultAt: "2020-01-01T00:00:00.000Z",
        },
        "forge:26.1.2": {
          loader: "forge" as const,
          mcVersion: "26.1.2",
          buildVerified: true,
          clientVerified: false,
          lastResultAt: "2020-01-01T00:00:00.000Z",
        },
      },
    };

    const plan = buildVersionVerificationPlan(meta, index);
    assert.deepEqual(
      plan.map((t) => `${t.loader}:${t.mcVersion}:${t.summary.state}`),
      [
        "fabric:26.1.2:unknown",
        "forge:26.1.2:build-only",
        "neoforge:1.21.4:unknown",
      ],
    );
  });

  it("matrix-all plan includes every supported loader version when forced", async () => {
    const { buildVersionVerificationPlan, summarizeMatrixCombinations } = await import("../src/workspace/version-verifier.js");
    const meta = {
      releaseVersions: ["26.2", "1.21.4", "1.20.1"],
      loaderVersions: {
        fabric: ["26.2", "1.21.4"],
        forge: ["1.20.1"],
        neoforge: ["1.21.4"],
      },
    };
    const counts = summarizeMatrixCombinations(meta);
    assert.equal(counts.total, 4);
    const index = { version: 1 as const, records: {
      "fabric:26.2": {
        loader: "fabric" as const,
        mcVersion: "26.2",
        buildVerified: true,
        clientVerified: true,
        lastResultAt: "2020-01-01T00:00:00.000Z",
      },
    } };
    assert.equal(buildVersionVerificationPlan(meta, index, {}).length, 3);
    assert.equal(buildVersionVerificationPlan(meta, index, { force: true }).length, 4);
  });
});

describe("verification auto-fix planning", () => {
  it("detects toolchain and cross-loader fixes from logs", async () => {
    const { planVerificationFixes } = await import("../src/workspace/verification-fix.js");
    const forgePlan = planVerificationFixes(
      "JDK 准备失败：Gradle 8 requires Java 17\nBUILD FAILED",
      "forge",
    );
    assert.deepEqual(forgePlan.fixes, ["toolchain"]);

    const crossPlan = planVerificationFixes(
      "error: package net.fabricmc.api does not exist\nModInitializer",
      "forge",
    );
    assert.ok(crossPlan.fixes.includes("cross-loader"));
  });
});

describe("version verification failure summaries", () => {
  it("prefers actionable root causes over generic Gradle failure lines", async () => {
    const {
      isLikelyTransientBuildFailure,
      summarizeVerificationFailure,
    } = await import("../src/workspace/version-verifier.js");
    const lines = [
      "BUILD FAILED in 10s",
      "Caused by: java.net.http.HttpConnectTimeoutException: HTTP connect timed out",
      "Process 'command 'java.exe'' finished with non-zero exit value 1",
      "BUILD FAILED",
    ];

    assert.equal(
      summarizeVerificationFailure(lines),
      "Caused by: java.net.http.HttpConnectTimeoutException: HTTP connect timed out",
    );
    assert.equal(isLikelyTransientBuildFailure(lines), true);
  });
});
