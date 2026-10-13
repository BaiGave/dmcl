#!/usr/bin/env node
/**
 * Opens the DMCL window, rebuilding only what changed since the last start.
 *
 * Three outputs, each with a content hash of its inputs stored in dist/.gui-build-stamps.json:
 *   core      src/**, tsconfig.json             -> dist/            (tsc -p .)
 *   backend   gui/*.ts, gui/tsconfig.json        -> gui/*.js         (tsc -p gui)
 *   renderer  gui/renderer-src/**                -> gui/renderer.js  (esbuild)
 * A normal double-click with unchanged sources goes straight to Electron.
 *   node scripts/gui-start.mjs            start (rebuild stale parts)
 *   node scripts/gui-start.mjs --rebuild  rebuild everything first
 *   node scripts/gui-start.mjs --build-only
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const stampFile = path.join(root, "dist", ".gui-build-stamps.json");

function listFiles(dir, accept) {
  const out = [];
  const visit = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (accept(full)) out.push(full);
    }
  };
  visit(dir);
  return out.sort();
}

function hashFiles(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    try {
      hash.update(fs.readFileSync(file));
    } catch {
      hash.update("missing");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

const tscCli = path.join(root, "node_modules", "typescript", "bin", "tsc");
const esbuildCli = path.join(root, "node_modules", "esbuild", "bin", "esbuild");
const guiTs = (file) => /\.ts$/.test(file) && path.dirname(file) === path.join(root, "gui") && !file.endsWith(".d.ts");

const parts = [
  {
    name: "core",
    inputs: () => [...listFiles(path.join(root, "src"), (f) => f.endsWith(".ts")), path.join(root, "tsconfig.json")],
    outputs: [path.join(root, "dist", "index.js"), path.join(root, "dist", "launch", "index.js")],
    build: [process.execPath, [tscCli, "-p", "."]],
  },
  {
    name: "backend",
    inputs: () => [...listFiles(path.join(root, "gui"), guiTs), path.join(root, "gui", "tsconfig.json")],
    outputs: [path.join(root, "gui", "main.js"), path.join(root, "gui", "preload-bridge.js")],
    build: [process.execPath, [tscCli, "-p", "gui/tsconfig.json"]],
  },
  {
    name: "renderer",
    inputs: () => listFiles(path.join(root, "gui", "renderer-src"), (f) => f.endsWith(".ts")),
    outputs: [path.join(root, "gui", "renderer.js")],
    build: [process.execPath, [esbuildCli, "gui/renderer-src/main.ts", "--bundle", "--outfile=gui/renderer.js", "--format=iife", "--target=es2020"]],
  },
];

let stamps = {};
try {
  stamps = JSON.parse(fs.readFileSync(stampFile, "utf8"));
} catch {
  stamps = {};
}

for (const part of parts) {
  const hash = hashFiles(part.inputs());
  const fresh = !args.has("--rebuild") && stamps[part.name] === hash && part.outputs.every((file) => fs.existsSync(file));
  if (fresh) continue;
  console.log(`[DMCL] 编译 ${part.name}…`);
  const [cmd, cmdArgs] = part.build;
  const result = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`[DMCL] ${part.name} 编译失败`);
    process.exit(result.status ?? 1);
  }
  stamps[part.name] = hash;
  fs.mkdirSync(path.dirname(stampFile), { recursive: true });
  fs.writeFileSync(stampFile, JSON.stringify(stamps, null, 2));
}

if (args.has("--build-only")) process.exit(0);

const electron = spawnSync(process.execPath, [path.join(root, "node_modules", "electron", "cli.js"), "gui/main.js"], {
  cwd: root,
  stdio: "inherit",
});
process.exit(electron.status ?? 0);
