import { app, BrowserWindow, ipcMain, screen } from "electron";
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
if ($cands.Count -eq 0) { $cands = $sessions }
$pick = $null
# 같은 앱의 세션이 여러 개면 화면에 보이던 곡과 정확히 같은 것을 먼저 찾는다.
if ($titleWant -ne '') {
  foreach ($s in $cands) {
    try {
      $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      if ([string]$p.Title -eq $titleWant) { $pick = $s; break }
    } catch { }
  }
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
if (-not $pick) { exit 0 }
$r = $pick.__ACTION__Async()
$t = $asTask.MakeGenericMethod([bool]).Invoke($null, @($r))
$t.Wait(-1) | Out-Null
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

interface BatteryInfo {
  hasBattery: boolean;
  percent: number;
  charging: boolean;
}

const NO_BATTERY: BatteryInfo = { hasBattery: false, percent: 0, charging: false };

// 데스크탑에는 Win32_Battery가 없으므로 hasBattery가 false가 된다.
const BATTERY_SCRIPT = `
$b = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $b) { '{"hasBattery":false,"percent":0,"charging":false}' } else {
  $charging = ($b.BatteryStatus -eq 2) -or ($b.BatteryStatus -ge 6 -and $b.BatteryStatus -le 9)
  [pscustomobject]@{ hasBattery = $true; percent = [int]$b.EstimatedChargeRemaining; charging = [bool]$charging } | ConvertTo-Json -Compress
}
`;

ipcMain.handle("notch:battery", async (): Promise<BatteryInfo> => {
  if (process.platform !== "win32") return NO_BATTERY;
  try {
    const out = await runPowerShell(BATTERY_SCRIPT);
    if (!out) return NO_BATTERY;
    return { ...NO_BATTERY, ...(JSON.parse(out) as Partial<BatteryInfo>) };
  } catch {
    return NO_BATTERY;
  }
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

// 화면에 띄운 세션. 일시정지해도 이 곡에 고정해 둔다 — 다른 앱으로 튀면 보고 있던 곡을 다시 켤 수 없다.
let lastShownApp = "";
let lastSnapshots = new Map<string, { position: number; updatedAt: number }>();
const thumbCache = new Map<string, string>();

// 재생 중이라고 주장해도 타임라인이 멈춰 있으면 실제로는 멈춘 세션이다(브라우저 탭이 흔하다).
function isFreshPlaying(row: MediaSessionRow): boolean {
  if (row.status !== "Playing") return false;
  const prev = lastSnapshots.get(row.app);
  return !prev || prev.position !== row.position || prev.updatedAt !== row.updatedAt;
}

function pickSession(rows: MediaSessionRow[]): MediaSessionRow | undefined {
  if (rows.length === 0) return undefined;
  const byRecent = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
  const freshPlaying = byRecent.filter(isFreshPlaying);
  const preferred = lastShownApp ? rows.find((r) => r.app === lastShownApp) : undefined;
  if (!preferred) return freshPlaying[0] ?? byRecent.find((r) => r.status === "Playing") ?? byRecent[0];
  if (preferred.status === "Playing") return preferred;
  // 다른 앱에서 새로 재생을 시작했을 때만 넘어간다.
  return freshPlaying.find((r) => r.app !== preferred.app) ?? preferred;
}

async function readThumbnail(app: string, title: string): Promise<string> {
  const key = `${app}|${title}`;
  const hit = thumbCache.get(key);
  if (hit !== undefined) return hit;
  const out = await runPowerShell(
    MEDIA_THUMB_SCRIPT.replace("__APP__", psString(app)).replace("__TITLE__", psString(title)),
  );
  const url = out.startsWith("data:") ? out : "";
  if (thumbCache.size >= 40) thumbCache.clear();
  thumbCache.set(key, url);
  return url;
}

ipcMain.handle("notch:media", async (): Promise<MediaInfo> => {
  if (process.platform !== "win32") return EMPTY_MEDIA;
  try {
    const out = await runPowerShell(MEDIA_READ_SCRIPT);
    if (!out) return EMPTY_MEDIA;
    const parsed = JSON.parse(out) as MediaSessionRow | MediaSessionRow[];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const pick = pickSession(rows);
    lastSnapshots = new Map(rows.map((r) => [r.app, { position: r.position, updatedAt: r.updatedAt }]));
    if (!pick) return EMPTY_MEDIA;
    lastShownApp = pick.app;
    let thumbnail = "";
    try {
      thumbnail = await readThumbnail(pick.app, pick.title);
    } catch {
      thumbnail = "";
    }
    return { ...EMPTY_MEDIA, ...pick, active: true, thumbnail };
  } catch {
    return EMPTY_MEDIA;
  }
});

interface MediaTarget {
  action: "Play" | "Previous" | "Next";
  app?: string;
  title?: string;
}

// PowerShell 작은따옴표 문자열에 값을 넣기 위한 이스케이프.
const psString = (value: string | undefined): string => (value ?? "").replace(/'/g, "''");

ipcMain.handle("notch:media-control", async (_event, target: MediaTarget) => {
  if (process.platform !== "win32") return;
  const method =
    target.action === "Play" ? "TryTogglePlayPause" : target.action === "Previous" ? "TrySkipPrevious" : "TrySkipNext";
  const script = MEDIA_CONTROL_SCRIPT.replace("__ACTION__", method)
    .replace("__APP__", psString(target.app))
    .replace("__TITLE__", psString(target.title));
  try {
    await runPowerShell(script);
  } catch {
    // 제어 실패는 무시한다.
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
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
