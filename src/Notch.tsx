import { useEffect, useRef, useState, type MouseEvent } from "react";

interface NotchProps {
  expanded: boolean;
  onToggle: () => void;
}

interface Lyrics {
  state: "idle" | "loading" | "ready" | "missing" | "instrumental";
  text: string;
  // 싱크 가사: 줄별 시작 시각(초)과 텍스트. 없으면 빈 배열.
  synced: { time: number; text: string }[];
}

const MEDIA_POLL_MS = 2000;
const BATTERY_POLL_MS = 30000;

// docs/PLAN.md 기준: 충전 중 파랑, 방전 중 50% 초과 초록, 50% 이하 노랑, 30% 이하 빨강.
function batteryLevelClass(b: NotchBattery): string {
  if (b.charging) return "is-charging";
  if (b.percent <= 30) return "is-critical";
  if (b.percent <= 50) return "is-low";
  return "is-high";
}
const LYRICS_GAP_MS = 300;
const LYRICS_CACHE_LIMIT = 50;

const EMPTY_MEDIA: NotchMedia = {
  active: false,
  status: "",
  title: "",
  artist: "",
  album: "",
  thumbnail: "",
  app: "",
  canPrev: false,
  canNext: false,
  canPlayPause: false,
  position: 0,
  duration: 0,
  updatedAt: 0,
};

const PROGRESS_TICK_MS = 250;

// 초를 m:ss 로 표시한다.
function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// 유튜브 제목의 [가사/해석/lyrics] 같은 꼬리표를 제거한다.
function cleanTitle(title: string): string {
  return title
    .replace(/\s*[\[(【][^\])】]*[\])】]/g, "")
    .replace(/\s*\|.*$/, "")
    .replace(/\s+(Official|M\/V|MV|Music Video|Lyrics?|가사|뮤직비디오|Audio)\b.*$/i, "")
    .trim();
}

// 제목에 "아티스트 : 곡명" 형식이 있으면 곡명만 쓴다.
function trackName(title: string): string {
  const cleaned = cleanTitle(title);
  const quoted = cleaned.match(/^(.*?)["'‘’“”]([^"'‘’“”]+?)["'‘’“”](?:\s|$)/);
  if (quoted && quoted[2].trim()) return quoted[2].trim();
  const match = cleaned.match(/^.+?\s:\s(.+)$/);
  return match ? match[1].trim() : cleaned;
}

// YouTube 업로더(레이블·방송 채널)는 가수가 아니므로 아티스트로 쓰지 않는다.
const CHANNEL_NAMES = ["SMTOWN", "HYBE LABELS", "JYP Entertainment", "YG ENTERTAINMENT", "Mnet K-POP", "KBS Kpop", "1theK (원더케이)", "1theK", "GENIE MUSIC", "Vevo", "YouTube", "BIGHIT MUSIC", "Stone Music Entertainment"];
// 화면에는 YouTube Music의 "- Topic" 꼬리를 빼고 보여준다.
function displayArtist(artist: string): string {
  return artist.replace(/\s*-\s*Topic$/i, "").trim();
}

function artistName(artist: string): string {
  const name = artist.trim().replace(/\s*-\s*Topic$/i, "");
  if (!name || /VEVO$/i.test(name) || /(Entertainment|Records|Labels|Official)$/i.test(name)) return "";
  return CHANNEL_NAMES.some((c) => c.toLowerCase() === name.toLowerCase()) ? "" : name;
}

// 검색 결과 후보의 점수. 곡명이 같아야 하고, 아티스트까지 맞으면 가장 높게 친다.
// 원본 TopDock LyricsService.ScoreMatch와 같은 규칙: 아티스트가 맞으면 가장 강하고,
// 아티스트를 못 믿으면(유튜브 업로더) 제목이 완전히 같고 재생 길이까지 맞아야 한다.
function matchScore(
  hit: { trackName?: string; artistName?: string; duration?: number },
  track: string,
  artist: string,
  mediaDuration: number,
): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const want = norm(track);
  const got = norm(hit.trackName ?? "");
  if (!want || !got) return 0;
  const titleScore = want === got ? 1 : got.includes(want) || want.includes(got) ? 0.6 : 0;
  if (titleScore === 0) return 0;
  if (artist) {
    const a = norm(artist);
    const ga = norm(hit.artistName ?? "");
    if (a && ga && (a === ga || ga.includes(a) || a.includes(ga))) return titleScore * 0.6 + 0.4;
  }
  if (want !== got) return 0;
  if (mediaDuration > 0 && hit.duration && hit.duration > 0) {
    const diff = Math.abs(hit.duration - mediaDuration);
    if (diff > 40) return 0;
    return diff <= 5 ? 0.85 : 0.72;
  }
  return 0.65;
}

function stripTimestamps(synced: string): string {
  return synced.replace(/^\[[^\]]*\]\s?/gm, "").trim();
}

// LRC 형식([mm:ss.xx] 텍스트)을 줄별 시각 목록으로 바꾼다.
function parseSynced(synced: string): { time: number; text: string }[] {
  const rows: { time: number; text: string }[] = [];
  for (const line of synced.split("\n")) {
    const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s?(.*)$/);
    if (!m) continue;
    rows.push({ time: Number(m[1]) * 60 + Number(m[2]), text: m[3].trim() });
  }
  return rows;
}

const lyricsCache = new Map<string, Lyrics>();
let lastLyricsAt = 0;

async function fetchLyrics(media: NotchMedia): Promise<Lyrics> {
  const track = trackName(media.title);
  const artist = artistName(media.artist);
  const key = `${track}|${artist}|${media.album}`;
  const cached = lyricsCache.get(key);
  if (cached) return cached;

  const wait = lastLyricsAt + LYRICS_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastLyricsAt = Date.now();

  const params = new URLSearchParams({ track_name: track, artist_name: artist });
  if (media.album) params.set("album_name", media.album);
  type LrcData = { plainLyrics?: string | null; syncedLyrics?: string | null; instrumental?: boolean };
  const headers = { "Lrclib-Client": "Notch/0.1" };
  const toResult = (data: LrcData): Lyrics => {
    if (data.instrumental) return { state: "instrumental", text: "", synced: [] };
    const text = data.plainLyrics?.trim() || (data.syncedLyrics ? stripTimestamps(data.syncedLyrics) : "");
    const synced = data.syncedLyrics ? parseSynced(data.syncedLyrics) : [];
    return text ? { state: "ready", text, synced } : { state: "missing", text: "", synced: [] };
  };
  let result: Lyrics = { state: "missing", text: "", synced: [] };
  try {
    // 1차: 정확한 제목·아티스트 조회
    const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, { headers });
    if (res.ok) result = toResult((await res.json()) as LrcData);
    // 2차: 실패 시 검색 API로 다시 찾기
    if (result.state === "missing") {
      // 검색 결과는 점수가 가장 높은 후보를 쓴다. 기준(0.6) 미만이거나 가사가 없으면 버린다.
      const queries = [...new Set([`${artist} ${track}`.trim(), track].filter((q) => q.length >= 2))];
      let best: { score: number; data: LrcData } | null = null;
      for (const q of queries) {
        if (best && best.score >= 0.999) break;
        const res2 = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, { headers });
        if (!res2.ok) continue;
        const list = (await res2.json()) as (LrcData & { trackName?: string; artistName?: string; duration?: number })[];
        for (const hit of list) {
          if (hit.instrumental) continue;
          if (!hit.plainLyrics?.trim() && !hit.syncedLyrics) continue;
          const score = matchScore(hit, track, artist, media.duration);
          if (score >= 0.6 && (!best || score > best.score)) best = { score, data: hit };
        }
      }
      if (best) result = toResult(best.data);
    }
  } catch {
    result = { state: "missing", text: "", synced: [] };
  }

  if (lyricsCache.size >= LYRICS_CACHE_LIMIT) lyricsCache.clear();
  lyricsCache.set(key, result);
  return result;
}

export function Notch({ expanded, onToggle }: NotchProps) {
  const [media, setMedia] = useState<NotchMedia>(EMPTY_MEDIA);
  const [lyrics, setLyrics] = useState<Lyrics>({ state: "idle", text: "", synced: [] });
  const [now, setNow] = useState(() => Date.now());
  const [battery, setBattery] = useState<NotchBattery | null>(null);
  const mediaRef = useRef(media);
  mediaRef.current = media;

  useEffect(() => {
    if (!window.notchApi) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await window.notchApi!.getMedia();
        if (!cancelled) setMedia(next);
      } catch {
        if (!cancelled) setMedia(EMPTY_MEDIA);
      }
    };
    void poll();
    const id = window.setInterval(poll, MEDIA_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // 배터리는 노트북에서만 존재한다. 데스크탑은 hasBattery=false라 점이 그려지지 않는다.
  useEffect(() => {
    if (!window.notchApi) return;
    let cancelled = false;
    const read = () =>
      window.notchApi!
        .getBattery()
        .then((b) => {
          if (!cancelled) setBattery(b);
        })
        .catch(() => {
          if (!cancelled) setBattery(null);
        });
    void read();
    const id = window.setInterval(read, BATTERY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // 재생 중에는 마지막 폴링 시점부터 경과 시간을 더해 진행률을 부드럽게 올린다.
  useEffect(() => {
    if (!media.active || media.status !== "Playing") return;
    const id = window.setInterval(() => setNow(Date.now()), PROGRESS_TICK_MS);
    return () => window.clearInterval(id);
  }, [media.active, media.status]);
  // Windows는 재생 중 위치를 바꾸지 않고 LastUpdatedTime만 기록하므로, 그 시점부터 경과 시간을 더한다.
  const elapsed = media.status === "Playing" && media.updatedAt > 0 ? (now - media.updatedAt) / 1000 : 0;
  const livePosition = Math.min(media.duration, media.position + Math.max(0, elapsed));

  const mediaKey = `${media.title}|${media.artist}|${media.album}`;
  useEffect(() => {
    if (!expanded) return;
    const current = mediaRef.current;
    if (!current.active || !current.title) {
      setLyrics({ state: "idle", text: "", synced: [] });
      return;
    }
    let cancelled = false;
    setLyrics({ state: "loading", text: "", synced: [] });
    void fetchLyrics(current).then((result) => {
      if (!cancelled) setLyrics(result);
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, mediaKey]);

  const control = (action: "Play" | "Previous" | "Next") => (e: MouseEvent) => {
    e.stopPropagation();
    if (action === "Play") {
      // 제어 명령은 1초 가량 걸리므로, 버튼을 누르면 화면을 먼저 바꾸고 실제 상태는 나중에 맞춘다.
      const m = mediaRef.current;
      const nowMs = Date.now();
      const playing = m.status === "Playing";
      const position =
        playing && m.updatedAt > 0 ? Math.min(m.duration, m.position + (nowMs - m.updatedAt) / 1000) : m.position;
      setMedia({ ...m, status: playing ? "Paused" : "Playing", position, updatedAt: nowMs });
    }
    // 화면에 보이는 그 세션에 명령을 보낸다 — 다른 앱의 일시정지된 세션으로 새면 엉뚱한 것이 재생된다.
    void window.notchApi
      ?.controlMedia(action, { app: mediaRef.current.app, title: mediaRef.current.title })
      .then(() => window.notchApi?.getMedia())
      .then((next) => {
        if (next) setMedia(next);
      })
      .catch(() => undefined);
  };

  const hasMedia = media.active && media.title.length > 0;
  const shownTitle = cleanTitle(media.title);
  const progress = media.duration > 0 ? Math.min(1, Math.max(0, livePosition / media.duration)) : 0;
  const hasSynced = lyrics.state === "ready" && lyrics.synced.length > 0;
  // 현재 재생 시각에 해당하는 줄의 인덱스(마지막으로 시작한 줄).
  let activeLine = -1;
  if (hasSynced) {
    for (let i = 0; i < lyrics.synced.length; i++) {
      if (lyrics.synced[i].time <= livePosition) activeLine = i;
      else break;
    }
  }
  const showArt = lyrics.state === "missing" || lyrics.state === "instrumental" || lyrics.state === "idle";
  const lyricsText =
    lyrics.state === "ready"
      ? lyrics.text
      : lyrics.state === "instrumental"
        ? "연주곡입니다."
        : lyrics.state === "loading"
          ? "가사를 불러오는 중..."
          : lyrics.state === "missing"
            ? "가사를 찾지 못했습니다."
            : "";

  return (
    <div
      role="button"
      tabIndex={0}
      className={`notch ${expanded ? "is-expanded" : "is-collapsed"}${hasMedia ? " has-media" : ""}${media.status === "Playing" ? " is-playing" : ""}`}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onToggle();
      }}
      aria-expanded={expanded}
      aria-label="Notch"
    >
      <span className="notch-body" />
      {battery?.hasBattery && (
        <span
          className={`notch-battery ${batteryLevelClass(battery)}`}
          title={`배터리 ${battery.percent}%${battery.charging ? " · 충전 중" : ""}`}
        />
      )}
      {!expanded && hasMedia ? (
        <span className="notch-now">
          <span className="notch-now-title">{shownTitle}</span>
          {media.artist && <span className="notch-now-artist">{displayArtist(media.artist)}</span>}
        </span>
      ) : !media.active && !expanded ? (
        <span className="notch-eyes">
          <span className="notch-eye" />
          <span className="notch-eye" />
        </span>
      ) : null}
      <span className="notch-title">NOTCH-01</span>
      <div className="notch-panel">

        <div className="notch-info">
          <span className="notch-info-row">
            <span className="notch-hud-key">TRACK</span>
            <span className="notch-info-title">{hasMedia ? shownTitle : "재생 중인 곡 없음"}</span>
          </span>
          {hasMedia && media.artist && (
            <span className="notch-info-row">
              <span className="notch-hud-key">ARTIST</span>
              <span className="notch-info-artist">{displayArtist(media.artist)}</span>
            </span>
          )}
          {hasMedia && media.album && media.album !== media.title && media.album !== shownTitle && (
            <span className="notch-info-row">
              <span className="notch-hud-key">ALBUM</span>
              <span className="notch-info-album">{media.album}</span>
            </span>
          )}
        </div>
        <div className="notch-progress">
          <span className="notch-time">{hasMedia ? clock(livePosition) : "--:--"}</span>
          <span className="notch-seg" aria-label="재생 진행률">
            <span className="notch-seg-fill" style={{ transform: `scaleX(${progress})` }} />
          </span>
          <span className="notch-time">{hasMedia ? clock(media.duration) : "--:--"}</span>
        </div>
        {showArt && media.thumbnail ? (
          <div className="notch-art">
            <img className="notch-art-img" src={media.thumbnail} alt="" />
            <span className="notch-art-note">{lyricsText}</span>
          </div>
        ) : hasSynced ? (
          <div className="notch-lyrics notch-lyrics-synced">
            <div key={activeLine} className="notch-line is-active">
              {lyrics.synced[activeLine]?.text || "\u00a0"}
            </div>
          </div>
        ) : (
          <div className="notch-lyrics">{lyricsText}</div>
        )}
        <div className="notch-controls">
          <button type="button" className="notch-btn" onClick={control("Previous")} disabled={!media.canPrev} aria-label="이전">
            PREV
          </button>
          <button type="button" className="notch-btn" onClick={control("Play")} disabled={!media.canPlayPause} aria-label="재생/일시정지">
            {media.status === "Playing" ? "PAUSE" : "PLAY"}
          </button>
          <button type="button" className="notch-btn" onClick={control("Next")} disabled={!media.canNext} aria-label="다음">
            NEXT
          </button>
        </div>
      </div>
      <span className="notch-scan" />
    </div>
  );
}
