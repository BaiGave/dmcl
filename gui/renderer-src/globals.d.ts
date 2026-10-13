/** Globals the Electron preload may expose to the renderer. Both are optional. */
interface DmclPreloadApi {
  /** Per-launch secret the local API expects in the X-DMCL-Token header. */
  apiToken?: string;
  [key: string]: unknown;
}

interface DmclBridgeApi {
  onBuildEvent(cb: (data: any) => void): () => void;
  onBuildSummary?(cb: (data: any) => void): () => void;
  onNotificationOpen?(cb: (data: any) => void): () => void;
}

interface Window {
  dmcl?: DmclPreloadApi;
  dmclBridge?: DmclBridgeApi;
}
