import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// Sandboxed preload: no local requires. The main process passes the per-session API token as
// `--dmcl-api-token=<hex>` (see api-guard.ts); every /api request must send it as X-DMCL-Token.
const TOKEN_ARG = "--dmcl-api-token=";
const apiToken = (process.argv.find((arg) => arg.startsWith(TOKEN_ARG)) ?? "").slice(TOKEN_ARG.length);

contextBridge.exposeInMainWorld("dmcl", {
  apiToken,
});

contextBridge.exposeInMainWorld("dmclBridge", {
  apiToken,
  onBuildEvent: (cb: (data: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on("build:event", handler);
    return () => ipcRenderer.removeListener("build:event", handler);
  },
  onBuildSummary: (cb: (data: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on("build:summary", handler);
    return () => ipcRenderer.removeListener("build:summary", handler);
  },
  onNotificationOpen: (cb: (data: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on("notification:open", handler);
    return () => ipcRenderer.removeListener("notification:open", handler);
  },
});
