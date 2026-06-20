import fs from "node:fs";
import path from "node:path";
import type { LoaderId } from "../types.js";
import { compareMcVersions } from "../meta/mc-version.js";
import { pascalCase } from "../core/scaffold.js";
import type { Logger } from "../types.js";

async function copyDir(src: string, dest: string): Promise<void> {
  if (!fs.existsSync(src)) return;
  await fs.promises.mkdir(dest, { recursive: true });
  for (const entry of await fs.promises.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else await fs.promises.copyFile(from, to);
  }
}

/** 跨加载器时仅复制共享资源（图标等），不覆盖目标模板的 Java / 加载器元数据 */
export async function copySharedModAssets(
  sourcePath: string,
  targetPath: string,
  modId: string,
  log: Logger,
): Promise<void> {
  const assetsSrc = path.join(sourcePath, "src", "main", "resources", "assets", modId);
  const assetsDest = path.join(targetPath, "src", "main", "resources", "assets", modId);
  if (fs.existsSync(assetsSrc)) {
    await copyDir(assetsSrc, assetsDest);
    log(`已复制共享资源 assets/${modId}/`);
  }
}

function javaPackageFromGroup(group: string): string {
  return group.trim() || "com.example.mod";
}

function writeJavaFile(targetDir: string, pkg: string, className: string, body: string): void {
  const dir = path.join(targetDir, "src", "main", "java", ...pkg.split("."));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${className}.java`),
    `package ${pkg};\n\n${body}\n`,
    "utf8",
  );
}

/** 当跨加载器复制误覆盖了模板时，写最小可编译 Forge 主类 */
export function writeMinimalForgeMainClass(
  targetDir: string,
  modId: string,
  displayName: string,
  group: string,
  mcVersion: string,
): string {
  const pkg = javaPackageFromGroup(group);
  const className = pascalCase(displayName) || pascalCase(modId);
  let body: string;

  if (compareMcVersions(mcVersion, "1.17") >= 0) {
    body = `import net.minecraftforge.fml.common.Mod;

@Mod("${modId}")
public class ${className} {
    public static final String MODID = "${modId}";
}`;
  } else if (compareMcVersions(mcVersion, "1.13") >= 0) {
    body = `import net.minecraftforge.fml.common.Mod;

@Mod("${modId}")
public class ${className} {
    public static final String MODID = "${modId}";
}`;
  } else {
    body = `import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.common.Mod.EventHandler;
import net.minecraftforge.fml.common.event.FMLInitializationEvent;

@Mod(modid = ${className}.MODID, name = "${displayName.replace(/"/g, '\\"')}", version = "0.1.0")
public class ${className} {
    public static final String MODID = "${modId}";

    @EventHandler
    public void init(FMLInitializationEvent event) {
    }
}`;
  }

  writeJavaFile(targetDir, pkg, className, body);
  return path.join(targetDir, "src", "main", "java", ...pkg.split("."), `${className}.java`);
}

export function stripForeignLoaderMetadata(targetDir: string, targetLoader: LoaderId): void {
  const res = path.join(targetDir, "src", "main", "resources");
  const remove = targetLoader === "fabric"
    ? ["META-INF/mods.toml", "META-INF/neoforge.mods.toml"]
    : targetLoader === "forge"
      ? ["fabric.mod.json", "META-INF/neoforge.mods.toml"]
      : ["fabric.mod.json", "META-INF/mods.toml"];
  for (const rel of remove) {
    const file = path.join(res, rel);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

function foreignLoaderNeedle(targetLoader: LoaderId): string {
  return targetLoader === "fabric" ? "net.minecraftforge" : "net.fabricmc.api.ModInitializer";
}

/** 删除混入的外加载器 Java 源文件（如 Fabric ModInitializer） */
export function removeForeignLoaderJava(targetDir: string, targetLoader: LoaderId): string[] {
  const javaRoot = path.join(targetDir, "src", "main", "java");
  if (!fs.existsSync(javaRoot)) return [];
  const needle = foreignLoaderNeedle(targetLoader);
  const removed: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".java")) {
        const content = fs.readFileSync(p, "utf8");
        if (content.includes(needle)) {
          fs.unlinkSync(p);
          removed.push(p);
        }
      }
    }
  };
  walk(javaRoot);
  return removed;
}

export function hasForeignLoaderJava(targetDir: string, targetLoader: LoaderId): boolean {
  const javaRoot = path.join(targetDir, "src", "main", "java");
  if (!fs.existsSync(javaRoot)) return false;
  const needle = foreignLoaderNeedle(targetLoader);
  let found = false;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".java") && fs.readFileSync(p, "utf8").includes(needle)) {
        found = true;
      }
    }
  };
  walk(javaRoot);
  return found;
}

export async function repairCrossLoaderProject(
  targetDir: string,
  modId: string,
  displayName: string,
  group: string,
  loader: LoaderId,
  mcVersion: string,
  log: Logger = () => {},
): Promise<boolean> {
  if (loader !== "forge") return false;
  if (!hasForeignLoaderJava(targetDir, loader) && !fs.existsSync(path.join(targetDir, "src", "main", "resources", "fabric.mod.json"))) {
    return false;
  }
  stripForeignLoaderMetadata(targetDir, loader);
  const removed = removeForeignLoaderJava(targetDir, loader);
  if (removed.length > 0) {
    log(`已删除 ${removed.length} 个外加载器 Java 源文件`);
  }
  const mainFile = writeMinimalForgeMainClass(targetDir, modId, displayName, group, mcVersion);
  log(`已修复 Forge 主类：${mainFile}`);
  return true;
}
