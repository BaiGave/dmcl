import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fabricApiVersionTargetsMc, fetchFabricApiVersion } from "../src/meta/fabric.js";
import { summarizeFabricIncompatibleModsError } from "../src/core/gradle.js";

describe("fabricApiVersionTargetsMc", () => {
  it("matches Maven-style suffixes exactly", () => {
    assert.equal(fabricApiVersionTargetsMc("0.116.12+1.21.1", "1.21.1"), true);
    assert.equal(fabricApiVersionTargetsMc("0.42.0+1.16", "1.16"), true);
  });

  it("matches Modrinth build-style suffixes", () => {
    assert.equal(fabricApiVersionTargetsMc("0.18.0+build.387-1.16.1", "1.16.1"), true);
    assert.equal(fabricApiVersionTargetsMc("0.13.1+build.370-1.16", "1.16"), true);
  });

  it("does not map 1.16.1 to broad +1.16 lines", () => {
    assert.equal(fabricApiVersionTargetsMc("0.42.0+1.16", "1.16.1"), false);
    assert.equal(fabricApiVersionTargetsMc("0.14.1+build.372-1.16", "1.16.1"), false);
  });

  it("allows +1.16 for 1.16.2+ when semver is new enough", () => {
    assert.equal(fabricApiVersionTargetsMc("0.42.0+1.16", "1.16.2"), true);
    assert.equal(fabricApiVersionTargetsMc("0.41.0+1.16", "1.16.2"), false);
  });

  it("blocks +1.16 for two-part 1.16 via pick helper semantics", () => {
    assert.equal(fabricApiVersionTargetsMc("0.42.0+1.16", "1.16"), true);
    assert.equal(fabricApiVersionTargetsMc("0.41.9+1.16", "1.16"), true);
  });
});

describe("fetchFabricApiVersion integration", () => {
  it("resolves 1.16.1 without selecting 0.42.0+1.16", async () => {
    const version = await fetchFabricApiVersion("1.16.1");
    assert.ok(version);
    assert.notEqual(version, "0.42.0+1.16");
    assert.match(version!, /1\.16\.1|1\.16$/);
  });

  it("resolves 1.16 with a pre-0.42 line", async () => {
    const version = await fetchFabricApiVersion("1.16");
    assert.ok(version);
    assert.notEqual(version, "0.42.0+1.16");
  });
});

describe("summarizeFabricIncompatibleModsError", () => {
  it("summarizes Chinese Fabric loader output", () => {
    const log = `
有不兼容的模组！ (Incompatible mods found!)
模组 'Fabric API' (fabric) 0.42.0+1.16 需要 'Minecraft' (minecraft) 的 从 1.16.2-alpha.20.28.a（含）到 1.17-（不含）的任意版本，但已经安装了的版本 1.16.1 不对！
`;
    const summary = summarizeFabricIncompatibleModsError(log);
    assert.ok(summary);
    assert.match(summary!, /Fabric API 0\.42\.0\+1\.16/);
    assert.match(summary!, /Minecraft 1\.16\.1/);
  });
});
