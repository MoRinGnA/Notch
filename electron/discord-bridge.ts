import dns from "node:dns";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { readDiscordConfig, writeDiscordConfig } from "./discord-config";

// Discord API가 IPv6로 먼저 붙었다가 멈추는 환경이 있어 IPv4를 먼저 쓴다.
dns.setDefaultResultOrder("ipv4first");

export interface DiscordVoiceMember {
  id: string;
  name: string;
  // 마이크가 꺼져 있는지(스스로 끈 경우와 서버에서 끈 경우를 모두 포함).
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  self: boolean;
}

export interface DiscordVoice {
  // true일 때만 노치에 마이크 표시를 띄운다(음성 채널에 있을 때).
  inChannel: boolean;
  muted: boolean;
  deafened: boolean;
  // 내 계정이 지금 말하고 있는지. SPEAKING 이벤트가 끊겨도 풀리도록 시간제한을 둔다.
  speaking: boolean;
  // 지금 들어가 있는 채널 이름(모르면 빈 문자열).
  channel: string;
  // 같은 채널에 있는 사람들. 들어오고 나가는 즉시 갱신된다.
  members: DiscordVoiceMember[];
}

const OFFLINE: DiscordVoice = {
  inChannel: false,
  muted: false,
  deafened: false,
  speaking: false,
  channel: "",
  members: [],
};

interface RawVoiceState {
  channel_id?: unknown;
  nick?: unknown;
  mute?: unknown;
  deaf?: unknown;
  user?: { id?: unknown; global_name?: unknown; username?: unknown };
  voice_state?: { self_mute?: unknown; self_deaf?: unknown; mute?: unknown; deaf?: unknown };
}

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

export interface DiscordVoicePatch {
  mute?: boolean;
  deaf?: boolean;
}

export interface DiscordBridge {
  start: () => void;
  onVoice: (callback: (voice: DiscordVoice) => void) => () => void;
  // 디스코드 쪽 음소거를 바꾼다. 성공했을 때만 true.
  setVoice: (patch: DiscordVoicePatch) => Promise<boolean>;
  // 인증 정보를 새로 받은 뒤 기존 소켓 대신 새로 붙는다(연결 절차 직후).
  restart: () => void;
  dispose: () => void;
}

// refresh_token으로 access_token을 새로 받는다. 만료가 7일이라 실행 중에는 거의 쓰이지 않는다.
async function refreshAccessToken(config: { clientId: string; clientSecret: string; refreshToken: string }): Promise<{ token: string; refreshToken: string } | null> {
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
  // 사람별 발화 표시 만료 타이머. 이벤트가 올 때만 만진다(폴링 아님).
  const speakingTimers = new Map<string, NodeJS.Timeout>();
  // 지금 들어가 있는 채널 id. 다른 채널의 이벤트는 무시한다.
  let currentChannel = "";
  let state: DiscordVoice = { ...OFFLINE };
  const pending = new Map<string, (data: unknown, failed: boolean) => void>();
  const listeners = new Set<(voice: DiscordVoice) => void>();

  // 멤버 목록까지 비교해야 하므로 값 전체를 한 줄로 요약해 같은지 본다(이벤트가 있을 때만 계산).
  const signature = (voice: DiscordVoice): string =>
    [
      voice.inChannel ? 1 : 0,
      voice.muted ? 1 : 0,
      voice.deafened ? 1 : 0,
      voice.speaking ? 1 : 0,
      voice.channel,
      ...voice.members.map(
        (m) => `${m.id}:${m.name}:${m.muted ? 1 : 0}${m.deafened ? 1 : 0}${m.speaking ? 1 : 0}`,
      ),
    ].join("|");

  const emit = (patch: Partial<DiscordVoice>) => {
    const next = { ...state, ...patch };
    if (signature(next) === signature(state)) return;
    state = next;
    for (const listener of listeners) listener(next);
  };

  // 채널 객체의 voice_states 항목을 화면에서 쓸 수 있는 모양으로 바꾼다.
  const parseMember = (raw: unknown): DiscordVoiceMember | null => {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as RawVoiceState;
    const id = typeof value.user?.id === "string" ? value.user.id : "";
    if (!id) return null;
    // 서버 별명이 있으면 그걸, 없으면 표시 이름, 그다음 계정 이름 순으로 쓴다.
    const name =
      [value.nick, value.user?.global_name, value.user?.username].find(
        (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
      ) ?? "?";
    const flags = value.voice_state ?? {};
    return {
      id,
      name,
      muted: flags.self_mute === true || flags.mute === true || value.mute === true,
      deafened: flags.self_deaf === true || flags.deaf === true || value.deaf === true,
      speaking: false,
      self: !!uid && id === uid,
    };
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
    // 참가자 목록의 내 줄도 함께 고친다(RPC로 바꾸면 VOICE_STATE_UPDATE가 오지 않음).
    const muted = typeof patch.mute === "boolean" ? patch.mute : state.muted;
    const deafened = typeof patch.deaf === "boolean" ? patch.deaf : state.deafened;
    emit({
      ...(typeof patch.mute === "boolean" ? { muted } : {}),
      ...(typeof patch.deaf === "boolean" ? { deafened } : {}),
      members: state.members.map((member) =>
        member.self ? { ...member, muted, deafened } : member,
      ),
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

  // 사람마다 발화 표시를 따로 만료시킨다. 끝 이벤트를 놓쳐도 계속 켜져 있지 않게.
  const bySelfFirst = (a: DiscordVoiceMember, b: DiscordVoiceMember): number =>
    Number(b.self) - Number(a.self) || a.name.localeCompare(b.name);

  const markSpeaking = (id: string, speaking: boolean) => {
    const previous = speakingTimers.get(id);
    if (previous) clearTimeout(previous);
    speakingTimers.delete(id);
    if (speaking) {
      speakingTimers.set(
        id,
        setTimeout(() => {
          speakingTimers.delete(id);
          markSpeaking(id, false);
        }, SPEAKING_HOLD_MS),
      );
    }
    const members = state.members.map((member) =>
      member.id === id ? { ...member, speaking } : member,
    );
    if (members.some((member, i) => member.speaking !== state.members[i]?.speaking)) {
      emit({ members });
    }
  };

  // 다른 사람의 발화도 같은 이벤트로 온다. 내 것만 따로 표시에 쓴다.
  const applySpeaking = (data: unknown, speaking: boolean) => {
    if (!data || typeof data !== "object") return;
    const value = data as { user_id?: unknown };
    if (typeof value.user_id !== "string" || value.user_id.length === 0) return;
    if (uid && value.user_id === uid) emit({ speaking });
    markSpeaking(value.user_id, speaking);
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
    // 같은 채널의 입장·퇴장·음소거 변화를 받아 목록을 실시간으로 맞춘다.
    void call("SUBSCRIBE", { channel_id: channel }, "VOICE_STATE_CREATE");
    void call("SUBSCRIBE", { channel_id: channel }, "VOICE_STATE_UPDATE");
    void call("SUBSCRIBE", { channel_id: channel }, "VOICE_STATE_DELETE");
  };

  // 채널 참가자 목록을 새로 읽는다(입장·퇴장 이벤트가 올 때도 다시 부른다).
  const applyChannel = (data: unknown) => {
    if (!data || typeof data !== "object") return;
    const value = data as { name?: unknown; voice_states?: unknown };
    const states = Array.isArray(value.voice_states) ? value.voice_states : [];
    // 말하는 중 표시는 이벤트로만 갱신되므로, 목록을 다시 읽어도 유지한다.
    const speaking = new Map(state.members.map((member) => [member.id, member.speaking]));
    const members = states
      .map(parseMember)
      .filter((member): member is DiscordVoiceMember => !!member)
      .map((member) => ({ ...member, speaking: speaking.get(member.id) === true }));
    emit({ members, channel: typeof value.name === "string" ? value.name : "" });
  };

  // 누군가 들어오거나 나가거나 음소거를 바꿨을 때. 목록을 그대로 맞춘다.
  const applyMemberEvent = (evt: string, data: unknown) => {
    if (!data || typeof data !== "object") return;
    const value = data as RawVoiceState;
    // 채널 id가 함께 오면 지금 내가 있는 채널의 변화만 반영한다.
    if (typeof value.channel_id === "string" && currentChannel && value.channel_id !== currentChannel) {
      return;
    }
    const member = parseMember(value.voice_state ?? value);
    if (!member) return;
    if (evt === "VOICE_STATE_DELETE") {
      const members = state.members.filter((other) => other.id !== member.id);
      if (members.length !== state.members.length) emit({ members });
      return;
    }
    const exists = state.members.some((other) => other.id === member.id);
    if (!exists) {
      emit({ members: [...state.members, member].sort(bySelfFirst) });
      return;
    }
    // 발화 표시는 SPEAKING 이벤트로만 바뀌므로 이 이벤트에서 덮어쓰지 않는다.
    emit({
      members: state.members.map((other) =>
        other.id === member.id ? { ...member, speaking: other.speaking } : other,
      ),
    });
  };

  const refreshChannel = async () => {
    const channel = await call("GET_SELECTED_VOICE_CHANNEL");
    const id = channelId(channel);
    currentChannel = id;
    emit({ inChannel: id.length > 0, speaking: false });
    if (id) {
      applyChannel(channel);
      subscribeSpeaking(id);
    } else {
      applyChannel(null);
    }
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
    if (
      message.evt === "VOICE_STATE_CREATE" ||
      message.evt === "VOICE_STATE_UPDATE" ||
      message.evt === "VOICE_STATE_DELETE"
    ) {
      applyMemberEvent(message.evt, message.data);
      return;
    }
    if (message.evt === "VOICE_CHANNEL_SELECT") {
      const id = channelId(message.data);
      currentChannel = id;
      if (!id) {
        for (const timer of speakingTimers.values()) clearTimeout(timer);
        speakingTimers.clear();
        emit({ inChannel: false, speaking: false, members: [], channel: "" });
        return;
      }
      emit({ inChannel: true, speaking: false });
      subscribeSpeaking(id);
      // 채널이 바뀌면 참가자 목록을 새로 읽는다.
      void call("GET_SELECTED_VOICE_CHANNEL").then(applyChannel);
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
    currentChannel = "";
    pending.clear();
    for (const timer of speakingTimers.values()) clearTimeout(timer);
    speakingTimers.clear();
    state = { ...OFFLINE, members: [] };
    for (const listener of listeners) listener(state);
  };

  const connect = async () => {
    if (disposed || socket) return;
    // 연결 도중 restart/teardown이 일어나면 이 실행은 버린다(소켓 두 개가 겹치지 않게).
    const stale = (sock: net.Socket) => disposed || socket !== sock;
    const config = readDiscordConfig(appData);
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
    if (stale(sock)) return;
    const token = await refreshAccessToken(config);
    if (stale(sock)) return;
    if (!token) {
      // 갱신 실패(비밀번호 변경·승인 취소 등)면 표시하지 않는다.
      teardown();
      scheduleReconnect();
      return;
    }
    // 디스코드는 refresh할 때마다 토큰을 새로 발급하므로 즉시 저장한다.
    if (token.refreshToken !== config.refreshToken) {
      writeDiscordConfig(appData, { ...config, refreshToken: token.refreshToken });
    }
    const auth = await send("AUTHENTICATE", { access_token: token.token });
    if (stale(sock)) return;
    if (auth.failed) {
      // 토큰이 거부되면 이 소켓은 아무 일도 하지 않으므로, 버리고 새로 붙어야 한다.
      console.warn("discord: AUTHENTICATE 실패", JSON.stringify(auth.data));
      teardown();
      scheduleReconnect();
      return;
    }
    await call("GET_VOICE_SETTINGS").then(applyVoiceSettings);
    // 음성 이벤트 구독. 실패해도 mute 표시는 계속 동작한다.
    void call("SUBSCRIBE", {}, "VOICE_SETTINGS_UPDATE");
    void call("SUBSCRIBE", {}, "VOICE_CHANNEL_SELECT");
    if (stale(sock)) return;
    await refreshChannel();
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
    restart() {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = null;
      teardown();
      void connect();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      teardown();
      listeners.clear();
    },
  };
}
