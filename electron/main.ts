import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, screen, shell, Tray } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createAudioBridge, type AudioBridge, type AudioDevice } from "./audio-bridge";
import { createDiscordBridge, type DiscordBridge, type DiscordVoice } from "./discord-bridge";

// 가사 길이에 따라 노치가 넓어질 수 있도록 창을 넉넉히 둔다.
const WINDOW_WIDTH = 900;
// 펼친 미디어/HUD 패널에 필요한 세로 크기.
const WINDOW_HEIGHT = 340;

// CPU 온도는 LibreHardwareMonitor/OpenHardwareMonitor의 CPU 센서를 먼저 쓴다.
// 없으면 성능 카운터의 정밀 온도(0.1K), 일반 온도(K), 마지막으로 ACPI WMI(0.1K)를 시도한다.
// Windows 열 구역은 CPU 다이 온도가 아닐 수 있으므로 말이 되는 범위의 가장 높은 값만 쓴다.
const TEMP_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
function Read-Sensor($ns) {
  try {
    $sensors = @(Get-CimInstance -Namespace $ns -ClassName Sensor -ErrorAction Stop | Where-Object { $_.SensorType -eq 'Temperature' -and $_.Value -gt 0 })
    if ($sensors.Count -eq 0) { return $null }
    $cpu = $sensors | Where-Object { $_.Name -match 'CPU Package|Package|Tctl|Tdie|CPU' } | Sort-Object Value -Descending | Select-Object -First 1
    if ($cpu) { return [double]$cpu.Value }
    return [double](($sensors | Measure-Object -Property Value -Maximum).Maximum)
  } catch { return $null }
}
$value = Read-Sensor 'root/LibreHardwareMonitor'
if ($null -eq $value) { $value = Read-Sensor 'root/OpenHardwareMonitor' }
if ($null -eq $value) {
  try {
    $zones = @(Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction Stop)
    $temps = @($zones | ForEach-Object {
      $celsius = $null
      $precise = 0.0
      if ([double]::TryParse([string]$_.HighPrecisionTemperature, [ref]$precise) -and $precise -gt 0) {
        $celsius = ($precise / 10.0) - 273.15
      }
      if (($null -eq $celsius -or $celsius -lt 15 -or $celsius -gt 115) -and [double]$_.Temperature -gt 0) {
        $celsius = [double]$_.Temperature - 273.15
      }
      if ($null -ne $celsius -and $celsius -ge 15 -and $celsius -le 115) {
        [pscustomobject]@{ Name = [string]$_.Name; Celsius = $celsius }
      }
    })
    # CPU 명시 존이 있으면 우선하고, 이름을 알 수 없으면 보고된 열 구역 중 가장 높은 값.
    $cpuTemps = @($temps | Where-Object { $_.Name -match 'CPUZ|TSZ0|TZ00|TZ01|THRM' })
    if ($cpuTemps.Count -gt 0) { $temps = $cpuTemps }
    if ($temps.Count -gt 0) { $value = ($temps | Measure-Object -Property Celsius -Maximum).Maximum }
  } catch { }
}
if ($null -eq $value) {
  try {
    $zones = @(Get-CimInstance -Namespace 'root/wmi' -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop)
    $temps = @($zones | Where-Object { $_.Active -ne $false -and [double]$_.CurrentTemperature -gt 0 } | ForEach-Object { ([double]$_.CurrentTemperature / 10.0) - 273.15 } | Where-Object { $_ -ge 15 -and $_ -le 115 })
    if ($temps.Count -gt 0) { $value = ($temps | Measure-Object -Maximum).Maximum }
  } catch { }
}
if ($null -eq $value) { 'null' } else { [Math]::Round([double]$value, 1).ToString([System.Globalization.CultureInfo]::InvariantCulture) }
`;

// HUD가 5초 간격으로 물어보므로 짧게 캐시해 PowerShell을 덜 띄운다.
let tempCache: { at: number; ttl: number; value: number | null } | null = null;

ipcMain.handle("notch:temp", async (): Promise<number | null> => {
  if (process.platform !== "win32") return null;
  const now = Date.now();
  if (tempCache && now - tempCache.at < tempCache.ttl) return tempCache.value;
  try {
    const value = Number.parseFloat((await runPowerShell(TEMP_SCRIPT)).trim());
    const result = Number.isFinite(value) && value > 0 && value < 150 ? value : null;
    // 센서가 없는 PC에서는 매번 PowerShell을 띄우지 않도록 실패를 더 오래 기억한다.
    tempCache = { at: now, ttl: result === null ? 12000 : 3000, value: result };
    return result;
  } catch {
    tempCache = { at: now, ttl: 12000, value: null };
    return null;
  }
});

// NOW 화면에서 고를 수 있는 재생 세션 하나.
interface MediaSource {
  id: string;
  app: string;
  title: string;
  artist: string;
  status: string;
}

interface MediaInfo {
  active: boolean;
  id: string;
  sources: MediaSource[];
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
  id: "",
  sources: [],
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

interface VolumeState {
  level: number;
  muted: boolean;
}

// 시스템 볼륨과 앱별 세션은 네이티브 사이드카(native/audio)가 담당한다.
// 사이드카는 앱이 살아 있는 동안 함께 떠 있고, 기본 출력 장치 변경을 이벤트로 알린다.
let audioBridge: AudioBridge | null = null;
let audioDevice: AudioDevice | null = null;
// Discord 음성 상태. 폴링 없이 이벤트로만 갱신된다.
let discordBridge: DiscordBridge | null = null;
let discordVoice: DiscordVoice | null = null;

// 개발 중에는 저장소의 빌드 산출물, 패키지에서는 extraResources로 넣은 exe를 쓴다.
function audioBridgePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "notch-audio.exe")
    : path.join(app.getAppPath(), "native", "audio", "bin", "notch-audio.exe");
}

function getAudioBridge(): AudioBridge {
  if (audioBridge) return audioBridge;
  const bridge = createAudioBridge(audioBridgePath());
  bridge.onDevice((device) => {
    const previous = audioDevice;
    audioDevice = device;
    if (!previous || previous.id === device.id) return;
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("notch:audio-device", { ...device, previous: previous.name });
    }
  });
  audioBridge = bridge;
  return bridge;
}

ipcMain.handle("notch:volume", async (): Promise<VolumeState | null> => {
  const state = await getAudioBridge().state();
  if (!state) return null;
  if (state.device) audioDevice = state.device;
  return { level: state.level, muted: state.muted };
});

ipcMain.handle("notch:volume-set", async (_event, level: unknown): Promise<boolean> => {
  if (typeof level !== "number" || !Number.isFinite(level)) return false;
  return getAudioBridge().setMasterLevel(level);
});

ipcMain.handle("notch:volume-mute", async (_event, muted: unknown): Promise<boolean> => {
  if (typeof muted !== "boolean") return false;
  return getAudioBridge().setMasterMuted(muted);
});

// 기본 출력 장치에서 소리를 내는 앱 하나.
interface AudioApp {
  pid: number;
  name: string;
  level: number;
  muted: boolean;
}

ipcMain.handle("notch:audio-apps", async (): Promise<AudioApp[]> => {
  if (process.platform !== "win32") return [];
  const apps = await getAudioBridge().apps();
  return apps.map(({ pid, name, level, muted }) => ({ pid, name, level, muted }));
});

// SOUND 화면의 미터용. 앱 목록보다 자주 부르므로 가벼운 명령만 쓴다.
ipcMain.handle("notch:audio-peaks", async (): Promise<{ pid: number; peak: number }[]> => {
  if (process.platform !== "win32") return [];
  return getAudioBridge().peaks();
});

ipcMain.handle("notch:audio-app-set", async (_event, pid: unknown, level: unknown): Promise<boolean> => {
  if (typeof pid !== "number" || typeof level !== "number") return false;
  if (!Number.isFinite(pid) || !Number.isFinite(level)) return false;
  return getAudioBridge().setAppLevel(pid, level);
});

ipcMain.handle("notch:audio-app-mute", async (_event, pid: unknown, muted: unknown): Promise<boolean> => {
  if (typeof pid !== "number" || typeof muted !== "boolean") return false;
  if (!Number.isFinite(pid)) return false;
  return getAudioBridge().setAppMuted(pid, muted);
});

ipcMain.handle("notch:sound-settings", (): boolean => {
  void shell.openExternal("ms-settings:sound");
  return true;
});

ipcMain.handle("notch:audio-device", async (): Promise<AudioDevice | null> => {
  if (!audioDevice) {
    const state = await getAudioBridge().state();
    if (state?.device) audioDevice = state.device;
  }
  return audioDevice;
});

// 복사한 텍스트 기록. 디스크에 쓰지 않고 실행 중인 동안만 메모리에 둔다.
// 비밀번호 관리자 같은 앱이 넣은 값도 파일로 남지 않게 하려는 선택이다.
interface ClipItem {
  id: number;
  text: string;
  at: number;
}

const CLIP_LIMIT = 20;
// 너무 긴 내용은 노치 목록에서 읽을 수 없고 payload만 커지므로 담지 않는다.
const CLIP_MAX_CHARS = 20000;
const CLIP_PREVIEW_CHARS = 160;

let clipItems: ClipItem[] = [];
let clipSeq = 0;
// 마지막으로 확인한 클립보드 내용. 같은 내용을 다시 쌓지 않기 위해 둔다.
let clipSeen = "";

// 목록에는 한 줄 미리보기만 담아 IPC로 큰 문자열을 계속 보내지 않는다.
function clipPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, CLIP_PREVIEW_CHARS);
}

function rememberClipboard(text: string): void {
  if (!text || text === clipSeen) return;
  clipSeen = text;
  if (text.length > CLIP_MAX_CHARS) return;
  clipItems = clipItems.filter((item) => item.text !== text);
  clipItems.unshift({ id: ++clipSeq, text, at: Date.now() });
  if (clipItems.length > CLIP_LIMIT) clipItems.length = CLIP_LIMIT;
}

let clipTimer: NodeJS.Timeout | null = null;

// 클립보드에는 변경 이벤트가 없어 짧은 간격으로 읽어 비교한다.
// 읽기는 Promise이므로 앞선 조회가 끝나기 전에는 다음 조회를 겹쳐 보내지 않는다.
function startClipboardWatcher(): void {
  if (clipTimer) return;
  let busy = false;
  const read = () => {
    if (busy) return;
    busy = true;
    void clipboard
      .readText()
      .then(rememberClipboard)
      // 읽지 못하면 다음 간격에 다시 시도한다.
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  };
  read();
  clipTimer = setInterval(read, 600);
}

ipcMain.handle("notch:clip-list", () =>
  clipItems.map((item) => ({ id: item.id, at: item.at, preview: clipPreview(item.text) })),
);

ipcMain.handle("notch:clip-copy", async (_event, id: unknown): Promise<boolean> => {
  if (typeof id !== "number" || !Number.isFinite(id)) return false;
  const item = clipItems.find((entry) => entry.id === id);
  if (!item) return false;
  try {
    await clipboard.writeText(item.text);
  } catch {
    return false;
  }
  clipSeen = item.text;
  // 방금 고른 항목을 맨 위(현재 클립보드)로 올린다.
  clipItems = [item, ...clipItems.filter((entry) => entry.id !== item.id)];
  return true;
});

ipcMain.handle("notch:clip-clear", async (): Promise<boolean> => {
  clipItems = [];
  // 지운 시점의 클립보드 내용이 다음 조회에서 다시 쌓이지 않게 기준을 옮긴다.
  try {
    clipSeen = await clipboard.readText();
  } catch {
    clipSeen = "";
  }
  return true;
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
// 사용자가 NOW에서 직접 고른 세션. 사라질 때까지 자동 선택보다 우선한다.
let userPickedSession = "";
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
  if (rows.length === 0) {
    userPickedSession = "";
    return undefined;
  }
  // 직접 고른 세션이 아직 살아 있으면 재생 상태와 관계없이 그대로 보여준다.
  if (userPickedSession) {
    const picked = rows.find((row) => sessionKey(row) === userPickedSession);
    if (picked) return picked;
    userPickedSession = "";
  }
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
    // 재생 중인 세션을 앞에 두되, 같은 앱의 여러 탭도 각각 고를 수 있게 제목까지 담는다.
    const sources: MediaSource[] = [...rows]
      .sort((a, b) => Number(b.status === "Playing") - Number(a.status === "Playing") || b.updatedAt - a.updatedAt)
      .map((row) => ({ id: sessionKey(row), app: row.app, title: row.title, artist: row.artist, status: row.status }));
    const media = { ...EMPTY_MEDIA, ...pick, id: sessionKey(pick), active: true, thumbnail, sources };
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

// NOW 화면에서 다른 재생 세션을 직접 고른다. 다음 미디어 조회부터 그 세션이 우선한다.
ipcMain.handle("notch:media-select", (_event, id: string): boolean => {
  if (typeof id !== "string" || !id || id.length > 400) return false;
  userPickedSession = id;
  return true;
});

// 트레이 객체는 앱이 실행되는 동안 유지해야 아이콘이 사라지지 않는다.
let tray: Tray | null = null;

// assets/tray.png를 못 읽는 경우에도 트레이 아이콘이 비지 않도록 직접 그린다.
function fallbackTrayIcon(): Electron.NativeImage {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 둥근 검은 바탕 위의 흰 눈 두 개.
      const inside = x >= 3 && x < 29 && y >= 3 && y < 29 &&
        !((x < 5 || x >= 27) && (y < 5 || y >= 27));
      if (!inside) continue;
      const eye = y >= 13 && y < 19 && ((x >= 8 && x < 13) || (x >= 19 && x < 24));
      const offset = (y * size + x) * 4;
      if (eye) pixels.fill(255, offset, offset + 3);
      pixels[offset + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

function createTray(): void {
  const image = nativeImage.createFromPath(path.join(__dirname, "../assets/tray.png"));
  tray = new Tray(image.isEmpty() ? fallbackTrayIcon() : image);
  tray.setToolTip("Notch");
  updateTrayMenu();
}

// 트레이 메뉴에서 바꿀 수 있는 단축키 후보. "사용 안 함"으로 끌 수 있다.
const SHORTCUT_CHOICES = [
  { label: "Ctrl+Alt+N", accelerator: "CommandOrControl+Alt+N" },
  { label: "Ctrl+Shift+N", accelerator: "CommandOrControl+Shift+N" },
  { label: "Ctrl+Alt+Shift+N", accelerator: "CommandOrControl+Alt+Shift+N" },
];

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: "마우스 올리면 펼치기",
      type: "checkbox",
      checked: settings.hoverOpen,
      click: (item) => saveSettings({ hoverOpen: item.checked }),
    },
    {
      label: "전체화면에서 숨기기",
      type: "checkbox",
      checked: settings.hideOnFullscreen,
      click: (item) => saveSettings({ hideOnFullscreen: item.checked }),
    },
    {
      label: "독점 전체화면 게임 위 표시는 지원하지 않음",
      enabled: false,
    },
    { type: "separator" },
    {
      label: "펼침 단축키",
      submenu: [
        ...SHORTCUT_CHOICES.map((choice) => ({
          label: choice.label,
          type: "radio" as const,
          checked: settings.toggleShortcut === choice.accelerator,
          click: () => saveSettings({ toggleShortcut: choice.accelerator }),
        })),
        { type: "separator" as const },
        {
          label: "사용 안 함",
          type: "radio" as const,
          checked: !settings.toggleShortcut,
          click: () => saveSettings({ toggleShortcut: "" }),
        },
      ],
    },
    { type: "separator" },
    { label: "Notch 종료", click: () => app.quit() },
  ]);
}

function updateTrayMenu(): void {
  tray?.setContextMenu(buildTrayMenu());
}

// 투명한 창 바깥 부분은 클릭을 뒤쪽 창으로 통과시킨다.
ipcMain.on("notch:bounds", (event, bounds: { x: number; y: number; width: number; height: number }) => {
  if (process.platform !== "win32" || !bounds ||
      ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
      bounds.width <= 0 || bounds.height <= 0) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const [windowWidth, windowHeight] = win.getContentSize();
  const left = Math.max(0, Math.floor(bounds.x));
  const top = Math.max(0, Math.floor(bounds.y));
  const right = Math.min(windowWidth, Math.ceil(bounds.x + bounds.width));
  const bottom = Math.min(windowHeight, Math.ceil(bounds.y + bounds.height));
  if (right <= left || bottom <= top) return;

  const radius = Math.min(16, Math.floor((right - left) / 2), bottom - top);
  const shape = [{ x: left, y: top, width: right - left, height: bottom - top - radius }];
  // 노치 위쪽의 작은 곡면도 잘리지 않게 포함한다.
  if (left > 0) shape.push({ x: Math.max(0, left - 8), y: top, width: Math.min(8, left), height: Math.min(8, bottom - top) });
  if (right < windowWidth) shape.push({ x: right, y: top, width: Math.min(8, windowWidth - right), height: Math.min(8, bottom - top) });
  for (let row = 0; row < radius; row++) {
    const dy = row + 0.5;
    const inset = Math.floor(radius - Math.sqrt(radius * radius - dy * dy));
    shape.push({ x: left + inset, y: bottom - radius + row, width: right - left - inset * 2, height: 1 });
  }
  win.setShape(shape.filter((rect) => rect.width > 0 && rect.height > 0));
});

// 펼침/접힘 전역 단축키 (Ctrl+Alt+N).
const TOGGLE_ACCELERATOR = "CommandOrControl+Alt+N";

interface NotchSettings {
  hoverOpen: boolean;
  toggleShortcut: string;
  hideOnFullscreen: boolean;
}

const DEFAULT_SETTINGS: NotchSettings = {
  hoverOpen: true,
  toggleShortcut: TOGGLE_ACCELERATOR,
  hideOnFullscreen: false,
};

// 전체화면 숨김은 기본값에서 opt-in으로 바뀌었다. 구버전 설정 파일은
// 기본값을 저장한 것인지 사용자가 직접 켠 것인지 구별할 수 없으므로 한 번만 표시 우선으로 옮긴다.
const SETTINGS_VERSION = 1;

// 설정은 실행 파일과 분리된 사용자 폴더에 두고, 없으면 기본값으로 만든다.
// 개발 실행과 포장 빌드가 같은 파일을 보도록 앱 이름 대신 고정 폴더를 쓴다.
// app.getPath는 ready 이후에만 안전하므로 쓸 때마다 구한다.
const settingsFile = (): string => path.join(app.getPath("appData"), "Notch", "settings.json");
let settings: NotchSettings = DEFAULT_SETTINGS;

function readSettings(): NotchSettings {
  if (!fs.existsSync(settingsFile())) {
    try {
      fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
      fs.writeFileSync(
        settingsFile(),
        JSON.stringify({ ...DEFAULT_SETTINGS, settingsVersion: SETTINGS_VERSION }, null, 2) + "\n",
        "utf8",
      );
    } catch (error) {
      console.warn("설정 파일을 만들지 못했습니다:", error);
    }
    return DEFAULT_SETTINGS;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as Partial<NotchSettings> & { settingsVersion?: number };
    const isLegacy = raw.settingsVersion !== SETTINGS_VERSION;
    // 값이 깨졌거나 빠진 항목은 기본값으로 채운다. 구버전의 숨김 기본값은 opt-in 정책으로 마이그레이션한다.
    const migrated: NotchSettings = {
      hoverOpen: typeof raw.hoverOpen === "boolean" ? raw.hoverOpen : DEFAULT_SETTINGS.hoverOpen,
      toggleShortcut:
        typeof raw.toggleShortcut === "string" ? raw.toggleShortcut.trim() : DEFAULT_SETTINGS.toggleShortcut,
      hideOnFullscreen: isLegacy
        ? DEFAULT_SETTINGS.hideOnFullscreen
        : typeof raw.hideOnFullscreen === "boolean" ? raw.hideOnFullscreen : DEFAULT_SETTINGS.hideOnFullscreen,
    };
    // 옮긴 값을 한 번은 파일에 남겨, 다음 실행부터는 사용자가 고른 값과 화면 동작이 어긋나지 않게 한다.
    if (isLegacy) writeJsonFile(settingsFile(), { ...migrated, settingsVersion: SETTINGS_VERSION }, "설정을 옮기지 못했습니다:");
    return migrated;
  } catch (error) {
    console.warn("설정 파일을 읽지 못해 기본값을 씁니다:", error);
    return DEFAULT_SETTINGS;
  }
}

// 설정으로 켜고 끄는 동작은 전부 여기서 한 번에 다시 적용한다.
function applySettings(): void {
  settings = readSettings();
  globalShortcut.unregisterAll();
  if (settings.toggleShortcut) {
    const registered = globalShortcut.register(settings.toggleShortcut, () => {
      notchWindow?.webContents.send("notch:toggle");
    });
    if (!registered) console.warn("전역 단축키를 등록하지 못했습니다:", settings.toggleShortcut);
  }
  syncFullscreenWatcher();
  updateTrayMenu();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("notch:settings", settings);
  }
}

ipcMain.handle("notch:settings", () => settings);
ipcMain.handle("notch:voice-state", (): DiscordVoice | null => discordVoice);

// 노치의 마이크 아이콘에서 부르는 쓰기. 렌더러가 보낸 값은 boolean만 받는다.
ipcMain.handle(
  "notch:voice-set",
  async (_event, patch: { mute?: unknown; deaf?: unknown } | null): Promise<boolean> => {
    const next: { mute?: boolean; deaf?: boolean } = {};
    if (typeof patch?.mute === "boolean") next.mute = patch.mute;
    if (typeof patch?.deaf === "boolean") next.deaf = patch.deaf;
    if (next.mute === undefined && next.deaf === undefined) return false;
    return discordBridge ? discordBridge.setVoice(next) : false;
  },
);

// JSON 파일은 임시 파일에 쓴 뒤 바꿔치기해, 쓰는 도중 앱이 꺼져도 반쯤 쓴 파일이 남지 않게 한다.
function writeJsonFile(file: string, value: unknown, failure: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.renameSync(temp, file);
  } catch (error) {
    console.warn(failure, error);
  }
}

// 트레이 메뉴에서 바꾸면 파일에 저장하고 바로 적용한다.
function saveSettings(patch: Partial<NotchSettings>): void {
  const next = { ...settings, ...patch };
  writeJsonFile(settingsFile(), { ...next, settingsVersion: SETTINGS_VERSION }, "설정을 저장하지 못했습니다:");
  applySettings();
}

// 앞쪽 창이 화면을 꽉 채운 전체화면인지 판정한다. 바탕화면(Progman/WorkerW)은 제외한다.
const FULLSCREEN_SCRIPT = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class NotchForeground {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint dwFlags);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
}
"@
$handle = [NotchForeground]::GetForegroundWindow()
if ($handle -eq [IntPtr]::Zero) { Write-Output 'false'; exit 0 }
$buffer = New-Object System.Text.StringBuilder 256
[void][NotchForeground]::GetClassName($handle, $buffer, 256)
$name = $buffer.ToString()
if ($name -eq 'Progman' -or $name -eq 'WorkerW' -or $name -eq 'Shell_TrayWnd') { Write-Output 'false'; exit 0 }
# 작업표시줄을 자동 숨김하면 최대화 창이 화면을 꽉 채운다. 이걸 전체화면으로 보면 안 된다.
if ([NotchForeground]::IsZoomed($handle)) { Write-Output 'false'; exit 0 }
$rect = New-Object NotchForeground+RECT
if (-not [NotchForeground]::GetWindowRect($handle, [ref]$rect)) { Write-Output 'false'; exit 0 }
$monitor = [NotchForeground]::MonitorFromWindow($handle, 2)
$info = New-Object NotchForeground+MONITORINFO
$info.cbSize = 40
if (-not [NotchForeground]::GetMonitorInfo($monitor, [ref]$info)) { Write-Output 'false'; exit 0 }
$full = ($rect.Left -le $info.rcMonitor.Left) -and ($rect.Top -le $info.rcMonitor.Top) -and ($rect.Right -ge $info.rcMonitor.Right) -and ($rect.Bottom -ge $info.rcMonitor.Bottom)
if ($full) { Write-Output 'true' } else { Write-Output 'false' }
`;

let notchWindow: BrowserWindow | null = null;
let fullscreenTimer: NodeJS.Timeout | null = null;

// 전체화면 앱이 앞에 있으면 노치를 숨기고, 빠지면 조용히 되살린다.
async function checkFullscreen(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;
  try {
    const fullscreen = (await runPowerShell(FULLSCREEN_SCRIPT)).trim() === "true";
    if (fullscreen && win.isVisible()) win.hide();
    else if (!fullscreen && !win.isVisible()) win.showInactive();
  } catch {
    // 판정에 실패하면 현재 표시 상태를 그대로 둔다.
  }
}

// 설정에서 끄면 감시를 멈추고, 숨어 있던 창은 다시 보여 준다.
function syncFullscreenWatcher(): void {
  if (fullscreenTimer) clearInterval(fullscreenTimer);
  fullscreenTimer = null;
  const win = notchWindow;
  if (!win || win.isDestroyed()) return;
  if (!settings.hideOnFullscreen) {
    if (!win.isVisible()) win.showInactive();
    return;
  }
  fullscreenTimer = setInterval(() => { void checkFullscreen(win); }, 3000);
}

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
    // 클릭해도 창이 활성화되지 않게 한다. 노치에서 클립보드 항목을 고른 뒤
    // 사용자가 보던 앱이 그대로 앞에 있어야 바로 붙여넣을 수 있다.
    focusable: false,
    hasShadow: false,
    icon: path.join(__dirname, "../assets/icon.png"),
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  notchWindow = win;
  win.on("closed", () => {
    if (fullscreenTimer) clearInterval(fullscreenTimer);
    fullscreenTimer = null;
    notchWindow = null;
  });
  syncFullscreenWatcher();

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

// 창을 두 개 띄우면 설정 파일을 서로 덮어쓰므로 한 번에 하나만 실행한다.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = notchWindow;
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) win.showInactive();
  });

  void app.whenReady().then(() => {
    // 사이드카를 먼저 띄워 두면 기본 출력 장치 변경을 이벤트로 받을 수 있다.
    const audio = getAudioBridge();
    audio.start();
    void audio.state().then((state) => {
      if (state?.device) audioDevice = state.device;
    });
    const notifyPowerChange = (onBattery: boolean) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("notch:power-change", onBattery);
      }
    };
    powerMonitor.on("on-ac", () => notifyPowerChange(false));
    powerMonitor.on("on-battery", () => notifyPowerChange(true));
    powerMonitor.on("resume", () => {
      notifyPowerChange(powerMonitor.isOnBatteryPower());
    });

    // Windows에서 노치의 작업표시줄 앱 ID를 Notch로 고정한다.
    app.setAppUserModelId("com.notch.app");
    startClipboardWatcher();
    // Discord가 켜져 있을 때만 붙는다(로컬 IPC). 없으면 조용히 재시도만 한다.
    discordBridge = createDiscordBridge(app.getPath("appData"));
    discordBridge.onVoice((voice) => {
      discordVoice = voice;
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send("notch:voice", voice);
    });
    discordBridge.start();
    createTray();
    createWindow();
    applySettings();
    // 설정 파일을 고치면 1초 안에 다시 적용한다.
    fs.watchFile(settingsFile(), { interval: 1000 }, () => applySettings());

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (clipTimer) clearInterval(clipTimer);
  clipTimer = null;
  discordBridge?.dispose();
  discordBridge = null;
  audioBridge?.dispose();
  audioBridge = null;
});

app.on("window-all-closed", () => {
  app.quit();
});
