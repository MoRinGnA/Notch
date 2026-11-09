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
  // 가사가 없을 때 채울 유튜브 썸네일(data URL). 없으면 빈 문자열.
  const [ytThumb, setYtThumb] = useState("");
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

  // 가사를 찾지 못한 곡은 유튜브 썸네일을 앨범처럼 띄운다. 실패하면 기존 앨범 아트로 돌아간다.
  useEffect(() => {
    if (!expanded || lyrics.state !== "missing" || !media.active) {
      setYtThumb("");
      return;
    }
    const track = trackName(media.title);
    const artist = artistName(media.artist);
    if (!track) return;
    let cancelled = false;
    void window.notchApi
      ?.getYoutubeThumb(track, artist)
      .then((url) => {
        if (!cancelled) setYtThumb(url || "");
      })
      .catch(() => {
        if (!cancelled) setYtThumb("");
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, lyrics.state, mediaKey]);

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

  // 미디어가 없을 때 펼친 화면은 HUD만 보여준다. 시계와 CPU는 그때만 돈다.
  const [hudNow, setHudNow] = useState(() => Date.now());
  const [cpu, setCpu] = useState(0);
  const [gpu, setGpu] = useState<number | null>(null);
  const [ping, setPing] = useState(0);
  const [polls, setPolls] = useState(0);
  const [weather, setWeather] = useState<{ tempC: number; kind: string; city: string } | null>(null);

  useEffect(() => {
    if (!expanded || hasMedia) return;
    const id = window.setInterval(() => setHudNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [expanded, hasMedia]);

  useEffect(() => {
    if (!expanded || hasMedia || !window.notchApi) return;
    let cancelled = false;
    const read = () => {
      const startedAt = performance.now();
      void window.notchApi!
        .getStats()
        .then((stats) => {
          if (cancelled) return;
          setCpu(stats.cpu);
          setPing(Math.round(performance.now() - startedAt));
          setPolls((count) => count + 1);
        })
        .catch(() => undefined);
    };
    void read();
    const id = window.setInterval(read, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };  }, [expanded, hasMedia]);

  // 데스크탑의 HUD에서만 GPU를 읽고, 이전 조회가 끝난 뒤 다음 조회를 예약한다.
  useEffect(() => {
    if (!expanded || hasMedia || !battery || battery.hasBattery || !window.notchApi) return;
    let cancelled = false;
    let timer: number | undefined;
    const read = async () => {
      try {
        const value = await window.notchApi!.getGpu();
        if (!cancelled) setGpu(value);
      } catch {
        if (!cancelled) setGpu(null);
      }
      if (!cancelled) timer = window.setTimeout(read, 3000);
    };
    void read();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [expanded, hasMedia, battery?.hasBattery]);

  // 날씨는 미디어가 없는 HUD에서만, 10분 간격으로 읽는다.
  useEffect(() => {
    if (!expanded || hasMedia || !window.notchApi) return;
    let cancelled = false;
    const read = () => {
      void window.notchApi!
        .getWeather()
        .then((next) => {
          if (!cancelled) setWeather(next);
        })
        .catch(() => undefined);
    };
    void read();
    const id = window.setInterval(read, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [expanded, hasMedia]);

  // 배터리는 평소에 숨기고, 충전 중이거나 30% 이하일 때만 글자로 알린다.
  const lowBattery = !!battery?.hasBattery && !battery.charging && battery.percent <= 30;
  const footerLabel =
    battery && !battery.hasBattery
      ? "NOTCH"
      : battery?.hasBattery && battery.charging
        ? `CHARGE ${battery.percent}%`
        : lowBattery
          ? `LOW ${battery.percent}%`
          : "NOTCH-01";
  const collapsedBadge = !expanded && battery?.hasBattery ? (battery.charging ? "bolt" : lowBattery ? "LOW" : "") : "";
  const progress = media.duration > 0 ? Math.min(1, Math.max(0, livePosition / media.duration)) : 0;
  const hudDate = new Date(hudNow);
  const pad2 = (value: number) => String(value).padStart(2, "0");
  // 초는 따로 떼어 어둡게, 숫자는 세 칸 고정폭으로 흔들리지 않게.
  const hudHm = `${pad2(hudDate.getHours())}:${pad2(hudDate.getMinutes())}`;
  const hudSec = pad2(hudDate.getSeconds());
  const hudDay = `${hudDate.getFullYear()}.${pad2(hudDate.getMonth() + 1)}.${pad2(hudDate.getDate())} ${hudDate.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase()}`;
  const hudCpu = String(Math.round(cpu)).padStart(3, " ");
  const hudGpu = (gpu === null ? "--" : String(Math.round(gpu))).padStart(3, " ");
  const hudPing = String(ping).padStart(3, " ");
  const hudPolls = String(polls).padStart(3, " ");
  const cpuHot = cpu > 80;
  // 제목과 같은 앨범은 중복이라 메타 줄에서 뺀다.
  const metaAlbum =
    media.album && media.album !== media.title && media.album !== shownTitle ? media.album : "";
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
          : "";

  return (
    <div
      role="button"
      tabIndex={0}
      className={`notch ${expanded ? "is-expanded" : "is-collapsed"}${hasMedia ? " has-media" : ""}${media.status === "Playing" ? " is-playing" : ""}${collapsedBadge ? " has-status" : ""}`}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onToggle();
      }}
      aria-expanded={expanded}
      aria-label="Notch"
    >
      <span className="notch-body" />
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
      <span className="notch-title">{footerLabel}</span>
      {collapsedBadge === "bolt" ? (
        <span className="notch-bolt" aria-label="충전 중" />
      ) : collapsedBadge ? (
        <span className="notch-status">{collapsedBadge}</span>
      ) : null}
      <div className="notch-panel">
        {!hasMedia ? (
          <div className="notch-hud">
            <span className="notch-hud-top">
              <span className="notch-hud-clock">
                {hudHm}
                <span className="notch-hud-sec">:{hudSec}</span>
              </span>
              {weather && (
                <span className="notch-hud-weather">
                  {weather.city && <span className="notch-hud-city" title={weather.city}>{weather.city}</span>}
                  <span className="notch-hud-weather-reading">
                    <WeatherIcon kind={weather.kind} />
                    <span className="notch-hud-temp">{weather.tempC}°</span>
                  </span>
                </span>
              )}
            </span>
            <span className="notch-hud-date">{hudDay}</span>
            <span className="notch-hud-strip">
              <span className={`notch-hud-cpu${cpuHot ? " is-hot" : ""}`}>{`CPU ${hudCpu}%`}</span>
              {battery && !battery.hasBattery && <span>{`GPU ${hudGpu}%`}</span>}
              <span className="notch-hud-ping">{`PING ${hudPing}ms`}</span>
              <span>{`POLL ${hudPolls}`}</span>
            </span>
          </div>
        ) : (
          <>
        <div className="notch-info">
          <span className="notch-info-row">
            <span className="notch-eq" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="notch-stop" aria-hidden="true" />
            <span className="notch-info-title">{hasMedia ? shownTitle : "재생 중인 곡 없음"}</span>
          </span>
          {hasMedia && (displayArtist(media.artist) || metaAlbum) && (
            <span className="notch-info-meta">
              {[displayArtist(media.artist), metaAlbum].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
        <div className="notch-progress">
          <span className="notch-time">{hasMedia ? clock(livePosition) : "--:--"}</span>
          <span className="notch-seg" aria-label="재생 진행률">
            <span className="notch-seg-fill" style={{ transform: `scaleX(${progress})` }} />
            <span className="notch-seg-head" style={{ left: `${progress * 100}%` }} />
          </span>
          <span className="notch-time">{hasMedia ? clock(media.duration) : "--:--"}</span>
        </div>
        {hasSynced ? (
          <div className="notch-lyrics notch-lyrics-synced">
            <div key={activeLine} className="notch-line is-active">
              {lyrics.synced[activeLine]?.text || "\u00a0"}
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
          </>
        )}
      </div>
      <span className="notch-scan" />
    </div>
  );
}
