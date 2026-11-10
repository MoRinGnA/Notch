import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent } from "react";

interface NotchProps {
  expanded: boolean;
  onToggle: () => void;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
}

interface PendingPlay {
  app: string;
  title: string;
  status: "Playing" | "Paused";
  confirmedAfter: number | null;
  previous: NotchMedia;
}

interface Lyrics {
  state: "idle" | "loading" | "ready" | "missing" | "instrumental";
  text: string;
  // 싱크 가사: 줄별 시작 시각(초)과 텍스트. 없으면 빈 배열.
  synced: { time: number; text: string }[];
}

const MEDIA_POLL_MS = 2000;
const BATTERY_POLL_MS = 30000;
// 펼친 화면의 기본 폭(내비게이션 + 작업 영역).
const EXPANDED_WIDTH = 600;

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

type TimerMode = "timer" | "stopwatch" | "pomodoro";
type PomodoroPhase = "focus" | "break";

const POMODORO_FOCUS_MS = 25 * 60 * 1000;
const POMODORO_BREAK_MS = 5 * 60 * 1000;

// 스톱워치는 endsAt을 시작 시각으로 써서 경과 시간을 재고, 나머지는 종료 시각까지 남은 시간을 쓴다.
type TimerState =
  | { status: "idle" }
  | { status: "running"; mode: TimerMode; phase: PomodoroPhase; round: number; endsAt: number }
  | { status: "paused"; mode: TimerMode; phase: PomodoroPhase; round: number; remainingMs: number }
  | { status: "done"; mode: TimerMode; phase: PomodoroPhase; round: number };

type NotchView = "done" | "media" | "timer" | "hud" | "notes";
// 펼친 화면 왼쪽 내비게이션에서 고르는 영역.
type NotchNav = "now" | "timer" | "notes";

// 완료 알림은 항상 우선하고, 그 아래는 사용자가 고른 영역을 따른다.
function resolveView(timer: TimerState, hasMedia: boolean, playing: boolean, nav: NotchNav): NotchView {
  if (timer.status === "done") return "done";
  if (nav === "notes") return "notes";
  if (nav === "timer") return "timer";
  if (hasMedia && playing) return "media";
  if (timer.status !== "idle") return "timer";
  return hasMedia ? "media" : "hud";
}

// 메모 목록의 시각 표시. 오늘은 시:분, 지난 메모는 월.일.
function noteStamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  const today = new Date().toDateString() === date.toDateString();
  return today ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : `${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
}

function notePreview(text: string): string {
  const line = text.split("\n").find((row) => row.trim()) ?? "";
  return line.trim().slice(0, 42) || "빈 메모";
}

// 스톱워치는 지난 시간, 나머지는 남은 시간.
function timerSpan(timer: TimerState, now: number): number {
  if (timer.status === "running") {
    return timer.mode === "stopwatch" ? Math.max(0, now - timer.endsAt) : Math.max(0, timer.endsAt - now);
  }
  if (timer.status === "paused") return Math.max(0, timer.remainingMs);
  return 0;
}

function timerTag(timer: TimerState): string {
  if (timer.status !== "idle" && timer.mode === "pomodoro") return timer.phase === "focus" ? "FOCUS" : "BREAK";
  if (timer.status !== "idle" && timer.mode === "stopwatch") return "STOP";
  return "TIMER";
}

function timerChipLabel(timer: TimerState, clock: string): string {
  return `${timer.status === "paused" ? "Ⅱ " : ""}${timerTag(timer)} ${clock}`;
}

function timerDoneCaption(timer: TimerState): string {
  if (timer.status === "done" && timer.mode === "pomodoro") {
    return timer.phase === "focus"
      ? "Focus complete. Take a 5-minute break."
      : "Break complete. Ready for the next focus session?";
  }
  return "Time is up.";
}

function timerClock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

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
  if (match) return match[1].trim();
  // "아티스트 - 곡명" 형식. 뒤가 Live·Remix 같은 꼬리표면 곡명이 아니므로 두고,
  // "Drowning - Live"처럼 뒤가 수식어인 경우는 원래 제목을 그대로 쓴다.
  const dashed = cleaned.match(/^(.+?)\s+[-\u2013\u2014]\s+(.+)$/);
  if (dashed) {
    const tail = dashed[2].trim();
    const qualifier = /^(live|remix|inst|instrumental|version|edit|acoustic|cover|mv|m\/v|official|lyrics|가사|audio|feat\.?)\b/i.test(tail);
    if (!qualifier && tail.length >= 2) return tail;
  }
  return cleaned;
}

// 제목 앞의 "aespa 에스파 'Supernova' MV" 같은 구간은 아티스트다(채널명이 레이블일 때 대신 쓴다).
function titleArtist(title: string): string {
  const quoted = title.match(/^(.*?)["'‘’“”][^"'‘’“”]+["'‘’“”]/);
  if (!quoted) return "";
  return quoted[1].replace(/[\s\-–—:]+$/, "").trim();
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
    // 아티스트가 다르면 제목이 완전히 같고 재생 길이까지 맞을 때만 받아들인다.
    if (want !== got) return 0;
    if (mediaDuration > 0 && hit.duration && hit.duration > 0) {
      const diff = Math.abs(hit.duration - mediaDuration);
      if (diff > 40) return 0;
      return diff <= 5 ? 0.85 : 0.72;
    }
    return 0;
  }
  // 아티스트를 모를 때는 제목과 재생 길이로만 판단한다.
  if (mediaDuration > 0 && hit.duration && hit.duration > 0) {
    const diff = Math.abs(hit.duration - mediaDuration);
    if (diff > 40) return 0;
    if (want === got) return diff <= 5 ? 0.85 : 0.72;
    // "밤편지"처럼 제목이 다른 언어와 섞여 있어도 길이가 거의 같으면 받아들인다.
    return diff <= 5 ? 0.7 : 0;
  }
  return want === got ? 0.65 : 0;
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

type LrcHit = {
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
  instrumental?: boolean;
  trackName?: string;
  artistName?: string;
  duration?: number;
};

// 같은 곡이 원문(한글)과 로마자 표기로 따로 올라와 있으면 원문을 고른다.
const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/;
function lyricScript(hit: LrcHit): number {
  return HANGUL.test(hit.syncedLyrics || hit.plainLyrics || "") ? 1 : 0;
}

type Candidate = { score: number; hit: LrcHit; order: number };

// 점수가 같으면 한글 가사 > 줄별 시각이 있는 가사 > 재생 길이에 가까운 가사 순으로 고른다.
function betterHit(next: Candidate, current: Candidate, mediaDuration: number): boolean {
  if (next.score !== current.score) return next.score > current.score;
  const script = lyricScript(next.hit) - lyricScript(current.hit);
  if (script !== 0) return script > 0;
  const synced = Number(!!next.hit.syncedLyrics) - Number(!!current.hit.syncedLyrics);
  if (synced !== 0) return synced > 0;
  const gap = (hit: LrcHit) =>
    mediaDuration > 0 && hit.duration ? Math.abs(hit.duration - mediaDuration) : Number.POSITIVE_INFINITY;
  const nextGap = gap(next.hit);
  const currentGap = gap(current.hit);
  if (nextGap !== currentGap) return nextGap < currentGap;
  return next.order < current.order;
}

const lyricsCache = new Map<string, Lyrics>();
let lastLyricsAt = 0;

async function fetchLyrics(media: NotchMedia): Promise<Lyrics> {
  const track = trackName(media.title);
  // 채널명이 레이블이라 아티스트를 못 얻으면 제목 앞부분에서 가져온다.
  const artist = artistName(media.artist) || titleArtist(media.title);
  const key = `${track}|${artist}|${media.album}`;
  const cached = lyricsCache.get(key);
  if (cached) return cached;

  // LRCLIB에 연속으로 묻지 않도록 간격을 둔다.
  const throttle = async () => {
    const wait = lastLyricsAt + LYRICS_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastLyricsAt = Date.now();
  };
  await throttle();

  const headers = { "Lrclib-Client": "Notch/0.1" };
  const toResult = (data: LrcHit): Lyrics => {
    if (data.instrumental) return { state: "instrumental", text: "", synced: [] };
    const text = data.plainLyrics?.trim() || (data.syncedLyrics ? stripTimestamps(data.syncedLyrics) : "");
    const synced = data.syncedLyrics ? parseSynced(data.syncedLyrics) : [];
    return text ? { state: "ready", text, synced } : { state: "missing", text: "", synced: [] };
  };

  // 후보 비교는 콜백에서 갱신하므로 객체에 담아 둔다.
  const selection: { best: Candidate | null; exact: LrcHit | null } = { best: null, exact: null };
  const consider = (hit: LrcHit, order: number) => {
    if (hit.instrumental) return;
    if (!hit.plainLyrics?.trim() && !hit.syncedLyrics) return;
    const score = matchScore(hit, track, artist, media.duration);
    if (score < 0.6) return;
    const candidate: Candidate = { score, hit, order };
    const current = selection.best;
    if (!current || betterHit(candidate, current, media.duration)) selection.best = candidate;
  };

  let result: Lyrics = { state: "missing", text: "", synced: [] };
  try {
    // 1차: 정확한 제목·아티스트 조회
    const params = new URLSearchParams({ track_name: track, artist_name: artist });
    if (media.album) params.set("album_name", media.album);
    const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, { headers });
    if (res.ok) {
      const data = (await res.json()) as LrcHit;
      selection.exact = data;
      consider(data, 0);
    }
    // 2차: 같은 곡의 다른 판본까지 훑어 한글 원문이 있으면 그쪽을 쓴다.
    const queries = [...new Set([`${artist} ${track}`.trim(), track].filter((q) => q.length >= 2))];
    for (const [index, q] of queries.entries()) {
      // 이미 한글 가사가 잡혔으면 더 찾지 않는다.
      if (selection.best && lyricScript(selection.best.hit)) break;
      await throttle();
      const res2 = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, { headers });
      if (!res2.ok) continue;
      const list = (await res2.json()) as LrcHit[];
      for (const hit of list) consider(hit, index + 1);
    }
    const picked = selection.best?.hit ?? selection.exact;
    if (picked) result = toResult(picked);
  } catch {
    result = { state: "missing", text: "", synced: [] };
  }

  if (lyricsCache.size >= LYRICS_CACHE_LIMIT) lyricsCache.clear();
  lyricsCache.set(key, result);
  return result;
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

function extractMediaAccent(image: HTMLImageElement): string {
  try {
    if (!image.complete || !image.naturalWidth || !image.naturalHeight) return "#e8833a";
    const canvas = document.createElement("canvas");
    const side = 24;
    canvas.width = side;
    canvas.height = side;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return "#e8833a";
    context.drawImage(image, 0, 0, side, side);
    const { data } = context.getImageData(0, 0, side, side);
    const bins = new Map<number, { score: number; red: number; green: number; blue: number; weight: number }>();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const high = Math.max(r, g, b);
      const low = Math.min(r, g, b);
      const saturation = high === 0 ? 0 : (high - low) / high;
      const brightness = high / 255;
      if (brightness < 0.12) continue;
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      const weight = 0.25 + saturation;
      const bin = bins.get(key) ?? { score: 0, red: 0, green: 0, blue: 0, weight: 0 };
      bin.score += weight;
      bin.red += r * weight;
      bin.green += g * weight;
      bin.blue += b * weight;
      bin.weight += weight;
      bins.set(key, bin);
    }
    const dominant = [...bins.values()].sort((a, b) => b.score - a.score)[0];
    if (!dominant?.weight) return "#e8833a";
    // Use the most common saturated color bucket rather than the cover's potentially muddy average.
    const channels = [dominant.red, dominant.green, dominant.blue].map((sum) => Math.round(sum / dominant.weight));
    const [red, green, blue] = channels.map((channel) => channel / 255);
    const high = Math.max(red, green, blue);
    const low = Math.min(red, green, blue);
    const delta = high - low;
    if (high * 255 < 34 || delta * 255 < 18) return "#e8833a";

    // Lift dark cover colors in HSL so their hue survives but the accent stays legible on black.
    const lightness = (high + low) / 2;
    const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
    const rawHue = delta === 0
      ? 0
      : high === red
        ? 60 * (((green - blue) / delta) % 6)
        : high === green
          ? 60 * ((blue - red) / delta + 2)
          : 60 * ((red - green) / delta + 4);
    const hue = ((rawHue % 360) + 360) % 360;
    const liftedLightness = Math.max(lightness, 0.82);
    const chroma = (1 - Math.abs(2 * liftedLightness - 1)) * saturation;
    const huePart = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
    const offset = liftedLightness - chroma / 2;
    const lifted = hue < 60
      ? [chroma, huePart, 0]
      : hue < 120
        ? [huePart, chroma, 0]
        : hue < 180
          ? [0, chroma, huePart]
          : hue < 240
            ? [0, huePart, chroma]
            : hue < 300
              ? [huePart, 0, chroma]
              : [chroma, 0, huePart];
    const brightChannels = lifted.map((channel) => Math.round((channel + offset) * 255));
    return `#${brightChannels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    // Tainted or unsupported image sources fall back to the existing accent.
    return "#e8833a";
  }
}

export function Notch({ expanded, onToggle, onHoverStart, onHoverEnd }: NotchProps) {
  const notchRef = useRef<HTMLDivElement>(null);
  // 접힌 미디어 행: 곡 정보(왼쪽)와 현재 가사(오른쪽)
  const trackRef = useRef<HTMLSpanElement>(null);
  const lyricSizerRef = useRef<HTMLSpanElement>(null);
  // 곡에서 가장 긴 가사 줄에 맞춘 접힌 노치 폭. 가사가 없으면 null(내용 폭).
  const [collapsedWidth, setCollapsedWidth] = useState<number | null>(null);
  // 펼친 화면도 같은 가사 줄이 한 줄에 들어오도록 넓힌다.
  const lineMeasureRef = useRef<HTMLSpanElement>(null);
  const [expandedWidth, setExpandedWidth] = useState<number | null>(null);
  useEffect(() => {
    const notch = notchRef.current;
    if (!notch || !window.notchApi) return;
    const updateBounds = () => {
      const { x, y, width, height } = notch.getBoundingClientRect();
      window.notchApi?.setNotchBounds({ x, y, width, height });
    };
    const observer = new ResizeObserver(updateBounds);
    observer.observe(notch);
    updateBounds();
    return () => observer.disconnect();
  }, []);

  const [media, setMedia] = useState<NotchMedia>(EMPTY_MEDIA);
  const [mediaAccent, setMediaAccent] = useState("#e8833a");
  const [lyrics, setLyrics] = useState<Lyrics>({ state: "idle", text: "", synced: [] });
  const [now, setNow] = useState(() => Date.now());
  const [battery, setBattery] = useState<NotchBattery | null>(null);
  const [timer, setTimer] = useState<TimerState>({ status: "idle" });
  const [timerNow, setTimerNow] = useState(() => Date.now());
  const [timerMinutes, setTimerMinutes] = useState("25");
  const [timerMode, setTimerMode] = useState<TimerMode>("timer");
  // 펼친 화면의 현재 영역. 접힘/펼침과 무관하게 유지되지만, 접으면 NOW로 돌아간다.
  const [nav, setNav] = useState<NotchNav>("now");
  // 메모: 고정은 한 건만, 목록은 최근 수정 순서.
  const [notes, setNotes] = useState<NotchNote[]>([]);
  const [pinnedNoteId, setPinnedNoteId] = useState<string | null>(null);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteStatus, setNoteStatus] = useState<"idle" | "editing" | "saved">("idle");
  // 삭제는 한 번 더 확인해야 실행된다(실수로 지우는 것을 막는다).
  const [deleteArmed, setDeleteArmed] = useState(false);
  const noteSavedRef = useRef("");
  const noteDraftRef = useRef("");
  const activeNoteRef = useRef<string | null>(null);
  // 편집기를 바꿀 때마다 올린다. 늦게 끝난 저장이 다른 메모 화면을 덮지 않게 하는 표식.
  const noteSessionRef = useRef(0);
  noteDraftRef.current = noteDraft;
  activeNoteRef.current = activeNoteId;
  // 가사가 없을 때 채울 유튜브 썸네일(data URL). 없으면 빈 문자열.
  const [ytThumb, setYtThumb] = useState("");
  const mediaRef = useRef(media);
  // 이벤트 리스너가 처음 렌더링의 값을 붙들지 않도록 최신 화면 상태를 따로 둔다.
  const expandedRef = useRef(expanded);
  const navRef = useRef(nav);
  const mediaRequestRef = useRef(0);
  // 트레이에서 새 메모를 열었는지: 목록에서 다른 메모를 골라 덮지 않게 한다.
  const pendingNewNoteRef = useRef(false);
  const pendingPlayRef = useRef<PendingPlay | null>(null);
  const [playPending, setPlayPending] = useState(false);
  mediaRef.current = media;
  expandedRef.current = expanded;
  navRef.current = nav;

  // 명령 전에 시작된 조회와 늦게 도착한 응답이 새 상태를 덮지 않도록 한다.
  const readMedia = async () => {
    if (!window.notchApi) return;
    const request = ++mediaRequestRef.current;
    try {
      const next = await window.notchApi.getMedia();
      if (request !== mediaRequestRef.current) return;
      const pending = pendingPlayRef.current;
      if (pending) {
        const sameSession = next.active && next.app === pending.app && next.title === pending.title;
        if (pending.confirmedAfter !== null && sameSession && next.status === pending.status) {
          pendingPlayRef.current = null;
          setPlayPending(false);
        } else if (pending.confirmedAfter === null || Date.now() < pending.confirmedAfter) {
          return;
        } else {
          pendingPlayRef.current = null;
          setPlayPending(false);
        }
      }
      mediaRef.current = next;
      setMedia(next);
    } catch (error) {
      if (request === mediaRequestRef.current) {
        const pending = pendingPlayRef.current;
        if (pending && pending.confirmedAfter !== null && Date.now() >= pending.confirmedAfter) {
          pendingPlayRef.current = null;
          setPlayPending(false);
          mediaRef.current = pending.previous;
          setMedia(pending.previous);
        }
        console.warn("미디어 조회 실패:", error);
      }
    }
  };

  useEffect(() => {
    if (!window.notchApi) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await readMedia();
      if (!cancelled) timer = window.setTimeout(poll, MEDIA_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      mediaRequestRef.current++;
      window.clearTimeout(timer);
    };
  }, []);

  const loadNotes = async (): Promise<NotchNotesData | null> => {
    if (!window.notchApi) return null;
    try {
      const data = await window.notchApi.getNotes();
      setNotes(data.notes);
      setPinnedNoteId(data.pinnedId);
      return data;
    } catch (error) {
      console.warn("메모 조회 실패:", error);
      return null;
    }
  };

  // 지금 편집 중인 내용을 저장한다. 빈 새 메모는 만들지 않는다.
  // 저장이 끝나기 전에 다른 메모로 옮기거나 새 메모를 열 수 있으므로,
  // 돌아온 결과는 그때도 같은 편집기를 보고 있을 때만 화면에 반영한다.
  const flushNote = async () => {
    const api = window.notchApi;
    if (!api) return;
    const session = noteSessionRef.current;
    const text = noteDraftRef.current;
    const id = activeNoteRef.current;
    if (text === noteSavedRef.current) return;
    if (!id && !text.trim()) return;
    try {
      const saved = await api.saveNote({ id, text });
      if (session === noteSessionRef.current) {
        noteSavedRef.current = text;
        if (saved) {
          if (!id) {
            activeNoteRef.current = saved.id;
            setActiveNoteId(saved.id);
          }
          if (noteDraftRef.current === text) setNoteStatus("saved");
        }
      }
      const data = await api.getNotes();
      setNotes(data.notes);
      setPinnedNoteId(data.pinnedId);
    } catch (error) {
      console.warn("메모 저장 실패:", error);
    }
  };

  // 삭제 확인 상태는 3초 뒤 스스로 풀린다.
  useEffect(() => {
    if (!deleteArmed) return;
    const id = window.setTimeout(() => setDeleteArmed(false), 3000);
    return () => window.clearTimeout(id);
  }, [deleteArmed]);

  // 입력이 잠깐 멈추면 자동 저장한다.
  useEffect(() => {
    if (nav !== "notes" || noteDraft === noteSavedRef.current) return;
    const id = window.setTimeout(() => { void flushNote(); }, 600);
    return () => window.clearTimeout(id);
  }, [noteDraft, nav]);

  // 메모 화면을 벗어나는 순간 남은 입력을 저장한다.
  const previousNavRef = useRef<NotchNav>("now");
  useEffect(() => {
    if (previousNavRef.current === "notes" && nav !== "notes") void flushNote();
    previousNavRef.current = nav;
  }, [nav]);

  const openNote = (note: NotchNote) => {
    void flushNote();
    noteSessionRef.current++;
    setDeleteArmed(false);
    activeNoteRef.current = note.id;
    noteDraftRef.current = note.text;
    noteSavedRef.current = note.text;
    setActiveNoteId(note.id);
    setNoteDraft(note.text);
    setNoteStatus("idle");
  };

  // 새 메모는 빈 편집기로 시작하고, 기존 내용은 먼저 저장한다.
  const startNewNote = () => {
    void flushNote();
    noteSessionRef.current++;
    setDeleteArmed(false);
    // 메모 화면에 새로 들어올 때만 목록 선택을 건너뛰면 된다.
    pendingNewNoteRef.current = !(expandedRef.current && navRef.current === "notes");
    activeNoteRef.current = null;
    noteDraftRef.current = "";
    noteSavedRef.current = "";
    setActiveNoteId(null);
    setNoteDraft("");
    setNoteStatus("idle");
  };

  // 메모 화면에 들어오면 목록을 읽고, 이어 쓸 메모(고정 → 최근)를 고른다.
  useEffect(() => {
    if (!expanded || nav !== "notes") return;
    let cancelled = false;
    void (async () => {
      const data = await loadNotes();
      if (!data || cancelled) return;
      if (pendingNewNoteRef.current) {
        pendingNewNoteRef.current = false;
        return;
      }
      if (activeNoteRef.current && data.notes.some((note) => note.id === activeNoteRef.current)) return;
      const target = data.notes.find((note) => note.id === data.pinnedId) ?? data.notes[0];
      if (target) {
        activeNoteRef.current = target.id;
        noteDraftRef.current = target.text;
        noteSavedRef.current = target.text;
        setActiveNoteId(target.id);
        setNoteDraft(target.text);
      }
    })();
    return () => { cancelled = true; };
  }, [expanded, nav]);

  // 트레이의 `새 메모`는 노치를 펼치고 빈 메모 화면을 연다.
  useEffect(() => {
    return window.notchApi?.onNewNote(() => {
      setNav("notes");
      startNewNote();
    });
  }, []);

  const togglePinNote = () => {
    const api = window.notchApi;
    const id = activeNoteRef.current;
    if (!api || !id) return;
    void api.pinNote(pinnedNoteId === id ? null : id).then((data) => {
      setNotes(data.notes);
      setPinnedNoteId(data.pinnedId);
    }).catch((error: unknown) => console.warn("메모 고정 실패:", error));
  };

  const deleteActiveNote = () => {
    const api = window.notchApi;
    const id = activeNoteRef.current;
    if (!api || !id) {
      startNewNote();
      return;
    }
    noteSessionRef.current++;
    setDeleteArmed(false);
    void api.deleteNote(id).then((data) => {
      setNotes(data.notes);
      setPinnedNoteId(data.pinnedId);
      const next = data.notes[0];
      activeNoteRef.current = next?.id ?? null;
      noteDraftRef.current = next?.text ?? "";
      noteSavedRef.current = next?.text ?? "";
      setActiveNoteId(next?.id ?? null);
      setNoteDraft(next?.text ?? "");
      setNoteStatus("idle");
    }).catch((error: unknown) => console.warn("메모 삭제 실패:", error));
  };

  // 전원 전환은 즉시 반영하고, 잔량은 이벤트 직후와 주기적으로 다시 읽는다.
  useEffect(() => {
    if (!window.notchApi) return;
    let cancelled = false;
    let request = 0;
    const read = () => {
      const current = ++request;
      void window.notchApi!
        .getBattery()
        .then((b) => {
          if (!cancelled && current === request) setBattery(b);
        })
        .catch((error: unknown) => {
          // 일시적 조회 실패 시 마지막으로 확인한 상태를 유지한다.
          if (!cancelled && current === request) console.warn("배터리 조회 실패:", error);
        });
    };
    const unsubscribe = window.notchApi.onPowerChange((onBattery) => {
      setBattery((previous) =>
        previous?.hasBattery ? { ...previous, charging: !onBattery } : previous,
      );
      read();
    });
    read();
    const id = window.setInterval(read, BATTERY_POLL_MS);
    return () => {
      cancelled = true;
      unsubscribe();
      window.clearInterval(id);
    };
  }, []);

  // 종료 시각을 기준으로 계산하므로 절전이나 렌더링 지연 후에도 남은 시간이 맞는다.
  useEffect(() => {
    if (timer.status !== "running") return;
    const tick = () => {
      const current = Date.now();
      setTimerNow(current);
      // 스톱워치는 끝이 없으므로 완료로 넘기지 않는다.
      if (timer.mode === "stopwatch" || current < timer.endsAt) return;
      setTimer((previous) =>
        previous === timer
          ? { status: "done", mode: timer.mode, phase: timer.phase, round: timer.round }
          : previous,
      );
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [timer]);

  const startTimer = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const current = Date.now();
    setTimerNow(current);
    if (timerMode === "stopwatch") {
      setTimer({ status: "running", mode: "stopwatch", phase: "focus", round: 1, endsAt: current });
    } else if (timerMode === "pomodoro") {
      setTimer({ status: "running", mode: "pomodoro", phase: "focus", round: 1, endsAt: current + POMODORO_FOCUS_MS });
    } else {
      const minutes = Number(timerMinutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return;
      setTimer({ status: "running", mode: "timer", phase: "focus", round: 1, endsAt: current + minutes * 60000 });
    }
    setNav("timer");
  };

  // 포모도로는 완료 알림에서 다음 단계(휴식↔집중)를 직접 시작한다.
  const startPomodoroPhase = (phase: PomodoroPhase, round: number) => {
    const current = Date.now();
    setTimerNow(current);
    setTimer({
      status: "running",
      mode: "pomodoro",
      phase,
      round,
      endsAt: current + (phase === "focus" ? POMODORO_FOCUS_MS : POMODORO_BREAK_MS),
    });
    setNav("timer");
  };

  const pauseTimer = () => {
    if (timer.status !== "running") return;
    const current = Date.now();
    const remainingMs = timer.mode === "stopwatch" ? Math.max(0, current - timer.endsAt) : timer.endsAt - current;
    if (timer.mode === "stopwatch" || remainingMs > 0) {
      setTimer({ status: "paused", mode: timer.mode, phase: timer.phase, round: timer.round, remainingMs });
      return;
    }
    setTimer({ status: "done", mode: timer.mode, phase: timer.phase, round: timer.round });
  };

  const resumeTimer = () => {
    if (timer.status !== "paused") return;
    const current = Date.now();
    setTimerNow(current);
    setTimer({
      status: "running",
      mode: timer.mode,
      phase: timer.phase,
      round: timer.round,
      endsAt: timer.mode === "stopwatch" ? current - timer.remainingMs : current + timer.remainingMs,
    });
  };

  const clearTimer = () => {
    setTimer({ status: "idle" });
    setNav("now");
  };

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
  // 접힌 노치에도 현재 가사를 보여줘야 하므로 펼침 여부와 무관하게 미리 불러온다.
  useEffect(() => {
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
  }, [mediaKey]);

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
    if (!window.notchApi || pendingPlayRef.current) return;
    const current = mediaRef.current;
    const target = { app: current.app, title: current.title };
    // 현재 실행 중인 조회는 제어 이전의 응답이므로 폐기한다.
    mediaRequestRef.current++;
    let pending: PendingPlay | null = null;
    const command = action === "Play" && current.status === "Playing" ? "Pause" : action;
    if (action === "Play") {
      const nowMs = Date.now();
      const playing = current.status === "Playing";
      const position = playing && current.updatedAt > 0
        ? Math.min(current.duration, current.position + Math.max(0, (nowMs - current.updatedAt) / 1000))
        : current.position;
      pending = { ...target, status: playing ? "Paused" : "Playing", confirmedAfter: null, previous: current };
      pendingPlayRef.current = pending;
      setPlayPending(true);
      const optimistic = { ...current, status: pending.status, position, updatedAt: nowMs };
      mediaRef.current = optimistic;
      setMedia(optimistic);
    }
    void window.notchApi.controlMedia(command, target).then((success) => {
      if (pending && pendingPlayRef.current === pending) {
        if (success) pending.confirmedAfter = Date.now() + 5000;
        else {
          pendingPlayRef.current = null;
          setPlayPending(false);
        }
      }
      if (!success) console.warn("미디어 제어 요청을 처리하지 못했습니다.");
      void readMedia();
    }).catch((error: unknown) => {
      if (pending && pendingPlayRef.current === pending) {
        pendingPlayRef.current = null;
        setPlayPending(false);
      }
      console.warn("미디어 제어 실패:", error);
      void readMedia();
    });
  };

  const hasMedia = media.active && media.title.length > 0;
  const shownTitle = cleanTitle(media.title);
  // 표지가 있는 한 일시정지 중에도 그 곡의 대표색을 유지한다. 미디어가 사라질 때만 기본색으로 돌아간다.
  const mediaAccentSource = hasMedia ? media.thumbnail : "";

  useEffect(() => {
    let cancelled = false;
    if (!mediaAccentSource) {
      setMediaAccent("#e8833a");
      return;
    }
    const image = new Image();
    image.onload = () => {
      if (!cancelled) setMediaAccent(extractMediaAccent(image));
    };
    image.onerror = () => {
      if (!cancelled) setMediaAccent("#e8833a");
    };
    image.src = mediaAccentSource;
    if (image.complete && image.naturalWidth > 0) setMediaAccent(extractMediaAccent(image));
    return () => {
      cancelled = true;
    };
  }, [mediaAccentSource]);
  const view = resolveView(timer, hasMedia, media.status === "Playing", nav);
  const timerActive = timer.status === "running" || timer.status === "paused";
  const timerLabel = timerClock(timerSpan(timer, timerNow));
  const timerChip = timerChipLabel(timer, timerLabel);
  const timerCaption =
    timer.status === "idle"
      ? ""
      : timer.mode === "pomodoro"
        ? `${timer.phase === "focus" ? "Focus" : "Break"} · Round ${timer.round}`
        : timer.mode === "stopwatch"
          ? "Elapsed time"
          : "Timer running";

  // 접으면 NOW로 돌아간다(타이머가 살아 있으면 view가 다시 타이머를 고른다).
  useEffect(() => {
    if (!expanded) setNav("now");
  }, [expanded]);

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
  const collapsedBadge = battery?.hasBattery ? (battery.charging ? "bolt" : lowBattery ? "LOW" : "") : "";
  // 미디어를 펼친 화면에서는 NOTCH 문구를 빼고, 충전·배터리 부족일 때만 그 자리에 쓴다.
  const footerText =
    expanded && view === "media" && !(battery?.hasBattery && (battery.charging || lowBattery))
      ? ""
      : footerLabel;
  // 펼친 내비게이션 위쪽에 같은 문구가 있으므로, 아래에는 충전·부족 알림만 남긴다.
  const navFooter = battery?.hasBattery && (battery.charging || lowBattery) ? footerLabel : "";
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
  // 접힌 노치 오른쪽에 보여줄 현재 가사 한 줄. 빈 줄(간주)에서는 직전 가사를 유지한다.
  const collapsedLyric = (() => {
    if (!hasSynced) return "";
    for (let i = Math.min(Math.max(0, activeLine), lyrics.synced.length - 1); i >= 0; i--) {
      const text = lyrics.synced[i].text.trim();
      if (text) return text;
    }
    return "";
  })();
  const widestLyric = hasSynced
    ? lyrics.synced.reduce((longest, line) => (line.text.length > longest.length ? line.text : longest), "")
    : "";
  // 빛은 그 가사 줄이 화면에 머무는 동안 왼쪽에서 오른쪽으로 정확히 한 번 지나간다.
  const activeLineTime = hasSynced ? lyrics.synced[activeLine]?.time ?? 0 : 0;
  const nextLineTime = hasSynced ? lyrics.synced[activeLine + 1]?.time : undefined;
  const lineEndTime = nextLineTime ?? (media.duration > activeLineTime ? media.duration : activeLineTime + 4);
  const lineSpan = Math.min(12, Math.max(0.6, lineEndTime - activeLineTime));
  // 이미 줄 중간이면 그만큼 앞선 지점에서 시작해 빛과 가사가 어긋나지 않게 한다.
  const lineElapsed = Math.min(lineSpan, Math.max(0, livePosition - activeLineTime));
  const shineProgress = lineSpan > 0 ? Math.min(1, Math.max(0, lineElapsed / lineSpan)) : 1;
  // 줄 시작에 왼쪽 끝(75%), 줄이 끝나면 오른쪽 끝(25%)에 빛이 닿는다.
  const shinePosition = `${(75 - 50 * shineProgress).toFixed(2)}% 0`;
  // 접힌 가사에도 같은 빛살을 흘린다. 빈 줄(간주)에서는 이전 가사가 남아 있으므로 빛은 두지 않는다.
  const collapsedShine = hasSynced && !!lyrics.synced[activeLine]?.text && !!collapsedLyric;

  // 곡이 바뀔 때 가장 긴 가사 줄이 들어갈 만큼만 노치를 넓히고, 곡이 끝날 때까지 폭을 유지한다.
  useEffect(() => {
    if (!collapsedLyric) {
      setCollapsedWidth(null);
      return;
    }
    // 펼치는 동안에는 접힌 폭을 그대로 두어 넓어지는 시작점으로 쓴다.
    if (expanded) return;
    const notch = notchRef.current;
    const track = trackRef.current;
    const sizer = lyricSizerRef.current;
    if (!notch || !track || !sizer) return;
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      const style = getComputedStyle(notch);
      const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      // 곡 정보 시작점부터 가장 긴 가사 끝까지. 구분선과 칸 사이 간격도 그대로 포함된다.
      const content = sizer.getBoundingClientRect().right - track.getBoundingClientRect().left;
      const width = Math.ceil(content + padding);
      setCollapsedWidth((previous) => (previous === width ? previous : width));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    observer.observe(sizer);
    void document.fonts.ready.then(measure);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [expanded, collapsedLyric, widestLyric, shownTitle, timerActive, collapsedBadge]);

  // 펼친 화면: 가장 긴 가사 줄이 두 줄로 접히지 않을 만큼만 넓힌다(좌우 여백 56 + 여유).
  useEffect(() => {
    if (!expanded || view !== "media" || !hasSynced || !widestLyric) {
      setExpandedWidth(null);
      return;
    }
    const measure = lineMeasureRef.current;
    if (!measure) return;
    let cancelled = false;
    const update = () => {
      if (cancelled) return;
      // 내비게이션과 좌우 여백을 포함한 폭. 가사가 길면 여기서 늘어난다.
      setExpandedWidth(Math.min(860, Math.max(EXPANDED_WIDTH, Math.ceil(measure.offsetWidth + 200))));
    };
    update();
    void document.fonts.ready.then(update);
    return () => {
      cancelled = true;
    };
  }, [expanded, view, hasSynced, widestLyric]);

  // 미디어 가사 외의 화면(타이머/HUD)에서는 긴 가사 폭을 물려받지 않고 기본 폭으로 돌아온다.
  const notchWidth = expanded
    ? view === "media" && hasSynced && widestLyric
      ? expandedWidth ?? EXPANDED_WIDTH
      : EXPANDED_WIDTH
    : collapsedWidth;

  // 내비게이션에서 지금 영역을 표시한다(완료 화면은 타이머로 본다).
  const navActive: NotchNav = view === "notes" ? "notes" : view === "timer" || view === "done" ? "timer" : "now";
  // 고정한 메모는 목록 맨 위에 두어 항상 바로 보이게 한다.
  const orderedNotes = pinnedNoteId
    ? [...notes].sort((a, b) => Number(b.id === pinnedNoteId) - Number(a.id === pinnedNoteId))
    : notes;
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
      ref={notchRef}
      role="button"
      tabIndex={0}
      className={`notch ${expanded ? "is-expanded" : "is-collapsed"}${view === "media" ? " has-media" : ""}${media.status === "Playing" ? " is-playing" : ""}${!expanded && collapsedBadge ? " has-status" : ""}${timerActive && view === "media" ? " has-timer" : ""}`}
      style={{
        ...(notchWidth ? { width: `${notchWidth}px` } : {}),
        "--media-accent": mediaAccent,
      } as CSSProperties}
      onClick={onToggle}
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onToggle();
        }
      }}
      aria-expanded={expanded}
      aria-label="Notch"
    >
      <span className="notch-body" />
      {view === "done" ? (
        <span className="notch-collapsed-timer is-done" role="status">{`${timerTag(timer)} DONE`}</span>
      ) : view === "timer" && timerActive ? (
        <span className={`notch-collapsed-timer${timer.status === "paused" ? " is-paused" : ""}`}>{timerChip}</span>
      ) : view === "media" ? (
        <span className={`notch-now${collapsedLyric ? " has-lyric" : ""}`}>
          <span ref={trackRef} className="notch-now-track">
            {media.artist && <span className="notch-now-artist">{displayArtist(media.artist)}</span>}
            <ScrollingTitle text={shownTitle} className="notch-now-title" />
          </span>
          {collapsedLyric && <span className="notch-now-rule" aria-hidden="true" />}
          {collapsedLyric && (
            <span className="notch-now-lyric">
              <span ref={lyricSizerRef} className="notch-now-lyric-sizer" aria-hidden="true">{widestLyric}</span>
              <span className="notch-now-lyric-line">
                {collapsedLyric}
                {collapsedShine && (
                  <span
                    key={activeLine}
                    className="notch-now-shine"
                    aria-hidden="true"
                    style={{ maskPosition: shinePosition, WebkitMaskPosition: shinePosition }}
                  >
                    {collapsedLyric}
                  </span>
                )}
              </span>
            </span>
          )}
        </span>
      ) : (
        <span className="notch-eyes">
          <span className="notch-eye" />
          <span className="notch-eye" />
        </span>
      )}
      {view === "media" && timerActive && (
        <span className={`notch-timer-chip${timer.status === "paused" ? " is-paused" : ""}`}>{timerChip}</span>
      )}
      {footerText && <span className={`notch-title${lowBattery ? " is-low" : ""}`}>{footerText}</span>}
      {collapsedBadge === "bolt" ? (
        <span className="notch-bolt" aria-label="충전 중" />
      ) : collapsedBadge ? (
        <span className={`notch-status${lowBattery ? " is-low" : ""}`}>{collapsedBadge}</span>
      ) : null}
      {/* 접힌 동안에는 패널 안의 버튼·입력이 탭으로 잡히지 않게 inert를 준다. */}
      <div className="notch-panel" inert={!expanded}>
        <nav className="notch-nav" aria-label="Notch sections">
          <span className="notch-nav-brand">NOTCH-01</span>
          <button
            type="button"
            className={`notch-nav-item${navActive === "now" ? " is-on" : ""}`}
            aria-pressed={navActive === "now"}
            onClick={(e) => { e.stopPropagation(); setNav("now"); }}
          >
            NOW
          </button>
          <button
            type="button"
            className={`notch-nav-item${navActive === "timer" ? " is-on" : ""}`}
            aria-pressed={navActive === "timer"}
            onClick={(e) => { e.stopPropagation(); setNav("timer"); }}
          >
            TIMER
          </button>
          <button
            type="button"
            className={`notch-nav-item${navActive === "notes" ? " is-on" : ""}`}
            aria-pressed={navActive === "notes"}
            onClick={(e) => { e.stopPropagation(); setNav("notes"); }}
          >
            NOTES
          </button>
          <span className={`notch-nav-foot${lowBattery ? " is-low" : ""}`}>{navFooter}</span>
        </nav>
        <div className="notch-main">
        {view === "notes" ? (
          <div className="notch-notes">
            <div className="notch-notes-list">
              <span className="notch-notes-head">NOTES</span>
              <div className="notch-notes-rows">
                {orderedNotes.map((note) => (
                  <button
                    key={note.id}
                    type="button"
                    className={`notch-note-row${note.id === activeNoteId ? " is-on" : ""}`}
                    onClick={(e) => { e.stopPropagation(); openNote(note); }}
                  >
                    <span className="notch-note-stamp">{noteStamp(note.updatedAt)}</span>
                    <span className="notch-note-preview">{notePreview(note.text)}</span>
                    {note.id === pinnedNoteId && <span className="notch-note-pin">PIN</span>}
                  </button>
                ))}
                {notes.length === 0 && <span className="notch-notes-empty">새 메모를 적어 두세요.</span>}
              </div>
              <button
                type="button"
                className="notch-note-new"
                onClick={(e) => { e.stopPropagation(); startNewNote(); }}
              >
                + NEW
              </button>
            </div>
            <div className="notch-notes-editor" onClick={(e) => e.stopPropagation()}>
              <textarea
                className="notch-note-input"
                value={noteDraft}
                onChange={(e) => { setNoteDraft(e.target.value); setNoteStatus("editing"); }}
                placeholder="메모"
                spellCheck={false}
              />
              <div className="notch-note-bar">
                <span className={`notch-note-state${noteStatus === "saved" ? " is-saved" : ""}`}>
                  {noteStatus === "saved" ? "SAVED" : noteStatus === "editing" ? "EDITING" : ""}
                </span>
                <button type="button" className="notch-btn" onClick={togglePinNote} disabled={!activeNoteId}>
                  {activeNoteId && pinnedNoteId === activeNoteId ? "UNPIN" : "PIN"}
                </button>
                <button
                  type="button"
                  className={`notch-btn${deleteArmed ? " is-armed" : ""}`}
                  onClick={() => {
                    if (!deleteArmed) {
                      setDeleteArmed(true);
                      return;
                    }
                    deleteActiveNote();
                  }}
                  disabled={!activeNoteId}
                >
                  {deleteArmed ? "SURE?" : "DELETE"}
                </button>
              </div>
            </div>
          </div>
        ) : view === "done" ? (
          <div className="notch-timer-panel" role="status">
            <span className="notch-timer-done">{`${timerTag(timer)} DONE`}</span>
            <span className="notch-timer-caption">{timerDoneCaption(timer)}</span>
            <div className="notch-controls">
              {timer.status === "done" && timer.mode === "pomodoro" && (
                <button
                  type="button"
                  className="notch-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (timer.phase === "focus") startPomodoroPhase("break", timer.round);
                    else startPomodoroPhase("focus", timer.round + 1);
                  }}
                >
                  {timer.phase === "focus" ? "Start break" : "Start focus"}
                </button>
              )}
              <button type="button" className="notch-btn" onClick={(e) => { e.stopPropagation(); clearTimer(); }}>Dismiss</button>
            </div>
          </div>
        ) : view === "timer" ? (
          <div className="notch-timer-panel" onClick={(e) => {
            if (!timerActive || (e.target as HTMLElement).closest("button, input, label")) e.stopPropagation();
          }}>
            {timerActive ? (
              <>
                <span className={`notch-timer-caption${timer.status === "running" ? " is-live" : ""}`}>{timer.status === "paused" ? `Paused · ${timerCaption}` : timerCaption}</span>
                <span className="notch-timer-clock">{timerLabel}</span>
                <div className="notch-controls">
                  {timer.status === "running" ? (
                    <button type="button" className="notch-btn" onClick={pauseTimer}>Pause</button>
                  ) : (
                    <button type="button" className="notch-btn" onClick={resumeTimer}>Resume</button>
                  )}
                  <button type="button" className="notch-btn" onClick={clearTimer}>Cancel</button>

                </div>
              </>
            ) : (
              <form className="notch-timer-form" onSubmit={startTimer}>
                <div className="notch-modes" role="group" aria-label="Timer mode">
                  {([
                    ["timer", "Timer"],
                    ["stopwatch", "Stopwatch"],
                    ["pomodoro", "Pomodoro"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`notch-mode${timerMode === value ? " is-on" : ""}`}
                      aria-pressed={timerMode === value}
                      onClick={(e) => { e.stopPropagation(); setTimerMode(value); }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {timerMode === "timer" ? (
                  <>
                    <label htmlFor="timer-minutes">Timer duration (minutes)</label>
                    <input id="timer-minutes" type="number" min="1" max="1440" step="1" required value={timerMinutes} onChange={(e) => setTimerMinutes(e.target.value)} />
                  </>
                ) : (
                  <span className="notch-timer-caption">
                    {timerMode === "pomodoro" ? "25 min focus · 5 min break" : "Counting up from 0:00"}
                  </span>
                )}
                <div className="notch-controls">
                  <button type="submit" className="notch-btn is-start">Start</button>
                </div>
              </form>
            )}
          </div>
        ) : view === "hud" ? (
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
            <ScrollingTitle text={shownTitle} className="notch-info-title" />
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
        {hasSynced && (
          <span ref={lineMeasureRef} className="notch-line-measure" aria-hidden="true">{widestLyric}</span>
        )}
        <div className="notch-controls">
          <button type="button" className="notch-btn" onClick={control("Previous")} disabled={playPending || !media.canPrev} aria-label="이전">
            PREV
          </button>
          <button type="button" className="notch-btn" onClick={control("Play")} disabled={playPending || !media.canPlayPause} aria-label="재생/일시정지">
            {media.status === "Playing" ? "PAUSE" : "PLAY"}
          </button>
          <button type="button" className="notch-btn" onClick={control("Next")} disabled={playPending || !media.canNext} aria-label="다음">
            NEXT
          </button>
        </div>
          </>
        )}
        </div>
      </div>
      <span className="notch-scan" />
    </div>
  );
}
