import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("notchApi", {
  setNotchBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send("notch:bounds", bounds),
  getStats: () => ipcRenderer.invoke("notch:stats") as Promise<{ cpu: number }>,
  getGpu: () => ipcRenderer.invoke("notch:gpu") as Promise<number | null>,
  getMedia: () => ipcRenderer.invoke("notch:media"),
  getBattery: () => ipcRenderer.invoke("notch:battery") as Promise<{ hasBattery: boolean; percent: number; charging: boolean }>,
  onPowerChange: (callback: (onBattery: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, onBattery: boolean) => callback(onBattery);
    ipcRenderer.on("notch:power-change", listener);
    return () => ipcRenderer.removeListener("notch:power-change", listener);
  },
  getYoutubeThumb: (track: string, artist: string) =>
    ipcRenderer.invoke("notch:youtube-thumb", { track, artist }) as Promise<string>,
  getWeather: () => ipcRenderer.invoke("notch:weather") as Promise<{ tempC: number; kind: string; city: string } | null>,
  controlMedia: (action: "Play" | "Pause" | "Previous" | "Next", target?: { app?: string; title?: string }) =>
    ipcRenderer.invoke("notch:media-control", { action, ...target }) as Promise<boolean>,
});
