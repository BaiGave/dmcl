"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isForgeMdkAvailable = isForgeMdkAvailable;
exports.filterForgeVersionsWithMdk = filterForgeVersionsWithMdk;
exports.fetchForgePromos = fetchForgePromos;
exports.fetchForgePromosRaw = fetchForgePromosRaw;
exports.forgeSupportedMcVersions = forgeSupportedMcVersions;
exports.pickForgeVersion = pickForgeVersion;
exports.forgeMdkUrl = forgeMdkUrl;
const http_js_1 = require("../core/http.js");
const http_js_2 = require("../core/http.js");
const meta_cache_js_1 = require("./meta-cache.js");
const sources_js_1 = require("./sources.js");
const mdkAvailableCache = new Map();
async function isForgeMdkAvailable(mcVersion) {
    if (mdkAvailableCache.has(mcVersion))
        return mdkAvailableCache.get(mcVersion);
    const forgeVersion = await pickForgeVersion(mcVersion);
    if (!forgeVersion) {
        mdkAvailableCache.set(mcVersion, false);
        return false;
    }
    const ok = await (0, http_js_2.urlExists)(forgeMdkUrl(mcVersion, forgeVersion));
    mdkAvailableCache.set(mcVersion, ok);
    return ok;
}
async function filterForgeVersionsWithMdk(mcVersions, concurrency = 8) {
    const kept = [];
    let index = 0;
    async function worker() {
        while (index < mcVersions.length) {
            const i = index++;
            if (await isForgeMdkAvailable(mcVersions[i]))
                kept.push(mcVersions[i]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, mcVersions.length) }, () => worker()));
    kept.sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const d = (pb[i] ?? 0) - (pa[i] ?? 0);
            if (d !== 0)
                return d;
        }
        return 0;
    });
    return kept;
}
async function fetchForgePromos() {
    const { data } = await (0, meta_cache_js_1.getMetaCache)().get();
    return data.forgePromos;
}
/** 强制从网络拉取 Forge promotions（仅供 meta-cache 刷新） */
async function fetchForgePromosRaw() {
    const data = await (0, http_js_1.fetchJson)(sources_js_1.META_ENDPOINTS.forgePromos);
    return data.promos;
}
/** Forge 支持的 MC 版本集合（出现在 promotions 里的版本） */
async function forgeSupportedMcVersions() {
    const promos = await fetchForgePromos();
    return new Set(Object.keys(promos).map((k) => k.replace(/-(latest|recommended)$/, "")));
}
/** 取某 MC 版本的 Forge 版本，优先 recommended */
async function pickForgeVersion(mcVersion) {
    const promos = await fetchForgePromos();
    return promos[`${mcVersion}-recommended`] ?? promos[`${mcVersion}-latest`] ?? null;
}
function forgeMdkUrl(mcVersion, forgeVersion) {
    return sources_js_1.META_ENDPOINTS.forgeMdkZip(mcVersion, forgeVersion);
}
