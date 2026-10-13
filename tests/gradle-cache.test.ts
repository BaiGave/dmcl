import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  attachLineStream,
  buildGradleEnv,
  decodeProcessLine,
  measureLegacyGradleShards,
  pruneDmclGradleCache,
  resolveGradleUserHome,
  withUtf8ConsoleFlags,
} from "../src/core/gradle.js";

let root: string;
let dmclHome: string;
let originalDmclHome: string | undefined;
let originalGradleHome: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-gradle-cache-"));
  dmclHome = path.join(root, "dmcl");
  originalDmclHome = process.env.DMCL_HOME;
  originalGradleHome = process.env.GRADLE_USER_HOME;
  process.env.DMCL_HOME = dmclHome;
});

afterEach(() => {
  if (originalDmclHome === undefined) delete process.env.DMCL_HOME;
  else process.env.DMCL_HOME = originalDmclHome;
  if (originalGradleHome === undefined) delete process.env.GRADLE_USER_HOME;
  else process.env.GRADLE_USER_HOME = originalGradleHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, content: string, mtime?: Date): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

describe("Gradle user home", () => {
  it("uses the user's Gradle home for imported projects and one DMCL home for generated ones", () => {
    const imported = path.join(root, "imported");
    const generated = path.join(root, "generated");
    write(path.join(imported, "build.gradle"), "");
    write(path.join(generated, ".dmcl", "scaffold.json"), "{}");

    process.env.GRADLE_USER_HOME = path.join(root, "my-gradle");
    assert.deepEqual(resolveGradleUserHome(imported), { path: path.join(root, "my-gradle"), kind: "user" });
    delete process.env.GRADLE_USER_HOME;
    assert.deepEqual(resolveGradleUserHome(imported), { path: path.join(os.homedir(), ".gradle"), kind: "user" });

    const dmcl = path.join(dmclHome, "cache", "gradle");
    assert.deepEqual(resolveGradleUserHome(generated), { path: dmcl, kind: "dmcl" });
    assert.deepEqual(resolveGradleUserHome(), { path: dmcl, kind: "dmcl" });
    assert.equal(buildGradleEnv(generated).GRADLE_USER_HOME, dmcl);
    assert.deepEqual(fs.readdirSync(dmcl).filter((name) => name.startsWith("jvm-")), [], "no per-JVM shards");
  });

  it("reports legacy per-JVM shards without deleting them", async () => {
    const shardFile = write(path.join(dmclHome, "cache", "gradle", "jvm-17", "caches", "a.bin"), "12345");
    write(path.join(dmclHome, "cache", "gradle", "shared", "b.bin"), "123");
    write(path.join(dmclHome, "cache", "gradle", "caches", "c.bin"), "1");
    const shards = await measureLegacyGradleShards();
    assert.deepEqual(
      shards.map((s) => [path.basename(s.path), s.bytes]).sort(),
      [["jvm-17", 5], ["shared", 3]],
    );
    assert.ok(fs.existsSync(shardFile));
  });
});

describe("DMCL Gradle cache pruning", () => {
  it("evicts only the oldest dependency files of DMCL's own Gradle home", async () => {
    const files21 = path.join(dmclHome, "cache", "gradle", "caches", "modules-2", "files-2.1");
    const oldDep = write(path.join(files21, "g", "m", "1", "h", "old.jar"), "12345678", new Date("2025-01-01"));
    const newDep = write(path.join(files21, "g", "m", "2", "h", "new.jar"), "1234", new Date("2026-08-01"));
    const sourceDep = write(
      path.join(dmclHome, "cache", "source-gradle", "caches", "modules-2", "files-2.1", "s.jar"),
      "12",
      new Date("2025-06-01"),
    );
    const kept = [
      write(path.join(dmclHome, "cache", "gradle", "wrapper", "dists", "gradle-9.2.1-bin", "x", "lib", "a.jar"), "wrapper", new Date("2020-01-01")),
      write(path.join(dmclHome, "cache", "gradle", "caches", "transforms-4", "t", "out.jar"), "transform", new Date("2020-01-01")),
      write(path.join(dmclHome, "cache", "gradle", "jvm-21", "caches", "modules-2", "files-2.1", "legacy.jar"), "legacy", new Date("2020-01-01")),
      write(path.join(dmclHome, "cache", "gradle", "native", "0.2.8", "gradle-fileevents.dll"), "native", new Date("2020-01-01")),
      write(path.join(dmclHome, "cache", "gradle", "sources", "vault.zip"), "sources", new Date("2020-01-01")),
    ];

    const result = await pruneDmclGradleCache({ maxBytes: 5 });
    assert.equal(result.scannedBytes, 14);
    assert.equal(fs.existsSync(oldDep), false);
    assert.equal(fs.existsSync(sourceDep), false, "source cache is next-oldest");
    assert.equal(fs.existsSync(newDep), true);
    for (const file of kept) assert.equal(fs.existsSync(file), true, file);
  });

  it("does not follow a junction out of DMCL's cache", async () => {
    const external = path.join(root, "external");
    const keep = write(path.join(external, "caches", "modules-2", "files-2.1", "keep.jar"), "keep");
    fs.mkdirSync(path.join(dmclHome, "cache"), { recursive: true });
    fs.symlinkSync(external, path.join(dmclHome, "cache", "gradle"), process.platform === "win32" ? "junction" : "dir");
    await pruneDmclGradleCache({ maxBytes: 0 });
    assert.equal(fs.readFileSync(keep, "utf8"), "keep");
  });
});

describe("Gradle process output", () => {
  it("keeps multi-byte characters intact across chunk boundaries", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const lines: string[] = [];
    attachLineStream({ stdout, stderr } as never, (line) => lines.push(line));
    const bytes = Buffer.from("构建成功 ✔\r\n第二行\n", "utf8");
    for (let i = 0; i < bytes.length; i += 2) stdout.write(bytes.subarray(i, i + 2));
    stderr.write(Buffer.from("末行无换行", "utf8"));
    stdout.end();
    stderr.end();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(lines, ["构建成功 ✔", "第二行", "末行无换行"]);
  });

  it("decodes console code page output (GBK) that is not valid UTF-8", () => {
    if (process.platform !== "win32") return;
    // "系统找不到指定的路径。" in GBK, as cmd.exe prints it on Chinese Windows
    const gbk = Buffer.from("cfb5cdb3d5d2b2bbb5bdd6b8b6a8b5c4c2b7beb6a1a3", "hex");
    assert.equal(decodeProcessLine(gbk), "系统找不到指定的路径。");
    assert.equal(decodeProcessLine(Buffer.from("UTF-8 中文", "utf8")), "UTF-8 中文");
  });

  it("asks every Gradle-spawned JVM for UTF-8 console output without dropping existing options", () => {
    assert.equal(
      withUtf8ConsoleFlags(undefined),
      "-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8",
    );
    const merged = withUtf8ConsoleFlags("-Xss4m -Dstdout.encoding=GBK");
    assert.match(merged, /^-Xss4m -Dstdout\.encoding=GBK /);
    assert.equal(merged.match(/-Dstdout\.encoding/g)?.length, 1, "an explicit user choice is kept");
  });
});
