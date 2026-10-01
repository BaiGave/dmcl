import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneDmclGradleCache } from "../src/core/gradle.js";

describe("DMCL Gradle cache policy", () => {
  it("preserves native libraries together with their extraction markers", async () => {
    const dmclHome = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-cache-native-"));
    const originalDmclHome = process.env.DMCL_HOME;
    process.env.DMCL_HOME = dmclHome;
    const nativeDirectories = [
      path.join(dmclHome, "cache", "gradle", "jvm-21", "native", "0.2.8", "x86_64-windows-gnu"),
      path.join(dmclHome, "cache", "source-gradle", "native", "0.2.8", "x86_64-windows-gnu"),
    ];
    const cacheFile = path.join(dmclHome, "cache", "gradle", "jvm-21", "caches", "old.bin");
    try {
      for (const nativeDirectory of nativeDirectories) {
        fs.mkdirSync(nativeDirectory, { recursive: true });
        fs.writeFileSync(path.join(nativeDirectory, "gradle-fileevents.dll"), "native-library");
        fs.writeFileSync(path.join(nativeDirectory, "gradle-fileevents.dll.lock"), Buffer.from([1]));
      }
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, "rebuildable");

      const result = await pruneDmclGradleCache({ maxBytes: 0 });

      assert.equal(fs.existsSync(cacheFile), false);
      assert.equal(result.remainingBytes, 0);
      for (const nativeDirectory of nativeDirectories) {
        assert.equal(fs.readFileSync(path.join(nativeDirectory, "gradle-fileevents.dll"), "utf8"), "native-library");
        assert.deepEqual(fs.readFileSync(path.join(nativeDirectory, "gradle-fileevents.dll.lock")), Buffer.from([1]));
      }
    } finally {
      if (originalDmclHome === undefined) delete process.env.DMCL_HOME;
      else process.env.DMCL_HOME = originalDmclHome;
      fs.rmSync(dmclHome, { recursive: true, force: true });
    }
  });

  it("does not follow a cache-root junction into files outside DMCL", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-cache-junction-"));
    const originalDmclHome = process.env.DMCL_HOME;
    process.env.DMCL_HOME = path.join(root, "dmcl");
    try {
      const cache = path.join(process.env.DMCL_HOME, "cache");
      const external = path.join(root, "external");
      fs.mkdirSync(cache, { recursive: true });
      fs.mkdirSync(external);
      const file = path.join(external, "keep.bin");
      fs.writeFileSync(file, "keep");
      fs.symlinkSync(external, path.join(cache, "gradle"), process.platform === "win32" ? "junction" : "dir");
      await pruneDmclGradleCache({ maxBytes: 0 });
      assert.equal(fs.readFileSync(file, "utf8"), "keep");
    } finally {
      if (originalDmclHome === undefined) delete process.env.DMCL_HOME;
      else process.env.DMCL_HOME = originalDmclHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("evicts oldest rebuildable files and preserves JDK directories", async () => {
    const dmclHome = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-cache-policy-"));
    const oldFile = path.join(dmclHome, "cache", "gradle", "jvm-21", "caches", "old.bin");
    const newerFile = path.join(dmclHome, "cache", "gradle", "jvm-21", "caches", "new.bin");
    const jdkFile = path.join(dmclHome, "cache", "gradle", "jvm-21", "jdks", "bin", "java.exe");
    const mavenizerJdkFile = path.join(dmclHome, "cache", "gradle", "jvm-8", "caches", "mavenizer", "dmcl-jdk8", "bin", "java.exe");
    const sourceCacheFile = path.join(dmclHome, "cache", "source-gradle", "caches", "old-source.bin");
    const oldDate = new Date("2025-01-01T00:00:00Z");
    const newDate = new Date("2026-08-01T00:00:00Z");
    const originalDmclHome = process.env.DMCL_HOME;
    process.env.DMCL_HOME = dmclHome;

    try {
      fs.mkdirSync(path.dirname(oldFile), { recursive: true });
      fs.mkdirSync(path.dirname(jdkFile), { recursive: true });
      fs.mkdirSync(path.dirname(mavenizerJdkFile), { recursive: true });
      fs.mkdirSync(path.dirname(sourceCacheFile), { recursive: true });
      fs.writeFileSync(oldFile, "12345678");
      fs.writeFileSync(newerFile, "12345678");
      fs.writeFileSync(jdkFile, "keep");
      fs.writeFileSync(mavenizerJdkFile, "keep");
      fs.writeFileSync(sourceCacheFile, "12345678");
      fs.utimesSync(oldFile, oldDate, oldDate);
      fs.utimesSync(newerFile, newDate, newDate);
      fs.utimesSync(sourceCacheFile, oldDate, oldDate);

      const result = await pruneDmclGradleCache({ maxBytes: 10 });

      assert.equal(result.skipped, false);
      assert.equal(fs.existsSync(oldFile), false);
      assert.equal(fs.existsSync(newerFile), true);
      assert.equal(fs.existsSync(jdkFile), true);
      assert.equal(fs.existsSync(mavenizerJdkFile), true);
      assert.equal(fs.existsSync(sourceCacheFile), false);
      assert.equal(result.remainingBytes, 8);
    } finally {
      if (originalDmclHome === undefined) delete process.env.DMCL_HOME;
      else process.env.DMCL_HOME = originalDmclHome;
      fs.rmSync(dmclHome, { recursive: true, force: true });
    }
  });
});
