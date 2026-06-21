"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectProject = detectProject;
exports.scanDirectory = scanDirectory;
exports.scanDefaultProjects = scanDefaultProjects;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const paths_js_1 = require("./paths.js");
function readProps(file) {
    if (!node_fs_1.default.existsSync(file))
        return {};
    const out = {};
    for (const line of node_fs_1.default.readFileSync(file, "utf8").split("\n")) {
        const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
        if (m)
            out[m[1]] = m[2].trim();
    }
    return out;
}
function isModProject(dir) {
    const gradlew = process.platform === "win32"
        ? node_path_1.default.join(dir, "gradlew.bat")
        : node_path_1.default.join(dir, "gradlew");
    return node_fs_1.default.existsSync(gradlew);
}
function detectLoader(dir, props) {
    if (props.loader_version || props.yarn_mappings || props.fabric_version)
        return "fabric";
    if (props.neo_version)
        return "neoforge";
    if (props.mod_id && (node_fs_1.default.existsSync(node_path_1.default.join(dir, "build.gradle")) || props.minecraft_version)) {
        const buildGradle = node_fs_1.default.existsSync(node_path_1.default.join(dir, "build.gradle"))
            ? node_fs_1.default.readFileSync(node_path_1.default.join(dir, "build.gradle"), "utf8")
            : "";
        if (buildGradle.includes("net.neoforged") || props.neo_version)
            return "neoforge";
        if (buildGradle.includes("net.minecraftforge") || props.mod_id)
            return "forge";
    }
    if (node_fs_1.default.existsSync(node_path_1.default.join(dir, "src", "main", "resources", "fabric.mod.json")))
        return "fabric";
    if (node_fs_1.default.existsSync(node_path_1.default.join(dir, "src", "main", "resources", "META-INF", "neoforge.mods.toml"))) {
        return "neoforge";
    }
    if (node_fs_1.default.existsSync(node_path_1.default.join(dir, "src", "main", "resources", "META-INF", "mods.toml")))
        return "forge";
    return null;
}
function readFabricModJson(dir) {
    const p = node_path_1.default.join(dir, "src", "main", "resources", "fabric.mod.json");
    if (!node_fs_1.default.existsSync(p))
        return {};
    try {
        const j = JSON.parse(node_fs_1.default.readFileSync(p, "utf8"));
        return { id: j.id, name: j.name, version: j.version };
    }
    catch {
        return {};
    }
}
function readModsToml(dir, file) {
    const p = node_path_1.default.join(dir, "src", "main", "resources", "META-INF", file);
    if (!node_fs_1.default.existsSync(p))
        return {};
    const content = node_fs_1.default.readFileSync(p, "utf8");
    const modId = content.match(/modId\s*=\s*"([^"]+)"/)?.[1];
    const name = content.match(/displayName\s*=\s*"([^"]+)"/)?.[1];
    const version = content.match(/version\s*=\s*"([^"]+)"/)?.[1];
    return { id: modId, name, version };
}
function detectMappings(loader, props, buildGradle = "") {
    const variant = props.mappings_variant ?? props.mappings_channel ?? "";
    if (variant.includes("parchment") || props.parchment_mappings_version)
        return "parchment";
    if (props.yarn_mappings)
        return "yarn";
    if (loader === "forge" && (variant.includes("snapshot") || variant.includes("stable")))
        return "mcp";
    if (loader === "forge") {
        const channel = /\bmappings\s+channel\s*:\s*['"]([^'"]+)['"]/.exec(buildGradle)?.[1]?.toLowerCase();
        if (channel === "snapshot" || channel === "stable")
            return "mcp";
        if (/\bmappings\s*=\s*['"](?:snapshot|stable)[^'"]*['"]/.test(buildGradle))
            return "mcp";
    }
    if (loader === "fabric")
        return "yarn";
    return "mojmap";
}
const scaffold_js_1 = require("../core/scaffold.js");
const jdk_js_1 = require("../core/jdk.js");
/** 从磁盘上的 mod 项目目录解析元数据 */
function detectProject(projectPath) {
    const resolved = node_path_1.default.resolve(projectPath);
    if (!isModProject(resolved))
        return null;
    const props = readProps(node_path_1.default.join(resolved, "gradle.properties"));
    const buildGradlePath = node_path_1.default.join(resolved, "build.gradle");
    const buildGradle = node_fs_1.default.existsSync(buildGradlePath) ? node_fs_1.default.readFileSync(buildGradlePath, "utf8") : "";
    const loader = detectLoader(resolved, props);
    if (!loader)
        return null;
    let mcVersion = props.minecraft_version ?? (0, jdk_js_1.readMcVersionFromProject)(resolved) ?? "";
    if (!mcVersion)
        return null;
    const fabricMeta = loader === "fabric" ? readFabricModJson(resolved) : {};
    const neoMeta = loader === "neoforge" ? readModsToml(resolved, "neoforge.mods.toml") : {};
    const forgeMeta = loader === "forge" ? readModsToml(resolved, "mods.toml") : {};
    const modId = props.mod_id ?? fabricMeta.id ?? neoMeta.id ?? forgeMeta.id ?? "";
    const displayName = props.mod_name ?? fabricMeta.name ?? neoMeta.name ?? forgeMeta.name ?? (0, scaffold_js_1.pascalCase)(modId);
    const modVersion = props.mod_version ?? fabricMeta.version ?? neoMeta.version ?? forgeMeta.version ?? "0.1.0";
    const group = props.maven_group ?? props.mod_group_id ?? `com.example.${modId.replace(/_/g, "")}`;
    if (!modId)
        return null;
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
function scanDirectory(parentDir) {
    const resolved = node_path_1.default.resolve(parentDir);
    if (!node_fs_1.default.existsSync(resolved))
        return [];
    const results = [];
    const seen = new Set();
    const add = (detected) => {
        if (!detected)
            return;
        const key = detected.projectPath.toLowerCase();
        if (seen.has(key))
            return;
        seen.add(key);
        results.push(detected);
    };
    add(detectProject(resolved));
    try {
        for (const modEntry of node_fs_1.default.readdirSync(resolved, { withFileTypes: true })) {
            if (!modEntry.isDirectory() || modEntry.name.startsWith("."))
                continue;
            const modPath = node_path_1.default.join(resolved, modEntry.name);
            add(detectProject(modPath));
            try {
                for (const varEntry of node_fs_1.default.readdirSync(modPath, { withFileTypes: true })) {
                    if (!varEntry.isDirectory() || varEntry.name.startsWith("."))
                        continue;
                    add(detectProject(node_path_1.default.join(modPath, varEntry.name)));
                }
            }
            catch { /* ignore */ }
        }
    }
    catch { /* ignore */ }
    return results;
}
/** 扫描默认 projects 目录 */
function scanDefaultProjects() {
    return scanDirectory((0, paths_js_1.getProjectsRoot)());
}
