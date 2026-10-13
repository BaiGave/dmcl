import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProperties, readPropertiesFile } from "../src/core/properties.js";
import {
  analyzeJdkNeed,
  detectJavaMajorAt,
  parseReleaseJavaMajor,
  pickJdkMajor,
  readDaemonJvmCriteria,
  readGradleVersion,
  readLoomVersion,
  resolveBuildJdk,
} from "../src/core/jdk.js";
import { resolveProjectToolchain, resolveVersionToolchain } from "../src/core/toolchain.js";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const crlf = (...lines: string[]) => lines.join("\r\n") + "\r\n";

function project(files: Record<string, string>): string {
  const dir = tempDir("dmcl-need-");
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

const wrapper = (version: string) => crlf(
  "distributionBase=GRADLE_USER_HOME",
  `distributionUrl=https\\://mirrors.cloud.tencent.com/gradle/gradle-${version}-bin.zip`,
);

/** A fake JDK: `release` names the version, so no JVM has to start. */
function fakeJdk(major: number): string {
  const home = tempDir(`dmcl-fake-jdk${major}-`);
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", process.platform === "win32" ? "java.exe" : "java"), "");
  fs.writeFileSync(path.join(home, "release"), `IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="${major}.0.5"\n`);
  return home;
}

describe(".properties parsing", () => {
  it("reads CRLF, CR and LF files, comments, separators, continuations and escapes", () => {
    const parsed = parseProperties(
      "\uFEFF# comment\r\n! also comment\r\n"
      + "loom_version = 1.14.10\r\n"
      + "org.gradle.java.home=C\\:\\\\Users\\\\me\\\\.dmcl\\\\jdks\\\\21\r\n"
      + "colon:value\r"
      + "spaced   value with spaces\n"
      + "multi=first, \\\n    second\r\n"
      + "unicode=\\u4e2d\r\n"
      + "empty=\r\n",
    );
    assert.equal(parsed.loom_version, "1.14.10");
    assert.equal(parsed["org.gradle.java.home"], "C:\\Users\\me\\.dmcl\\jdks\\21");
    assert.equal(parsed.colon, "value");
    assert.equal(parsed.spaced, "value with spaces");
    assert.equal(parsed.multi, "first, second");
    assert.equal(parsed.unicode, "中");
    assert.equal(parsed.empty, "");
    assert.equal(Object.keys(parsed).some((k) => k.startsWith("#") || k.startsWith("!")), false);
    assert.equal(Object.values(parsed).some((v) => v.includes("\r")), false);
  });

  it("treats a missing file as empty", () => {
    assert.deepEqual(readPropertiesFile(path.join(os.tmpdir(), "does-not-exist.properties")), {});
  });
});

describe("JDK need analysis", () => {
  it("Fabric Loom 1.14.10 with Minecraft 1.20.1 needs Gradle on Java 21 (CRLF files)", () => {
    const dir = project({
      "gradle.properties": crlf("minecraft_version=1.20.1", "loom_version=1.14.10"),
      "gradle/wrapper/gradle-wrapper.properties": wrapper("9.2.1"),
      "build.gradle": "plugins { id 'fabric-loom' version \"${loom_version}\" }\r\n",
    });
    assert.equal(readGradleVersion(dir), "9.2.1");
    assert.equal(readLoomVersion(dir), "1.14.10");
    const need = analyzeJdkNeed(dir, "1.20.1");
    assert.equal(need.major, 21);
    assert.equal(need.compileMajor, 17);
    assert.equal(need.minMajor, 21);
    assert.equal(pickJdkMajor("1.20.1", dir), 21);
  });

  it("Loom declared only in a shared applied script (Linker layout) still yields 21", () => {
    const root = tempDir("dmcl-shared-loom-");
    fs.mkdirSync(path.join(root, "gradle"), { recursive: true });
    fs.writeFileSync(path.join(root, "gradle", "fabric.gradle"), "// shared\r\n");
    const dir = path.join(root, "fabric-1.20.1");
    fs.mkdirSync(path.join(dir, "gradle", "wrapper"), { recursive: true });
    fs.writeFileSync(path.join(dir, "gradle", "wrapper", "gradle-wrapper.properties"), wrapper("9.2.1"));
    fs.writeFileSync(path.join(dir, "gradle.properties"), crlf("minecraft_version=1.20.1"));
    fs.writeFileSync(path.join(dir, "build.gradle"), crlf(
      "plugins {",
      "    id 'net.fabricmc.fabric-loom-remap' version '1.14.10'",
      "}",
      "apply from: '../gradle/fabric.gradle'",
    ));
    assert.equal(pickJdkMajor("1.20.1", dir), 21);
  });

  it("honors gradle-daemon-jvm.properties toolchainVersion on Gradle 8.8+", () => {
    const files = {
      "gradle.properties": crlf("minecraft_version=1.20.1", "forge_version=47.3.0"),
      "build.gradle": "plugins { id 'net.neoforged.moddev.legacyforge' version '2.0.141' }\r\n",
      "gradle/gradle-daemon-jvm.properties": crlf("# comment", "toolchainVersion=21"),
    };
    const modern = project({ ...files, "gradle/wrapper/gradle-wrapper.properties": wrapper("9.2.1") });
    assert.deepEqual(readDaemonJvmCriteria(modern), { toolchainVersion: 21 });
    const need = analyzeJdkNeed(modern, "1.20.1");
    assert.equal(need.major, 21, "Forge 1.20.1 alone would pick 17");
    assert.equal(need.minMajor, 21);
    assert.equal(need.maxMajor, 21);
    assert.equal(need.incompatibleReason, undefined);
    assert.equal(resolveProjectToolchain(modern, "1.20.1")?.gradleRuntimeJdkMajor, 21);

    const old = project({ ...files, "gradle/wrapper/gradle-wrapper.properties": wrapper("8.5") });
    assert.equal(analyzeJdkNeed(old, "1.20.1").major, 17, "Gradle < 8.8 ignores the criteria file");
  });

  it("reports daemon criteria below what the build needs", () => {
    const dir = project({
      "gradle.properties": crlf("minecraft_version=1.21.1"),
      "gradle/wrapper/gradle-wrapper.properties": wrapper("9.2.1"),
      "gradle/gradle-daemon-jvm.properties": "toolchainVersion=17\n",
    });
    assert.match(analyzeJdkNeed(dir, "1.21.1").incompatibleReason ?? "", /Java 17.*Java 21/);
  });

  it("version-only hints for Fabric 1.20.1 now say Java 21", () => {
    assert.equal(resolveVersionToolchain("fabric", "1.20.1").gradleRuntimeJdkMajor, 21);
    assert.equal(resolveVersionToolchain("forge", "1.20.1").gradleRuntimeJdkMajor, 17);
  });
});

describe("JDK detection and selection", () => {
  it("reads the major version from the JDK release file", () => {
    assert.equal(parseReleaseJavaMajor('JAVA_VERSION="21.0.5"\n'), 21);
    assert.equal(parseReleaseJavaMajor('JAVA_VERSION="1.8.0_402"\n'), 8);
    assert.equal(parseReleaseJavaMajor("nothing"), null);
    assert.equal(detectJavaMajorAt(fakeJdk(17)), 17);
    assert.equal(detectJavaMajorAt(path.join(os.tmpdir(), "no-jdk-here")), null);
  });

  it("re-validates the JDK recorded in .dmcl/toolchain.json on every launch", async () => {
    const jdk17 = fakeJdk(17);
    const jdk21 = fakeJdk(21);
    const dir = project({
      "gradle.properties": crlf("minecraft_version=1.20.1"),
      "gradle/wrapper/gradle-wrapper.properties": wrapper("9.2.1"),
      "gradle/gradle-daemon-jvm.properties": "toolchainVersion=21\n",
      ".dmcl/toolchain.json": JSON.stringify({ javaHome: jdk17, jdkMajor: 17 }),
    });
    const log: string[] = [];
    const chosen = await resolveBuildJdk(dir, "1.20.1", (line) => log.push(line), { javaHome: jdk21, download: false });
    assert.equal(chosen.javaHome, path.resolve(jdk21));
    assert.equal(chosen.major, 21);
    assert.ok(log.some((line) => line.includes("改为重新选择")), log.join("\n"));

    fs.writeFileSync(path.join(dir, ".dmcl", "toolchain.json"), JSON.stringify({ javaHome: jdk21 }));
    const kept = await resolveBuildJdk(dir, "1.20.1", () => {}, { download: false });
    assert.equal(kept.javaHome, jdk21);
    assert.equal(kept.origin, "dmcl");
  });
});
