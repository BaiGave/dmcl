"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidModId = isValidModId;
exports.assertValidModId = assertValidModId;
const MOD_ID_RE = /^[a-z][a-z0-9_]{1,63}$/;
function isValidModId(modId) {
    return MOD_ID_RE.test(modId);
}
function assertValidModId(modId) {
    if (!isValidModId(modId)) {
        throw new Error("modId 需为小写字母开头，仅含小写字母、数字、下划线");
    }
}
