import { app, BrowserWindow, ipcMain, nativeImage, powerMonitor, screen } from "electron";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

const WINDOW_WIDTH = 520;
const WINDOW_HEIGHT = 220;

interface CpuSample {
  idle: number;
  total: number;
}

function sampleCpu(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

let lastCpu = sampleCpu();

ipcMain.handle("notch:stats", () => {
  const now = sampleCpu();
  const dIdle = now.idle - lastCpu.idle;
  const dTotal = now.total - lastCpu.total;
  lastCpu = now;
  const cpu = dTotal > 0 ? (1 - dIdle / dTotal) * 100 : 0;
  return { cpu };
});

interface MediaInfo {
  active: boolean;
  status: string;
  title: string;
  artist: string;
  thumbnail: string;
  album: string;
  app: string;
  canPrev: boolean;
  canNext: boolean;
  canPlayPause: boolean;
  position: number;
  duration: number;
  updatedAt: number;
}

const EMPTY_MEDIA: MediaInfo = {
  active: false,
  status: "",
  title: "",
  artist: "",
  thumbnail: "",
  album: "",
  app: "",
  canPrev: false,
  canNext: false,
  canPlayPause: false,
  position: 0,
  duration: 0,
  updatedAt: 0,
};

// Windows GSMTC(미디어 세션) 조회 스크립트. 재생 중 세션을 우선한다.
const MEDIA_READ_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation') })[0]
function Await($op, $type) {
  $m = $asTask.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$list = @()
foreach ($s in @($mgr.GetSessions())) {
  try {
    $pi = $s.GetPlaybackInfo()
    $c = $pi.Controls
    $tl = $s.GetTimelineProperties()
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $list += [pscustomobject]@{
      app = [string]$s.SourceAppUserModelId
      status = [string]$pi.PlaybackStatus
      title = [string]$p.Title
      artist = [string]$p.Artist
      album = [string]$p.AlbumTitle
      canPrev = [bool]$c.IsPreviousEnabled
      canNext = [bool]$c.IsNextEnabled
      canPlayPause = [bool]$c.IsPlayPauseToggleEnabled
      position = [double]$tl.Position.TotalSeconds
      duration = [double]$tl.EndTime.TotalSeconds
      updatedAt = [double]([DateTimeOffset]$tl.LastUpdatedTime).ToUnixTimeMilliseconds()
    }
  } catch { }
}
ConvertTo-Json -InputObject @($list) -Compress -Depth 3
`;

// 선택된 세션의 앨범 아트만 따로 가져온다(매 폴링마다 모든 세션의 이미지를 읽지 않도록).
const MEDIA_THUMB_SCRIPT = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation') })[0]
function Await($op, $type) {
  $m = $asTask.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$appWant = '__APP__'
$titleWant = '__TITLE__'
foreach ($s in @($mgr.GetSessions())) {
  if ([string]$s.SourceAppUserModelId -ne $appWant) { continue }
  try {
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if ($titleWant -ne '' -and [string]$p.Title -ne $titleWant) { continue }
    if ($p.Thumbnail) {
      $raw = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
      $conv = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsStreamForRead' -and $_.GetParameters()[0].ParameterType.Name -eq 'IInputStream' } | Select-Object -First 1
      $net = $conv.Invoke($null, @($raw))
      $ms = New-Object System.IO.MemoryStream
      $net.CopyTo($ms)
      $bytes = $ms.ToArray()
      $mime = if ($bytes.Length -ge 4 -and $bytes[0] -eq 0x89) { 'image/png' } else { 'image/jpeg' }
      Write-Output ('data:' + $mime + ';base64,' + [Convert]::ToBase64String($bytes))
    }
    break
  } catch { }
}
`;

// 재생 제어 스크립트. __ACTION__ 자리에 Play/Pause/Previous/Next 중 하나가,
// __APP__/__TITLE__ 자리에 화면에 표시 중인 세션이 들어간다 — 표시된 그 세션에만 명령을 보낸다.
const MEDIA_CONTROL_SCRIPT = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation') })[0]
function Await($op, $type) {
  $m = $asTask.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$sessions = @($mgr.GetSessions())
$appWant = '__APP__'
$titleWant = '__TITLE__'
$cands = @($sessions | Where-Object { $appWant -ne '' -and [string]$_.SourceAppUserModelId -eq $appWant })
if ($cands.Count -eq 0) { Write-Output 'false'; exit 0 }
$pick = $null
# 같은 앱의 세션이 여러 개면 화면에 보이던 곡과 정확히 같은 것을 먼저 찾는다.
if ($titleWant -ne '') {
  foreach ($s in $cands) {
    try {
      $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      if ([string]$p.Title -eq $titleWant) { $pick = $s; break }
    } catch { }
  }
  # 표시된 제목이 사라졌다면 다른 세션을 대신 제어하지 않는다.
  if (-not $pick) { Write-Output 'false'; exit 0 }
}
if (-not $pick) {
  $playing = @($cands | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' })
  if ($playing.Count -gt 0) {
    $pick = $playing | Sort-Object { ([DateTimeOffset]$_.GetTimelineProperties().LastUpdatedTime).ToUnixTimeMilliseconds() } -Descending | Select-Object -First 1
  }
}
if (-not $pick -and $cands.Count -gt 0) {
  $pick = $cands | Sort-Object { ([DateTimeOffset]$_.GetTimelineProperties().LastUpdatedTime).ToUnixTimeMilliseconds() } -Descending | Select-Object -First 1
}
if (-not $pick) { Write-Output 'false'; exit 0 }
$r = $pick.__ACTION__Async()
$t = $asTask.MakeGenericMethod([bool]).Invoke($null, @($r))
$t.Wait(-1) | Out-Null
Write-Output $t.Result.ToString().ToLowerInvariant()
`;

function runPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      },
    );
  });
}

// 프로세스별 GPU 엔진 사용률을 합산하고 가장 바쁜 엔진을 표시한다.
const GPU_SCRIPT = `
$ErrorActionPreference = 'Stop'
$engines = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine)
if ($engines.Count -eq 0) { 'null'; exit }
$totals = @{}
foreach ($engine in $engines) {
  $name = [string]$engine.Name
  if ($name -notmatch '^pid_\\d+_(luid_.*)$') { continue }
  $key = $Matches[1]
  if (-not $totals.ContainsKey($key)) { $totals[$key] = 0.0 }
  $totals[$key] += [double]$engine.UtilizationPercentage
}
if ($totals.Count -eq 0) { 'null'; exit }
$highest = ($totals.Values | Measure-Object -Maximum).Maximum
ConvertTo-Json -InputObject ([Math]::Min(100.0, [Math]::Max(0.0, $highest))) -Compress
`;

ipcMain.handle("notch:gpu", async (): Promise<number | null> => {
  if (process.platform !== "win32") return null;
  try {
    const value: unknown = JSON.parse(await runPowerShell(GPU_SCRIPT));
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
});

interface BatteryInfo {
  hasBattery: boolean;
  percent: number;
  charging: boolean;
}

const NO_BATTERY: BatteryInfo = { hasBattery: false, percent: 0, charging: false };

// 데스크탑에는 Win32_Battery가 없으므로 hasBattery가 false가 된다.
const BATTERY_SCRIPT = `
$b = Get-CimInstance -ClassName Win32_Battery -ErrorAction Stop | Select-Object -First 1
if ($null -eq $b) { '{"hasBattery":false,"percent":0,"charging":false}' } else {
  [pscustomobject]@{ hasBattery = $true; percent = [int]$b.EstimatedChargeRemaining } | ConvertTo-Json -Compress
}
`;

ipcMain.handle("notch:battery", async (): Promise<BatteryInfo> => {
  if (process.platform !== "win32") return NO_BATTERY;
  const out = await runPowerShell(BATTERY_SCRIPT);
  const battery = JSON.parse(out) as Partial<BatteryInfo>;
  if (typeof battery.hasBattery !== "boolean" || typeof battery.percent !== "number") {
    throw new Error("Invalid battery information");
  }
  return {
    hasBattery: battery.hasBattery,
    percent: battery.percent,
    // 외부 전원 연결 여부를 사용해 완충 또는 충전 제한 상태도 표시한다.
    charging: battery.hasBattery && !powerMonitor.isOnBatteryPower(),
  };
});

interface MediaSessionRow {
  app: string;
  status: string;
  title: string;
  artist: string;
  album: string;
  canPrev: boolean;
  canNext: boolean;
  canPlayPause: boolean;
  position: number;
  duration: number;
  updatedAt: number;
}

// 브라우저는 영상 이미지 대신 앱 아이콘을 썸네일로 내보낼 수 있다.
function isBrowserApp(appId: string): boolean {
  return /(?:^|[\\/])(?:chrome|msedge|whale|firefox|brave|opera|vivaldi|chromium|arc)(?:\.exe)?$/i.test(appId);
}

// 같은 브라우저에 여러 세션이 있어도 표시된 앱과 제목을 함께 기억한다.
let lastShownSession = "";
let lastShownMedia: MediaInfo | null = null;
let mediaReadId = 0;
const sessionKey = (row: MediaSessionRow) => JSON.stringify([row.app, row.title]);
let lastSnapshots = new Map<string, { position: number; updatedAt: number }>();
const thumbCache = new Map<string, string>();

// 曲の切り替え中に別セッションへ移らないよう、以前から存在した同じアプリの別タブも除外する。
const TRACK_TRANSITION_MS = 8000;
let trackTransition: { app: string; title: string; excluded: Set<string>; expiresAt: number } | null = null;
function holdTrackTransition(app: string, title: string) {
  const excluded = new Set(lastSnapshots.keys());
  return { app, title, excluded, expiresAt: Date.now() + TRACK_TRANSITION_MS };
}

// 재생 중이라고 주장해도 타임라인이 멈춰 있으면 실제로는 멈춘 세션이다(브라우저 탭이 흔하다).
function isFreshPlaying(row: MediaSessionRow): boolean {
  if (row.status !== "Playing") return false;
  const prev = lastSnapshots.get(sessionKey(row));
  return !prev || prev.position !== row.position || prev.updatedAt !== row.updatedAt;
}

function pickSession(rows: MediaSessionRow[]): MediaSessionRow | undefined {
  if (rows.length === 0) return undefined;
  const byRecent = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
  const freshPlaying = byRecent.filter(isFreshPlaying);
  const preferred = lastShownSession ? rows.find((r) => sessionKey(r) === lastShownSession) : undefined;
  if (!preferred) return freshPlaying[0] ?? byRecent.find((r) => r.status === "Playing") ?? byRecent[0];
  if (preferred.status === "Playing") return preferred;
  // 같은 브라우저의 다른 탭도 별도의 세션으로 취급한다.
  return freshPlaying.find((r) => sessionKey(r) !== lastShownSession) ?? preferred;
}

async function readThumbnail(app: string, title: string): Promise<string> {
  const key = `${app}|${title}`;
  const hit = thumbCache.get(key);
  if (hit !== undefined) return hit;
  const out = await runPowerShell(
    MEDIA_THUMB_SCRIPT.replace("__APP__", psString(app)).replace("__TITLE__", psString(title)),
  );
  let url = out.startsWith("data:") ? out : "";
  if (url && isBrowserApp(app)) {
    const image = nativeImage.createFromDataURL(url);
    const { width, height } = image.getSize();
    // 정사각형은 브라우저 기본 아이콘일 가능성이 높다. 영상 썸네일은 보존한다.
    if (image.isEmpty() || !width || !height || Math.abs(width - height) / Math.max(width, height) < 0.1) url = "";
  }
  if (thumbCache.size >= 40) thumbCache.clear();
  thumbCache.set(key, url);
  return url;
}

ipcMain.handle("notch:media", async (): Promise<MediaInfo> => {
  if (process.platform !== "win32") return EMPTY_MEDIA;
  const readId = ++mediaReadId;
  try {
    const out = await runPowerShell(MEDIA_READ_SCRIPT);
    if (readId !== mediaReadId) return lastShownMedia ?? EMPTY_MEDIA;
    if (!out) return EMPTY_MEDIA;
    const parsed = JSON.parse(out) as MediaSessionRow | MediaSessionRow[];
    const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (row) => row && typeof row.app === "string" && typeof row.title === "string",
    );
    const previous = lastShownMedia;
    const preferred = rows.find((row) => sessionKey(row) === lastShownSession);
    // 自動で次の曲に進む場合も、曲末で元のセッションが消えた短い間は保留する。
    if (!trackTransition && previous?.status === "Playing" && previous.duration > 0 &&
        (!preferred || preferred.status !== "Playing")) {
      const elapsed = previous.updatedAt > 0 ? Math.max(0, (Date.now() - previous.updatedAt) / 1000) : 0;
      if (previous.position + elapsed >= previous.duration - 3) {
        trackTransition = holdTrackTransition(previous.app, previous.title);
      }
    }
    let pick: MediaSessionRow | undefined;
    const transition = trackTransition;
    if (transition && Date.now() < transition.expiresAt) {
      pick = rows.find((row) => row.app === transition.app && row.title && row.title !== transition.title &&
        row.status === "Playing" && !transition.excluded.has(sessionKey(row)));
      if (pick) trackTransition = null;
      else {
        lastSnapshots = new Map(rows.map((row) => [sessionKey(row), { position: row.position, updatedAt: row.updatedAt }]));
        if (lastShownMedia?.app === transition.app && lastShownMedia.title === transition.title) return lastShownMedia;
      }
    } else if (transition) {
      trackTransition = null;
    }
    pick ??= pickSession(rows);
    lastSnapshots = new Map(rows.map((r) => [sessionKey(r), { position: r.position, updatedAt: r.updatedAt }]));
    if (!pick) {
      lastShownSession = "";
      lastShownMedia = null;
      return EMPTY_MEDIA;
    }
    let thumbnail = "";
    try {
      thumbnail = await readThumbnail(pick.app, pick.title);
    } catch {
      thumbnail = "";
    }
    const media = { ...EMPTY_MEDIA, ...pick, active: true, thumbnail };
    if (readId !== mediaReadId) return lastShownMedia ?? media;
    lastShownSession = sessionKey(pick);
    lastShownMedia = media;
    return media;
  } catch {
    return EMPTY_MEDIA;
  }
});

// 가사가 없는 곡은 유튜브 검색 결과의 썸네일을 앨범 아트 대신 쓴다.
const youtubeCache = new Map<string, string>();

// 검색 결과 제목 비교용: 대소문자·공백·기호를 지워 부분 일치로 본다.
function normalizeSearch(text: string): string {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(.)/g, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

async function fetchYoutubeThumb(artist: string, track: string): Promise<string> {
  const key = `${artist}|${track}`;
  const hit = youtubeCache.get(key);
  if (hit !== undefined) return hit;
  const query = encodeURIComponent([artist, track].filter(Boolean).join(" "));
  let thumb = "";
  try {
    const res = await fetch(`https://www.youtube.com/results?search_query=${query}&hl=ko`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const html = await res.text();
      const allIds = [...new Set([...html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)].map((m) => m[1]))];
      // 제목을 읽을 수 있으면 곡/아티스트가 들어간 결과만 써서 엉뚱한 썸네일을 막는다.
      const titled = [...html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"[\s\S]{0,600}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g)].map(
        (m) => ({ id: m[1], text: normalizeSearch(m[2]) }),
      );
      const wantTrack = normalizeSearch(track);
      const wantArtist = normalizeSearch(artist);
      const matched = titled
        .filter((m) => m.text && (m.text.includes(wantTrack) || (wantArtist.length >= 2 && m.text.includes(wantArtist))))
        .map((m) => m.id);
      // 제목 파싱 자체가 실패하면(마크업 변경 등) 첫 결과로 폴백한다.
      const ids = titled.length > 0 ? [...new Set(matched)] : allIds;
      for (const id of ids.slice(0, 3)) {
        const img = await fetch(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!img.ok) continue;
        const bytes = Buffer.from(await img.arrayBuffer());
        if (bytes.length < 1000) continue;
        thumb = `data:image/jpeg;base64,${bytes.toString("base64")}`;
        break;
      }
    }
  } catch {
    thumb = "";
  }
  if (youtubeCache.size >= 20) youtubeCache.clear();
  youtubeCache.set(key, thumb);
  return thumb;
}

ipcMain.handle("notch:youtube-thumb", async (_event, query: { track?: string; artist?: string }) => {
  const track = (query?.track ?? "").trim();
  if (!track) return "";
  return fetchYoutubeThumb((query?.artist ?? "").trim(), track);
});

type WeatherKind = "sun" | "cloud" | "fog" | "rain" | "snow" | "thunder";

interface WeatherNow {
  tempC: number;
  kind: WeatherKind;
  city: string;
}

// WMO 날씨 코드를 아이콘 종류로 묶는다.
function weatherKind(code: number): WeatherKind {
  if (code === 0 || code === 1) return "sun";
  if (code === 2 || code === 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "thunder";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  return "cloud";
}

// 위치는 한 번만 찾고, 날씨는 10분 캐시(실패 시 1분 뒤 재시도).
let geoPoint: { lat: number; lon: number; city: string } | null = null;
let weatherCache: { at: number; ttl: number; value: WeatherNow | null } | null = null;

async function fetchWeather(): Promise<WeatherNow | null> {
  try {
    if (!geoPoint) {
      const geoRes = await fetch("https://ipwho.is/", { signal: AbortSignal.timeout(5000) });
      if (!geoRes.ok) return null;
      const geo = (await geoRes.json()) as { success?: boolean; latitude?: number; longitude?: number; city?: string };
      if (!geo.success || typeof geo.latitude !== "number" || typeof geo.longitude !== "number") return null;
      geoPoint = { lat: geo.latitude, lon: geo.longitude, city: typeof geo.city === "string" ? geo.city.trim() : "" };
    }
    const url =
      "https://api.open-meteo.com/v1/forecast?latitude=" +
      geoPoint.lat +
      "&longitude=" +
      geoPoint.lon +
      "&current=temperature_2m,weather_code&timezone=auto";
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { current?: { temperature_2m?: number; weather_code?: number } };
    const temp = data.current?.temperature_2m;
    const code = data.current?.weather_code;
    if (typeof temp !== "number" || typeof code !== "number") return null;
    return { tempC: Math.round(temp), kind: weatherKind(code), city: geoPoint.city };
  } catch {
    return null;
  }
}

ipcMain.handle("notch:weather", async (): Promise<WeatherNow | null> => {
  const now = Date.now();
  if (weatherCache && now - weatherCache.at < weatherCache.ttl) return weatherCache.value;
  const value = await fetchWeather();
  weatherCache = { at: now, ttl: value ? 10 * 60 * 1000 : 60 * 1000, value };
  return value;
});

interface MediaTarget {
  action: "Play" | "Pause" | "Previous" | "Next";
  app?: string;
  title?: string;
}

// PowerShell 작은따옴표 문자열에 값을 넣기 위한 이스케이프.
const psString = (value: string | undefined): string => (value ?? "").replace(/'/g, "''");

ipcMain.handle("notch:media-control", async (_event, target: MediaTarget): Promise<boolean> => {
  if (process.platform !== "win32") return false;
  const method = target.action === "Play" ? "TryPlay" : target.action === "Pause" ? "TryPause"
    : target.action === "Previous" ? "TrySkipPrevious" : "TrySkipNext";
  const script = MEDIA_CONTROL_SCRIPT.replace("__ACTION__", method)
    .replace("__APP__", psString(target.app))
    .replace("__TITLE__", psString(target.title));
  const transition = (target.action === "Next" || target.action === "Previous") && target.app && target.title
    ? holdTrackTransition(target.app, target.title)
    : null;
  if (transition) {
    // 버튼을 누르기 전에 시작된 느린 조회가 보류 중인 세션을 덮지 않게 한다.
    mediaReadId++;
    trackTransition = transition;
  }
  try {
    const success = (await runPowerShell(script)) === "true";
    if (!success && trackTransition === transition) trackTransition = null;
    return success;
  } catch (error) {
    if (trackTransition === transition) trackTransition = null;
    console.warn("미디어 제어 실패:", error);
    return false;
  }
});

function createWindow(): void {
  const { workArea } = screen.getPrimaryDisplay();

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2),
    y: workArea.y,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  const notifyPowerChange = (onBattery: boolean) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("notch:power-change", onBattery);
    }
  };
  powerMonitor.on("on-ac", () => notifyPowerChange(false));
  powerMonitor.on("on-battery", () => notifyPowerChange(true));
  powerMonitor.on("resume", () => notifyPowerChange(powerMonitor.isOnBatteryPower()));

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
