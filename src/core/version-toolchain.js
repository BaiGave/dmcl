"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.minimumGradleForJvm = minimumGradleForJvm;
exports.isLegacyForgeByMcVersion = isLegacyForgeByMcVersion;
exports.recommendedGradleVersion = recommendedGradleVersion;
exports.resolveVersionToolchain = resolveVersionToolchain;
const mc_version_js_1 = require("../meta/mc-version.js");
const jdk_js_1 = require("./jdk.js");
/** 运行 Gradle 所需的最低 Wrapper 版本（支持指定 JVM 主版本） */
function minimumGradleForJvm(jvmMajor) {
    if (jvmMajor >= 25)
        return "9.1";
    if (jvmMajor >= 24)
        return "8.14";
    if (jvmMajor >= 23)
        return "8.10";
    if (jvmMajor >= 22)
        return "8.8";
    if (jvmMajor >= 21)
        return "8.5";
    if (jvmMajor >= 20)
        return "8.3";
    if (jvmMajor >= 19)
        return "7.6.4";
    if (jvmMajor >= 18)
        return "7.5";
    if (jvmMajor >= 17)
        return "7.3.3";
    if (jvmMajor >= 16)
        return "7.0";
    if (jvmMajor >= 15)
        return "6.7";
    if (jvmMajor >= 14)
        return "6.3";
    if (jvmMajor >= 13)
        return "6.0";
    if (jvmMajor >= 12)
        return "5.4";
    if (jvmMajor >= 11)
        return "5.0";
    if (jvmMajor >= 10)
        return "4.7";
    if (jvmMajor >= 9)
        return "4.3";
    return "4.0";
}
/** 按 MC 版本推断是否属于旧版 ForgeGradle（无 FG7 dependency 语法） */
function isLegacyForgeByMcVersion(mcVersion) {
    return (0, mc_version_js_1.compareMcVersions)(mcVersion, "1.20.2") < 0;
}
function fabricLoomHint(mcVersion) {
    if ((0, mc_version_js_1.isUnobfuscatedMc)(mcVersion))
        return "1.16-SNAPSHOT";
    if ((0, mc_version_js_1.compareMcVersions)(mcVersion, "1.21") >= 0)
        return "1.10-SNAPSHOT";
    if ((0, mc_version_js_1.compareMcVersions)(mcVersion, "1.20.5") >= 0)
        return "1.8-SNAPSHOT";
    if ((0, mc_version_js_1.compareMcVersions)(mcVersion, "1.20") >= 0)
        return "1.6-SNAPSHOT";
    if ((0, mc_version_js_1.compareMcVersions)(mcVersion, "1.19") >= 0)
        return "1.4-SNAPSHOT";
    return "1.0-SNAPSHOT";
}
/**
 * DMCL 脚手架 / 官方 MDK 常用的 Gradle Wrapper 推荐版本。
 * 无磁盘项目时用于矩阵展示与预检。
 */
function recommendedGradleVersion(loader, mcVersion) {
    if (loader === "fabric") {
        if ((0, mc_version_js_1.isUnobfuscatedMc)(mcVersion))
            return "9.4.1";
        if ((0, mc_version_js_1.compareMcVersions)(mcVersion, "1.21") >= 0)
            return "8.12";
        if ((0, mc_version_js_1.compareMcVersions)(mcVersion, "1.20") >= 0)
            return "8.8";
        if ((0, mc_version_js_1.compareMcVersions)(mcVersion, "1.18") >= 0)
            return "7.6.4";
        return "7.3.3";
    }
    if (loader === "forge") {
        if (isLegacyForgeByMcVersion(mcVersion)) {
            if ((0, mc_version_js_1.compareMcVersions)(mcVersion, "1.13") < 0)
                return "4.10.3";
            if ((0, mc_version_js_1.compareMcVersions)(mcVersion, "1.17") < 0)
                return "5.6.4";
        }
        if ((0, mc_version_js_1.compareMcVersions)(mcVersion, "1.21") >= 0)
            return "8.12";
        if ((0, mc_version_js_1.compareMcVersions)(mcVersion, "1.20") >= 0)
            return "8.8";
        if ((0, mc_version_js_1.compareMcVersions)(mcVersion, "1.17") >= 0)
            return "7.6.4";
        return "5.6.4";
    }
    // neoforge
    if ((0, mc_version_js_1.compareMcVersions)(mcVersion, "1.20.6") >= 0)
        return "8.12";
    if ((0, mc_version_js_1.compareMcVersions)(mcVersion, "1.20.5") >= 0)
        return "8.8";
    return "8.8";
}
/**
 * 仅凭加载器 + MC 版本查询推荐 JDK / Gradle（无需项目目录）。
 * 有现成项目时请用 resolveProjectToolchain() 读取 Wrapper / Loom 实际配置。
 */
function resolveVersionToolchain(loader, mcVersion) {
    const legacyForgeGradle = loader === "forge" && isLegacyForgeByMcVersion(mcVersion);
    const compileJavaMajor = legacyForgeGradle ? 8 : (0, jdk_js_1.requiredJavaFor)(mcVersion);
    const gradleVersion = recommendedGradleVersion(loader, mcVersion);
    const minimumGradleVersion = minimumGradleForJvm(compileJavaMajor);
    const gradleRange = (0, jdk_js_1.gradleJvmRange)(gradleVersion);
    let gradleRuntimeJdkMajor = compileJavaMajor;
    if (legacyForgeGradle) {
        gradleRuntimeJdkMajor = 8;
    }
    else if (loader === "fabric") {
        const loomHint = fabricLoomHint(mcVersion);
        const loomNeed = loomHint ? (0, jdk_js_1.loomMinJvm)(loomHint) : gradleRange.min;
        gradleRuntimeJdkMajor = Math.max(gradleRange.min, loomNeed, compileJavaMajor);
    }
    else {
        gradleRuntimeJdkMajor = Math.max(gradleRange.min, compileJavaMajor);
    }
    const bits = [
        `${loader} ${mcVersion}`,
        `Gradle ${gradleVersion}`,
        `Java ${gradleRuntimeJdkMajor}`,
    ];
    if (loader === "fabric") {
        const loom = fabricLoomHint(mcVersion);
        if (loom)
            bits.splice(1, 0, `Loom ${loom}`);
    }
    if (legacyForgeGradle)
        bits.push("ForgeGradle 旧版");
    if (loader === "forge")
        bits.push("Mavenizer JDK 8");
    return {
        loader,
        mcVersion,
        compileJavaMajor,
        gradleRuntimeJdkMajor,
        recommendedGradleVersion: gradleVersion,
        minimumGradleVersion,
        legacyForgeGradle,
        needsForgeMavenizer: loader === "forge",
        loomVersionHint: loader === "fabric" ? fabricLoomHint(mcVersion) : undefined,
        summary: bits.join(" · "),
    };
}
