import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("dmclBridge", {
  onBuildEvent: (cb: (data: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on("build:event", handler);
    return () => ipcRenderer.removeListener("build:event", handler);
  },
});
