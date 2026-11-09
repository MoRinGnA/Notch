import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("notchApi", {
  getStats: () => ipcRenderer.invoke("notch:stats") as Promise<{ cpu: number }>,
  getMedia: () => ipcRenderer.invoke("notch:media"),
  getBattery: () => ipcRenderer.invoke("notch:battery") as Promise<{ hasBattery: boolean; percent: number; charging: boolean }>,
  controlMedia: (action: "Play" | "Previous" | "Next", target?: { app?: string; title?: string }) =>
    ipcRenderer.invoke("notch:media-control", { action, ...target }) as Promise<void>,
});
