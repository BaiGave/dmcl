"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("dmclBridge", {
    onBuildEvent: (cb) => {
        const handler = (_e, data) => cb(data);
        electron_1.ipcRenderer.on("build:event", handler);
        return () => electron_1.ipcRenderer.removeListener("build:event", handler);
    },
    onBuildSummary: (cb) => {
        const handler = (_e, data) => cb(data);
        electron_1.ipcRenderer.on("build:summary", handler);
        return () => electron_1.ipcRenderer.removeListener("build:summary", handler);
    },
    onNotificationOpen: (cb) => {
        const handler = (_e, data) => cb(data);
        electron_1.ipcRenderer.on("notification:open", handler);
        return () => electron_1.ipcRenderer.removeListener("notification:open", handler);
    },
});
