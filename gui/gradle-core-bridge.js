"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadGradleCore = loadGradleCore;
exports.loadProjectJdk = loadProjectJdk;
exports.getGradleCore = getGradleCore;
exports.getProjectJdk = getProjectJdk;
const dist_loader_1 = require("./dist-loader");
function loadGradleCore() {
    return (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("core", "gradle.js"));
}
function loadProjectJdk() {
    return (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("core", "project-jdk.js"));
}
const gradleCorePromise = loadGradleCore();
const projectJdkPromise = loadProjectJdk();
function getGradleCore() {
    return gradleCorePromise;
}
function getProjectJdk() {
    return projectJdkPromise;
}
