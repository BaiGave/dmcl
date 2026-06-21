"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GITHUB_DEFAULT_BRANCHES = exports.META_ENDPOINTS = exports.HTTP_TIMEOUT_MS = exports.MAPPINGS_FRESH_TTL_MS = exports.META_FRESH_TTL_MS = exports.META_CACHE_SCHEMA_VERSION = void 0;
function positiveIntFromEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
exports.META_CACHE_SCHEMA_VERSION = 1;
// Short enough to stay close to live upstream metadata, long enough to avoid
// re-querying every wizard step. Can be tuned in CI or diagnostics.
exports.META_FRESH_TTL_MS = positiveIntFromEnv("DMCL_META_FRESH_TTL_MS", 15 * 60 * 1000);
exports.MAPPINGS_FRESH_TTL_MS = positiveIntFromEnv("DMCL_MAPPINGS_FRESH_TTL_MS", 12 * 60 * 60 * 1000);
exports.HTTP_TIMEOUT_MS = positiveIntFromEnv("DMCL_HTTP_TIMEOUT_MS", 15_000);
exports.META_ENDPOINTS = {
    mojangVersionManifest: "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
    fabricMetaBase: "https://meta.fabricmc.net/v2",
    fabricGameVersions: "https://meta.fabricmc.net/v2/versions/game",
    fabricLoaderVersions: "https://meta.fabricmc.net/v2/versions/loader",
    fabricLoaderForMc: (mcVersion) => `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`,
    fabricYarnForMc: (mcVersion) => `https://meta.fabricmc.net/v2/versions/yarn/${encodeURIComponent(mcVersion)}?limit=1`,
    fabricApiModrinth: (mcVersion) => "https://api.modrinth.com/v2/project/fabric-api/version" +
        `?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}` +
        `&loaders=${encodeURIComponent("[\"fabric\"]")}`,
    fabricApiMavenMetadata: "https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml",
    fabricExampleBranchZip: (branch) => `https://codeload.github.com/FabricMC/fabric-example-mod/zip/refs/heads/${branch}`,
    fabricExampleHeadZip: "https://github.com/FabricMC/fabric-example-mod/archive/HEAD.zip",
    forgePromos: "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
    forgeMdkZip: (mcVersion, forgeVersion) => {
        const full = `${mcVersion}-${forgeVersion}`;
        return `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-mdk.zip`;
    },
    neoforgeVersions: "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
    neoforgeMdkBranchZip: (repo, branch) => `https://codeload.github.com/NeoForgeMDKs/${repo}/zip/refs/heads/${branch}`,
    parchmentMetadata: (mcVersion) => `https://maven.parchmentmc.org/org/parchmentmc/data/parchment-${mcVersion}/maven-metadata.xml`,
    parchmentMaven: "https://maven.parchmentmc.org/",
};
exports.GITHUB_DEFAULT_BRANCHES = ["main", "master"];
