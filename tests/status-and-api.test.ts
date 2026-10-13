import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { createApiGuard, tokenFromArgv } from "../gui/api-guard";
import { variantStatusOf } from "../src/workspace/store.js";
import {
  migrateVerificationIndex,
  projectVerificationKey,
  readVersionVerificationIndex,
  recordVersionVerification,
} from "../src/workspace/version-verification.js";

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("local API guard", () => {
  const guard = createApiGuard(19089, "a".repeat(64));
  const ok = { host: "127.0.0.1:19089", "x-dmcl-token": "a".repeat(64) };

  it("requires the session token on /api and lets static files through", () => {
    assert.equal(guard.check(request(ok), "/api/mods"), null);
    assert.equal(guard.check(request({ host: "localhost:19089" }), "/api/mods")?.status, 401);
    assert.equal(guard.check(request({ ...ok, "x-dmcl-token": "b".repeat(64) }), "/api/mods")?.status, 401);
    assert.equal(guard.check(request({ host: "localhost:19089" }), "/renderer.js"), null);
  });

  it("rejects foreign Host (DNS rebinding) and foreign Origin", () => {
    assert.equal(guard.check(request({ ...ok, host: "evil.example:19089" }), "/api/mods")?.status, 403);
    assert.equal(guard.check(request({ ...ok, host: "127.0.0.1:80" }), "/index.html")?.status, 403);
    assert.equal(guard.check(request({ ...ok, origin: "https://evil.example" }), "/api/mods")?.status, 403);
    assert.equal(guard.check(request({ ...ok, origin: "http://127.0.0.1:19089" }), "/api/mods"), null);
  });

  it("hands the token to the preload through argv", () => {
    assert.equal(tokenFromArgv(["electron", guard.preloadArgument()]), "a".repeat(64));
    assert.equal(tokenFromArgv(["electron"]), "");
    assert.notEqual(createApiGuard(19089).token, createApiGuard(19089).token);
  });
});

describe("variant status", () => {
  it("shows the active job first, then the last result, then the legacy word", () => {
    const result = {
      kind: "run" as const,
      state: "failed" as const,
      at: "2026-10-13T10:00:00.000Z",
      reason: "游戏崩溃",
      phaseReached: "starting",
    };
    assert.deepEqual(variantStatusOf(result, { state: "running", kind: "run", jobId: "j1" }), {
      state: "running", kind: "run", at: null, reason: null, phaseReached: "starting", activeJobId: "j1",
    });
    assert.deepEqual(variantStatusOf(result, undefined), {
      state: "failed", kind: "run", at: result.at, reason: "游戏崩溃", phaseReached: "starting", activeJobId: null,
    });
    assert.equal(variantStatusOf(undefined, undefined, "success").state, "succeeded");
    assert.equal(variantStatusOf(undefined, undefined, "building").state, "unknown", "a persisted 'building' is never shown as active");
  });
});

describe("verification index keyed by project and variant", () => {
  it("keeps user projects apart from DMCL's loader:mc template records", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-verif-")), "index.json");
    process.env.DMCL_VERSION_VERIFICATION_FILE = file;
    try {
      recordVersionVerification({ loader: "fabric", mcVersion: "1.20.1", jobType: "build+run", buildSuccess: true, clientSuccess: true });
      recordVersionVerification({
        scope: "project",
        loader: "fabric",
        mcVersion: "1.20.1",
        jobType: "run",
        projectPath: "D:/dcml/projects/linker/apps/minecraft/fabric-1.20.1",
        variantId: "v-linker",
        clientSuccess: false,
        failureSummary: "crash",
      });
      const records = readVersionVerificationIndex().records;
      assert.equal(records["fabric:1.20.1"].clientVerified, true, "a user project's failure does not touch the template record");
      assert.equal(records[projectVerificationKey("D:/dcml/projects/linker/apps/minecraft/fabric-1.20.1", "v-linker")].failureSummary, "crash");
    } finally {
      delete process.env.DMCL_VERSION_VERIFICATION_FILE;
    }
  });

  it("migrates version 1: variant results move to project keys, temp fixtures are dropped", () => {
    const migrated = migrateVerificationIndex({
      version: 1,
      records: {
        "fabric:1.21.1": { loader: "fabric", mcVersion: "1.21.1", buildVerified: true, clientVerified: false, lastResultAt: "x", lastProjectPath: "D:/p/linker/fabric-1.21.1", lastVariantId: "v1" },
        "forge:1.20.1": { loader: "forge", mcVersion: "1.20.1", buildVerified: true, clientVerified: true, lastResultAt: "x", lastProjectPath: path.join(os.homedir(), ".dmcl", "version-verification-projects", "forge-1.20.1") },
        "neoforge:1.21.1": { loader: "neoforge", mcVersion: "1.21.1", buildVerified: false, clientVerified: false, lastResultAt: "x", lastProjectPath: path.join(os.tmpdir(), "dmcl-fixture", "x"), lastVariantId: "t" },
      },
    });
    assert.equal(migrated.version, 2);
    assert.deepEqual(Object.keys(migrated.records).sort(), [
      "forge:1.20.1",
      projectVerificationKey("D:/p/linker/fabric-1.21.1", "v1"),
    ].sort());
  });
});

describe("workspace store start-up reset", () => {
  it("turns a persisted 'building' into 'cancelled' and keeps active jobs in memory only", async () => {
    const { WorkspaceStore } = await import("../src/workspace/store.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-store-reset-"));
    const variant = path.join(root, "mymod", "fabric-1.21.1");
    fs.mkdirSync(path.join(variant, ".dmcl"), { recursive: true });
    fs.mkdirSync(path.join(variant, "src", "main", "resources"), { recursive: true });
    fs.writeFileSync(path.join(variant, "gradlew.bat"), "@echo off\n");
    fs.writeFileSync(path.join(variant, "gradle.properties"), "minecraft_version=1.21.1\nmod_id=mymod\n");
    fs.writeFileSync(path.join(variant, "build.gradle"), "plugins { id 'fabric-loom' version '1.14.10' }\n");
    fs.writeFileSync(path.join(variant, "src", "main", "resources", "fabric.mod.json"), JSON.stringify({ id: "mymod", name: "My Mod" }));
    fs.writeFileSync(path.join(variant, ".dmcl", "variant.json"), JSON.stringify({
      id: "v-stuck", buildStatus: "building", source: "imported", createdAt: "2026-01-01T00:00:00.000Z",
    }));
    const store = new WorkspaceStore();
    store.addScanDir(root);
    assert.equal(store.getVariant("v-stuck")?.variant.buildStatus, "building");
    assert.equal(store.resetInterruptedStatuses(), 1);
    const reset = store.getVariant("v-stuck")!.variant;
    assert.equal(reset.buildStatus, "cancelled");
    assert.equal(reset.status?.state, "cancelled");
    assert.match(reset.status?.reason ?? "", /中断/);

    store.setVariantActivity("v-stuck", { state: "running", kind: "run", jobId: "job-1" });
    assert.equal(store.getVariant("v-stuck")!.variant.status?.activeJobId, "job-1");
    const onDisk = JSON.parse(fs.readFileSync(path.join(variant, ".dmcl", "variant.json"), "utf8"));
    assert.equal(onDisk.buildStatus, "cancelled", "active state is not persisted");

    store.recordVariantResult("v-stuck", {
      kind: "run", state: "succeeded", at: "2026-10-13T10:00:00.000Z", reason: null, phaseReached: "in-game",
    });
    const done = store.getVariant("v-stuck")!.variant;
    assert.equal(done.status?.state, "succeeded");
    assert.equal(done.status?.activeJobId, null);
    assert.equal(done.buildStatus, "success");
    store.removeScanDir(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
