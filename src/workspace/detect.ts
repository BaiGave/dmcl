import fs from "node:fs";
import path from "node:path";
import type { LoaderId, MappingsId } from "../types.js";
import type { DetectedProject } from "./types.js";
import { getProjectsRoot } from "./paths.js";

function readProps(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function isModProject(dir: string): boolean {
  const gradlew = process.platform === "win32"
    ? path.join(dir, "gradlew.bat")
    : path.join(dir, "gradlew");
  return fs.existsSync(gradlew);
}

function detectLoader(dir: string, props: Record<string, string>): LoaderId | null {
  if (props.loader_version || props.yarn_mappings || props.fabric_version) return "fabric";
  if (props.neo_version) return "neoforge";
  if (props.mod_id && (fs.existsSync(path.join(dir, "build.gradle")) || props.minecraft_version)) {
    const buildGradle = fs.existsSync(path.join(dir, "build.gradle"))
      ? fs.readFileSync(path.join(dir, "build.gradle"), "utf8")
      : "";
    if (buildGradle.includes("net.neoforged") || props.neo_version) return "neoforge";
    if (buildGradle.includes("net.minecraftforge") || props.mod_id) return "forge";
  }
  if (fs.existsSync(path.join(dir, "src", "main", "resources", "fabric.mod.json"))) return "fabric";
  if (fs.existsSync(path.join(dir, "src", "main", "resources", "META-INF", "neoforge.mods.toml"))) {
    return "neoforge";
  }
  if (fs.existsSync(path.join(dir, "src", "main", "resources", "META-INF", "mods.toml"))) return "forge";
  return null;
}

function readFabricModJson(dir: string): { id?: string; name?: string; version?: string } {
  const p = path.join(dir, "src", "main", "resources", "fabric.mod.json");
  if (!fs.existsSync(p)) return {};
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return { id: j.id, name: j.name, version: j.version };
  } catch {
    return {};
  }
}

function readModsToml(dir: string, file: string): { id?: string; name?: string; version?: string } {
  const p = path.join(dir, "src", "main", "resources", "META-INF", file);
  if (!fs.existsSync(p)) return {};
  const content = fs.readFileSync(p, "utf8");
  const modId = content.match(/modId\s*=\s*"([^"]+)"/)?.[1];
  const name = content.match(/displayName\s*=\s*"([^"]+)"/)?.[1];
  const version = content.match(/version\s*=\s*"([^"]+)"/)?.[1];
  return { id: modId, name, version };
}

function detectMappings(loader: LoaderId, props: Record<string, string>, buildGradle = ""): MappingsId {
  const variant = props.mappings_variant ?? props.mappings_channel ?? "";
  if (variant.includes("parchment") || props.parchment_mappings_version) return "parchment";
  if (props.yarn_mappings) return "yarn";
  if (loader === "forge" && (variant.includes("snapshot") || variant.includes("stable"))) return "mcp";
  if (loader === "forge") {
    const channel = /\bmappings\s+channel\s*:\s*['"]([^'"]+)['"]/.exec(buildGradle)?.[1]?.toLowerCase();
    if (channel === "snapshot" || channel === "stable") return "mcp";
    if (/\bmappings\s*=\s*['"](?:snapshot|stable)[^'"]*['"]/.test(buildGradle)) return "mcp";
  }
  if (loader === "fabric") return "yarn";
  return "mojmap";
}

import { pascalCase } from "../core/scaffold.js";
import { readMcVersionFromProject } from "../core/jdk.js";
/** 从磁盘上的 mod 项目目录解析元数据 */
export function detectProject(projectPath: string): DetectedProject | null {
  const resolved = path.resolve(projectPath);
  if (!isModProject(resolved)) return null;

  const props = readProps(path.join(resolved, "gradle.properties"));
  const buildGradlePath = path.join(resolved, "build.gradle");
  const buildGradle = fs.existsSync(buildGradlePath) ? fs.readFileSync(buildGradlePath, "utf8") : "";
  const loader = detectLoader(resolved, props);
  if (!loader) return null;

  let mcVersion = props.minecraft_version ?? readMcVersionFromProject(resolved) ?? "";
  if (!mcVersion) return null;

  const fabricMeta = loader === "fabric" ? readFabricModJson(resolved) : {};
  const neoMeta = loader === "neoforge" ? readModsToml(resolved, "neoforge.mods.toml") : {};
  const forgeMeta = loader === "forge" ? readModsToml(resolved, "mods.toml") : {};

  const modId = props.mod_id ?? fabricMeta.id ?? neoMeta.id ?? forgeMeta.id ?? "";
  const displayName = props.mod_name ?? fabricMeta.name ?? neoMeta.name ?? forgeMeta.name ?? pascalCase(modId);
  const modVersion = props.mod_version ?? fabricMeta.version ?? neoMeta.version ?? forgeMeta.version ?? "0.1.0";
  const group = props.maven_group ?? props.mod_group_id ?? `com.example.${modId.replace(/_/g, "")}`;

  if (!modId) return null;

  return {
    loader,
    mcVersion,
    modId,
    displayName,
    modVersion,
    group,
    mappings: detectMappings(loader, props, buildGradle),
    projectPath: resolved,
  };
}

/** 扫描目录下的 mod 项目（支持 projects/{modId}/{loader-mc}/ 两层结构及扁平目录） */
export function scanDirectory(parentDir: string): DetectedProject[] {
  const resolved = path.resolve(parentDir);
  if (!fs.existsSync(resolved)) return [];

  const results: DetectedProject[] = [];
  const seen = new Set<string>();

  const add = (detected: DetectedProject | null) => {
    if (!detected) return;
    const key = detected.projectPath.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push(detected);
  };

  add(detectProject(resolved));

  try {
    for (const modEntry of fs.readdirSync(resolved, { withFileTypes: true })) {
      if (!modEntry.isDirectory() || modEntry.name.startsWith(".")) continue;
      const modPath = path.join(resolved, modEntry.name);

      add(detectProject(modPath));

      try {
        for (const varEntry of fs.readdirSync(modPath, { withFileTypes: true })) {
          if (!varEntry.isDirectory() || varEntry.name.startsWith(".")) continue;
          add(detectProject(path.join(modPath, varEntry.name)));
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  return results;
}

/** 扫描默认 projects 目录 */
export function scanDefaultProjects(): DetectedProject[] {
  return scanDirectory(getProjectsRoot());
}
