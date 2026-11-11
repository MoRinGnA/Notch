import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("notchApi", {
  setNotchBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send("notch:bounds", bounds),
  getTemp: () => ipcRenderer.invoke("notch:temp") as Promise<number | null>,
  getGpu: () => ipcRenderer.invoke("notch:gpu") as Promise<number | null>,
  getMedia: () => ipcRenderer.invoke("notch:media"),
  getBattery: () => ipcRenderer.invoke("notch:battery") as Promise<{ hasBattery: boolean; percent: number; charging: boolean }>,
  getSettings: () => ipcRenderer.invoke("notch:settings") as Promise<{
    hoverOpen: boolean;
    toggleShortcut: string;
    hideOnFullscreen: boolean;
  }>,
  onSettings: (callback: (settings: { hoverOpen: boolean; toggleShortcut: string; hideOnFullscreen: boolean }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, settings: { hoverOpen: boolean; toggleShortcut: string; hideOnFullscreen: boolean }) =>
      callback(settings);
    ipcRenderer.on("notch:settings", listener);
    return () => ipcRenderer.removeListener("notch:settings", listener);
  },
  onToggle: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("notch:toggle", listener);
    return () => ipcRenderer.removeListener("notch:toggle", listener);
  },
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
  selectMedia: (id: string) => ipcRenderer.invoke("notch:media-select", id) as Promise<boolean>,
  getVolume: () => ipcRenderer.invoke("notch:volume") as Promise<{ level: number; muted: boolean } | null>,
  setVolume: (level: number) => ipcRenderer.invoke("notch:volume-set", level) as Promise<boolean>,
  setMuted: (muted: boolean) => ipcRenderer.invoke("notch:volume-mute", muted) as Promise<boolean>,
  getAudioApps: () =>
    ipcRenderer.invoke("notch:audio-apps") as Promise<{ pid: number; name: string; level: number; muted: boolean }[]>,
  getAudioPeaks: () => ipcRenderer.invoke("notch:audio-peaks") as Promise<{ pid: number; peak: number }[]>,
  setAppVolume: (pid: number, level: number) => ipcRenderer.invoke("notch:audio-app-set", pid, level) as Promise<boolean>,
  setAppMuted: (pid: number, muted: boolean) => ipcRenderer.invoke("notch:audio-app-mute", pid, muted) as Promise<boolean>,
  getAudioDevice: () => ipcRenderer.invoke("notch:audio-device") as Promise<{ id: string; name: string } | null>,
  onAudioDevice: (callback: (device: { id: string; name: string; previous: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, device: { id: string; name: string; previous: string }) =>
      callback(device);
    ipcRenderer.on("notch:audio-device", listener);
    return () => ipcRenderer.removeListener("notch:audio-device", listener);
  },
  openSoundSettings: () => ipcRenderer.invoke("notch:sound-settings") as Promise<boolean>,
});
