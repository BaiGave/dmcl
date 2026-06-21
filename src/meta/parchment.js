"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchParchmentVersion = fetchParchmentVersion;
const http_js_1 = require("../core/http.js");
const sources_js_1 = require("./sources.js");
/** 查询 Parchment 最新正式版，返回 null 表示该 MC 版本暂无 Parchment */
async function fetchParchmentVersion(mcVersion) {
    try {
        const xml = await (0, http_js_1.fetchText)(sources_js_1.META_ENDPOINTS.parchmentMetadata(mcVersion), { retries: 1, timeoutMs: 10_000 });
        const m = xml.match(/<release>([^<]+)<\/release>/);
        if (!m)
            return null;
        const version = m[1].trim();
        if (version.endsWith("-SNAPSHOT"))
            return null;
        return version;
    }
    catch {
        return null;
    }
}
