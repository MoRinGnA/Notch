import net from "node:net";
import { randomUUID } from "node:crypto";
import { DEFAULT_CLIENT_ID, readDiscordConfig, writeDiscordConfig } from "./discord-config";

// 다른 PC에서 처음 디스코드를 붙일 때 쓰는 절차.
// 브라우저 대신 디스코드 클라이언트 안에 승인 창을 띄우는 RPC AUTHORIZE를 쓴다.
// redirect_uri를 등록할 필요가 없어서 개발자 포털을 건드리지 않아도 된다.

const PIPE_PREFIX = `${String.fromCharCode(92, 92, 46, 92)}pipe${String.fromCharCode(92)}discord-ipc-`;
const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_PING = 3;
const OP_PONG = 4;

const HANDSHAKE_WAIT_MS = 450;
// 승인은 사람이 디스코드 창에서 눌러야 하므로 넉넉히 기다린다.
const AUTHORIZE_TIMEOUT_MS = 180_000;

export interface DiscordLinkResult {
  ok: boolean;
  // 화면에 그대로 보여 줄 수 있는 한 줄 설명.
  error?: string;
}

function frame(op: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Discord가 켜져 있지 않으면 열 수 있는 파이프가 없다. 0~9를 순서대로 본다.
function openPipe(): Promise<net.Socket | null> {
  const attempt = (index: number): Promise<net.Socket | null> => {
    if (index > 9) return Promise.resolve(null);
    return new Promise((resolve) => {
      const sock = net.connect(`${PIPE_PREFIX}${index}`);
      let settled = false;
      sock.once("connect", () => {
        if (settled) return;
        settled = true;
        resolve(sock);
      });
      sock.once("error", () => {
        if (settled) return;
        settled = true;
        sock.destroy();
        void attempt(index + 1).then(resolve);
      });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        sock.destroy();
        void attempt(index + 1).then(resolve);
      }, 500);
    });
  };
  return attempt(0);
}

// 디스코드 쪽 응답 한 건을 nonce로 기다린다. ERROR 이벤트는 실패로 돌려준다.
function collect(sock: net.Socket) {
  let buffer = Buffer.alloc(0);
  const pending = new Map<string, (data: unknown, failed: boolean) => void>();
  sock.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const op = buffer.readInt32LE(0);
      const len = buffer.readInt32LE(4);
      if (buffer.length < 8 + len) break;
      const payload = buffer.subarray(8, 8 + len).toString("utf8");
      buffer = buffer.subarray(8 + len);
      if (op === OP_PING) {
        try {
          sock.write(frame(OP_PONG, JSON.parse(payload)));
        } catch {
          // 무시
        }
        continue;
      }
      if (op !== OP_FRAME) continue;
      let message: { nonce?: string; evt?: string; data?: unknown } | null = null;
      try {
        message = JSON.parse(payload) as { nonce?: string; evt?: string; data?: unknown };
      } catch {
        continue;
      }
      if (!message?.nonce) continue;
      const resolve = pending.get(message.nonce);
      if (!resolve) continue;
      pending.delete(message.nonce);
      resolve(message.data ?? null, message.evt === "ERROR");
    }
  });
  const call = (cmd: string, args: Record<string, unknown>, timeoutMs: number) =>
    new Promise<{ data: unknown; failed: boolean }>((resolve) => {
      const nonce = randomUUID();
      pending.set(nonce, (data, failed) => resolve({ data, failed }));
      try {
        sock.write(frame(OP_FRAME, { cmd, nonce, args }));
      } catch {
        pending.delete(nonce);
        resolve({ data: null, failed: true });
        return;
      }
      setTimeout(() => {
        if (pending.delete(nonce)) resolve({ data: null, failed: true });
      }, timeoutMs);
    });
  return { call };
}

// 실패 사유를 화면에서 바로 이해할 수 있는 말로 바꾼다.
function describe(failedData: unknown, fallback: string): string {
  if (failedData && typeof failedData === "object") {
    const value = failedData as { code?: unknown; message?: unknown };
    if (typeof value.message === "string" && value.message.length > 0) return value.message;
    if (typeof value.code === "number") return `${fallback} (${value.code})`;
  }
  return fallback;
}

export async function linkDiscord(appData: string, rawSecret: unknown): Promise<DiscordLinkResult> {
  const clientSecret = typeof rawSecret === "string" ? rawSecret.trim() : "";
  if (clientSecret.length < 16) {
    return { ok: false, error: "클라이언트 시크릿을 붙여넣어 주세요." };
  }
  const clientId = readDiscordConfig(appData)?.clientId ?? DEFAULT_CLIENT_ID;

  const sock = await openPipe();
  if (!sock) {
    return { ok: false, error: "디스코드 데스크톱 앱을 켠 뒤 다시 시도해 주세요." };
  }

  try {
    const { call } = collect(sock);
    sock.write(frame(OP_HANDSHAKE, { v: 1, client_id: clientId }));
    await delay(HANDSHAKE_WAIT_MS);

    // 이 명령이 디스코드 창 안에 "Notch 승인" 창을 띄운다. 사용자가 누를 때까지 기다린다.
    const granted = await call("AUTHORIZE", { client_id: clientId, scopes: ["rpc"] }, AUTHORIZE_TIMEOUT_MS);
    if (granted.failed) {
      return { ok: false, error: describe(granted.data, "디스코드가 승인을 거절했습니다.") };
    }
    const code = (granted.data as { code?: unknown } | null)?.code;
    if (typeof code !== "string" || code.length === 0) {
      return { ok: false, error: "승인이 취소되었습니다. 디스코드를 열어 두고 다시 시도해 주세요." };
    }

    // 코드를 토큰으로 바꾼다. 여기서 받은 refresh token이 이 PC의 인증 정보가 된다.
    let body: { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
    try {
      const res = await fetch("https://discord.com/api/v10/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code,
        }),
        signal: AbortSignal.timeout(12_000),
      });
      body = (await res.json()) as typeof body;
      if (!res.ok) {
        const reason = body.error_description || body.error || `HTTP ${res.status}`;
        return { ok: false, error: `토큰 교환 실패: ${reason}` };
      }
    } catch {
      return { ok: false, error: "디스코드에 연결하지 못했습니다. 네트워크를 확인해 주세요." };
    }

    if (!body.refresh_token) {
      return { ok: false, error: "디스코드가 갱신 토큰을 주지 않았습니다. 시크릿을 확인해 주세요." };
    }
    if (!writeDiscordConfig(appData, { clientId, clientSecret, refreshToken: body.refresh_token })) {
      return { ok: false, error: "인증 정보를 저장하지 못했습니다." };
    }
    return { ok: true };
  } finally {
    sock.destroy();
  }
}
