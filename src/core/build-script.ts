import fs from "node:fs";
import path from "node:path";

const SCRIPT_NAMES = ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];
const MAX_APPLY_DEPTH = 4;
const APPLY_FROM = /\bapply\s*(?:\(\s*)?from\s*[:=]\s*(?:(?:rootProject|project)\.)?(?:file\s*\(\s*)?(['"])([^'"\r\n]+)\1/g;

/** 去掉 Groovy/Kotlin 注释，字符串内的 `//`（如 URL）保持不变，避免把被注释的声明当成配置。 */
export function stripGradleComments(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\" && next !== undefined) {
        out += next;
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      i--;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += ch;
    }
  }
  return out;
}

/** `apply from:` 的相对路径按项目目录解析（与 Gradle 的 project.file 一致）；远程脚本忽略。 */
function appliedScript(project: string, ref: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return null;
  const relative = ref.replace(/^\$\{?(?:rootDir|rootProject\.projectDir|projectDir|project\.projectDir)\}?[\/]?/, "");
  return path.resolve(project, relative);
}

/**
 * 读取项目的 Gradle 构建声明：根 build/settings 脚本及其 `apply from:` 的本地脚本（去注释）。
 * 多个 Linker 变体共享 `../gradle/fabric.gradle`，映射与插件声明只在这些被引用脚本里。
 */
export function readBuildScripts(projectPath: string): string {
  const project = path.resolve(projectPath);
  const seen = new Set<string>();
  const parts: string[] = [];
  const visit = (file: string, depth: number): void => {
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    if (seen.has(key)) return;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    seen.add(key);
    const text = stripGradleComments(raw);
    parts.push(text);
    if (depth >= MAX_APPLY_DEPTH) return;
    for (const match of text.matchAll(APPLY_FROM)) {
      const target = appliedScript(project, match[2]);
      if (target) visit(target, depth + 1);
    }
  };
  for (const name of SCRIPT_NAMES) visit(path.join(project, name), 0);
  return parts.join("\n");
}

/** 把 `${project.name}` / `${name}` / `$name` 按 gradle.properties 展开；无法展开返回 null。 */
export function resolveGradleValue(value: string, props: Record<string, string>): string | null {
  let unresolved = false;
  const expanded = value.replace(/\$\{(?:project\.)?([\w.-]+)\}|\$(\w+)/g, (_all, braced: string, bare: string) => {
    const resolved = props[braced ?? bare];
    if (resolved === undefined) unresolved = true;
    return resolved ?? "";
  });
  return unresolved || !expanded ? null : expanded;
}
