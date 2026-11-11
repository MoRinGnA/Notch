import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, screen, shell, Tray } from "electron";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// 가사 길이에 따라 노치가 넓어질 수 있도록 창을 넉넉히 둔다.
const WINDOW_WIDTH = 900;
// 펼친 미디어/HUD 패널에 필요한 세로 크기.
const WINDOW_HEIGHT = 340;

// CPU 온도는 LibreHardwareMonitor/OpenHardwareMonitor가 실행 중이면 그 CPU 센서를 먼저 쓰고,
// 없으면 Windows 열 구역(thermal zone) 중 가장 높은 값을 쓴다. 없으면 null.
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
  $zones = @(Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction SilentlyContinue)
  $temps = @($zones | ForEach-Object { ([double]$_.HighPrecisionTemperature / 10) - 273.15 } | Where-Object { $_ -ge 15 -and $_ -le 115 })
  if ($temps.Count -gt 0) { $value = ($temps | Measure-Object -Maximum).Maximum }
}
if ($null -eq $value) { 'null' } else { [Math]::Round($value, 1).ToString([System.Globalization.CultureInfo]::InvariantCulture) }
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
    tempCache = { at: now, ttl: result === null ? 60000 : 3000, value: result };
    return result;
  } catch {
    tempCache = { at: now, ttl: 60000, value: null };
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

// 시스템 기본 출력의 마스터 볼륨. Windows Core Audio(IAudioEndpointVolume)를 C#으로 감싼다.
// Add-Type 컴파일이 무거워 호출마다 PowerShell을 새로 띄우면 슬라이더가 끊기므로,
// 한 프로세스를 띄워 두고 stdin/stdout으로 get/set 명령만 주고받는다.
const VOLUME_AGENT_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace NotchAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  internal class MMDeviceEnumerator { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
    [PreserveSig] int GetId(out IntPtr id);
    [PreserveSig] int GetState(out int state);
  }

  // 기본 출력 장치에 붙은 앱별 오디오 세션.
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int streamFlags, out IntPtr sessionControl);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int streamFlags, out IntPtr sessionVolume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator enumerator);
    [PreserveSig] int RegisterSessionNotification(IntPtr notify);
    [PreserveSig] int UnregisterSessionNotification(IntPtr notify);
    [PreserveSig] int RegisterDuckNotification(IntPtr sessionId, IntPtr notify);
    [PreserveSig] int UnregisterDuckNotification(IntPtr notify);
  }

  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 control);
  }

  // 메서드는 vtable 순서대로 채운다. 쓰지 않는 항목도 자리를 지켜야 한다.
  [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioSessionControl {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr context);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr context);
    [PreserveSig] int GetGroupingParam(out Guid grouping);
    [PreserveSig] int SetGroupingParam(ref Guid grouping, IntPtr context);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr notify);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notify);
  }

  [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr context);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr context);
    [PreserveSig] int GetGroupingParam(out Guid grouping);
    [PreserveSig] int SetGroupingParam(ref Guid grouping, IntPtr context);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr notify);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notify);
    [PreserveSig] int GetSessionIdentifier(out IntPtr identifier);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr identifier);
    [PreserveSig] int GetProcessId(out uint processId);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
  }

  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, Guid context);
    [PreserveSig] int GetMasterVolume(out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid context);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }

  // 메서드는 vtable 순서대로 선언해야 한다. 쓰지 않는 채널 관련 항목도 자리를 채운다.
  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int GetChannelCount(out uint count);
    [PreserveSig] int SetMasterVolumeLevel(float levelDb, Guid context);
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, Guid context);
    [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDb, Guid context);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, Guid context);
    [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDb);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid context);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }

  public static class Master {
    // 짧은 시간 동안은 기본 출력 객체를 재사용한다(초당 여러 번 읽어도 부담이 없게).
    private static IAudioEndpointVolume cached;
    private static DateTime cachedAt = DateTime.MinValue;

    private static void Forget() {
      cached = null;
      cachedAt = DateTime.MinValue;
    }

    private static IAudioEndpointVolume Endpoint() {
      if (cached != null && (DateTime.UtcNow - cachedAt).TotalSeconds < 5) return cached;
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice device;
      Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
      var iid = typeof(IAudioEndpointVolume).GUID;
      object instance;
      Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out instance));
      cached = (IAudioEndpointVolume)instance;
      cachedAt = DateTime.UtcNow;
      return cached;
    }

    // "레벨;음소거" 한 줄로 답한다(따옴표 이스케이프를 피하려고 JSON 대신 쓴다).
    public static string Read() {
      try {
        var endpoint = Endpoint();
        float level;
        bool muted;
        Marshal.ThrowExceptionForHR(endpoint.GetMasterVolumeLevelScalar(out level));
        Marshal.ThrowExceptionForHR(endpoint.GetMute(out muted));
        var percent = (int)Math.Round(Math.Max(0f, Math.Min(1f, level)) * 100f);
        return percent.ToString() + ";" + (muted ? "1" : "0");
      } catch {
        // 출력 기기가 바뀌었으면 다음 호출에서 새 기본 기기를 찾는다.
        Forget();
        throw;
      }
    }

    public static void Set(int percent) {
      try {
        var endpoint = Endpoint();
        var level = Math.Max(0, Math.Min(100, percent)) / 100f;
        Marshal.ThrowExceptionForHR(endpoint.SetMasterVolumeLevelScalar(level, Guid.Empty));
      } catch {
        Forget();
        throw;
      }
    }

    public static void SetMute(bool muted) {
      try {
        var endpoint = Endpoint();
        Marshal.ThrowExceptionForHR(endpoint.SetMute(muted, Guid.Empty));
      } catch {
        Forget();
        throw;
      }
    }

    // 기본 출력 장치의 엔드포인트 ID. 장치가 바뀌었는지 비교하는 데만 쓴다.
    public static string DeviceId() {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice device;
      Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
      IntPtr id;
      Marshal.ThrowExceptionForHR(device.GetId(out id));
      try { return Marshal.PtrToStringUni(id); } finally { Marshal.FreeCoTaskMem(id); }
    }
  }

  // 기본 출력 장치의 오디오 세션 목록과 앱별 음량 제어.
  // 세션 하나는 "pid;레벨;음소거;이름"이고 세션끼리 '|'로 잇는다(줄바꿈 없이 한 줄로 답하기 위해).
  public static class Sessions {
    private static IAudioSessionEnumerator Open() {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice device;
      Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
      var iid = typeof(IAudioSessionManager2).GUID;
      object manager;
      Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out manager));
      var sessions = (IAudioSessionManager2)manager;
      IAudioSessionEnumerator list;
      Marshal.ThrowExceptionForHR(sessions.GetSessionEnumerator(out list));
      return list;
    }

    private static string NameOf(uint pid) {
      try { return Process.GetProcessById((int)pid).ProcessName; } catch { return "app"; }
    }

    public static string Read() {
      var parts = new List<string>();
      var seen = new List<int>();
      var list = Open();
      int count;
      if (list.GetCount(out count) != 0) return "";
      for (int i = 0; i < count; i++) {
        IAudioSessionControl2 control;
        if (list.GetSession(i, out control) != 0 || control == null) continue;
        try {
          int state;
          if (control.GetState(out state) != 0 || state != 1) continue;
          if (control.IsSystemSoundsSession() == 0) continue;
          uint pid;
          if (control.GetProcessId(out pid) != 0 || pid == 0) continue;
          if (seen.Contains((int)pid)) continue;
          var volume = control as ISimpleAudioVolume;
          if (volume == null) continue;
          float level;
          bool muted;
          if (volume.GetMasterVolume(out level) != 0) continue;
          if (volume.GetMute(out muted) != 0) muted = false;
          seen.Add((int)pid);
          var percent = (int)Math.Round(Math.Max(0f, Math.Min(1f, level)) * 100f);
          parts.Add(pid.ToString() + ";" + percent.ToString() + ";" + (muted ? "1" : "0") + ";" + NameOf(pid));
        } finally {
          Marshal.ReleaseComObject(control);
        }
      }
      Marshal.ReleaseComObject(list);
      return String.Join("|", parts);
    }

    private static void Apply(uint target, int percent, int mute) {
      var list = Open();
      int count;
      if (list.GetCount(out count) != 0) return;
      for (int i = 0; i < count; i++) {
        IAudioSessionControl2 control;
        if (list.GetSession(i, out control) != 0 || control == null) continue;
        try {
          uint pid;
          if (control.GetProcessId(out pid) != 0 || pid != target) continue;
          var volume = control as ISimpleAudioVolume;
          if (volume == null) continue;
          if (percent >= 0) {
            var level = Math.Max(0, Math.Min(100, percent)) / 100f;
            volume.SetMasterVolume(level, Guid.Empty);
          }
          if (mute >= 0) volume.SetMute(mute == 1, Guid.Empty);
        } finally {
          Marshal.ReleaseComObject(control);
        }
      }
      Marshal.ReleaseComObject(list);
    }

    public static void Set(int pid, int percent) { Apply((uint)pid, percent, -1); }

    public static void Mute(int pid, bool muted) { Apply((uint)pid, -1, muted ? 1 : 0); }
  }
}
'@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = @($line.Trim() -split '\\s+')
  $reply = 'err'
  try {
    if ($parts[0] -eq 'get') { $reply = [NotchAudio.Master]::Read() }
    elseif ($parts[0] -eq 'set' -and $parts.Count -ge 2) { [NotchAudio.Master]::Set([int]$parts[1]); $reply = 'ok' }
    elseif ($parts[0] -eq 'mute' -and $parts.Count -ge 2) { [NotchAudio.Master]::SetMute($parts[1] -eq '1'); $reply = 'ok' }
    elseif ($parts[0] -eq 'sessions') { $reply = [NotchAudio.Sessions]::Read(); if ($null -eq $reply) { $reply = '' } }
    elseif ($parts[0] -eq 'sess-set' -and $parts.Count -ge 3) { [NotchAudio.Sessions]::Set([int]$parts[1], [int]$parts[2]); $reply = 'ok' }
    elseif ($parts[0] -eq 'sess-mute' -and $parts.Count -ge 3) { [NotchAudio.Sessions]::Mute([int]$parts[1], $parts[2] -eq '1'); $reply = 'ok' }
    elseif ($parts[0] -eq 'device') {
      $deviceId = ''
      $deviceName = ''
      try {
        $deviceId = [NotchAudio.Master]::DeviceId()
        if ($deviceId) {
          $key = $deviceId
          if ($deviceId -match '\{[0-9a-fA-F-]+\}$') { $key = $matches[0] }
          $root = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render'
          $path = Join-Path (Join-Path $root $key) 'Properties'
          $props = Get-ItemProperty -Path $path -ErrorAction SilentlyContinue
          if ($null -ne $props) { $deviceName = $props.'{a45c254e-df1c-4efd-8020-67d146a850e0},2' }
        }
      } catch { $deviceName = '' }
      $reply = ($deviceId + ';' + $deviceName)
    }
    elseif ($parts[0] -eq 'quit') { [Console]::Out.WriteLine('bye'); [Console]::Out.Flush(); break }
  } catch { $reply = 'err' }
  [Console]::Out.WriteLine($reply)
  [Console]::Out.Flush()
}
`;

interface VolumeRequest {
  done: boolean;
  timer: NodeJS.Timeout;
  finish: (error: Error | null, value: string) => void;
}

let volumeProc: ChildProcessWithoutNullStreams | null = null;
let volumeBuffer = "";
let volumeRequests: VolumeRequest[] = [];
let volumeIdleTimer: NodeJS.Timeout | null = null;

function settleVolumeRequests(error: Error): void {
  const pending = volumeRequests;
  volumeRequests = [];
  for (const request of pending) {
    if (request.done) continue;
    request.done = true;
    clearTimeout(request.timer);
    request.finish(error, "");
  }
}

// 대화가 끊기면 대기 중인 요청을 모두 실패로 정리하고, 다음 호출에서 새로 띄운다.
function resetVolumeAgent(error: Error): void {
  const proc = volumeProc;
  volumeProc = null;
  volumeBuffer = "";
  if (proc) {
    proc.removeAllListeners();
    proc.stdin.destroy();
    proc.kill();
  }
  settleVolumeRequests(error);
}

function stopVolumeAgent(): void {
  if (volumeIdleTimer) {
    clearTimeout(volumeIdleTimer);
    volumeIdleTimer = null;
  }
  volumeProc = null;
  volumeBuffer = "";
  settleVolumeRequests(new Error("volume agent stopped"));
}

// 노치를 닫고 한동안 볼륨을 만지지 않으면 PowerShell을 정리한다.
function touchVolumeIdle(): void {
  if (volumeIdleTimer) clearTimeout(volumeIdleTimer);
  volumeIdleTimer = setTimeout(() => {
    volumeIdleTimer = null;
    if (volumeRequests.length > 0) {
      touchVolumeIdle();
      return;
    }
    stopVolumeAgent();
  }, 60000);
}

// 스크립트가 커지면 -EncodedCommand는 명령줄 길이 한계(32KB)를 넘는다. 임시 폴더에 .ps1로 두고 -File로 띄운다.
function writeVolumeAgentScript(): string {
  const scriptPath = path.join(app.getPath("temp"), "notch-audio-agent.ps1");
  // PowerShell 5.1은 BOM이 없으면 UTF-8을 ANSI로 읽어 한글 주석에서 깨진다.
  fs.writeFileSync(scriptPath, `\ufeff${VOLUME_AGENT_SCRIPT}`, "utf8");
  return scriptPath;
}

function spawnVolumeAgent(): void {
  let scriptPath: string;
  try {
    scriptPath = writeVolumeAgentScript();
  } catch (error) {
    settleVolumeRequests(error as Error);
    return;
  }
  const proc = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { windowsHide: true, stdio: "pipe" },
  );
  volumeProc = proc;
  volumeBuffer = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    volumeBuffer += chunk;
    let index = volumeBuffer.indexOf("\n");
    while (index >= 0) {
      const line = volumeBuffer.slice(0, index).trim();
      volumeBuffer = volumeBuffer.slice(index + 1);
      const request = volumeRequests.shift();
      if (request && !request.done) {
        request.done = true;
        clearTimeout(request.timer);
        request.finish(null, line);
      }
      index = volumeBuffer.indexOf("\n");
    }
    touchVolumeIdle();
  });
  proc.on("error", (error) => {
    if (volumeProc === proc) resetVolumeAgent(error as Error);
  });
  proc.on("exit", (code) => {
    if (volumeProc !== proc) return;
    volumeProc = null;
    volumeBuffer = "";
    settleVolumeRequests(new Error(`volume agent exited (${code})`));
  });
  touchVolumeIdle();
}

function volumeCommand(command: string): Promise<string> {
  if (process.platform !== "win32") return Promise.reject(new Error("unsupported platform"));
  if (!volumeProc) spawnVolumeAgent();
  const proc = volumeProc;
  if (!proc) return Promise.reject(new Error("volume agent unavailable"));
  return new Promise((resolve, reject) => {
    const request: VolumeRequest = {
      done: false,
      // 첫 호출은 Add-Type 컴파일 때문에 느리다.
      timer: setTimeout(() => {
        if (request.done) return;
        request.done = true;
        // 응답을 놓치면 이후 응답이 한 칸씩 밀리므로 대화를 새로 시작한다.
        resetVolumeAgent(new Error("volume agent timeout"));
        reject(new Error("volume agent timeout"));
      }, 5000),
      finish: (error, value) => (error ? reject(error) : resolve(value)),
    };
    volumeRequests.push(request);
    proc.stdin.write(`${command}\n`);
  });
}

ipcMain.handle("notch:volume", async (): Promise<VolumeState | null> => {
  if (process.platform !== "win32") return null;
  try {
    const [level, muted] = (await volumeCommand("get")).split(";");
    const parsed = Number.parseInt(level, 10);
    if (!Number.isFinite(parsed)) return null;
    return { level: Math.max(0, Math.min(100, parsed)), muted: muted === "1" };
  } catch {
    return null;
  }
});

ipcMain.handle("notch:volume-set", async (_event, level: unknown): Promise<boolean> => {
  if (typeof level !== "number" || !Number.isFinite(level)) return false;
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  try {
    return (await volumeCommand(`set ${clamped}`)) === "ok";
  } catch {
    return false;
  }
});

ipcMain.handle("notch:volume-mute", async (_event, muted: unknown): Promise<boolean> => {
  if (typeof muted !== "boolean") return false;
  try {
    return (await volumeCommand(`mute ${muted ? 1 : 0}`)) === "ok";
  } catch {
    return false;
  }
});

// 기본 출력 장치에서 소리를 내는 앱 하나.
interface AudioApp {
  pid: number;
  name: string;
  level: number;
  muted: boolean;
}

interface AudioDevice {
  id: string;
  name: string;
}

// 도우미는 세션을 "pid;레벨;음소거;이름"으로 잇고 세션끼리 '|'로 구분해 한 줄로 답한다.
function parseAudioApps(reply: string): AudioApp[] {
  const apps: AudioApp[] = [];
  for (const entry of reply.split("|")) {
    const fields = entry.split(";");
    if (fields.length < 4) continue;
    const pid = Number.parseInt(fields[0], 10);
    const level = Number.parseInt(fields[1], 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    apps.push({
      pid,
      level: Number.isFinite(level) ? Math.max(0, Math.min(100, level)) : 0,
      muted: fields[2] === "1",
      name: fields.slice(3).join(";").trim() || "app",
    });
  }
  return apps;
}

ipcMain.handle("notch:audio-apps", async (): Promise<AudioApp[]> => {
  if (process.platform !== "win32") return [];
  try {
    return parseAudioApps(await volumeCommand("sessions"));
  } catch {
    return [];
  }
});

ipcMain.handle("notch:audio-app-set", async (_event, pid: unknown, level: unknown): Promise<boolean> => {
  if (typeof pid !== "number" || typeof level !== "number") return false;
  if (!Number.isFinite(pid) || !Number.isFinite(level)) return false;
  try {
    return (await volumeCommand(`sess-set ${Math.round(pid)} ${Math.max(0, Math.min(100, Math.round(level)))}`)) === "ok";
  } catch {
    return false;
  }
});

ipcMain.handle("notch:audio-app-mute", async (_event, pid: unknown, muted: unknown): Promise<boolean> => {
  if (typeof pid !== "number" || typeof muted !== "boolean") return false;
  if (!Number.isFinite(pid)) return false;
  try {
    return (await volumeCommand(`sess-mute ${Math.round(pid)} ${muted ? 1 : 0}`)) === "ok";
  } catch {
    return false;
  }
});

ipcMain.handle("notch:sound-settings", (): boolean => {
  void shell.openExternal("ms-settings:sound");
  return true;
});

// 기본 출력 장치. 장치가 바뀌었는지 비교하고 이름을 알리는 데만 쓴다.
let audioDevice: AudioDevice | null = null;
let deviceCheckTimer: NodeJS.Timeout | null = null;

async function readAudioDevice(): Promise<AudioDevice | null> {
  try {
    const reply = await volumeCommand("device");
    const index = reply.indexOf(";");
    const id = (index >= 0 ? reply.slice(0, index) : reply).trim();
    if (!id) return null;
    return { id, name: index >= 0 ? reply.slice(index + 1).trim() : "" };
  } catch {
    return null;
  }
}

// 첫 확인은 조용히 기준만 잡고, 이후 장치가 바뀌면 펼친 화면에 짧게 알린다.
async function refreshAudioDevice(): Promise<void> {
  const next = await readAudioDevice();
  if (!next) return;
  const previous = audioDevice;
  audioDevice = next;
  if (!previous || previous.id === next.id) return;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("notch:audio-device", {
      id: next.id,
      name: next.name || "출력 장치",
      previous: previous.name,
    });
  }
}

// 장치 변경 메시지는 여러 번 몰려 오므로 잠깐 묶어 한 번만 확인한다.
function scheduleAudioDeviceCheck(): void {
  if (deviceCheckTimer) return;
  deviceCheckTimer = setTimeout(() => {
    deviceCheckTimer = null;
    void refreshAudioDevice();
  }, 700);
}

// 시작할 때 읽지 못했으면 믹서를 열 때 한 번 더 시도한다.
ipcMain.handle("notch:audio-device", async (): Promise<AudioDevice | null> => {
  if (!audioDevice) audioDevice = await readAudioDevice();
  return audioDevice;
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
  hideOnFullscreen: true,
};

// 설정은 실행 파일과 분리된 사용자 폴더에 두고, 없으면 기본값으로 만든다.
// 개발 실행과 포장 빌드가 같은 파일을 보도록 앱 이름 대신 고정 폴더를 쓴다.
// app.getPath는 ready 이후에만 안전하므로 쓸 때마다 구한다.
const settingsFile = (): string => path.join(app.getPath("appData"), "Notch", "settings.json");
let settings: NotchSettings = DEFAULT_SETTINGS;

function readSettings(): NotchSettings {
  if (!fs.existsSync(settingsFile())) {
    try {
      fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
      fs.writeFileSync(settingsFile(), JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n", "utf8");
    } catch (error) {
      console.warn("설정 파일을 만들지 못했습니다:", error);
    }
    return DEFAULT_SETTINGS;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as Partial<NotchSettings>;
    // 값이 깨졌거나 빠진 항목은 기본값으로 채운다.
    return {
      hoverOpen: typeof raw.hoverOpen === "boolean" ? raw.hoverOpen : DEFAULT_SETTINGS.hoverOpen,
      toggleShortcut:
        typeof raw.toggleShortcut === "string" ? raw.toggleShortcut.trim() : DEFAULT_SETTINGS.toggleShortcut,
      hideOnFullscreen:
        typeof raw.hideOnFullscreen === "boolean" ? raw.hideOnFullscreen : DEFAULT_SETTINGS.hideOnFullscreen,
    };
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
  writeJsonFile(settingsFile(), next, "설정을 저장하지 못했습니다:");
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
  // 헤드폰을 빼거나 기기를 연결하면 Windows가 모든 최상위 창에 알린다(WM_DEVICECHANGE).
  if (process.platform === "win32") win.hookWindowMessage(0x0219, () => scheduleAudioDeviceCheck());
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
    // 시작할 때 기본 출력 장치를 조용히 기억해 둔다.
    void refreshAudioDevice();
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
  if (volumeProc) {
    volumeProc.stdin.end();
    volumeProc.kill();
    volumeProc = null;
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
