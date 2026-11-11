interface NotchMediaSource {
  id: string;
  app: string;
  title: string;
  artist: string;
  status: string;
}

interface NotchMedia {
  active: boolean;
  id: string;
  sources: NotchMediaSource[];
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

interface NotchVolume {
  level: number;
  muted: boolean;
}

interface NotchAudioApp {
  pid: number;
  name: string;
  level: number;
  muted: boolean;
}

interface NotchAudioPeak {
  pid: number;
  peak: number;
}

interface NotchAudioDevice {
  id: string;
  name: string;
}

interface NotchAudioDeviceChange extends NotchAudioDevice {
  previous: string;
}

interface NotchClipItem {
  id: number;
  at: number;
  preview: string;
}

interface NotchVoiceMember {
  id: string;
  name: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  self: boolean;
}

interface NotchVoice {
  inChannel: boolean;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  channel: string;
  members: NotchVoiceMember[];
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
    getTemp: () => Promise<number | null>;
    getGpu: () => Promise<number | null>;
    getBattery: () => Promise<NotchBattery>;
    onPowerChange: (callback: (onBattery: boolean) => void) => () => void;
    onToggle: (callback: () => void) => () => void;
    getMedia: () => Promise<NotchMedia>;
    getYoutubeThumb: (track: string, artist: string) => Promise<string>;
    getWeather: () => Promise<{ tempC: number; kind: string; city: string } | null>;
    controlMedia: (action: "Play" | "Pause" | "Previous" | "Next", target?: { app?: string; title?: string }) => Promise<boolean>;
    selectMedia: (id: string) => Promise<boolean>;
    getVolume: () => Promise<NotchVolume | null>;
    setVolume: (level: number) => Promise<boolean>;
    setMuted: (muted: boolean) => Promise<boolean>;
    getAudioApps: () => Promise<NotchAudioApp[]>;
    getAudioPeaks: () => Promise<NotchAudioPeak[]>;
    setAppVolume: (pid: number, level: number) => Promise<boolean>;
    setAppMuted: (pid: number, muted: boolean) => Promise<boolean>;
    getAudioDevice: () => Promise<NotchAudioDevice | null>;
    onAudioDevice: (callback: (device: NotchAudioDeviceChange) => void) => () => void;
    openSoundSettings: () => Promise<boolean>;
    getClipboardItems: () => Promise<NotchClipItem[]>;
    copyClipboardItem: (id: number) => Promise<boolean>;
    clearClipboard: () => Promise<boolean>;
    getVoiceState: () => Promise<NotchVoice | null>;
    onVoice: (callback: (voice: NotchVoice) => void) => () => void;
    setVoice: (patch: { mute?: boolean; deaf?: boolean }) => Promise<boolean>;
  };
}
