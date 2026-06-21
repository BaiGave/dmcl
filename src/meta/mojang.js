"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchReleaseVersions = fetchReleaseVersions;
const http_js_1 = require("../core/http.js");
const sources_js_1 = require("./sources.js");
/** 返回所有正式版版本号，按从新到旧排列 */
async function fetchReleaseVersions() {
    const data = await (0, http_js_1.fetchJson)(sources_js_1.META_ENDPOINTS.mojangVersionManifest);
    return data.versions.filter((v) => v.type === "release").map((v) => v.id);
}
