// Notch 오디오 사이드카. Windows Core Audio를 C#에서 직접 다루고, Electron과는
// 표준입출력 한 줄 프로토콜로 대화한다. PowerShell + Add-Type을 매번 컴파일하던
// 비용(첫 호출 1~2초)을 없애고, 기본 출력 장치 변경을 이벤트로 즉시 알린다.
//
// 요청: "<id> state"            응답: "<id> ok level=72;muted=0;deviceId=..;deviceName=.."    // 요청: "<id> apps"             응답: "<id> ok pid,level,muted,peak,name|..."
    // 요청: "<id> peaks"            응답: "<id> ok pid,peak|..." (미터용, 이름 조회 없음)
// 요청: "<id> master.set 40"    응답: "<id> ok"
// 요청: "<id> master.mute 1"    응답: "<id> ok"
// 요청: "<id> app.set 1234 40"  응답: "<id> ok"
// 요청: "<id> app.mute 1234 1"  응답: "<id> ok"
// 이벤트: "event device <deviceId>|<name>"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace NotchAudio
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumerator
    {
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice(string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    // 메서드는 vtable 순서대로 선언해야 한다. 쓰지 않는 항목도 자리를 채운다.
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
        [PreserveSig] int GetId(out IntPtr id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioEndpointVolume
    {
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

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int streamFlags, out IntPtr sessionControl);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int streamFlags, out IntPtr sessionVolume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator enumerator);
        [PreserveSig] int RegisterSessionNotification(IntPtr notify);
        [PreserveSig] int UnregisterSessionNotification(IntPtr notify);
        [PreserveSig] int RegisterDuckNotification(IntPtr sessionId, IntPtr notify);
        [PreserveSig] int UnregisterDuckNotification(IntPtr notify);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, out IAudioSessionControl2 control);
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl2
    {
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
    internal interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float level, Guid context);
        [PreserveSig] int GetMasterVolume(out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid context);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    // WASAPI 루프백 캡처. 정렬기(가사 싱크)용 PCM을 파일로 떨군다.
    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, out IntPtr service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out int flags, out long devicePosition, out long qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    // 세션의 실제 출력 레벨(0~1). 앱별 미터를 그리는 데 쓴다.
    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioMeterInformation
    {
        [PreserveSig] int GetPeakValue(out float peak);
        [PreserveSig] int GetMeteringChannelCount(out int count);
        [PreserveSig] int GetChannelsPeakValues(int count, [Out] float[] peaks);
        [PreserveSig] int QueryHardwareSupport(out int mask);
    }

    // 기본 출력 장치가 바뀌면 Windows가 이 인터페이스로 알려 준다(이벤트 기반).
    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY
    {
        public Guid fmtid;
        public int pid;
    }

    [ComVisible(true)]
    [Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMNotificationClient
    {
        [PreserveSig] int OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int newState);
        [PreserveSig] int OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string deviceId);
        [PreserveSig] int OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string deviceId);
        [PreserveSig] int OnDefaultDeviceChanged(int flow, int role, [MarshalAs(UnmanagedType.LPWStr)] string defaultDeviceId);
        [PreserveSig] int OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)] string deviceId, PROPERTYKEY key);
    }

    internal sealed class SessionInfo
    {
        public int Pid;
        public int Level;
        public bool Muted;
        public float Peak;
        public string Name;
    }

    [ComVisible(true)]
    public sealed class DeviceWatcher : IMMNotificationClient
    {
        public int OnDeviceStateChanged(string deviceId, int newState)
        {
            Program.NotifyDevice();
            return 0;
        }

        public int OnDeviceAdded(string deviceId)
        {
            Program.NotifyDevice();
            return 0;
        }

        public int OnDeviceRemoved(string deviceId)
        {
            Program.NotifyDevice();
            return 0;
        }

        // flow 0 = 렌더(출력), role 1 = eMultimedia. 기본 출력이 바뀔 때만 알린다.
        public int OnDefaultDeviceChanged(int flow, int role, string defaultDeviceId)
        {
            if (flow == 0 && role == 1) Program.NotifyDevice();
            return 0;
        }

        public int OnPropertyValueChanged(string deviceId, PROPERTYKEY key)
        {
            return 0;
        }
    }

    internal static class Audio
    {
        private static IAudioEndpointVolume _endpoint;
        private static DateTime _endpointAt = DateTime.MinValue;
        private static readonly Dictionary<string, string> NameCache = new Dictionary<string, string>();

        // 기본 출력 객체는 5초 동안 재사용한다(초당 여러 번 읽어도 부담이 없게).
        private static IAudioEndpointVolume Endpoint()
        {
            if (_endpoint != null && (DateTime.UtcNow - _endpointAt).TotalSeconds < 5) return _endpoint;
            MMDeviceEnumerator factory = new MMDeviceEnumerator();
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)factory;
            IMMDevice device;
            Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
            Guid iid = typeof(IAudioEndpointVolume).GUID;
            object instance;
            Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out instance));
            _endpoint = (IAudioEndpointVolume)instance;
            _endpointAt = DateTime.UtcNow;
            return _endpoint;
        }

        public static void Forget()
        {
            _endpoint = null;
            _endpointAt = DateTime.MinValue;
        }

        public static void MasterRead(out int level, out bool muted)
        {
            try
            {
                float scalar;
                bool mute;
                Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out scalar));
                Marshal.ThrowExceptionForHR(Endpoint().GetMute(out mute));
                level = (int)Math.Round(Math.Max(0f, Math.Min(1f, scalar)) * 100f);
                muted = mute;
            }
            catch
            {
                Forget();
                throw;
            }
        }

        public static void MasterSet(int percent)
        {
            try
            {
                float level = Math.Max(0, Math.Min(100, percent)) / 100f;
                Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(level, Guid.Empty));
            }
            catch
            {
                Forget();
                throw;
            }
        }

        public static void MasterMute(bool muted)
        {
            try
            {
                Marshal.ThrowExceptionForHR(Endpoint().SetMute(muted, Guid.Empty));
            }
            catch
            {
                Forget();
                throw;
            }
        }

        // 기본 출력 장치의 엔드포인트 ID. 장치가 바뀌었는지 비교하는 데 쓴다.
        public static string DefaultDeviceId()
        {
            MMDeviceEnumerator factory = new MMDeviceEnumerator();
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)factory;
            IMMDevice device;
            Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
            IntPtr id;
            Marshal.ThrowExceptionForHR(device.GetId(out id));
            try
            {
                return Marshal.PtrToStringUni(id);
            }
            finally
            {
                Marshal.FreeCoTaskMem(id);
            }
        }

        // 표시 이름은 같은 기기의 레지스트리 속성(FriendlyName)에서 읽는다.
        public static string DeviceName(string deviceId)
        {
            if (string.IsNullOrEmpty(deviceId)) return "";
            string name;
            if (NameCache.TryGetValue(deviceId, out name)) return name;
            name = "";
            try
            {
                string key = deviceId;
                int brace = deviceId.LastIndexOf('{');
                if (brace > 0) key = deviceId.Substring(brace);
                using (RegistryKey props = Registry.LocalMachine.OpenSubKey(
                    @"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render\" + key + @"\Properties"))
                {
                    if (props != null)
                    {
                        object value = props.GetValue("{a45c254e-df1c-4efd-8020-67d146a850e0},2");
                        if (value != null) name = value.ToString();
                    }
                }
            }
            catch
            {
                name = "";
            }
            NameCache[deviceId] = name;
            return name;
        }

        private static IAudioSessionEnumerator OpenSessions()
        {
            MMDeviceEnumerator factory = new MMDeviceEnumerator();
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)factory;
            IMMDevice device;
            Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
            Guid iid = typeof(IAudioSessionManager2).GUID;
            object manager;
            Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out manager));
            IAudioSessionManager2 sessions = (IAudioSessionManager2)manager;
            IAudioSessionEnumerator list;
            Marshal.ThrowExceptionForHR(sessions.GetSessionEnumerator(out list));
            return list;
        }

        private static string ProcessName(int pid)
        {
            try
            {
                return Process.GetProcessById(pid).ProcessName;
            }
            catch
            {
                return "app";
            }
        }

        // 현재 소리를 내는(Active) 세션만 프로세스별로 하나씩 모은다.
        public static List<SessionInfo> Sessions()
        {
            List<SessionInfo> result = new List<SessionInfo>();
            IAudioSessionEnumerator list = OpenSessions();
            int count;
            if (list.GetCount(out count) != 0) return result;
            List<int> seen = new List<int>();
            for (int i = 0; i < count; i++)
            {
                IAudioSessionControl2 control;
                if (list.GetSession(i, out control) != 0 || control == null) continue;
                try
                {
                    int state;
                    if (control.GetState(out state) != 0 || state != 1) continue;
                    if (control.IsSystemSoundsSession() == 0) continue;
                    uint processId;
                    if (control.GetProcessId(out processId) != 0 || processId == 0) continue;
                    int pid = (int)processId;
                    if (seen.Contains(pid)) continue;
                    ISimpleAudioVolume volume = control as ISimpleAudioVolume;
                    if (volume == null) continue;
                    float level;
                    if (volume.GetMasterVolume(out level) != 0) continue;
                    bool muted;
                    if (volume.GetMute(out muted) != 0) muted = false;
                    float peak = 0f;
                    IAudioMeterInformation meter = control as IAudioMeterInformation;
                    if (meter != null) meter.GetPeakValue(out peak);
                    seen.Add(pid);
                    SessionInfo info = new SessionInfo();
                    info.Pid = pid;
                    info.Level = (int)Math.Round(Math.Max(0f, Math.Min(1f, level)) * 100f);
                    info.Muted = muted;
                    info.Peak = Math.Max(0f, Math.Min(1f, peak));
                    info.Name = ProcessName(pid);
                    result.Add(info);
                }
                finally
                {
                    Marshal.ReleaseComObject(control);
                }
            }
            Marshal.ReleaseComObject(list);
            return result;
        }

        // 미터용으로 세션의 피크만 빠르게 모은다. 프로세스 이름 조회는 하지 않는다.
        public static List<SessionInfo> Peaks()
        {
            List<SessionInfo> result = new List<SessionInfo>();
            IAudioSessionEnumerator list = OpenSessions();
            int count;
            if (list.GetCount(out count) != 0) return result;
            List<int> seen = new List<int>();
            for (int i = 0; i < count; i++)
            {
                IAudioSessionControl2 control;
                if (list.GetSession(i, out control) != 0 || control == null) continue;
                try
                {
                    int state;
                    if (control.GetState(out state) != 0 || state != 1) continue;
                    if (control.IsSystemSoundsSession() == 0) continue;
                    uint processId;
                    if (control.GetProcessId(out processId) != 0 || processId == 0) continue;
                    int pid = (int)processId;
                    if (seen.Contains(pid)) continue;
                    IAudioMeterInformation meter = control as IAudioMeterInformation;
                    if (meter == null) continue;
                    float peak;
                    if (meter.GetPeakValue(out peak) != 0) peak = 0f;
                    seen.Add(pid);
                    SessionInfo info = new SessionInfo();
                    info.Pid = pid;
                    info.Peak = Math.Max(0f, Math.Min(1f, peak));
                    result.Add(info);
                }
                finally
                {
                    Marshal.ReleaseComObject(control);
                }
            }
            Marshal.ReleaseComObject(list);
            return result;
        }

        private static void ApplyToSession(int target, int percent, int mute)
        {
            IAudioSessionEnumerator list = OpenSessions();
            int count;
            if (list.GetCount(out count) != 0) return;
            for (int i = 0; i < count; i++)
            {
                IAudioSessionControl2 control;
                if (list.GetSession(i, out control) != 0 || control == null) continue;
                try
                {
                    uint processId;
                    if (control.GetProcessId(out processId) != 0 || (int)processId != target) continue;
                    ISimpleAudioVolume volume = control as ISimpleAudioVolume;
                    if (volume == null) continue;
                    if (percent >= 0)
                    {
                        float level = Math.Max(0, Math.Min(100, percent)) / 100f;
                        volume.SetMasterVolume(level, Guid.Empty);
                    }
                    if (mute >= 0) volume.SetMute(mute == 1, Guid.Empty);
                }
                finally
                {
                    Marshal.ReleaseComObject(control);
                }
            }
            Marshal.ReleaseComObject(list);
        }

        public static void SessionSet(int pid, int percent)
        {
            ApplyToSession(pid, percent, -1);
        }

        public static void SessionMute(int pid, bool muted)
        {
            ApplyToSession(pid, -1, muted ? 1 : 0);
        }


    }

    internal static class Program
    {
        private static readonly object WriteLock = new object();
        private static IMMDeviceEnumerator _enumerator;
        private static IntPtr _watcherPtr = IntPtr.Zero;
        private static string _lastDeviceId = "";

        private static int Main(string[] args)
        {
            try
            {
                Console.OutputEncoding = Encoding.UTF8;
            }
            catch
            {
                // 콘솔 인코딩을 바꾸지 못해도 계속한다.
            }
            RegisterDeviceWatcher();
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;
                string[] parts = line.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length == 0) continue;
                string id = parts[0];
                string command = parts.Length > 1 ? parts[1] : "";
                try
                {
                    string payload = Execute(command, parts);
                    Reply(id, "ok", payload);
                }
                catch (Exception error)
                {
                    Reply(id, "err", error.Message.Replace('\n', ' '));
                }
                if (command == "quit") break;
            }
            UnregisterDeviceWatcher();
            return 0;
        }

        private static string Execute(string command, string[] parts)
        {
            switch (command)
            {
                case "state":
                    return StatePayload();
                case "apps":
                    return AppsPayload();
                case "peaks":
                    return PeaksPayload();
                case "master.set":
                    Audio.MasterSet(IntArg(parts, 2));
                    return "";
                case "master.mute":
                    Audio.MasterMute(BoolArg(parts, 2));
                    return "";
                case "app.set":
                    Audio.SessionSet(IntArg(parts, 2), IntArg(parts, 3));
                    return "";
                case "app.mute":
                    Audio.SessionMute(IntArg(parts, 2), BoolArg(parts, 3));
                    return "";
                case "device":
                    return DevicePayload(Audio.DefaultDeviceId());
                case "ping":
                    return "pong";
                case "quit":
                    return "";
                default:
                    throw new ArgumentException("unknown command");
            }
        }

        private static int IntArg(string[] parts, int index)
        {
            if (parts.Length <= index) throw new ArgumentException("missing argument");
            return int.Parse(parts[index], CultureInfo.InvariantCulture);
        }

        private static bool BoolArg(string[] parts, int index)
        {
            return IntArg(parts, index) != 0;
        }

        private static string StatePayload()
        {
            int level;
            bool muted;
            Audio.MasterRead(out level, out muted);
            string deviceId = Audio.DefaultDeviceId();
            return "level=" + level.ToString(CultureInfo.InvariantCulture)
                + ";muted=" + (muted ? "1" : "0")
                + ";deviceId=" + deviceId
                + ";deviceName=" + Audio.DeviceName(deviceId);
        }

        private static string AppsPayload()
        {
            List<SessionInfo> sessions = Audio.Sessions();
            StringBuilder builder = new StringBuilder();
            for (int i = 0; i < sessions.Count; i++)
            {
                SessionInfo session = sessions[i];
                if (i > 0) builder.Append('|');
                builder.Append(session.Pid.ToString(CultureInfo.InvariantCulture));
                builder.Append(',');
                builder.Append(session.Level.ToString(CultureInfo.InvariantCulture));
                builder.Append(',');
                builder.Append(session.Muted ? '1' : '0');
                builder.Append(',');
                builder.Append(session.Peak.ToString("0.00", CultureInfo.InvariantCulture));
                builder.Append(',');
                builder.Append(session.Name);
            }
            return builder.ToString();
        }

        // 별도 명령으로 피크만 돌려줘, 미터를 자주 읽어도 이름·음량 조회를 반복하지 않는다.
        private static string PeaksPayload()
        {
            List<SessionInfo> peaks = Audio.Peaks();
            StringBuilder builder = new StringBuilder();
            for (int i = 0; i < peaks.Count; i++)
            {
                if (i > 0) builder.Append('|');
                builder.Append(peaks[i].Pid.ToString(CultureInfo.InvariantCulture));
                builder.Append(',');
                builder.Append(peaks[i].Peak.ToString("0.00", CultureInfo.InvariantCulture));
            }
            return builder.ToString();
        }

        private static string DevicePayload(string deviceId)
        {
            return deviceId + "|" + Audio.DeviceName(deviceId);
        }

        private static void RegisterDeviceWatcher()
        {
            try
            {
                DeviceWatcher watcher = new DeviceWatcher();
                _watcherPtr = Marshal.GetComInterfaceForObject(watcher, typeof(IMMNotificationClient));
                MMDeviceEnumerator factory = new MMDeviceEnumerator();
                _enumerator = (IMMDeviceEnumerator)factory;
                Marshal.ThrowExceptionForHR(_enumerator.RegisterEndpointNotificationCallback(_watcherPtr));
                _lastDeviceId = Audio.DefaultDeviceId();
            }
            catch
            {
                _enumerator = null;
                _watcherPtr = IntPtr.Zero;
            }
        }

        private static void UnregisterDeviceWatcher()
        {
            try
            {
                if (_enumerator != null && _watcherPtr != IntPtr.Zero)
                {
                    _enumerator.UnregisterEndpointNotificationCallback(_watcherPtr);
                }
            }
            catch
            {
                // 종료 중에는 실패해도 무시한다.
            }
            finally
            {
                if (_watcherPtr != IntPtr.Zero) Marshal.Release(_watcherPtr);
                _watcherPtr = IntPtr.Zero;
                _enumerator = null;
            }
        }

        // 콜백 스레드에서 불린다. 기본 출력 장치가 실제로 바뀌었을 때만 한 번 알린다.
        internal static void NotifyDevice()
        {
            try
            {
                Audio.Forget();
                string id = Audio.DefaultDeviceId();
                if (id == _lastDeviceId) return;
                _lastDeviceId = id;
                Write("event device " + DevicePayload(id));
            }
            catch
            {
                // 장치를 읽지 못하면 다음 변경 때 다시 시도한다.
            }
        }

        private static void Reply(string id, string status, string payload)
        {
            string text = id + " " + status;
            if (!string.IsNullOrEmpty(payload)) text += " " + payload;
            Write(text);
        }

        private static void Write(string text)
        {
            lock (WriteLock)
            {
                Console.Out.WriteLine(text);
                Console.Out.Flush();
            }
        }
    }
}
