import { Mic, MicOff, HeadphoneOff } from "lucide-react";
import { useEffect, useState } from "react";

// 클립보드 기록 화면. 항목을 누르면 그 내용이 다시 클립보드로 들어간다.
// 마이크 상태는 작은 채움 아이콘으로 보여준다. 아이콘 자체가 포인트 컬러라
// 검정 본체 위에서도 밝고, 말하는 동안에만 오른쪽 음파가 점등된다.
// 클릭하면 마이크 음소거, 우클릭하면 헤드셋 음소거를 디스코드에 바로 건다.
export function MicStatus({
  voice,
  inline = false,
  onToggle,
}: {
  voice: NotchVoice;
  inline?: boolean;
  onToggle: (patch: { mute?: boolean; deaf?: boolean }) => void;
}) {
  // 헤드셋을 끄면 디스코드가 입력도 함께 끄므로 둘을 같은 "꺼짐"으로 본다.
  const off = voice.muted || voice.deafened;
  const label = voice.deafened
    ? "헤드셋 음소거"
    : voice.muted
      ? "마이크 음소거"
      : voice.speaking
        ? "말하는 중"
        : "마이크 켜짐";
  return (
    <button
      type="button"
      className={`notch-mic${inline ? " is-inline" : ""}${off ? " is-muted" : ""}${voice.speaking && !off ? " is-speaking" : ""}`}
      aria-label={`${label} · 누르면 음소거 전환`}
      title={`${label} · 클릭: 마이크 음소거, 우클릭: 헤드셋 음소거`}
      onClick={(event) => {
        event.stopPropagation();
        // 헤드셋이 꺼져 있으면 먼저 그것부터 되살린다(디스코드가 입력도 함께 끄기 때문).
        if (voice.deafened) onToggle({ deaf: false });
        else onToggle({ mute: !voice.muted });
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle({ deaf: !voice.deafened });
      }}
    >
      {off ? <MicOff size={18} strokeWidth={1.75} /> : <Mic size={18} strokeWidth={1.75} />}

    </button>
  );
}

// 접힌 노치에서는 다른 사람이 말할 때만 이니셜을 잠깐 띄운다(폭이나 가사 위치를 건드리지 않음).
// 이 PC에 디스코드 인증 정보가 없을 때 쓰는 연결 화면. 트레이 메뉴에서 연다.
export function DiscordLink({ onClose }: { onClose: () => void }) {
  const [secret, setSecret] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "ok" | "error">("idle");
  const [note, setNote] = useState("");
  const [linked, setLinked] = useState<boolean | null>(null);

  useEffect(() => {
    void window.notchApi
      ?.isDiscordLinked()
      .then(setLinked)
      .catch(() => undefined);
  }, []);

  // 화면이 사라지면 창을 다시 포커스 없는 상태로 돌려놓는다(앞 창이 키보드를 이어받게).
  useEffect(() => {
    return () => window.notchApi?.closeDiscordLink();
  }, []);

  const submit = () => {
    if (state === "busy") return;
    const api = window.notchApi;
    if (!api) return;
    setState("busy");
    // 디스코드 창 안에 승인 창이 뜨므로 그쪽을 보라고 안내한다.
    setNote("디스코드 창에 뜬 승인 창에서 허용을 눌러 주세요.");
    void api
      .linkDiscord(secret)
      .then((result) => {
        if (result.ok) {
          setState("ok");
          setLinked(true);
          setSecret("");
          setNote("연결되었습니다. 음성 채널에 들어가면 표시됩니다.");
          return;
        }
        setState("error");
        setNote(result.error ?? "연결하지 못했습니다.");
      })
      .catch(() => {
        setState("error");
        setNote("연결하지 못했습니다.");
      });
  };

  return (
    <div
      className="notch-link"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <span className="notch-link-head">
        <span className="notch-link-title">Discord</span>
        <span className="notch-link-state">
          {linked === null ? "" : linked ? "연결됨" : "연결 안 됨"}
        </span>
      </span>
      <span className="notch-link-note">
        {linked
          ? "이미 연결되어 있습니다. 다시 연결하면 이 PC의 토큰이 새로 발급됩니다."
          : "이 PC에는 인증 정보가 없습니다. 디스코드 개발자 포털의 OAuth2 클라이언트 시크릿을 한 번 넣으면 이 PC에만 저장됩니다."}
      </span>
      <form
        className="notch-link-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          className="notch-link-input"
          type="password"
          value={secret}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder="클라이언트 시크릿"
          aria-label="디스코드 클라이언트 시크릿"
          onChange={(event) => setSecret(event.target.value)}
        />
        <button type="submit" className="notch-btn" disabled={state === "busy" || secret.trim().length === 0}>
          {state === "busy" ? "연결 중" : "연결"}
        </button>
      </form>
      <span
        className={`notch-link-status${state === "error" ? " is-error" : state === "ok" ? " is-ok" : ""}`}
        role="status"
      >
        {note}
      </span>
      <span className="notch-link-foot">
        <button
          type="button"
          className="notch-btn"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          닫기
        </button>
      </span>
    </div>
  );
}

export function VoiceNow({ voice }: { voice: NotchVoice }) {
  const others = voice.members.filter((member) => !member.self && member.speaking).slice(0, 2);
  if (others.length === 0) return null;
  return (
    <span className="notch-voice-now" aria-hidden="true">
      {others.map((member) => (
        <span key={member.id}>{member.name.slice(0, 1).toUpperCase()}</span>
      ))}
    </span>
  );
}

// 디스코드 전용 화면. 참가자와 각자의 상태는 이 화면에서만 본다.
export function VoicePanel({
  voice,
  onClose,
  onToggle,
}: {
  voice: NotchVoice;
  onClose: () => void;
  onToggle: (patch: { mute?: boolean; deaf?: boolean }) => void;
}) {
  // 내 상태는 음성 설정 값을 믿는다(목록은 다른 사람 상태를 볼 때만 쓴다).
  const muted = voice.muted;
  const deafened = voice.deafened;
  return (
    <div
      className="notch-voice"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <span className="notch-voice-head">
        <span className="notch-voice-title">{voice.channel || "음성 채널"}</span>
        <span className="notch-voice-count">{`${voice.members.length}명`}</span>
      </span>
      <div className="notch-voice-list">
        {voice.members.length === 0 ? (
          <span className="notch-voice-empty">채널에 아무도 없습니다.</span>
        ) : (
          voice.members.map((member) => {
            // 내 줄은 음성 설정에서 바로 읽어야 버튼을 누른 즉시 반영된다.
            const rowMuted = member.self ? muted : member.muted;
            const rowDeafened = member.self ? deafened : member.deafened;
            return (
              <span
                key={member.id}
                className={`notch-voice-row${member.speaking ? " is-speaking" : ""}`}
              >
                <span className="notch-voice-name">
                  {member.self && member.name.trim() !== "나" ? `${member.name} (나)` : member.name}
                </span>
                {rowDeafened ? (
                  <HeadphoneOff className="notch-voice-flag" aria-label="헤드셋 꺼짐" size={16} />
                ) : rowMuted ? (
                  <MicOff className="notch-voice-flag" aria-label="마이크 꺼짐" size={16} />
                ) : null}
              </span>
            );
          })
        )}
      </div>
      <div className="notch-voice-foot">
        <span className="notch-controls-group">
          <button
            type="button"
            className="notch-btn"
            onClick={(event) => {
              event.stopPropagation();
              if (deafened) onToggle({ deaf: false });
              else onToggle({ mute: !muted });
            }}
          >
            {deafened ? "마이크 켜기" : muted ? "음소거 해제" : "음소거"}
          </button>
          <button
            type="button"
            className="notch-btn"
            onClick={(event) => {
              event.stopPropagation();
              onToggle({ deaf: !deafened });
            }}
          >
            {deafened ? "헤드셋 켜기" : "헤드셋 끄기"}
          </button>
        </span>
        <button
          type="button"
          className="notch-btn"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          닫기
        </button>
      </div>
    </div>
  );
}
