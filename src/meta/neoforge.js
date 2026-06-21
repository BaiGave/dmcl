"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchNeoForgeVersions = fetchNeoForgeVersions;
exports.fetchNeoForgeVersionsRaw = fetchNeoForgeVersionsRaw;
exports.neoPrefixFor = neoPrefixFor;
exports.pickNeoForgeVersion = pickNeoForgeVersion;
exports.neoMdkTemplateFamily = neoMdkTemplateFamily;
exports.neoMdkZipCandidates = neoMdkZipCandidates;
exports.neoMdkFallbackCandidates = neoMdkFallbackCandidates;
const http_js_1 = require("../core/http.js");
const sources_js_1 = require("./sources.js");
const meta_cache_js_1 = require("./meta-cache.js");
async function fetchNeoForgeVersions() {
    const { data } = await (0, meta_cache_js_1.getMetaCache)().get();
    return data.neoforgeVersions;
}
async function fetchNeoForgeVersionsRaw() {
    const data = await (0, http_js_1.fetchJson)(sources_js_1.META_ENDPOINTS.neoforgeVersions);
    return data.versions;
}
function neoPrefixFor(mcVersion) {
    if (mcVersion.startsWith("1.")) {
        const rest = mcVersion.slice(2);
        return rest.includes(".") ? rest : `${rest}.0`;
    }
    return mcVersion;
}
function pickNeoForgeVersion(versions, mcVersion) {
    const prefix = neoPrefixFor(mcVersion);
    const expectedSegments = prefix.split(".").length + 1;
    const matches = versions.filter((v) => v.startsWith(`${prefix}.`) && v.split(".").length === expectedSegments);
    if (matches.length === 0)
        return null;
    const stable = matches.filter((v) => !/-(beta|alpha|rc)/.test(v));
    const pool = stable.length > 0 ? stable : matches;
    return pool[pool.length - 1];
}
function mdkBranchZips(repo) {
    return sources_js_1.GITHUB_DEFAULT_BRANCHES.map((branch) => sources_js_1.META_ENDPOINTS.neoforgeMdkBranchZip(repo, branch));
}
function neoMdkTemplateFamily(mcVersion) {
    const match = /^1\.20\.(\d+)$/.exec(mcVersion);
    if (match && Number.parseInt(match[1], 10) <= 5)
        return "NeoGradle";
    return "ModDevGradle";
}
function neoMdkZipCandidates(mcVersion) {
    const family = neoMdkTemplateFamily(mcVersion);
    const repos = [`MDK-${mcVersion}-${family}`];
    const parts = mcVersion.split(".");
    if (parts.length === 3 && family === "ModDevGradle") {
        repos.push(`MDK-${parts[0]}.${parts[1]}-ModDevGradle`);
    }
    return repos.flatMap(mdkBranchZips);
}
function neoMdkFallbackCandidates(mcVersion) {
    const parts = mcVersion.split(".");
    if (parts.length < 3)
        return [];
    const patch = Number.parseInt(parts[2], 10);
    if (Number.isNaN(patch))
        return [];
    const minor = `${parts[0]}.${parts[1]}`;
    const family = neoMdkTemplateFamily(mcVersion);
    const nearbyPatches = family === "NeoGradle"
        ? [patch - 1, patch + 1, patch - 2, patch + 2].filter((value) => value >= 0)
        : [patch + 1, patch + 2];
    return nearbyPatches.flatMap((p) => mdkBranchZips(`MDK-${minor}.${p}-${family}`));
}
