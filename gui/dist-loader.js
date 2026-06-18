"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.repoDist = repoDist;
exports.loadDist = loadDist;
const node_path_1 = __importDefault(require("node:path"));
const node_url_1 = require("node:url");
const repoRoot = node_path_1.default.resolve(__dirname, "..");
/** 动态 import，避免 tsc(commonjs) 将其编译为 require(ESM)。 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImport = new Function("specifier", "return import(specifier)");
function repoDist(...segments) {
    return node_path_1.default.join(repoRoot, "dist", ...segments);
}
function loadDist(absolutePath) {
    return dynamicImport((0, node_url_1.pathToFileURL)(node_path_1.default.resolve(absolutePath)).href);
}
