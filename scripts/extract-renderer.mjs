import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const src = fs.readFileSync(path.join(root, "gui", "renderer.js"), "utf8");
const body = src
  .replace(/^\/\*\*[\s\S]*?\*\/\s*/, "")
  .replace(/^\(function \(\) \{\s*"use strict";\s*/, "")
  .replace(/\n\}\)\(\);\s*$/, "")
  .replace(/\n  var LOADERS = [\s\S]*?;\n\n  var LOADER_LABELS[\s\S]*?;\n\n  var state = \{[\s\S]*?\};\n\n  var pathRefreshTimer = null;\n\n/, "\n");

const header = `import { state, pathRefreshTimer, setPathRefreshTimer } from "./state";
import { LOADERS, LOADER_LABELS, STATUS_LABELS } from "./constants";
import { $, showError, hideError, setText, notify, showView, esc, showModal } from "./dom";
import { api } from "./api";

export function bootWorkbench(): void {
`;

const outDir = path.join(root, "gui", "renderer-src");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "boot.ts"), header + body + "\n}\n");
console.log("wrote boot.ts");
