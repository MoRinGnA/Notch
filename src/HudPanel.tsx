import { Cloud, CloudFog, CloudLightning, CloudRain, CloudSnow, Sun } from "lucide-react";
import { VolumeDeck } from "./AudioControls";
import { MicStatus } from "./VoiceControls";

export function HudPanel({ hudHm, hudSec, hudDay, weather, tempHot, hudTempLabel, hudTemp, hudGpu, expanded, openMix, voiceActive, voice, openVoice, toggleVoice }: { hudHm: string; hudSec: string; hudDay: string; weather: {tempC: number; kind: string; city: string} | null; tempHot: boolean; hudTempLabel: string; hudTemp: string; hudGpu: string; expanded: boolean; openMix: () => void; voiceActive: boolean; voice: NotchVoice | null; openVoice: () => void; toggleVoice: (patch: { mute?: boolean; deaf?: boolean }) => void }) {
  const icons = { sun: Sun, cloud: Cloud, fog: CloudFog, rain: CloudRain, snow: CloudSnow, thunder: CloudLightning };
  const WeatherIcon = icons[weather?.kind as keyof typeof icons] ?? Cloud;
  return (
    <div className="notch-hud">
      <div className="notch-hud-grid">
        <div className="notch-tile notch-hud-time">
          <span className="notch-hud-clock">{hudHm}<span className="notch-hud-sec">:{hudSec}</span></span>
          <span className="notch-hud-date">{hudDay}</span>
          {weather && <span className="notch-hud-weather" title={weather.city}><WeatherIcon size={18} strokeWidth={1.75} aria-hidden="true" /> {weather.tempC}° {weather.city}</span>}
        </div>
        <div className="notch-tile notch-hud-reads">
          <span className="notch-hud-read"><span className="notch-hud-label">{hudTempLabel}</span><span className="notch-hud-value">{hudTemp}<span className="notch-hud-unit">°C</span>{tempHot && <span className="notch-warning" aria-label="온도 높음" />}</span></span>
          <span className="notch-hud-read"><span className="notch-hud-label">GPU</span><span className="notch-hud-value">{hudGpu}<span className="notch-hud-unit">%</span></span></span>
        </div>
      </div>
      <div className="notch-tile notch-hud-volume">
        <VolumeDeck active={expanded} onOpenMixer={openMix} />
        {voiceActive && voice && <span className="notch-hud-foot"><button type="button" className="notch-tool-label" title="디스코드 음성 열기" aria-label="디스코드 음성 열기" onClick={(event) => { event.stopPropagation(); openVoice(); }}>음성</button><MicStatus voice={voice} inline onToggle={toggleVoice} /></span>}
      </div>
    </div>
  );
}
