import { readMcVersionFromProject } from "../core/jdk.js";
import { readBuildScripts, resolveGradleValue } from "../core/build-script.js";
import { detectProject } from "../workspace/detect.js";
import type { LoaderId, MappingsId } from "../types.js";

export interface DeclaredMapping {
  mapping: MappingsId;
  mappingVersion: string;
}

const OFFICIAL_MOJANG = /\bofficialMojangMappings\s*\(\s*\)/;
const PARCHMENT_LAYER = /\bparchment\s*\(\s*(['"])([^'"\r\n]+)\1/;
const YARN_COORDINATE = /['"]net\.fabricmc:yarn:([^'"\r\n]+)['"]/;

/**
 * 读取 Loom 构建脚本声明的映射。
 * 以脚本为准而不是 gradle.properties：属性可能只是模板残留，真正生效的是 `mappings …` 一行，
 * 例如 Linker 的 Fabric 变体用 `loom.officialMojangMappings()`，产物是 Mojang 官方命名而不是 Yarn。
 * 未声明 Parchment 的官方映射记为 mojmap，版本沿用 MC 版本，与源码库对隐式官方映射的约定一致。
 */
export function detectLoomMappings(
  projectPath: string,
  props: Record<string, string>,
  mcVersion: string,
): DeclaredMapping | null {
  const script = readBuildScripts(projectPath);

  const parchment = PARCHMENT_LAYER.exec(script);
  if (parchment) {
    const coordinate = resolveGradleValue(parchment[2], props);
    const version = coordinate?.split(":")[2]?.replace(/@.*$/, "")
      ?? props.parchment_version
      ?? props.parchment_mappings_version
      ?? mcVersion;
    return { mapping: "parchment", mappingVersion: version };
  }
  if (OFFICIAL_MOJANG.test(script)) return { mapping: "mojmap", mappingVersion: mcVersion };

  const yarn = YARN_COORDINATE.exec(script);
  if (yarn) {
    const version = resolveGradleValue(yarn[1].replace(/:v2$/, ""), props) ?? props.yarn_mappings;
    if (version) return { mapping: "yarn", mappingVersion: version };
  }
  return null;
}

/** 从构建脚本与属性判断项目的加载器；先看脚本，因为 Linker 变体的 gradle.properties 不带加载器专属键 */
export function detectProjectLoader(projectPath: string): LoaderId | null {
  const script = readBuildScripts(projectPath);
  if (/\bfabric-loom\b/.test(script)) return "fabric";
  // ModDevGradle's legacyforge plugin builds Forge (1.20.1 and older) under the net.neoforged group.
  if (/\bnet\.neoforged\.moddev\.legacyforge\b/.test(script)) return "forge";
  if (/\bnet\.neoforged\b/.test(script)) return "neoforge";
  if (/\bnet\.minecraftforge\b/.test(script)) return "forge";
  return detectProject(projectPath)?.loader ?? null;
}

/** 无界面准备源码时从项目目录推断目标；任一项推断不出就返回 null，由调用方要求显式指定 */
export function detectSourceProjectTarget(projectPath: string): { loader: LoaderId; mcVersion: string } | null {
  const loader = detectProjectLoader(projectPath);
  const mcVersion = readMcVersionFromProject(projectPath);
  return loader && mcVersion ? { loader, mcVersion } : null;
}
