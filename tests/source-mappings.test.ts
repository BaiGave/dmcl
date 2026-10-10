import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { readBuildScripts, stripGradleComments } from "../src/core/build-script.js";
import { pickJdkMajor, readLoomVersion, resolveBuildJdk } from "../src/core/jdk.js";
import { getMinecraftSourceUnitDir } from "../src/sources/paths.js";
import { detectSourceProjectTarget } from "../src/sources/project-build.js";
import {
  detectModMetadata,
  detectProjectMapping,
  getMinecraftSourceStatus,
  projectExternalModSource,
  startMinecraftSourceTask,
} from "../src/sources/service.js";
import type { ModSourceEntry } from "../src/sources/types.js";

const cleanup: string[] = [];
const originalDmclHome = process.env.DMCL_HOME;

afterEach(() => {
  if (originalDmclHome === undefined) delete process.env.DMCL_HOME;
  else process.env.DMCL_HOME = originalDmclHome;
  while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(root);
  return root;
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

/** A Linker-style layout: each variant applies a Loom script shared by every Fabric variant. */
function linkerStyleVariant(root: string, sharedScript: string, loomVersion = "1.14.10"): string {
  const variant = path.join(root, "apps", "minecraft", "fabric-1.20.1");
  write(path.join(root, "apps", "minecraft", "gradle", "fabric.gradle"), sharedScript);
  write(path.join(variant, "build.gradle"), [
    "plugins {",
    `    id 'fabric-loom' version '${loomVersion}'`,
    "    id 'java-library'",
    "}",
    "java.toolchain.languageVersion = JavaLanguageVersion.of(21)",
    "apply from: '../gradle/fabric.gradle'",
    "",
  ].join("\n"));
  write(path.join(variant, "gradle.properties"), "minecraft_version=1.20.1\nfabric_loader_version=0.18.4\n");
  write(path.join(variant, "gradle", "wrapper", "gradle-wrapper.properties"),
    "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.2.1-bin.zip\n");
  return variant;
}

const fallback = { loader: "fabric" as const, mcVersion: "1.20.1", mapping: "yarn" as const, mappingVersion: "1.20.1+build.10" };

describe("Loom mapping detection", () => {
  it("records officialMojangMappings from an applied script as Mojang names, not Yarn", () => {
    const variant = linkerStyleVariant(tempRoot("dmcl-mojmap-"), [
      "dependencies {",
      "    minecraft \"com.mojang:minecraft:${minecraft_version}\"",
      "    mappings loom.officialMojangMappings()",
      "}",
    ].join("\n"));
    assert.deepEqual(detectProjectMapping(variant, fallback), { mapping: "mojmap", mappingVersion: "1.20.1" });
  });

  it("lets the script win over a leftover yarn_mappings property", () => {
    const variant = linkerStyleVariant(tempRoot("dmcl-mojmap-prop-"), "dependencies { mappings loom.officialMojangMappings() }");
    fs.appendFileSync(path.join(variant, "gradle.properties"), "yarn_mappings=1.20.1+build.10\n");
    assert.equal(detectProjectMapping(variant, fallback).mapping, "mojmap");
  });

  it("reads Parchment from a layered Mojang mapping", () => {
    const variant = linkerStyleVariant(tempRoot("dmcl-layered-"), [
      "dependencies {",
      "    mappings loom.layered {",
      "        officialMojangMappings()",
      "        parchment(\"org.parchmentmc.data:parchment-1.20.1:2023.09.03@zip\")",
      "    }",
      "}",
    ].join("\n"));
    assert.deepEqual(detectProjectMapping(variant, fallback), { mapping: "parchment", mappingVersion: "2023.09.03" });
  });

  it("resolves Yarn coordinates through gradle.properties", () => {
    const variant = linkerStyleVariant(tempRoot("dmcl-yarn-"), "dependencies { mappings \"net.fabricmc:yarn:${project.yarn_mappings}:v2\" }");
    fs.appendFileSync(path.join(variant, "gradle.properties"), "yarn_mappings=1.20.1+build.10\n");
    assert.deepEqual(detectProjectMapping(variant, { ...fallback, mapping: "mojmap", mappingVersion: "1.20.1" }), {
      mapping: "yarn",
      mappingVersion: "1.20.1+build.10",
    });
  });

  it("ignores commented-out declarations and keeps string contents intact", () => {
    const variant = linkerStyleVariant(tempRoot("dmcl-comment-"), [
      "// mappings loom.officialMojangMappings()",
      "/* mappings loom.officialMojangMappings() */",
      "repositories { maven { url = 'https://maven.fabricmc.net/' } }",
      "dependencies { mappings \"net.fabricmc:yarn:1.20.1+build.10:v2\" }",
    ].join("\n"));
    assert.deepEqual(detectProjectMapping(variant, { ...fallback, mapping: "mojmap" }), {
      mapping: "yarn",
      mappingVersion: "1.20.1+build.10",
    });
    assert.equal(stripGradleComments("url = 'https://x/' // tail\nnext"), "url = 'https://x/' \nnext");
    assert.match(readBuildScripts(variant), /maven\.fabricmc\.net/);
  });

  it("falls back to the requested mapping when the build declares none", () => {
    const root = tempRoot("dmcl-nomapping-");
    write(path.join(root, "build.gradle"), "plugins { id 'java' }\n");
    assert.deepEqual(detectProjectMapping(root, fallback), fallback);
  });

  it("recognizes Loom variants without loader-specific gradle.properties keys", () => {
    const variant = linkerStyleVariant(tempRoot("dmcl-target-"), "dependencies { mappings loom.officialMojangMappings() }");
    assert.deepEqual(detectSourceProjectTarget(variant), { loader: "fabric", mcVersion: "1.20.1" });
  });

  it("tells ModDevGradle's legacyforge plugin (Forge) from its NeoForge plugin", () => {
    const root = tempRoot("dmcl-moddev-");
    write(path.join(root, "forge", "build.gradle"), "plugins { id 'net.neoforged.moddev.legacyforge' version '2.0.141' }\n");
    write(path.join(root, "forge", "gradle.properties"), "minecraft_version=1.20.1\nforge_version=47.3.0\n");
    write(path.join(root, "neo", "build.gradle"), "plugins { id 'net.neoforged.moddev' version '2.0.141' }\n");
    write(path.join(root, "neo", "gradle.properties"), "minecraft_version=1.21.1\nneo_version=21.1.238\n");
    assert.deepEqual(detectSourceProjectTarget(path.join(root, "forge")), { loader: "forge", mcVersion: "1.20.1" });
    assert.deepEqual(detectSourceProjectTarget(path.join(root, "neo")), { loader: "neoforge", mcVersion: "1.21.1" });
  });
});

describe("source preparation JDK", () => {
  it("takes the Loom requirement from the build script, so 1.20.1 still needs Java 21", () => {
    const variant = linkerStyleVariant(tempRoot("dmcl-loom-jdk-"), "dependencies { mappings loom.officialMojangMappings() }");
    assert.equal(readLoomVersion(variant), "1.14.10");
    assert.equal(pickJdkMajor("1.20.1", variant), 21);
    const older = linkerStyleVariant(tempRoot("dmcl-loom-old-"), "", "1.5.7");
    assert.equal(pickJdkMajor("1.20.1", older), 17);
  });

  function fakeJdk(root: string, name: string): string {
    const home = path.join(root, name);
    write(path.join(home, "bin", process.platform === "win32" ? "java.exe" : "java"), "not a real runtime");
    return home;
  }

  it("chooses a JDK without writing it into gradle.properties", async () => {
    const root = tempRoot("dmcl-jdk-choice-");
    const variant = linkerStyleVariant(root, "dependencies { mappings loom.officialMojangMappings() }");
    const properties = path.join(variant, "gradle.properties");
    const before = fs.readFileSync(properties);
    const requested = fakeJdk(root, "requested-jdk");

    const jdk = await resolveBuildJdk(variant, "1.20.1", () => {}, { javaHome: requested });
    assert.deepEqual({ home: jdk.javaHome, origin: jdk.origin }, { home: requested, origin: "requested" });
    assert.deepEqual(fs.readFileSync(properties), before);
  });

  it("keeps a java.home the project configured instead of overriding it", async () => {
    const root = tempRoot("dmcl-jdk-user-");
    const variant = linkerStyleVariant(root, "dependencies { mappings loom.officialMojangMappings() }");
    const configured = fakeJdk(root, "user-jdk");
    const properties = path.join(variant, "gradle.properties");
    fs.appendFileSync(properties, `org.gradle.java.home=${configured.replace(/\\/g, "/")}\n`);
    const before = fs.readFileSync(properties);

    const jdk = await resolveBuildJdk(variant, "1.20.1", () => {}, { javaHome: fakeJdk(root, "other-jdk") });
    assert.deepEqual({ home: path.resolve(jdk.javaHome), origin: jdk.origin }, { home: path.resolve(configured), origin: "project" });
    assert.deepEqual(fs.readFileSync(properties), before);

    fs.writeFileSync(properties, before.toString().replace(/org\.gradle\.java\.home=.*/, `org.gradle.java.home=${root.replace(/\\/g, "/")}/missing-jdk`));
    const missing = fs.readFileSync(properties);
    await assert.rejects(resolveBuildJdk(variant, "1.20.1", () => {}, { javaHome: configured }), /org\.gradle\.java\.home/);
    assert.deepEqual(fs.readFileSync(properties), missing);
  });

  it("runs Gradle on the chosen JDK and files Loom's Mojang-named sources under mojmap", async () => {
    const root = tempRoot("dmcl-mojmap-task-");
    process.env.DMCL_HOME = path.join(root, "data");
    const variant = linkerStyleVariant(root, "dependencies { mappings loom.officialMojangMappings() }");
    const properties = path.join(variant, "gradle.properties");
    const before = fs.readFileSync(properties);
    const jdk = fakeJdk(root, "gradle-jdk");

    const sourcesJar = path.join(root, "prebuilt-sources.jar");
    const zip = new AdmZip();
    for (let index = 0; index < 101; index++) {
      zip.addFile(`net/minecraft/world/level/Level${index}.java`, Buffer.from(`package net.minecraft.world.level; public class Level${index} {}`));
    }
    zip.writeZip(sourcesJar);
    const produced = path.join(variant, ".gradle", "loom-cache", "minecraftMaven", "net", "minecraft", "minecraft-merged-test", "1.20.1");
    const producedJar = path.join(produced, "minecraft-merged-test-1.20.1-sources.jar");
    const capture = path.join(root, "gradle-invocation.txt");
    write(path.join(variant, "gradlew.bat"), [
      "@echo off",
      `>"${capture}" echo %JAVA_HOME%`,
      `>>"${capture}" echo %*`,
      `if not exist "${produced}" mkdir "${produced}"`,
      `copy /y "${sourcesJar}" "${producedJar}" >nul`,
      "exit /b 0",
      "",
    ].join("\r\n"));
    write(path.join(variant, "gradlew"), [
      "#!/bin/sh",
      `printf '%s\\n' "$JAVA_HOME" > '${capture}'`,
      `printf '%s\\n' "$*" >> '${capture}'`,
      `mkdir -p '${produced}'`,
      `cp '${sourcesJar}' '${producedJar}'`,
      "",
    ].join("\n"));
    fs.chmodSync(path.join(variant, "gradlew"), 0o755);

    startMinecraftSourceTask({
      scope: "single",
      loader: "fabric",
      mcVersion: "1.20.1",
      projectPath: variant,
      includeDependencies: false,
      javaHome: jdk,
    });
    for (let attempt = 0; attempt < 500 && getMinecraftSourceStatus().task?.state === "running"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const task = getMinecraftSourceStatus().task;
    assert.equal(task?.state, "completed", task?.lastError);

    const [javaHome, args] = fs.readFileSync(capture, "utf8").split(/\r?\n/);
    assert.equal(path.resolve(javaHome), path.resolve(jdk));
    assert.match(args, /genSources/);
    assert.doesNotMatch(args, /java\.home/);
    assert.deepEqual(fs.readFileSync(properties), before);

    const mojmap = getMinecraftSourceUnitDir("fabric", "1.20.1", "mojmap");
    assert.equal(fs.existsSync(path.join(mojmap, "READY")), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(mojmap, "manifest.json"), "utf8")).mapping, "mojmap");
    assert.equal(fs.existsSync(getMinecraftSourceUnitDir("fabric", "1.20.1", "yarn")), false);
    const index = JSON.parse(fs.readFileSync(path.join(variant, ".dmcl", "sources", "index.json"), "utf8"));
    assert.equal(index.minecraft.mapping, "mojmap");
  });
});

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

describe("project Git exclusion", { skip: !gitAvailable }, () => {
  function sourceEntry(root: string): ModSourceEntry {
    const unit = path.join(root, "unit");
    write(path.join(unit, "src", "Helper.java"), "public class Helper {}");
    return {
      loader: "fabric", minecraftVersion: "1.20.1", modId: "helper", modName: "helper", modVersion: "1.0",
      artifactSha256: "a".repeat(64), sourceKind: "sources-jar", javaFiles: 1,
      path: unit, sourcePath: path.join(unit, "src"),
    };
  }

  function repository(root: string): { git: (args: string[]) => string; variant: string } {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
    git(["init"]);
    const variant = path.join(repo, "apps", "minecraft", "fabric-1.20.1");
    fs.mkdirSync(variant, { recursive: true });
    return { git, variant };
  }

  it("does not drop a .gitignore into a variant the repository already ignores", async () => {
    const root = tempRoot("dmcl-git-ignored-");
    process.env.DMCL_HOME = path.join(root, "data");
    const { git, variant } = repository(root);
    write(path.join(root, "repo", ".gitignore"), "/apps/minecraft/**/.dmcl/\n");

    await projectExternalModSource(variant, sourceEntry(root));
    assert.equal(fs.existsSync(path.join(variant, ".gitignore")), false);
    assert.equal(fs.existsSync(path.join(root, "repo", ".git", "info", "exclude")) && /\.dmcl/.test(fs.readFileSync(path.join(root, "repo", ".git", "info", "exclude"), "utf8")), false);
    assert.equal(git(["status", "--porcelain", "--", "apps"]).trim().replace(/^\?\? /, ""), "");
  });

  it("excludes an unignored nested variant locally, leaving tracked files alone", async () => {
    const root = tempRoot("dmcl-git-nested-");
    process.env.DMCL_HOME = path.join(root, "data");
    const { git, variant } = repository(root);

    await projectExternalModSource(variant, sourceEntry(root));
    assert.equal(fs.existsSync(path.join(variant, ".gitignore")), false);
    const exclude = fs.readFileSync(path.join(root, "repo", ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /^\/apps\/minecraft\/fabric-1\.20\.1\/\.dmcl\/$/m);
    assert.equal(git(["check-ignore", "apps/minecraft/fabric-1.20.1/.dmcl/sources/index.json"]).trim(), "apps/minecraft/fabric-1.20.1/.dmcl/sources/index.json");
  });
});

describe("mod jar metadata", () => {
  function jar(root: string, entries: Record<string, string>): string {
    const file = path.join(root, "mod.jar");
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content));
    zip.writeZip(file);
    return file;
  }

  it("reads the loader's own metadata from a jar that carries several loaders' files", () => {
    const root = tempRoot("dmcl-multiloader-");
    const file = jar(root, {
      "fabric.mod.json": JSON.stringify({ id: "elementa", name: "Elementa", version: "743" }),
      "META-INF/neoforge.mods.toml": [
        "modLoader = \"javafml\"",
        "# modId = \"decoy\"",
        "[[mods]]",
        "modId = \"mtr\"",
        "displayName = \"Minecraft Transit Railway\"",
        "version = \"4.1.0-beta.2\"",
        "[[dependencies.mtr]]",
        "modId = \"neoforge\"",
        "versionRange = \"[21,)\"",
      ].join("\n"),
    });
    assert.deepEqual(detectModMetadata(file, "fallback", "local", "neoforge"), {
      modId: "mtr",
      modName: "Minecraft Transit Railway",
      modVersion: "4.1.0-beta.2",
    });
    assert.equal(detectModMetadata(file, "fallback", "local", "fabric")?.modId, "elementa");
    assert.equal(detectModMetadata(file, "fallback", "local")?.modId, "elementa");
  });

  it("falls back to the file-derived version for unresolved template placeholders", () => {
    const file = jar(tempRoot("dmcl-placeholder-"), {
      "META-INF/neoforge.mods.toml": "[[mods]]\nmodId = \"ctm\"\nversion = \"${file.jarVersion}\"\n",
    });
    assert.deepEqual(detectModMetadata(file, "CTM", "1.21-1.2.1+3", "neoforge"), {
      modId: "ctm",
      modName: "ctm",
      modVersion: "1.21-1.2.1+3",
    });
  });
});
