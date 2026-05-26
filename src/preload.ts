/**
 * Renderer ↔ main bridge. Exposes a minimal `window.api` surface — every
 * call goes through ipcRenderer so the renderer never touches Node directly.
 *
 * Keep this surface tight: each method here is also handled in main.ts.
 */
import { contextBridge, ipcRenderer } from "electron";

export type AgentConfig = {
  printerIp?: string;
  printerPort?: number;
  autoStart?: boolean;
  lastPing?: "ok" | "fail";
};

const api = {
  getConfig: (): Promise<AgentConfig> => ipcRenderer.invoke("config:get"),
  saveConfig: (patch: Partial<AgentConfig>): Promise<AgentConfig> =>
    ipcRenderer.invoke("config:save", patch),
  testPrint: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("printer:test"),
  /**
   * Sweep the LAN for printers. The progress callback fires with 0..1 as
   * the sweep advances; resolve fires once with the list of IPs found.
   */
  scanForPrinters: (onProgress: (frac: number) => void): Promise<string[]> => {
    const handler = (_e: Electron.IpcRendererEvent, frac: number) => onProgress(frac);
    ipcRenderer.on("printer:scan-progress", handler);
    return (ipcRenderer.invoke("printer:scan") as Promise<string[]>).finally(() => {
      ipcRenderer.off("printer:scan-progress", handler);
    });
  },
  getAutoStart: (): Promise<boolean> => ipcRenderer.invoke("autostart:get"),
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
