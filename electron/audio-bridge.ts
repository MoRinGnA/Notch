import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

// 사이드카와의 한 줄 프로토콜: "<id> <cmd> [args]" → "<id> ok [payload]" / "<id> err <message>"
// 이벤트는 "event device <deviceId>|<name>" 형태로 id 없이 온다.

export interface AudioDevice {
  id: string;
  name: string;
}

export interface AudioMaster {
  level: number;
  muted: boolean;
  device: AudioDevice | null;
}

export interface AudioApp {
  pid: number;
  name: string;
  level: number;
  muted: boolean;
  peak: number;
}

// 미터용 피크 한 개. 앱 목록(apps)과 따로 조회해 자주 읽어도 가볍다.
export interface AudioPeak {
  pid: number;
  peak: number;
}

export interface AudioBridge {
  start: () => void;
  state: () => Promise<AudioMaster | null>;
  apps: () => Promise<AudioApp[]>;
  peaks: () => Promise<AudioPeak[]>;
  setMasterLevel: (level: number) => Promise<boolean>;
  setMasterMuted: (muted: boolean) => Promise<boolean>;
  setAppLevel: (pid: number, level: number) => Promise<boolean>;
  setAppMuted: (pid: number, muted: boolean) => Promise<boolean>;
  onDevice: (callback: (device: AudioDevice) => void) => () => void;
  // 가사 정렬용 루프백 녹음. 시작하면 샘플레이트를, 중지하면 쓴 바이트 수를 돌려준다.
  beginCapture: (file: string) => Promise<number | null>;
  endCapture: () => Promise<number>;
  dispose: () => void;
}

interface Pending {
  resolve: (payload: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

// 요청 하나는 이 시간 안에 답이 와야 한다. 넘으면 그 요청만 실패로 정리한다.
const REQUEST_TIMEOUT_MS = 2500;

function parseDevice(id: string, name: string): AudioDevice | null {
  if (!id) return null;
  return { id, name: name.trim() || "출력 장치" };
}

function parseState(payload: string): AudioMaster | null {
  const fields = new Map<string, string>();
  // deviceName은 마지막이라 값 안에 ';'가 있어도 안전하게 남은 문자열을 통째로 쓴다.
  const nameIndex = payload.indexOf(";deviceName=");
  const head = nameIndex >= 0 ? payload.slice(0, nameIndex) : payload;
  for (const entry of head.split(";")) {
    const split = entry.indexOf("=");
    if (split > 0) fields.set(entry.slice(0, split), entry.slice(split + 1));
  }
  const level = Number.parseInt(fields.get("level") ?? "", 10);
  if (!Number.isFinite(level)) return null;
  const device = parseDevice(fields.get("deviceId") ?? "", nameIndex >= 0 ? payload.slice(nameIndex + ";deviceName=".length) : "");
  return { level: Math.max(0, Math.min(100, level)), muted: fields.get("muted") === "1", device };
}

function parseApps(payload: string): AudioApp[] {
  const apps: AudioApp[] = [];
  if (!payload) return apps;
  for (const entry of payload.split("|")) {
    // pid,level,muted,peak,name — 이름이 마지막이라 쉼표가 있어도 남은 문자열을 쓴다.
    const fields = entry.split(",");
    if (fields.length < 5) continue;
    const pid = Number.parseInt(fields[0], 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const level = Number.parseInt(fields[1], 10);
    const peak = Number.parseFloat(fields[3]);
    apps.push({
      pid,
      level: Number.isFinite(level) ? Math.max(0, Math.min(100, level)) : 0,
      muted: fields[2] === "1",
      peak: Number.isFinite(peak) ? Math.max(0, Math.min(1, peak)) : 0,
      name: fields.slice(4).join(",").trim() || "app",
    });
  }
  return apps;
}

function parsePeaks(payload: string): AudioPeak[] {
  const peaks: AudioPeak[] = [];
  if (!payload) return peaks;
  for (const entry of payload.split("|")) {
    const comma = entry.indexOf(",");
    if (comma < 0) continue;
    const pid = Number.parseInt(entry.slice(0, comma), 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const peak = Number.parseFloat(entry.slice(comma + 1));
    peaks.push({ pid, peak: Number.isFinite(peak) ? Math.max(0, Math.min(1, peak)) : 0 });
  }
  return peaks;
}

export function createAudioBridge(exePath: string): AudioBridge {
  let proc: ChildProcessWithoutNullStreams | null = null;
  let buffer = "";
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const deviceListeners = new Set<(device: AudioDevice) => void>();

  const failPending = (error: Error) => {
    const entries = [...pending.values()];
    pending.clear();
    for (const request of entries) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  };

  const handleLine = (line: string) => {
    if (line.startsWith("event device ")) {
      const [id, ...name] = line.slice("event device ".length).split("|");
      const device = parseDevice(id, name.join("|"));
      if (device) for (const listener of deviceListeners) listener(device);
      return;
    }
    const space = line.indexOf(" ");
    if (space < 0) return;
    const requestId = Number.parseInt(line.slice(0, space), 10);
    if (!Number.isFinite(requestId)) return;
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    clearTimeout(request.timer);
    const rest = line.slice(space + 1);
    if (rest === "ok") request.resolve("");
    else if (rest.startsWith("ok ")) request.resolve(rest.slice(3));
    else request.reject(new Error(rest.replace(/^err\s*/, "") || "audio bridge error"));
  };

  const start = () => {
    if (proc) return;
    const child = spawn(exePath, [], { windowsHide: true, stdio: "pipe" });
    proc = child;
    buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) handleLine(line);
        index = buffer.indexOf("\n");
      }
    });
    child.on("error", (error) => {
      if (proc !== child) return;
      proc = null;
      failPending(error as Error);
    });
    child.on("exit", (code) => {
      if (proc !== child) return;
      proc = null;
      failPending(new Error(`audio bridge exited (${code})`));
    });
  };

  const request = (command: string): Promise<string> => {
    start();
    const child = proc;
    if (!child) return Promise.reject(new Error("audio bridge unavailable"));
    const id = nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("audio bridge timeout"));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${id} ${command}\n`);
    });
  };

  const run = async (command: string): Promise<boolean> => {
    try {
      await request(command);
      return true;
    } catch {
      return false;
    }
  };

  return {
    start,
    async state() {
      try {
        return parseState(await request("state"));
      } catch {
        return null;
      }
    },
    async apps() {
      try {
        return parseApps(await request("apps"));
      } catch {
        return [];
      }
    },
    async peaks() {
      try {
        return parsePeaks(await request("peaks"));
      } catch {
        return [];
      }
    },
    setMasterLevel(level: number) {
      return run(`master.set ${Math.max(0, Math.min(100, Math.round(level)))}`);
    },
    setMasterMuted(muted: boolean) {
      return run(`master.mute ${muted ? 1 : 0}`);
    },
    setAppLevel(pid: number, level: number) {
      return run(`app.set ${Math.round(pid)} ${Math.max(0, Math.min(100, Math.round(level)))}`);
    },
    setAppMuted(pid: number, muted: boolean) {
      return run(`app.mute ${Math.round(pid)} ${muted ? 1 : 0}`);
    },
    onDevice(callback) {
      deviceListeners.add(callback);
      return () => {
        deviceListeners.delete(callback);
      };
    },
    async beginCapture(file: string) {
      try {
        const payload = await request(`pcm.begin ${file}`);
        const rate = Number.parseInt(payload.replace(/^rate=/, ""), 10);
        return Number.isFinite(rate) && rate > 0 ? rate : null;
      } catch {
        return null;
      }
    },
    async endCapture() {
      try {
        const payload = await request("pcm.stop");
        const bytes = Number.parseInt(payload.replace(/^bytes=/, ""), 10);
        return Number.isFinite(bytes) ? bytes : 0;
      } catch {
        return 0;
      }
    },
    dispose() {
      const child = proc;
      proc = null;
      failPending(new Error("audio bridge stopped"));
      if (!child) return;
      try {
        child.stdin.write(`${nextId++} quit\n`);
      } catch {
        // 이미 닫혔으면 그냥 정리한다.
      }
      // 응답을 기다리지 않고 잠깐 뒤 정리한다(좀비 프로세스를 남기지 않게).
      setTimeout(() => {
        if (!child.killed) child.kill();
      }, 300);
    },
  };
}
