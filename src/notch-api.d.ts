interface NotchStats {
  cpu: number;
}

interface NotchMedia {
  active: boolean;
  status: string;
  title: string;
  artist: string;
  album: string;
  thumbnail: string;
  app: string;
  canPrev: boolean;
  canNext: boolean;
  canPlayPause: boolean;
  position: number;
  duration: number;
  updatedAt: number;
}

interface NotchBattery {
  hasBattery: boolean;
  percent: number;
  charging: boolean;
}

interface NotchSettings {
  hoverOpen: boolean;
  toggleShortcut: string;
  hideOnFullscreen: boolean;
}

interface Window {
  notchApi?: {
    setNotchBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
    getSettings: () => Promise<NotchSettings>;
    onSettings: (callback: (settings: NotchSettings) => void) => () => void;
    getStats: () => Promise<NotchStats>;
    getGpu: () => Promise<number | null>;
    getBattery: () => Promise<NotchBattery>;
    onPowerChange: (callback: (onBattery: boolean) => void) => () => void;
    onToggle: (callback: () => void) => () => void;
    getMedia: () => Promise<NotchMedia>;
    getYoutubeThumb: (track: string, artist: string) => Promise<string>;
    getWeather: () => Promise<{ tempC: number; kind: string; city: string } | null>;
    controlMedia: (action: "Play" | "Pause" | "Previous" | "Next", target?: { app?: string; title?: string }) => Promise<boolean>;
  };
}
