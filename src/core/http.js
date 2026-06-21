"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UA = void 0;
exports.fetchJson = fetchJson;
exports.fetchText = fetchText;
exports.urlExists = urlExists;
exports.downloadFile = downloadFile;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
exports.UA = "DMCL/0.1 (https://github.com/BaiGave/dmcl)";
async function fetchWithRetry(url, opts = {}) {
    const { retries = 2, timeoutMs = 15_000 } = opts;
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url, {
                headers: { "user-agent": exports.UA },
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            return res;
        }
        catch (err) {
            lastErr = err;
        }
    }
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`请求失败：${url}（${reason}）`);
}
async function fetchJson(url, opts) {
    const res = await fetchWithRetry(url, opts);
    return (await res.json());
}
async function fetchText(url, opts) {
    const res = await fetchWithRetry(url, opts);
    return res.text();
}
async function urlExists(url) {
    // ???codeload.github.com ???? HEAD ???? 404???? GET ??
    const signal = AbortSignal.timeout(15_000);
    try {
        const head = await fetch(url, { method: "HEAD", redirect: "follow", headers: { "user-agent": exports.UA }, signal });
        if (head.ok)
            return true;
    }
    catch {
        // ?????? GET ??
    }
    try {
        const res = await fetch(url, {
            redirect: "follow",
            headers: { "user-agent": exports.UA, range: "bytes=0-0" },
            signal,
        });
        await res.body?.cancel();
        return res.ok;
    }
    catch {
        return false;
    }
}
async function downloadFile(url, dest) {
    const res = await fetch(url, { headers: { "user-agent": exports.UA } });
    if (!res.ok) {
        throw new Error(`下载失败 HTTP ${res.status}：${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(dest), { recursive: true });
    await node_fs_1.default.promises.writeFile(dest, buf);
}
