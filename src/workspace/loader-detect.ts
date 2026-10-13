import fs from "node:fs";
import path from "node:path";
import type { LoaderId } from "../types.js";
import { readBuildScripts } from "../core/build-script.js";
import { readPropertiesFile } from "../core/properties.js";

const readProps = readPropertiesFile;

/**
 * 判断项目的加载器，工作区、工具链与源码准备共用这一处。
 * 先看构建脚本声明的插件：Linker 等项目的 gradle.properties 不带加载器专属键，只有 mod_id 不能说明是 Forge。
 */
export function detectProjectLoader(projectPath: string): LoaderId | null {
  const dir = path.resolve(projectPath);
  const script = readBuildScripts(dir);
  if (/\bfabric-loom\b/.test(script)) return "fabric";
  // ModDevGradle's legacyforge plugin builds Forge (1.20.1 and older) under the net.neoforged group.
  if (/\bnet\.neoforged\.moddev\.legacyforge\b/.test(script)) return "forge";
  if (/\bnet\.neoforged\b/.test(script)) return "neoforge";
  if (/\bnet\.minecraftforge\b/.test(script)) return "forge";

  const props = readProps(path.join(dir, "gradle.properties"));
  if (props.loader_version || props.fabric_loader_version || props.yarn_mappings || props.fabric_version) {
    return "fabric";
  }
  if (props.neo_version) return "neoforge";
  if (props.forge_version) return "forge";

  const resources = path.join(dir, "src", "main", "resources");
  if (fs.existsSync(path.join(resources, "fabric.mod.json"))) return "fabric";
  if (fs.existsSync(path.join(resources, "META-INF", "neoforge.mods.toml"))) return "neoforge";
  if (fs.existsSync(path.join(resources, "META-INF", "mods.toml"))) return "forge";
  return null;
}
