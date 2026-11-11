import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Discord API가 IPv6로 먼저 붙었다가 멈추는 환경이 있어 IPv4를 먼저 쓴다.
dns.setDefaultResultOrder("ipv4first");

export interface DiscordVoice {
  // true일 때만 노치에 마이크 표시를 띄운다(음성 채널에 있을 때).
  inChannel: boolean;
  muted: boolean;
  deafened: boolean;
  // 내 계정이 지금 말하고 있는지. SPEAKING 이벤트가 끊겨도 풀리도록 시간제한을 둔다.
  speaking: boolean;
}

const OFFLINE: DiscordVoice = { inChannel: false, muted: false, deafened: false, speaking: false };

// Discord는 \\.\pipe\discord-ipc-0..9 를 순서대로 연다.
const PIPE_PREFIX = `${String.fromCharCode(92, 92, 46, 92)}pipe${String.fromCharCode(92)}discord-ipc-`;
const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

const REQUEST_TIMEOUT_MS = 8000;
const RECONNECT_MS = 5000;
// SPEAKING은 시작/끝 두 이벤트로 오지만 끝 이벤트를 놓칠 수 있어 스스로 만료시킨다.
const SPEAKING_HOLD_MS = 1200;

interface RpcMessage {
  cmd?: string;
  evt?: string;
  nonce?: string;
  data?: unknown;
}

interface DiscordConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface DiscordVoicePatch {
  mute?: boolean;
  deaf?: boolean;
}

export interface DiscordBridge {
  start: () => void;
  onVoice: (callback: (voice: DiscordVoice) => void) => () => void;
  // 디스코드 쪽 음소거를 바꾼다. 성공했을 때만 true.
  setVoice: (patch: DiscordVoicePatch) => Promise<boolean>;
  dispose: () => void;
}

const configPath = (appData: string): string => path.join(appData, "Notch", "discord.json");

function readConfig(appData: string): DiscordConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(appData), "utf8")) as Partial<DiscordConfig>;
    if (!raw.clientId || !raw.clientSecret || !raw.refreshToken) return null;
    return { clientId: raw.clientId, clientSecret: raw.clientSecret, refreshToken: raw.refreshToken };
  } catch {
    return null;
  }
}

function saveRefreshToken(appData: string, config: DiscordConfig, refreshToken: string): void {
  try {
    const next = { ...config, refreshToken };
    fs.mkdirSync(path.dirname(configPath(appData)), { recursive: true });
    fs.writeFileSync(configPath(appData), JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    // 저장에 실패해도 이번 실행은 계속한다.
  }
}

// refresh_token으로 access_token을 새로 받는다. 만료가 7일이라 실행 중에는 거의 쓰이지 않는다.
async function refreshAccessToken(config: DiscordConfig): Promise<{ token: string; refreshToken: string } | null> {
  try {
    const res = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: config.refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token?: string; refresh_token?: string };
    if (!body.access_token) return null;
    return { token: body.access_token, refreshToken: body.refresh_token ?? config.refreshToken };
  } catch {
    return null;
  }
}

function frame(op: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

export function createDiscordBridge(appData: string): DiscordBridge {
  let socket: net.Socket | null = null;
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;
  let buffer = Buffer.alloc(0);
  let uid = "";
  let speakingTimer: NodeJS.Timeout | null = null;
  let state: DiscordVoice = { ...OFFLINE };
  const pending = new Map<string, (data: unknown, failed: boolean) => void>();
  const listeners = new Set<(voice: DiscordVoice) => void>();

  const emit = (patch: Partial<DiscordVoice>) => {
    const next = { ...state, ...patch };
    if (
      next.inChannel === state.inChannel &&
      next.muted === state.muted &&
      next.deafened === state.deafened &&
      next.speaking === state.speaking
    ) {
      return;
    }
    state = next;
    for (const listener of listeners) listener(next);
  };

  // ERROR 응답과 타임아웃을 구분해야 하는 쓰기 명령을 위해 실패 여부를 함께 돌려준다.
  const send = (cmd: string, args: Record<string, unknown> = {}, evt?: string): Promise<{ data: unknown; failed: boolean }> => {
    const sock = socket;
    if (!sock) return Promise.resolve({ data: null, failed: true });
    const nonce = randomUUID();
    return new Promise((resolve) => {
      pending.set(nonce, (data, failed) => resolve({ data, failed }));
      try {
        sock.write(frame(OP_FRAME, { cmd, nonce, args, ...(evt ? { evt } : {}) }));
      } catch {
        pending.delete(nonce);
        resolve({ data: null, failed: true });
        return;
      }
      setTimeout(() => {
        if (pending.delete(nonce)) resolve({ data: null, failed: true });
      }, REQUEST_TIMEOUT_MS);
    });
  };

  const call = async (cmd: string, args: Record<string, unknown> = {}, evt?: string): Promise<unknown> => {
    const result = await send(cmd, args, evt);
    return result.failed ? null : result.data;
  };

  // 클릭 한 번에 RPC 한 번. 폴링도, 추가 프로세스도 없이 같은 소켓을 그대로 쓴다.
  const setVoice = async (patch: DiscordVoicePatch): Promise<boolean> => {
    const result = await send("SET_VOICE_SETTINGS", { ...patch });
    if (result.failed) {
      // 왜 거절됐는지 한 줄만 남긴다(스코프 부족 등). 성공 경로는 조용히 둔다.
      console.warn("discord: SET_VOICE_SETTINGS 실패", JSON.stringify(result.data));
      return false;
    }
    // 확인 이벤트가 오기 전에 화면이 먼저 반응하도록 바로 반영한다.
    emit({
      ...(typeof patch.mute === "boolean" ? { muted: patch.mute } : {}),
      ...(typeof patch.deaf === "boolean" ? { deafened: patch.deaf } : {}),
    });
    return true;
  };

  const applyVoiceSettings = (data: unknown) => {
    if (!data || typeof data !== "object") return;
    const settings = "voice_settings" in data ? (data as { voice_settings: unknown }).voice_settings : data;
    if (!settings || typeof settings !== "object") return;
    const value = settings as { mute?: unknown; deaf?: unknown };
    if (typeof value.mute === "boolean" || typeof value.deaf === "boolean") {
      emit({
        muted: typeof value.mute === "boolean" ? value.mute : state.muted,
        deafened: typeof value.deaf === "boolean" ? value.deaf : state.deafened,
      });
    }
  };

  const applySpeaking = (data: unknown, speaking: boolean) => {
    if (!data || typeof data !== "object") return;
    const value = data as { user_id?: unknown };
    if (uid && value.user_id !== uid) return;
    if (typeof value.user_id !== "string") return;
    emit({ speaking });
    if (speakingTimer) clearTimeout(speakingTimer);
    speakingTimer = null;
    if (speaking) {
      // 끝 이벤트를 놓쳐도 표시가 계속 켜져 있지 않게 한다.
      speakingTimer = setTimeout(() => emit({ speaking: false }), SPEAKING_HOLD_MS);
    }
  };

  // 채널 객체는 id로 오고, VOICE_CHANNEL_SELECT 이벤트는 channel_id로 온다. 둘 다 받는다.
  const channelId = (data: unknown): string => {
    if (!data || typeof data !== "object") return "";
    const value = data as { id?: unknown; channel_id?: unknown };
    const id = typeof value.channel_id === "string" ? value.channel_id : value.id;
    return typeof id === "string" ? id : "";
  };

  const subscribeSpeaking = (channel: string) => {
    if (!channel) return;
    void call("SUBSCRIBE", { channel_id: channel }, "SPEAKING_START");
    void call("SUBSCRIBE", { channel_id: channel }, "SPEAKING_STOP");
  };

  const refreshChannel = async () => {
    const channel = await call("GET_SELECTED_VOICE_CHANNEL");
    const id = channelId(channel);
    emit({ inChannel: id.length > 0, speaking: false });
    if (id) subscribeSpeaking(id);
  };

  const handleFrame = (op: number, payload: string) => {
    if (op === OP_PING) {
      try {
        socket?.write(frame(OP_PONG, JSON.parse(payload)));
      } catch {
        // 무시
      }
      return;
    }
    if (op !== OP_FRAME) return;
    let message: RpcMessage | null;
    try {
      message = JSON.parse(payload) as RpcMessage;
    } catch {
      return;
    }
    if (!message) return;
    if (message.nonce && pending.has(message.nonce)) {
      const resolve = pending.get(message.nonce);
      pending.delete(message.nonce);
      // ERROR 응답은 상태를 바꾸지 않고, 오류 본문은 호출한 쪽이 읽을 수 있게 남긴다.
      const failed = message.evt === "ERROR";
      resolve?.(message.data ?? null, failed);
      return;
    }
    if (message.evt === "READY") {
      const user = (message.data as { user?: { id?: string } } | null)?.user;
      if (user?.id) uid = user.id;
      return;
    }
    if (message.evt === "VOICE_SETTINGS_UPDATE") {
      applyVoiceSettings(message.data);
      return;
    }
    if (message.evt === "SPEAKING_START" || message.evt === "SPEAKING_STOP") {
      applySpeaking(message.data, message.evt === "SPEAKING_START");
      return;
    }
    if (message.evt === "VOICE_CHANNEL_SELECT") {
      const id = channelId(message.data);
      if (!id && speakingTimer) clearTimeout(speakingTimer);
      if (!id) speakingTimer = null;
      emit({ inChannel: id.length > 0, speaking: false });
      if (id) subscribeSpeaking(id);
      return;
    }
  };

  const connectToPipe = (index: number): Promise<net.Socket | null> =>
    new Promise((resolve) => {
      const sock = net.connect(`${PIPE_PREFIX}${index}`);
      let settled = false;
      sock.once("connect", () => {
        settled = true;
        resolve(sock);
      });
      sock.once("error", () => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve(null);
      });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve(null);
      }, 600);
    });

  const scheduleReconnect = () => {
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, RECONNECT_MS);
  };

  const teardown = () => {
    socket?.destroy();
    socket = null;
    buffer = Buffer.alloc(0);
    uid = "";
    pending.clear();
    if (speakingTimer) clearTimeout(speakingTimer);
    speakingTimer = null;
    state = { ...OFFLINE };
    for (const listener of listeners) listener(state);
  };

  const connect = async () => {
    if (disposed || socket) return;
    const config = readConfig(appData);
    // 설정이 없으면 Discord를 쓰지 않는 것으로 보고 조용히 쉰다.
    if (!config) {
      scheduleReconnect();
      return;
    }
    let sock: net.Socket | null = null;
    for (let i = 0; i < 10 && !sock; i++) sock = await connectToPipe(i);
    if (!sock) {
      // Discord가 꺼져 있으면 잠시 뒤 다시 시도한다.
      scheduleReconnect();
      return;
    }
    socket = sock;
    buffer = Buffer.alloc(0);
    sock.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const op = buffer.readInt32LE(0);
        const len = buffer.readInt32LE(4);
        if (buffer.length < 8 + len) break;
        const payload = buffer.subarray(8, 8 + len).toString("utf8");
        buffer = buffer.subarray(8 + len);
        handleFrame(op, payload);
      }
    });
    const onGone = () => {
      if (socket !== sock) return;
      teardown();
      scheduleReconnect();
    };
    sock.on("close", onGone);
    sock.on("error", onGone);

    try {
      sock.write(frame(OP_HANDSHAKE, { v: 1, client_id: config.clientId }));
    } catch {
      onGone();
      return;
    }
    // READY를 기다린 뒤 토큰을 갱신해 인증한다.
    await new Promise((r) => setTimeout(r, 700));
    const token = await refreshAccessToken(config);
    if (!token) {
      // 갱신 실패(비밀번호 변경·승인 취소 등)면 표시하지 않는다.
      teardown();
      scheduleReconnect();
      return;
    }
    if (token.refreshToken !== config.refreshToken) saveRefreshToken(appData, config, token.refreshToken);
    await call("AUTHENTICATE", { access_token: token.token });
    await call("GET_VOICE_SETTINGS").then(applyVoiceSettings);
    // 음성 이벤트 구독. 실패해도 mute 표시는 계속 동작한다.
    void call("SUBSCRIBE", {}, "VOICE_SETTINGS_UPDATE");
    void call("SUBSCRIBE", {}, "VOICE_CHANNEL_SELECT");
    await refreshChannel();
    state = { ...state };
  };

  return {
    start() {
      if (disposed) return;
      void connect();
    },
    onVoice(callback) {
      listeners.add(callback);
      callback(state);
      return () => {
        listeners.delete(callback);
      };
    },
    setVoice,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      teardown();
      listeners.clear();
    },
  };
}
