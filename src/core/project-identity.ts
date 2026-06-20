import fs from "node:fs";
import path from "node:path";
import type { LoaderId } from "../types.js";
import { patchProperties } from "./fsutils.js";

export interface ProjectIdentity {
  targetDir: string;
  modId: string;
  displayName: string;
  group: string;
  loader?: LoaderId;
}

/** 把模板残留的 Example Mod / modid 统一写回目标模组身份（复制源码后必须再调一次） */
export async function applyProjectIdentity(opts: ProjectIdentity): Promise<void> {
  const gradleProps = path.join(opts.targetDir, "gradle.properties");
  await patchProperties(gradleProps, {
    mod_id: opts.modId,
    mod_name: opts.displayName,
    archives_base_name: opts.modId,
    maven_group: opts.group,
  });

  const fabricJson = path.join(opts.targetDir, "src", "main", "resources", "fabric.mod.json");
  if (fs.existsSync(fabricJson)) {
    try {
      const json = JSON.parse(fs.readFileSync(fabricJson, "utf8")) as Record<string, unknown>;
      json.id = opts.modId;
      json.name = opts.displayName;
      fs.writeFileSync(fabricJson, `${JSON.stringify(json, null, 2)}\n`, "utf8");
    } catch { /* ignore malformed json */ }
  }

  for (const toml of ["neoforge.mods.toml", "mods.toml"]) {
    const file = path.join(opts.targetDir, "src", "main", "resources", "META-INF", toml);
    if (!fs.existsSync(file)) continue;
    let content = fs.readFileSync(file, "utf8");
    if (/modId\s*=/.test(content)) {
      content = content.replace(/modId\s*=\s*"[^"]*"/, `modId="${opts.modId}"`);
    }
    if (/displayName\s*=/.test(content)) {
      content = content.replace(
        /displayName\s*=\s*"[^"]*"/,
        `displayName="${opts.displayName.replace(/"/g, '\\"')}"`,
      );
    }
    fs.writeFileSync(file, content, "utf8");
  }
}
