import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dmcl", {
  generate: (args: string[]) => ipcRenderer.invoke("gen:run", args),
  onProgress: (cb: (line: string) => void) => {
    ipcRenderer.on("gen:line", (_e, line) => cb(line));
  },
  fileExists: (p: string) => ipcRenderer.invoke("fs:exists", p),
  writeFile: (p: string, content: string) => ipcRenderer.invoke("fs:write", p, content),
  openDir: (dir: string) => ipcRenderer.invoke("app:open", dir),
});
