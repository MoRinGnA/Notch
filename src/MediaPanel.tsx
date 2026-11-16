import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type RefObject } from "react";
import { VolumeDeck } from "./AudioControls";
import { MicStatus } from "./VoiceControls";
import { displayArtist } from "./mediaText";
import { Music, SkipBack, SkipForward, Play, Pause } from "lucide-react";
import type { Lyrics } from "./lyrics";

// 초를 m:ss 로 표시한다.
function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function ScrollingTitle({ text, className }: { text: string; className: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = textRef.current;
    if (!viewport || !content) return;
    let cancelled = false;
    const measure = () => {
      if (!cancelled) setOverflow(Math.max(0, content.offsetWidth - viewport.clientWidth));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    measure();
    void document.fonts.ready.then(measure);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [text]);

  return (
    <span ref={viewportRef} className={className} title={text}>
      <span
        ref={textRef}
        className={`notch-title-text${overflow > 1 ? " is-overflowing" : ""}`}
        style={{
          "--title-shift": `${overflow}px`,
          "--title-duration": `${Math.max(6, overflow * 2 / 25 + 3)}s`,
        } as CSSProperties}
      >
        {text}
      </span>
    </span>
  );
}


export function MediaPanel({ shownTitle, hasMedia, media, metaAlbum, livePosition, progress, sourceChips, playPending, selectSource, hasSynced, activeLine, lyrics, shinePosition, showArt, ytThumb, lyricsText, lineMeasureRef, widestLyric, voiceActive, voice, openVoice, toggleVoice, control, expanded, openMix }: { shownTitle: string; hasMedia: boolean; media: NotchMedia; metaAlbum: string; livePosition: number; progress: number; sourceChips: (NotchMediaSource & { label: string })[]; playPending: boolean; selectSource: (id: string) => void; hasSynced: boolean; activeLine: number; lyrics: Lyrics; shinePosition: string; showArt: boolean; ytThumb: string; lyricsText: string; lineMeasureRef: RefObject<HTMLSpanElement | null>; widestLyric: string; voiceActive: boolean; voice: NotchVoice | null; openVoice: () => void; toggleVoice: (patch: { mute?: boolean; deaf?: boolean }) => void; control: (action: "Play" | "Previous" | "Next") => (event: MouseEvent) => void; expanded: boolean; openMix: () => void }) {
  return (
          <>
        <div className="notch-tile notch-info">
          {media.thumbnail || ytThumb ? <img className="notch-cover" src={media.thumbnail || ytThumb} alt="" /> : <Music className="notch-cover" aria-hidden="true" strokeWidth={1.75} />}
          <span className="notch-meta">
            <ScrollingTitle text={shownTitle} className="notch-info-title" />
            {displayArtist(media.artist) && <span className="notch-info-meta">{displayArtist(media.artist)}</span>}
            {metaAlbum && <span className="notch-info-meta">{metaAlbum}</span>}
          </span>
        {sourceChips.length > 1 && (
          <div className="notch-sources" role="group" aria-label="재생 소스">
            {sourceChips.map((source) => (
              <button
                key={source.id}
                type="button"
                className={`notch-source${source.id === media.id ? " is-on" : ""}`}
                aria-pressed={source.id === media.id}
                disabled={playPending}
                title={`${source.title}${source.artist ? ` · ${source.artist}` : ""}${source.status === "Playing" ? "" : " (일시정지)"}`}
                onClick={(e) => { e.stopPropagation(); selectSource(source.id); }}
              >
                {source.label}
              </button>
            ))}
          </div>
        )}
        </div>
        <div className="notch-tile notch-lyrics-tile">
        {hasSynced ? (
          <div className="notch-lyrics notch-lyrics-synced">
            <div key={activeLine} className="notch-line is-active">
              {lyrics.synced[activeLine]?.text || "\u00a0"}
              {/* 줄이 바뀔 때 이 복제된 글자 위로 빛이 한 번 지나간다 */}
              <span
                className="notch-line-shine"
                aria-hidden="true"
                style={{ maskPosition: shinePosition, WebkitMaskPosition: shinePosition }}
              >
                {lyrics.synced[activeLine]?.text || "\u00a0"}
              </span>
            </div>
          </div>
        ) : showArt && ytThumb ? (
          <div className="notch-art-still">
            <img className="notch-art-still-img" src={ytThumb} alt="" />
          </div>
        ) : showArt && media.thumbnail ? (
          <div className="notch-art">
            <img className="notch-art-img" src={media.thumbnail} alt="" />
            {lyricsText ? <span className="notch-art-note">{lyricsText}</span> : null}
          </div>
        ) : (
          <div className="notch-lyrics">{lyricsText}</div>
        )}
        </div>
        {hasSynced && (
          <span ref={lineMeasureRef} className="notch-line-measure" aria-hidden="true">{widestLyric}</span>
        )}
        <div className="notch-tile notch-player">
          <div className="notch-progress">
            <span className="notch-time">{hasMedia ? clock(livePosition) : "–"}</span>
            <span className="notch-seg" aria-label="재생 진행률"><span className="notch-seg-fill" style={{ transform: `scaleX(${progress})` }} /><span className="notch-seg-head" style={{ left: `${progress * 100}%` }} /></span>
            <span className="notch-time">{hasMedia ? clock(media.duration) : "–"}</span>
          </div>
        <div className="notch-controls">
          <span className="notch-controls-tools">
          {voiceActive && voice && (
            <>
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
                음성
              </button>
              <MicStatus voice={voice} inline onToggle={toggleVoice} />
            </>
          )}
          </span>
          <span className="notch-controls-group">
            <button type="button" className="notch-btn" onClick={control("Previous")} disabled={playPending || !media.canPrev} aria-label="이전">
              <SkipBack size={18} strokeWidth={1.75} />
            </button>
            <button type="button" className="notch-btn" onClick={control("Play")} disabled={playPending || !media.canPlayPause} aria-label={media.status === "Playing" ? "일시정지" : "재생"}>
              {media.status === "Playing" ? <Pause size={18} strokeWidth={1.75} /> : <Play size={18} strokeWidth={1.75} />}
            </button>
            <button type="button" className="notch-btn" onClick={control("Next")} disabled={playPending || !media.canNext} aria-label="다음">
              <SkipForward size={18} strokeWidth={1.75} />
            </button>
          </span>
          <VolumeDeck active={expanded} onOpenMixer={openMix} />
        </div>
        </div>
          </>
  );
}
