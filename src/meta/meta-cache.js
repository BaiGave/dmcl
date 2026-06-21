"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetaCache = exports.META_TTL_MS = exports.META_CACHE_FILE = void 0;
exports.getMetaCache = getMetaCache;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const mojang_js_1 = require("./mojang.js");
const fabric_js_1 = require("./fabric.js");
const forge_js_1 = require("./forge.js");
const neoforge_js_1 = require("./neoforge.js");
const loader_support_js_1 = require("./loader-support.js");
const sources_js_1 = require("./sources.js");
exports.META_CACHE_FILE = node_path_1.default.join(node_os_1.default.homedir(), ".dmcl", "meta-cache.json");
/** MC 版本、加载器支持列表等元数据：每日刷新一次即可 */
exports.META_TTL_MS = sources_js_1.META_FRESH_TTL_MS;
async function fetchFreshMeta() {
    const [releaseVersions, fabricGameVersions, fabricLoaderVersion, forgePromos, neoforgeVersions] = await Promise.all([
        (0, mojang_js_1.fetchReleaseVersions)(),
        (0, fabric_js_1.fetchFabricGameVersionsRaw)(),
        (0, fabric_js_1.fetchFabricLoaderVersionRaw)(),
        (0, forge_js_1.fetchForgePromosRaw)(),
        (0, neoforge_js_1.fetchNeoForgeVersionsRaw)(),
    ]);
    const loaderVersions = (0, loader_support_js_1.computeLoaderVersions)(releaseVersions, fabricGameVersions, forgePromos, neoforgeVersions);
    loaderVersions.forge = await (0, forge_js_1.filterForgeVersionsWithMdk)(loaderVersions.forge);
    return {
        version: sources_js_1.META_CACHE_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        releaseVersions,
        fabricGameVersions,
        fabricLoaderVersion,
        forgePromos,
        neoforgeVersions,
        loaderVersions,
    };
}
class MetaCache {
    data = null;
    refreshInFlight = null;
    constructor() {
        this.data = this.load();
    }
    load() {
        try {
            if (node_fs_1.default.existsSync(exports.META_CACHE_FILE)) {
                const raw = JSON.parse(node_fs_1.default.readFileSync(exports.META_CACHE_FILE, "utf8"));
                if (raw.version === sources_js_1.META_CACHE_SCHEMA_VERSION && raw.loaderVersions)
                    return raw;
            }
        }
        catch { /* fresh */ }
        return null;
    }
    save(data) {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(exports.META_CACHE_FILE), { recursive: true });
        node_fs_1.default.writeFileSync(exports.META_CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
        this.data = data;
    }
    isStale(data, maxAgeMs = exports.META_TTL_MS) {
        const updatedAt = new Date(data.updatedAt).getTime();
        if (!Number.isFinite(updatedAt))
            return true;
        return Date.now() - updatedAt > maxAgeMs;
    }
    getStatus() {
        const d = this.data;
        return {
            cacheFile: exports.META_CACHE_FILE,
            updatedAt: d?.updatedAt,
            stale: !d || this.isStale(d),
            releaseCount: d?.releaseVersions.length ?? 0,
            loaderCounts: {
                fabric: d?.loaderVersions.fabric.length ?? 0,
                forge: d?.loaderVersions.forge.length ?? 0,
                neoforge: d?.loaderVersions.neoforge.length ?? 0,
            },
        };
    }
    /** 有缓存则立即返回；过期则在后台刷新 */
    async get(opts = {}) {
        const strategy = opts.strategy ?? "fresh";
        const maxAgeMs = opts.maxAgeMs ?? exports.META_TTL_MS;
        const allowStaleOnError = opts.allowStaleOnError ?? true;
        if (this.data && !this.isStale(this.data, maxAgeMs)) {
            return { data: this.data, fromCache: true, stale: false };
        }
        if (this.data && strategy === "cache-first") {
            void this.refresh().catch(() => { });
            return { data: this.data, fromCache: true, stale: true };
        }
        try {
            const data = await this.refresh();
            return { data, fromCache: false, stale: false };
        }
        catch (err) {
            if (this.data && allowStaleOnError) {
                return { data: this.data, fromCache: true, stale: true };
            }
            throw err;
        }
    }
    /** 启动时调用：有缓存且未过期则跳过；过期则后台刷新 */
    refreshIfStale(maxAgeMs = exports.META_TTL_MS) {
        if (this.data && !this.isStale(this.data, maxAgeMs))
            return;
        void this.refresh().catch((err) => {
            console.warn("[dmcl] 元数据缓存刷新失败:", err instanceof Error ? err.message : err);
        });
    }
    async refresh() {
        if (this.refreshInFlight)
            return this.refreshInFlight;
        this.refreshInFlight = fetchFreshMeta()
            .then((data) => {
            this.save(data);
            this.refreshInFlight = null;
            return data;
        })
            .catch((err) => {
            this.refreshInFlight = null;
            throw err;
        });
        return this.refreshInFlight;
    }
    async getLoaderVersions(loader) {
        const { data } = await this.get();
        return data.loaderVersions[loader] ?? [];
    }
    async getAllLoaderVersions() {
        const { data } = await this.get();
        return data.loaderVersions;
    }
    async getReleaseVersions() {
        const { data } = await this.get();
        return data.releaseVersions;
    }
}
exports.MetaCache = MetaCache;
let singleton = null;
function getMetaCache() {
    if (!singleton)
        singleton = new MetaCache();
    return singleton;
}
