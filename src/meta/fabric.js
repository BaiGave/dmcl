"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchFabricGameVersionsRaw = fetchFabricGameVersionsRaw;
exports.fetchFabricLoaderVersionRaw = fetchFabricLoaderVersionRaw;
exports.fetchFabricLoaderVersion = fetchFabricLoaderVersion;
exports.fetchFabricLoaderForMc = fetchFabricLoaderForMc;
exports.fetchYarnVersion = fetchYarnVersion;
exports.fabricApiVersionTargetsMc = fabricApiVersionTargetsMc;
exports.fetchFabricApiVersion = fetchFabricApiVersion;
const http_js_1 = require("../core/http.js");
const meta_cache_js_1 = require("./meta-cache.js");
const sources_js_1 = require("./sources.js");
async function fetchFabricGameVersionsRaw() {
    const list = await (0, http_js_1.fetchJson)(sources_js_1.META_ENDPOINTS.fabricGameVersions);
    return list.filter((v) => v.stable).map((v) => v.version);
}
async function fetchFabricLoaderVersionRaw() {
    const list = await (0, http_js_1.fetchJson)(sources_js_1.META_ENDPOINTS.fabricLoaderVersions);
    return (list.find((v) => v.stable) ?? list[0]).version;
}
async function fetchFabricLoaderVersion() {
    const { data } = await (0, meta_cache_js_1.getMetaCache)().get();
    return data.fabricLoaderVersion;
}
/** 某 MC 版本对应的稳定 Fabric Loader（优先于全局最新版） */
async function fetchFabricLoaderForMc(mcVersion) {
    try {
        const list = await (0, http_js_1.fetchJson)(sources_js_1.META_ENDPOINTS.fabricLoaderForMc(mcVersion));
        const stable = list.find((e) => e.loader.stable);
        return (stable ?? list[0])?.loader.version ?? null;
    }
    catch {
        return fetchFabricLoaderVersion().catch(() => null);
    }
}
async function fetchYarnVersion(mcVersion) {
    try {
        const list = await (0, http_js_1.fetchJson)(sources_js_1.META_ENDPOINTS.fabricYarnForMc(mcVersion));
        return list[0]?.version ?? null;
    }
    catch {
        return null;
    }
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function parseSemverTriple(version) {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match)
        return [0, 0, 0];
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function compareSemver(a, b) {
    const [a1, a2, a3] = parseSemverTriple(a);
    const [b1, b2, b3] = parseSemverTriple(b);
    if (a1 !== b1)
        return a1 - b1;
    if (a2 !== b2)
        return a2 - b2;
    return a3 - b3;
}
/**

 * Fabric API 版本号是否面向指定 MC 版本。

 * 支持 Maven（0.42.0+1.16）与 Modrinth/build（0.18.0+build.387-1.16.1）两种命名。

 * 禁止把 1.16.1 宽泛匹配到 +1.16（0.42.0+1.16 需要 MC 1.16.2+）。

 */
function fabricApiVersionTargetsMc(version, mcVersion) {
    const mc = escapeRegex(mcVersion);
    if (new RegExp(`\\+${mc}$`).test(version))
        return true;
    if (new RegExp(`-${mc}$`).test(version))
        return true;
    const parts = mcVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
    if (parts.length === 3 && parts[0] === 1 && parts[1] === 16 && parts[2] >= 2) {
        if (/\+1\.16$/.test(version)) {
            return compareSemver(version.split("+")[0], "0.42.0") >= 0;
        }
    }
    return false;
}
function pickBestMavenFabricApiVersion(versions, mcVersion) {
    const exact = versions.filter((version) => fabricApiVersionTargetsMc(version, mcVersion));
    if (exact.length === 0)
        return null;
    if (mcVersion === "1.16") {
        const safe = exact.filter((version) => compareSemver(version.split("+")[0], "0.42.0") < 0);
        if (safe.length > 0)
            return safe[safe.length - 1];
    }
    return exact[exact.length - 1];
}
/** Fabric API 版本：优先 Modrinth（按 game_versions）；不可达时退回 Maven 元数据 */
async function fetchFabricApiVersion(mcVersion) {
    try {
        const list = await (0, http_js_1.fetchJson)(sources_js_1.META_ENDPOINTS.fabricApiModrinth(mcVersion), { retries: 1, timeoutMs: 12_000 });
        const tagged = list.find((entry) => entry.game_versions?.includes(mcVersion));
        if (tagged)
            return tagged.version_number;
        const matched = list.find((entry) => fabricApiVersionTargetsMc(entry.version_number, mcVersion));
        if (matched)
            return matched.version_number;
    }
    catch {
        // 退回 Maven
    }
    try {
        const xml = await (0, http_js_1.fetchText)(sources_js_1.META_ENDPOINTS.fabricApiMavenMetadata, { retries: 1, timeoutMs: 12_000 });
        const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1]);
        return pickBestMavenFabricApiVersion(versions, mcVersion);
    }
    catch {
        return null;
    }
}
