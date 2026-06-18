import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("dmclBridge", {
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
