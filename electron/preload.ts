import { contextBridge, ipcRenderer } from "electron";

// 메모 한 건의 모양(저장소는 메인 프로세스의 notes.json).
interface NotchNote {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

contextBridge.exposeInMainWorld("notchApi", {
  setNotchBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send("notch:bounds", bounds),
  getStats: () => ipcRenderer.invoke("notch:stats") as Promise<{ cpu: number }>,
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
  getNotes: () => ipcRenderer.invoke("notch:notes") as Promise<{ pinnedId: string | null; notes: NotchNote[] }>,
  saveNote: (note: { id: string | null; text: string }) =>
    ipcRenderer.invoke("notch:note-save", note) as Promise<NotchNote | null>,
  pinNote: (id: string | null) =>
    ipcRenderer.invoke("notch:note-pin", id) as Promise<{ pinnedId: string | null; notes: NotchNote[] }>,
  deleteNote: (id: string) =>
    ipcRenderer.invoke("notch:note-delete", id) as Promise<{ pinnedId: string | null; notes: NotchNote[] }>,
  onNewNote: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("notch:new-note", listener);
    return () => ipcRenderer.removeListener("notch:new-note", listener);
  },
});
