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

interface Window {
  notchApi?: {
    getStats: () => Promise<NotchStats>;
    getBattery: () => Promise<NotchBattery>;
    getMedia: () => Promise<NotchMedia>;
    controlMedia: (action: "Play" | "Previous" | "Next", target?: { app?: string; title?: string }) => Promise<void>;
  };
}
