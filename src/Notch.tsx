import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";

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
// 펼친 화면의 기본 폭(HUD 또는 미디어 패널).
const EXPANDED_WIDTH = 600;

const LYRICS_GAP_MS = 300;
const LYRICS_CACHE_LIMIT = 50;

const EMPTY_MEDIA: NotchMedia = {
  active: false,
  id: "",
  sources: [],
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

type NotchView = "media" | "hud";

function resolveView(hasMedia: boolean): NotchView {
  return hasMedia ? "media" : "hud";
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

// NOW 화면의 소스 버튼에 쓸 짧은 앱 이름. AUMID 꼬리와 .exe를 떼고 알아보기 쉬운 이름으로 바꾼다.
const MEDIA_APP_NAMES: Record<string, string> = {
  chrome: "CHROME", msedge: "EDGE", whale: "WHALE", firefox: "FIREFOX", brave: "BRAVE",
  opera: "OPERA", vivaldi: "VIVALDI", chromium: "CHROMIUM", arc: "ARC", spotify: "SPOTIFY",
};
function mediaAppName(app: string): string {
  const target = app.includes("!") ? app.split("!").pop() ?? app : app;
  const file = target.split(/[\\/]/).pop() ?? target;
  let base = file.replace(/\.exe$/i, "");
  // com.example.app 같은 AUMID는 마지막 조각이 알아보기 쉽다.
  if (!/[\\/]/.test(app) && base.includes(".")) base = base.split(".").pop() ?? base;
  const key = base.toLowerCase();
  return (MEDIA_APP_NAMES[key] ?? base.toUpperCase()).slice(0, 18);
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

// 미디어 키·다른 앱의 볼륨 변경도 놓치지 않을 만큼 짧게 확인한다.
const VOLUME_POLL_MS = 300;
// 10%마다 눈금을 세우고, 50%마다 길게 세워 값을 눈으로 어림하기 쉽게 한다.
const VOLUME_TICKS = Array.from({ length: 11 }, (_, index) => index * 10);

// 시스템 마스터 볼륨. 부드러운 프로그래스 바 대신, 눈금 셀 사다리·커서·반전 플레이트로 값을 읽는 계기판.
function VolumeDeck({ active, onOpenMixer }: { active: boolean; onOpenMixer?: () => void }) {
  const [volume, setVolume] = useState<NotchVolume | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  // 끄는 동안에는 폴링 결과가 손가락 위치를 덮지 않도록 마지막 값을 여기에 둔다.
  const volumeRef = useRef<NotchVolume | null>(null);
  const draggingRef = useRef(false);
  const readRef = useRef(0);
  // 조작 직전에 시작된 조회가 돌아와 방금 바꾼 값을 되돌리지 않도록 세대 번호로 막는다.
  const writeSeq = useRef(0);
  const writesInFlight = useRef(0);
  const writeTimer = useRef<number | null>(null);
  const queuedLevel = useRef<number | null>(null);

  const read = async () => {
    const api = window.notchApi;
    if (!api) return;
    const request = ++readRef.current;
    const seq = writeSeq.current;
    try {
      const next = await api.getVolume();
      if (request !== readRef.current || draggingRef.current || seq !== writeSeq.current) return;
      // 잠깐 값을 못 읽었을 때 화면을 비우지 않고 마지막 값을 유지한다.
      if (!next) return;
      volumeRef.current = next;
      setVolume(next);
    } catch {
      // 잠깐 읽지 못하면 마지막으로 확인한 값을 그대로 둔다.
    }
  };

  // 펼친 동안에만 읽고 쓴다. 접힌 노치가 조용히 PowerShell을 붙들고 있지 않게 한다.
  // 미디어 키나 다른 앱이 볼륨을 바꿔도 바로 따라오도록 짧게 돈다.
  useEffect(() => {
    if (!active) return;
    void read();
    const id = window.setInterval(() => {
      // 끄는 중이거나 시스템에 쓰는 중이면 잠시 건너뛰고, 쓰기가 끝나면 바로 다시 읽는다.
      if (draggingRef.current || writesInFlight.current > 0 || queuedLevel.current !== null) return;
      void read();
    }, VOLUME_POLL_MS);
    return () => {
      window.clearInterval(id);
      readRef.current++;
    };
  }, [active]);

  // 시스템에 쓰는 동안에는 조회를 멈춘다. 늦게 도착한 옛 값이 방금 바꾼 값을 되돌리지 않게.
  const runWrite = (task: (api: NonNullable<Window["notchApi"]>) => Promise<boolean>) => {
    const api = window.notchApi;
    if (!api) return;
    writesInFlight.current++;
    void task(api)
      .catch(() => undefined)
      .finally(() => {
        writesInFlight.current--;
        if (!writesInFlight.current && queuedLevel.current === null) void read();
      });
  };

  useEffect(() => {
    return () => {
      if (writeTimer.current) window.clearTimeout(writeTimer.current);
      const last = queuedLevel.current;
      queuedLevel.current = null;
      if (last !== null) void window.notchApi?.setVolume(last).catch(() => undefined);
    };
  }, []);

  // 끄는 동안 매 픽셀마다 IPC를 보내지 않고 마지막 값만 묶어서 보낸다.
  const sendLevel = (level: number) => {
    queuedLevel.current = level;
    if (writeTimer.current) return;
    writeTimer.current = window.setTimeout(() => {
      writeTimer.current = null;
      const value = queuedLevel.current;
      queuedLevel.current = null;
      if (value === null) return;
      runWrite((api) => api.setVolume(value));
    }, 60);
  };

  const apply = (level: number) => {
    const current = volumeRef.current;
    if (!current) return;
    writeSeq.current++;
    const next = { level, muted: false };
    volumeRef.current = next;
    setVolume(next);
    sendLevel(level);
    // 음소거 상태에서 볼륨을 만지면 Windows처럼 소리를 되살린다.
    if (current.muted) runWrite((api) => api.setMuted(false));
  };

  const toggleMute = () => {
    const current = volumeRef.current;
    if (!current) return;
    writeSeq.current++;
    const next = { ...current, muted: !current.muted };
    volumeRef.current = next;
    setVolume(next);
    runWrite((api) => api.setMuted(next.muted));
  };

  const levelAt = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const ratio = (clientX - rect.left) / Math.max(1, rect.width);
    return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  };

  const startDrag = (event: PointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    if (!volumeRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    setDragging(true);
    setHover(null);
    apply(levelAt(event.clientX));
  };

  const moveDrag = (event: PointerEvent<HTMLSpanElement>) => {
    if (draggingRef.current) {
      event.stopPropagation();
      apply(levelAt(event.clientX));
      return;
    }
    if (!volumeRef.current) return;
    setHover(levelAt(event.clientX));
  };

  const endDrag = (event: PointerEvent<HTMLSpanElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    const track = event.currentTarget;
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    // 묶어 보낸 값이 시스템에 닿은 뒤에 실제 값을 다시 읽어 맞춘다.
    window.setTimeout(() => {
      if (!draggingRef.current) void read();
    }, 220);
  };

  const handleKey = (event: KeyboardEvent<HTMLSpanElement>) => {
    const current = volumeRef.current;
    if (!current) return;
    const step = event.shiftKey ? 10 : 2;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      apply(Math.min(100, current.level + step));
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      apply(Math.max(0, current.level - step));
    } else if (event.key === "Home") {
      event.preventDefault();
      apply(0);
    } else if (event.key === "End") {
      event.preventDefault();
      apply(100);
    } else if (event.key === "m" || event.key === "M") {
      event.preventDefault();
      event.stopPropagation();
      toggleMute();
    }
  };

  const level = volume?.level ?? 0;
  const muted = volume?.muted ?? false;
  // 마우스로 훑는 동안에는 실제 값과 목표 값 사이를 미리 보여준다.
  const preview = !dragging && hover !== null && volume !== null && hover !== level ? hover : null;
  const readout = volume === null ? "---" : String(preview ?? level).padStart(3, "0");

  return (
    <div
      className={`notch-vol${muted ? " is-muted" : ""}${dragging ? " is-live" : ""}${volume === null ? " is-off" : ""}`}
      onClick={(event) => event.stopPropagation()}
    >
      {/* 라벨이 곧 앱별 볼륨으로 들어가는 문이다(눌러서 열고, 끄는 건 레일에서). */}
      {onOpenMixer ? (
        <button
          type="button"
          className="notch-vol-label"
          title="앱별 볼륨 열기"
          aria-label="앱별 볼륨 열기"
          onClick={(event) => {
            event.stopPropagation();
            onOpenMixer();
          }}
        >
          VOL
        </button>
      ) : (
        <span className="notch-vol-label">VOL</span>
      )}
      <span
        ref={trackRef}
        className="notch-vol-track"
        role="slider"
        tabIndex={volume === null ? -1 : 0}
        aria-label="시스템 볼륨"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={level}
        aria-valuetext={volume === null ? "사용할 수 없음" : muted ? "음소거됨" : `${level}%`}
        aria-disabled={volume === null}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHover(null)}
        onKeyDown={handleKey}
      >
        <span className="notch-vol-rail" aria-hidden="true" />
        <span className="notch-vol-fill" aria-hidden="true" style={{ width: `${level}%` }} />
        <span className="notch-vol-ticks" aria-hidden="true">
          {VOLUME_TICKS.map((tick) => (
            <span
              key={tick}
              className={`notch-vol-tick${tick % 50 === 0 ? " is-major" : ""}`}
              style={{ left: `${tick}%` }}
            />
          ))}
        </span>
        {preview !== null && (
          <span className="notch-vol-ghost" aria-hidden="true" style={{ left: `${preview}%` }} />
        )}
        {volume !== null && (
          <span className="notch-vol-cursor" aria-hidden="true" style={{ left: `${level}%` }} />
        )}
      </span>
      <span className={`notch-vol-value${muted ? " is-muted" : ""}${preview !== null ? " is-target" : ""}`}>
        {readout}
      </span>
      <button
        type="button"
        className={`notch-vol-mute${muted ? " is-on" : ""}`}
        aria-pressed={muted}
        aria-label={muted ? "음소거 해제" : "음소거"}
        title={muted ? "음소거 해제 (M)" : "음소거 (M)"}
        disabled={volume === null}
        onClick={(event) => {
          event.stopPropagation();
          toggleMute();
        }}
      >
        M
      </button>
    </div>
  );
}

// 한 줄짜리 음량 계기판. MASTER와 앱이 같은 모양을 쓰고, 구분선 위/아래 위치로 위계를 보여 준다.
function MixRow({
  label,
  level: rawLevel,
  muted,
  master = false,
  unavailable = false,
  peak,
  onLevel,
  onMute,
  onBusy,
}: {
  label: string;
  level: number;
  muted: boolean;
  master?: boolean;
  unavailable?: boolean;
  // 0~1 사이의 순간 피크. 넘기지 않으면 미터를 그리지 않는다(MASTER 줄).
  peak?: number;
  onLevel: (level: number) => void;
  onMute: (muted: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const trackRef = useRef<HTMLSpanElement>(null);
  const draggingRef = useRef(false);
  const level = Math.max(0, Math.min(100, rawLevel));
  // 빠르게 연속으로 눌러도 한 번에 한 칸씩 오르도록 마지막 값을 따로 들고 있다.
  const levelRef = useRef(level);
  levelRef.current = level;
  const step = (next: number) => {
    const value = Math.max(0, Math.min(100, next));
    levelRef.current = value;
    onLevel(value);
  };

  const levelAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return level;
    const ratio = (clientX - rect.left) / Math.max(1, rect.width);
    return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  };

  const startDrag = (event: PointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    onBusy(true);
    onLevel(levelAt(event.clientX));
  };

  const moveDrag = (event: PointerEvent<HTMLSpanElement>) => {
    if (!draggingRef.current) return;
    event.stopPropagation();
    onLevel(levelAt(event.clientX));
  };

  const endDrag = (event: PointerEvent<HTMLSpanElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    onBusy(false);
    const track = event.currentTarget;
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
  };

  const handleKey = (event: KeyboardEvent<HTMLSpanElement>) => {
    const delta = event.shiftKey ? 10 : 2;
    const keys = ["ArrowRight", "ArrowUp", "ArrowLeft", "ArrowDown", "Home", "End", "m", "M"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "ArrowRight" || event.key === "ArrowUp") step(levelRef.current + delta);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") step(levelRef.current - delta);
    else if (event.key === "Home") step(0);
    else if (event.key === "End") step(100);
    else onMute(!muted);
  };

  return (
    <div
      className={`notch-mix-row${master ? " is-master" : ""}${muted ? " is-muted" : ""}${unavailable ? " is-off" : ""}`}
      onClick={(event) => event.stopPropagation()}
    >
      <span className="notch-mix-name" title={label}>{label}</span>
      {peak === undefined ? null : (
        <span
          className="notch-mix-peak"
          aria-hidden="true"
          style={{ width: `${Math.round(Math.max(0, Math.min(1, peak)) * 100)}%` }}
        />
      )}
      <span
        ref={trackRef}
        className="notch-vol-track notch-mix-track"
        role="slider"
        tabIndex={unavailable ? -1 : 0}
        aria-label={`${label} 볼륨`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={level}
        aria-valuetext={unavailable ? "사용할 수 없음" : muted ? "음소거됨" : `${level}%`}
        aria-disabled={unavailable}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKey}
      >
        <span className="notch-vol-rail" aria-hidden="true" />
        <span className="notch-vol-fill" aria-hidden="true" style={{ width: `${level}%` }} />
        <span className="notch-vol-ticks" aria-hidden="true">
          {VOLUME_TICKS.map((tick) => (
            <span
              key={tick}
              className={`notch-vol-tick${tick % 50 === 0 ? " is-major" : ""}`}
              style={{ left: `${tick}%` }}
            />
          ))}
        </span>
        <span className="notch-vol-cursor" aria-hidden="true" style={{ left: `${level}%` }} />
      </span>
      <span className={`notch-vol-value${muted ? " is-muted" : ""}`}>
        {unavailable ? "---" : String(level).padStart(3, "0")}
      </span>
      <button
        type="button"
        className={`notch-vol-mute${muted ? " is-on" : ""}`}
        aria-pressed={muted}
        aria-label={muted ? `${label} 음소거 해제` : `${label} 음소거`}
        title={muted ? "음소거 해제" : "음소거"}
        disabled={unavailable}
        onClick={(event) => {
          event.stopPropagation();
          onMute(!muted);
        }}
      >
        M
      </button>
    </div>
  );
}

const MIX_POLL_MS = 800;
// 미터는 눈으로 읽히는 속도만 필요하다. 세션 피크만 읽는 가벼운 명령을 쓴다.
const PEAK_POLL_MS = 120;

// 앱별 볼륨 화면. 기본 출력 장치에서 실제로 소리를 내는 세션만 보여준다.
function SoundMixer({ active, onClose }: { active: boolean; onClose: () => void }) {
  const [apps, setApps] = useState<NotchAudioApp[]>([]);
  const [master, setMaster] = useState<NotchVolume | null>(null);
  const [device, setDevice] = useState("");
  // pid별로 다듬은 피크 값. 사이드카는 순간값만 주므로 여기서 조금씩 놓아준다.
  const [peaks, setPeaks] = useState<Record<number, number>>({});
  // 끌고 있는 동안 폴링 결과가 손가락 위치를 덮지 않게 한다.
  const busyRef = useRef(false);
  const requestRef = useRef(0);
  // 앱마다 마지막 값만 묶어 보낸다(픽셀마다 IPC를 보내지 않게).
  const queued = useRef(new Map<number, number>());
  const queueTimer = useRef<number | null>(null);
  const queuedMaster = useRef<number | null>(null);
  const masterTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    const api = window.notchApi;
    if (!api) return;
    let cancelled = false;
    const read = async () => {
      const request = ++requestRef.current;
      try {
        const [list, output, volume] = await Promise.all([
          api.getAudioApps(),
          api.getAudioDevice(),
          api.getVolume(),
        ]);
        if (cancelled || request !== requestRef.current) return;
        if (output?.name) setDevice(output.name);
        if (!busyRef.current && queued.current.size === 0) setApps(list);
        if (volume && !busyRef.current && queuedMaster.current === null) setMaster(volume);
      } catch {
        // 잠깐 읽지 못하면 마지막 목록을 그대로 둔다.
      }
    };
    void read();
    const id = window.setInterval(read, MIX_POLL_MS);
    return () => {
      cancelled = true;
      requestRef.current++;
      window.clearInterval(id);
    };
  }, [active]);

  // 미터: 화면이 열려 있는 동안만 짧은 간격으로 피크만 읽는다.
  useEffect(() => {
    if (!active) return;
    const api = window.notchApi;
    if (!api) return;
    let cancelled = false;
    const read = async () => {
      try {
        const list = await api.getAudioPeaks();
        if (cancelled) return;
        setPeaks((previous) => {
          const next: Record<number, number> = {};
          for (const { pid, peak } of list) {
            // 떨어질 때 바로 0이 되지 않게 직전 값의 일부를 남긴다.
            next[pid] = Math.max(peak, (previous[pid] ?? 0) * 0.68);
          }
          return next;
        });
      } catch {
        // 읽지 못하면 다음 간격에 다시 시도한다.
      }
    };
    void read();
    const id = window.setInterval(read, PEAK_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active]);

  useEffect(() => {
    return () => {
      if (queueTimer.current) window.clearTimeout(queueTimer.current);
      if (masterTimer.current) window.clearTimeout(masterTimer.current);
    };
  }, []);

  const setLevel = (pid: number, level: number) => {
    setApps((previous) => previous.map((app) => (app.pid === pid ? { ...app, level, muted: false } : app)));
    queued.current.set(pid, level);
    if (queueTimer.current) return;
    queueTimer.current = window.setTimeout(() => {
      queueTimer.current = null;
      const entries = [...queued.current.entries()];
      queued.current.clear();
      for (const [appPid, next] of entries) {
        void window.notchApi?.setAppVolume(appPid, next).catch(() => undefined);
      }
    }, 70);
  };

  const setMute = (pid: number, muted: boolean) => {
    setApps((previous) => previous.map((app) => (app.pid === pid ? { ...app, muted } : app)));
    void window.notchApi?.setAppMuted(pid, muted).catch(() => undefined);
  };

  const setMasterLevel = (level: number) => {
    setMaster((previous) => (previous ? { ...previous, level, muted: false } : previous));
    queuedMaster.current = level;
    if (masterTimer.current) return;
    masterTimer.current = window.setTimeout(() => {
      masterTimer.current = null;
      const value = queuedMaster.current;
      queuedMaster.current = null;
      if (value === null) return;
      void window.notchApi?.setVolume(value).catch(() => undefined);
    }, 70);
  };

  const setMasterMute = (muted: boolean) => {
    setMaster((previous) => (previous ? { ...previous, muted } : previous));
    void window.notchApi?.setMuted(muted).catch(() => undefined);
  };

  return (
    <div className="notch-mix">
      <span className="notch-mix-head">
        <span className="notch-mix-title">SOUND</span>
        <span className="notch-mix-device" title={device}>{device || "출력 장치"}</span>
      </span>
      <div className="notch-mix-list">
        <MixRow
          label="MASTER"
          master
          level={master?.level ?? 0}
          muted={master?.muted ?? false}
          unavailable={!master}
          onLevel={setMasterLevel}
          onMute={setMasterMute}
          onBusy={(busy) => {
            busyRef.current = busy;
          }}
        />
        <span className="notch-mix-divider" aria-hidden="true" />
        {apps.length === 0 ? (
          <span className="notch-mix-empty">소리를 내는 앱이 없습니다.</span>
        ) : (
          apps.map((app) => (
            <MixRow
              key={app.pid}
              label={app.name.toUpperCase()}
              level={app.level}
              muted={app.muted}
              peak={peaks[app.pid] ?? 0}
              onLevel={(level) => setLevel(app.pid, level)}
              onMute={(muted) => setMute(app.pid, muted)}
              onBusy={(busy) => {
                busyRef.current = busy;
              }}
            />
          ))
        )}
      </div>
      <span className="notch-mix-foot">
        <button
          type="button"
          className="notch-btn"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          BACK
        </button>
        <button
          type="button"
          className="notch-btn"
          onClick={(event) => {
            event.stopPropagation();
            void window.notchApi?.openSoundSettings();
          }}
        >
          SOUND SETTINGS
        </button>
      </span>
    </div>
  );
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
  // 가사가 없을 때 채울 유튜브 썸네일(data URL). 없으면 빈 문자열.
  const [ytThumb, setYtThumb] = useState("");
  const mediaRef = useRef(media);
  // 이벤트 리스너가 처음 렌더링의 값을 붙들지 않도록 최신 화면 상태를 따로 둔다.
  const mediaRequestRef = useRef(0);
  const pendingPlayRef = useRef<PendingPlay | null>(null);
  const [playPending, setPlayPending] = useState(false);
  mediaRef.current = media;

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
  // 같은 앱의 탭이 둘 이상이면 번호를 붙여 어느 쪽인지 구분한다.
  const sourceChips = (() => {
    if (media.sources.length < 2) return [];
    const totals = new Map<string, number>();
    for (const source of media.sources) {
      const label = mediaAppName(source.app);
      totals.set(label, (totals.get(label) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    return media.sources.map((source) => {
      const label = mediaAppName(source.app);
      const index = (seen.get(label) ?? 0) + 1;
      seen.set(label, index);
      return { ...source, label: (totals.get(label) ?? 1) > 1 ? `${label}·${index}` : label };
    });
  })();
  // 직접 고른 세션으로 바꾸고, 다음 폴링을 기다리지 않고 바로 다시 읽는다.
  const selectSource = (id: string) => {
    const api = window.notchApi;
    if (!api || playPending || id === media.id) return;
    void api
      .selectMedia(id)
      .then((ok) => {
        if (ok) void readMedia();
      })
      .catch((error: unknown) => console.warn("미디어 소스 전환 실패:", error));
  };
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
  const view = resolveView(hasMedia);

  // 미디어가 없을 때 펼친 화면은 HUD만 보여준다. 시계와 온도는 그때만 돈다.
  const [hudNow, setHudNow] = useState(() => Date.now());
  const [temp, setTemp] = useState<number | null>(null);
  const [gpu, setGpu] = useState<number | null>(null);
  const [weather, setWeather] = useState<{ tempC: number; kind: string; city: string } | null>(null);
  // 앱별 볼륨 화면. 펼친 패널 내용만 바꾸고, 접으면 닫힌다.
  const [mixOpen, setMixOpen] = useState(false);
  // 출력 장치가 바뀌면 잠깐 알린다(접힌 동안에는 OUT 배지로만).
  const [deviceNote, setDeviceNote] = useState<NotchAudioDeviceChange | null>(null);

  useEffect(() => {
    if (!expanded) setMixOpen(false);
  }, [expanded]);

  useEffect(() => {
    return window.notchApi?.onAudioDevice((change) => setDeviceNote(change));
  }, []);

  useEffect(() => {
    if (!deviceNote) return;
    const id = window.setTimeout(() => setDeviceNote(null), 9000);
    return () => window.clearTimeout(id);
  }, [deviceNote]);

  useEffect(() => {
    if (!expanded || hasMedia) return;
    const id = window.setInterval(() => setHudNow(Date.now()), 1000);
    return () => window.clearInterval(id);  }, [expanded, hasMedia]);

  useEffect(() => {
    if (!expanded || hasMedia || !window.notchApi) return;
    let cancelled = false;
    const read = () => {
      void window.notchApi!
        .getTemp()
        .then((value) => {
          if (cancelled) return;
          setTemp(value);
        })
        .catch(() => undefined);
    };
    void read();
    const id = window.setInterval(read, 5000);
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
    };  }, [expanded, hasMedia]);

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
  const collapsedBadge = battery?.hasBattery
    ? battery.charging
      ? "bolt"
      : lowBattery
        ? "LOW"
        : ""
    : deviceNote
      ? "OUT"
      : "";
  // 미디어 패널에서는 중복되는 NOTCH 문구를 숨기고 전원 상태만 표시한다.
  const footerText =
    expanded && view === "media" && !(battery?.hasBattery && (battery.charging || lowBattery))
      ? ""
      : footerLabel;
  const progress = media.duration > 0 ? Math.min(1, Math.max(0, livePosition / media.duration)) : 0;
  const hudDate = new Date(hudNow);
  const pad2 = (value: number) => String(value).padStart(2, "0");
  // 초는 따로 떼어 어둡게, 숫자는 세 칸 고정폭으로 흔들리지 않게.
  const hudHm = `${pad2(hudDate.getHours())}:${pad2(hudDate.getMinutes())}`;
  const hudSec = pad2(hudDate.getSeconds());
  const hudDay = `${hudDate.getFullYear()}.${pad2(hudDate.getMonth() + 1)}.${pad2(hudDate.getDate())} ${hudDate.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase()}`;
  const hudTemp = (temp === null ? "--" : String(Math.round(temp))).padStart(3, " ");
  const hudGpu = (gpu === null ? "--" : String(Math.round(gpu))).padStart(3, " ");
  const tempHot = temp !== null && temp >= 85;
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
  }, [expanded, collapsedLyric, widestLyric, shownTitle, collapsedBadge]);

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
      // 미디어 패널과 좌우 여백을 포함한 폭. 가사가 길면 여기서 늘어난다.
      setExpandedWidth(Math.min(860, Math.max(EXPANDED_WIDTH, Math.ceil(measure.offsetWidth + 200))));
    };
    update();
    void document.fonts.ready.then(update);
    return () => {
      cancelled = true;
    };
  }, [expanded, view, hasSynced, widestLyric]);

  // HUD는 미디어 가사 폭을 물려받지 않고 기본 폭으로 돌아온다.
  const notchWidth = expanded
    ? mixOpen
      ? EXPANDED_WIDTH
      : view === "media" && hasSynced && widestLyric
        ? expandedWidth ?? EXPANDED_WIDTH
        : EXPANDED_WIDTH
    : collapsedWidth;

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
      className={`notch ${expanded ? "is-expanded" : "is-collapsed"}${view === "media" ? " has-media" : ""}${mixOpen ? " has-mix" : ""}${media.status === "Playing" ? " is-playing" : ""}${!expanded && collapsedBadge ? " has-status" : ""}`}
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
      {view === "media" ? (
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
      {footerText && <span className={`notch-title${lowBattery ? " is-low" : ""}`}>{footerText}</span>}
      {collapsedBadge === "bolt" ? (
        <span className="notch-bolt" aria-label="충전 중" />
      ) : collapsedBadge ? (
        <span className={`notch-status${lowBattery ? " is-low" : ""}`}>{collapsedBadge}</span>
      ) : null}
      {/* 접힌 동안 패널 안의 버튼이 탭으로 잡히지 않게 inert를 준다. */}
      <div className="notch-panel" inert={!expanded}>
        <div className="notch-main">
          {deviceNote && (
            <span className="notch-device-note" role="status" title={deviceNote.previous ? `이전: ${deviceNote.previous}` : undefined}>
              <span className="notch-device-note-text">OUT · {deviceNote.name}</span>
              <button
                type="button"
                className="notch-device-note-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  void window.notchApi?.openSoundSettings();
                }}
              >
                SETTINGS
              </button>
            </span>
          )}
          {mixOpen ? (
            <SoundMixer active={expanded} onClose={() => setMixOpen(false)} />
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
              <span className="notch-hud-readings">
                <span className={`notch-hud-thermal${tempHot ? " is-hot" : ""}`}>{`TEMP ${hudTemp}°C`}</span>
                {battery && !battery.hasBattery && <span>{`GPU ${hudGpu}%`}</span>}
              </span>
              <VolumeDeck active={expanded} onOpenMixer={() => setMixOpen(true)} />
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
          <span className="notch-controls-group">
            <button type="button" className="notch-btn" onClick={control("Previous")} disabled={playPending || !media.canPrev} aria-label="이전">
              PREV
            </button>
            <button type="button" className="notch-btn" onClick={control("Play")} disabled={playPending || !media.canPlayPause} aria-label="재생/일시정지">
              {media.status === "Playing" ? "PAUSE" : "PLAY"}
            </button>
            <button type="button" className="notch-btn" onClick={control("Next")} disabled={playPending || !media.canNext} aria-label="다음">
              NEXT
            </button>
          </span>
          <VolumeDeck active={expanded} onOpenMixer={() => setMixOpen(true)} />
        </div>
          </>
        )}
        </div>
      </div>
      <span className="notch-scan" />
    </div>
  );
}
