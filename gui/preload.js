"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("mcdev", {
    generate: (args) => electron_1.ipcRenderer.invoke("gen:run", args),
    onProgress: (cb) => {
        electron_1.ipcRenderer.on("gen:line", (_e, line) => cb(line));
    },
    fileExists: (p) => electron_1.ipcRenderer.invoke("fs:exists", p),
    writeFile: (p, content) => electron_1.ipcRenderer.invoke("fs:write", p, content),
    openDir: (dir) => electron_1.ipcRenderer.invoke("app:open", dir),
});
