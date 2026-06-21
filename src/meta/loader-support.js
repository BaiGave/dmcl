"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.forgeMcVersionFromPromoKey = forgeMcVersionFromPromoKey;
exports.computeLoaderVersions = computeLoaderVersions;
const neoforge_js_1 = require("./neoforge.js");
function forgeMcVersionFromPromoKey(key) {
    return key.replace(/-(latest|recommended)$/, "");
}
function computeLoaderVersions(releaseVersions, fabricGameVersions, forgePromos, neoforgeVersions) {
    const fabricSet = new Set(fabricGameVersions);
    const forgeSet = new Set(Object.keys(forgePromos).map(forgeMcVersionFromPromoKey));
    return {
        fabric: releaseVersions.filter((version) => fabricSet.has(version)),
        forge: releaseVersions.filter((version) => forgeSet.has(version)),
        neoforge: releaseVersions.filter((version) => (0, neoforge_js_1.pickNeoForgeVersion)(neoforgeVersions, version) !== null),
    };
}
