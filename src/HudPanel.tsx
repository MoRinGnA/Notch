import { VolumeDeck } from "./AudioControls";
import { MicStatus } from "./VoiceControls";

// 9x9 도트 날씨 아이콘. 1칸 = 1픽셀, 흑백으로만 그린다.
const WEATHER_DOTS: Record<string, string[]> = {
  sun: [
    "....#....",
    ".#..#..#.",
    "..#####..",
    "..#####..",
    "#########",
    "..#####..",
    "..#####..",
    ".#..#..#.",
    "....#....",
  ],
  cloud: [
    ".........",
    ".........",
    "....###..",
    "..#####..",
    ".#######.",
    ".#######.",
    "..#####..",
    ".........",
    ".........",
  ],
  fog: [
    ".........",
    ".........",
    ".#####...",
    "...#####.",
    ".#####...",
    "...#####.",
    ".#####...",
    ".........",
    ".........",
  ],
  rain: [
    "....###..",
    "..#####..",
    ".#######.",
    "..#####..",
    ".#.#.#...",
    "..#.#....",
    ".#.#.....",
    ".........",
    ".........",
  ],
  snow: [
    "....###..",
    "..#####..",
    ".#######.",
    "..#####..",
    ".#.#.#...",
    "#.#.#.#..",
    ".#.#.#...",
    ".........",
    ".........",
  ],
  thunder: [
    "....###..",
    "..#####..",
    ".#######.",
    "..#####..",
    "....##...",
    "...##....",
    "..##.....",
    "..#......",
    ".........",
  ],
};

function WeatherIcon({ kind }: { kind: string }) {
  const rows = WEATHER_DOTS[kind] ?? WEATHER_DOTS.cloud;
  return (
    <svg className="notch-hud-pixel" viewBox={`0 0 ${rows.length} ${rows.length}`} aria-hidden="true">
      {rows.flatMap((row, y) =>
        [...row].map((cell, x) =>
          cell === "#" ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} /> : null,
        ),
      )}
    </svg>
  );
}


export function HudPanel({ hudHm, hudSec, hudDay, weather, tempHot, hudTempLabel, hudTemp, hudGpu, expanded, openMix, voiceActive, voice, openVoice, toggleVoice }: { hudHm: string; hudSec: string; hudDay: string; weather: {tempC: number; kind: string; city: string} | null; tempHot: boolean; hudTempLabel: string; hudTemp: string; hudGpu: string; expanded: boolean; openMix: () => void; voiceActive: boolean; voice: NotchVoice | null; openVoice: () => void; toggleVoice: (patch: { mute?: boolean; deaf?: boolean }) => void }) {
  return (
          <div className="notch-hud">
            <span className="notch-hud-clock">
              {hudHm}
              <span className="notch-hud-sec">:{hudSec}</span>
            </span>
            <span className="notch-hud-line">
              <span className="notch-hud-date">{hudDay}</span>
              {weather && (
                <span className="notch-hud-weather" title={weather.city ?? undefined}>
                  <WeatherIcon kind={weather.kind} />
                  <span>{weather.tempC}°</span>
                  {weather.city && <span className="notch-hud-city">{weather.city}</span>}
                </span>
              )}
            </span>
            <div className="notch-hud-reads">
              <span className={`notch-hud-read${tempHot ? " is-hot" : ""}`}>
                <span className="notch-hud-label">{hudTempLabel}</span>
                <span className="notch-hud-value">
                  {hudTemp}
                  <span className="notch-hud-unit">°C</span>
                </span>
              </span>
              <span className="notch-hud-read">
                <span className="notch-hud-label">GPU</span>
                <span className="notch-hud-value">
                  {hudGpu}
                  <span className="notch-hud-unit">%</span>
                </span>
              </span>
            </div>
            <VolumeDeck active={expanded} onOpenMixer={openMix} />
            {voiceActive && voice && (
              <span className="notch-hud-foot">
                <button
                  type="button"
                  className="notch-tool-label"
                  title="디스코드 음성 열기"
                  aria-label="디스코드 음성 열기"
                  onClick={(event) => {
                    event.stopPropagation();
                    openVoice();
                  }}
                >
                  VOICE
                </button>
                <MicStatus voice={voice} inline onToggle={toggleVoice} />
              </span>
            )}
          </div>
  );
}
