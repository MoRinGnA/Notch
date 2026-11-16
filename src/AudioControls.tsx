import { Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

// 미디어 키·다른 앱의 볼륨 변경도 놓치지 않을 만큼 짧게 확인한다.
const VOLUME_POLL_MS = 300;
// 10%마다 눈금을 세우고, 50%마다 길게 세워 값을 눈으로 어림하기 쉽게 한다.


// 시스템 마스터 볼륨. 부드러운 프로그래스 바 대신, 눈금 셀 사다리·커서·반전 플레이트로 값을 읽는 계기판.
export function VolumeDeck({ active, onOpenMixer }: { active: boolean; onOpenMixer?: () => void }) {
  const [volume, setVolume] = useState<NotchVolume | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  // 끄는 동안에는 폴링 결과가 손가락 위치를 덮지 않도록 마지막 값을 여기에 둔다.
  const volumeRef = useRef<NotchVolume | null>(null);
  const draggingRef = useRef(false);
  const readRef = useRef(0);
  // 조작 직전에 시작된 조회가 돌아와 방금 바꾼 값을 되돌리지 않도록 세대 번호로 막는다.
  const writeSeq = useRef(0);
  const writesInFlight = useRef(0);
  const writeTimer = useRef<number | null>(null);
  const queuedLevel = useRef<number | null>(null);

  const read = async () => {
    const api = window.notchApi;
    if (!api) return;
    const request = ++readRef.current;
    const seq = writeSeq.current;
    try {
      const next = await api.getVolume();
      if (request !== readRef.current || draggingRef.current || seq !== writeSeq.current) return;
      // 잠깐 값을 못 읽었을 때 화면을 비우지 않고 마지막 값을 유지한다.
      if (!next) return;
      volumeRef.current = next;
      setVolume(next);
    } catch {
      // 잠깐 읽지 못하면 마지막으로 확인한 값을 그대로 둔다.
    }
  };

  // 펼친 동안에만 읽고 쓴다. 접힌 노치가 조용히 PowerShell을 붙들고 있지 않게 한다.
  // 미디어 키나 다른 앱이 볼륨을 바꿔도 바로 따라오도록 짧게 돈다.
  useEffect(() => {
    if (!active) return;
    void read();
    const id = window.setInterval(() => {
      // 끄는 중이거나 시스템에 쓰는 중이면 잠시 건너뛰고, 쓰기가 끝나면 바로 다시 읽는다.
      if (draggingRef.current || writesInFlight.current > 0 || queuedLevel.current !== null) return;
      void read();
    }, VOLUME_POLL_MS);
    return () => {
      window.clearInterval(id);
      readRef.current++;
    };
  }, [active]);

  // 시스템에 쓰는 동안에는 조회를 멈춘다. 늦게 도착한 옛 값이 방금 바꾼 값을 되돌리지 않게.
  const runWrite = (task: (api: NonNullable<Window["notchApi"]>) => Promise<boolean>) => {
    const api = window.notchApi;
    if (!api) return;
    writesInFlight.current++;
    void task(api)
      .catch(() => undefined)
      .finally(() => {
        writesInFlight.current--;
        if (!writesInFlight.current && queuedLevel.current === null) void read();
      });
  };

  useEffect(() => {
    return () => {
      if (writeTimer.current) window.clearTimeout(writeTimer.current);
      const last = queuedLevel.current;
      queuedLevel.current = null;
      if (last !== null) void window.notchApi?.setVolume(last).catch(() => undefined);
    };
  }, []);

  // 끄는 동안 매 픽셀마다 IPC를 보내지 않고 마지막 값만 묶어서 보낸다.
  const sendLevel = (level: number) => {
    queuedLevel.current = level;
    if (writeTimer.current) return;
    writeTimer.current = window.setTimeout(() => {
      writeTimer.current = null;
      const value = queuedLevel.current;
      queuedLevel.current = null;
      if (value === null) return;
      runWrite((api) => api.setVolume(value));
    }, 60);
  };

  const apply = (level: number) => {
    const current = volumeRef.current;
    if (!current) return;
    writeSeq.current++;
    const next = { level, muted: false };
    volumeRef.current = next;
    setVolume(next);
    sendLevel(level);
    // 음소거 상태에서 볼륨을 만지면 Windows처럼 소리를 되살린다.
    if (current.muted) runWrite((api) => api.setMuted(false));
  };

  const toggleMute = () => {
    const current = volumeRef.current;
    if (!current) return;
    writeSeq.current++;
    const next = { ...current, muted: !current.muted };
    volumeRef.current = next;
    setVolume(next);
    runWrite((api) => api.setMuted(next.muted));
  };

  const levelAt = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const ratio = (clientX - rect.left) / Math.max(1, rect.width);
    return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  };

  const startDrag = (event: PointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    if (!volumeRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    setDragging(true);
    setHover(null);
    apply(levelAt(event.clientX));
  };

  const moveDrag = (event: PointerEvent<HTMLSpanElement>) => {
    if (draggingRef.current) {
      event.stopPropagation();
      apply(levelAt(event.clientX));
      return;
    }
    if (!volumeRef.current) return;
    setHover(levelAt(event.clientX));
  };

  const endDrag = (event: PointerEvent<HTMLSpanElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    const track = event.currentTarget;
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    // 묶어 보낸 값이 시스템에 닿은 뒤에 실제 값을 다시 읽어 맞춘다.
    window.setTimeout(() => {
      if (!draggingRef.current) void read();
    }, 220);
  };

  const handleKey = (event: KeyboardEvent<HTMLSpanElement>) => {
    const current = volumeRef.current;
    if (!current) return;
    const step = event.shiftKey ? 10 : 2;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      apply(Math.min(100, current.level + step));
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      apply(Math.max(0, current.level - step));
    } else if (event.key === "Home") {
      event.preventDefault();
      apply(0);
    } else if (event.key === "End") {
      event.preventDefault();
      apply(100);
    } else if (event.key === "m" || event.key === "M") {
      event.preventDefault();
      event.stopPropagation();
      toggleMute();
    }
  };

  const level = volume?.level ?? 0;
  const muted = volume?.muted ?? false;
  // 마우스로 훑는 동안에는 실제 값과 목표 값 사이를 미리 보여준다.
  const preview = !dragging && hover !== null && volume !== null && hover !== level ? hover : null;
  const readout = volume === null ? "–" : String(preview ?? level);

  return (
    <div
      className={`notch-vol${muted ? " is-muted" : ""}${dragging ? " is-live" : ""}${volume === null ? " is-off" : ""}`}
      onClick={(event) => event.stopPropagation()}
    >
      {/* 라벨이 곧 앱별 볼륨으로 들어가는 문이다(눌러서 열고, 끄는 건 레일에서). */}
      {onOpenMixer ? (
        <button
          type="button"
          className="notch-vol-label"
          title="앱별 볼륨 열기"
          aria-label="앱별 볼륨 열기"
          onClick={(event) => {
            event.stopPropagation();
            onOpenMixer();
          }}
        >
          <Volume2 size={18} strokeWidth={1.75} />
        </button>
      ) : (
        <Volume2 size={18} strokeWidth={1.75} aria-hidden="true" />
      )}
      <span
        ref={trackRef}
        className="notch-vol-track"
        role="slider"
        tabIndex={volume === null ? -1 : 0}
        aria-label="시스템 볼륨"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={level}
        aria-valuetext={volume === null ? "사용할 수 없음" : muted ? "음소거됨" : `${level}%`}
        aria-disabled={volume === null}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHover(null)}
        onKeyDown={handleKey}
      >
        <span className="notch-vol-rail" aria-hidden="true" />
        <span className="notch-vol-fill" aria-hidden="true" style={{ width: `${level}%` }} />
        {preview !== null && (
          <span className="notch-vol-ghost" aria-hidden="true" style={{ left: `${preview}%` }} />
        )}
        {volume !== null && (
          <span className="notch-vol-cursor" aria-hidden="true" style={{ left: `${level}%` }} />
        )}
      </span>
      <span className={`notch-vol-value${muted ? " is-muted" : ""}${preview !== null ? " is-target" : ""}`}>
        {(dragging || preview !== null) && readout}
      </span>
      <button
        type="button"
        className={`notch-vol-mute${muted ? " is-on" : ""}`}
        aria-pressed={muted}
        aria-label={muted ? "음소거 해제" : "음소거"}
        title={muted ? "음소거 해제 (M)" : "음소거 (M)"}
        disabled={volume === null}
        onClick={(event) => {
          event.stopPropagation();
          toggleMute();
        }}
      >
        {muted ? <VolumeX size={18} strokeWidth={1.75} /> : <Volume2 size={18} strokeWidth={1.75} />}
      </button>
    </div>
  );
}

// 한 줄짜리 음량 계기판. MASTER와 앱이 같은 모양을 쓰고, 구분선 위/아래 위치로 위계를 보여 준다.
function MixRow({
  label,
  level: rawLevel,
  muted,
  master = false,
  unavailable = false,
  peak,
  onLevel,
  onMute,
  onBusy,
}: {
  label: string;
  level: number;
  muted: boolean;
  master?: boolean;
  unavailable?: boolean;
  // 0~1 사이의 순간 피크. 넘기지 않으면 미터를 그리지 않는다(MASTER 줄).
  peak?: number;
  onLevel: (level: number) => void;
  onMute: (muted: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const trackRef = useRef<HTMLSpanElement>(null);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const level = Math.max(0, Math.min(100, rawLevel));
  // 빠르게 연속으로 눌러도 한 번에 한 칸씩 오르도록 마지막 값을 따로 들고 있다.
  const levelRef = useRef(level);
  levelRef.current = level;
  const step = (next: number) => {
    const value = Math.max(0, Math.min(100, next));
    levelRef.current = value;
    onLevel(value);
  };

  const levelAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return level;
    const ratio = (clientX - rect.left) / Math.max(1, rect.width);
    return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  };

  const startDrag = (event: PointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    onBusy(true);
    setDragging(true);
    onLevel(levelAt(event.clientX));
  };

  const moveDrag = (event: PointerEvent<HTMLSpanElement>) => {
    if (!draggingRef.current) { setHover(levelAt(event.clientX)); return; }
    event.stopPropagation();
    onLevel(levelAt(event.clientX));
  };

  const endDrag = (event: PointerEvent<HTMLSpanElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    onBusy(false);
    setDragging(false);
    const track = event.currentTarget;
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
  };

  const handleKey = (event: KeyboardEvent<HTMLSpanElement>) => {
    const delta = event.shiftKey ? 10 : 2;
    const keys = ["ArrowRight", "ArrowUp", "ArrowLeft", "ArrowDown", "Home", "End", "m", "M"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "ArrowRight" || event.key === "ArrowUp") step(levelRef.current + delta);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") step(levelRef.current - delta);
    else if (event.key === "Home") step(0);
    else if (event.key === "End") step(100);
    else onMute(!muted);
  };

  return (
    <div
      className={`notch-mix-row${master ? " is-master" : ""}${muted ? " is-muted" : ""}${unavailable ? " is-off" : ""}${dragging ? " is-live" : ""}`}
      onClick={(event) => event.stopPropagation()}
    >
      <span className="notch-mix-name" title={label}>{label}</span>
      {peak === undefined ? null : (
        <span
          className="notch-mix-peak"
          aria-hidden="true"
          style={{ width: `${Math.round(Math.max(0, Math.min(1, peak)) * 100)}%` }}
        />
      )}
      <span
        ref={trackRef}
        className="notch-vol-track notch-mix-track"
        role="slider"
        tabIndex={unavailable ? -1 : 0}
        aria-label={`${label} 볼륨`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={level}
        aria-valuetext={unavailable ? "사용할 수 없음" : muted ? "음소거됨" : `${level}%`}
        aria-disabled={unavailable}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHover(null)}
        onKeyDown={handleKey}
      >
        <span className="notch-vol-rail" aria-hidden="true" />
        <span className="notch-vol-fill" aria-hidden="true" style={{ width: `${level}%` }} />
        <span className="notch-vol-cursor" aria-hidden="true" style={{ left: `${level}%` }} />
      </span>
      <span className={`notch-vol-value${muted ? " is-muted" : ""}`}>
        {!unavailable && (dragging || hover !== null) ? String(dragging ? level : hover) : ""}
      </span>
      <button
        type="button"
        className={`notch-vol-mute${muted ? " is-on" : ""}`}
        aria-pressed={muted}
        aria-label={muted ? `${label} 음소거 해제` : `${label} 음소거`}
        title={muted ? "음소거 해제" : "음소거"}
        disabled={unavailable}
        onClick={(event) => {
          event.stopPropagation();
          onMute(!muted);
        }}
      >
        {muted ? <VolumeX size={18} strokeWidth={1.75} /> : <Volume2 size={18} strokeWidth={1.75} />}
      </button>
    </div>
  );
}

const MIX_POLL_MS = 800;
// 미터는 눈으로 읽히는 속도만 필요하다. 세션 피크만 읽는 가벼운 명령을 쓴다.
const PEAK_POLL_MS = 120;

// 앱별 볼륨 화면. 기본 출력 장치에서 실제로 소리를 내는 세션만 보여준다.
export function SoundMixer({ active, onClose }: { active: boolean; onClose: () => void }) {
  const [apps, setApps] = useState<NotchAudioApp[]>([]);
  const [master, setMaster] = useState<NotchVolume | null>(null);
  const [device, setDevice] = useState("");
  // pid별로 다듬은 피크 값. 사이드카는 순간값만 주므로 여기서 조금씩 놓아준다.
  const [peaks, setPeaks] = useState<Record<number, number>>({});
  // 끌고 있는 동안 폴링 결과가 손가락 위치를 덮지 않게 한다.
  const busyRef = useRef(false);
  const requestRef = useRef(0);
  // 앱마다 마지막 값만 묶어 보낸다(픽셀마다 IPC를 보내지 않게).
  const queued = useRef(new Map<number, number>());
  const queueTimer = useRef<number | null>(null);
  const queuedMaster = useRef<number | null>(null);
  const masterTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    const api = window.notchApi;
    if (!api) return;
    let cancelled = false;
    const read = async () => {
      const request = ++requestRef.current;
      try {
        const [list, output, volume] = await Promise.all([
          api.getAudioApps(),
          api.getAudioDevice(),
          api.getVolume(),
        ]);
        if (cancelled || request !== requestRef.current) return;
        if (output?.name) setDevice(output.name);
        if (!busyRef.current && queued.current.size === 0) setApps(list);
        if (volume && !busyRef.current && queuedMaster.current === null) setMaster(volume);
      } catch {
        // 잠깐 읽지 못하면 마지막 목록을 그대로 둔다.
      }
    };
    void read();
    const id = window.setInterval(read, MIX_POLL_MS);
    return () => {
      cancelled = true;
      requestRef.current++;
      window.clearInterval(id);
    };
  }, [active]);

  // 미터: 화면이 열려 있는 동안만 짧은 간격으로 피크만 읽는다.
  useEffect(() => {
    if (!active) return;
    const api = window.notchApi;
    if (!api) return;
    let cancelled = false;
    const read = async () => {
      try {
        const list = await api.getAudioPeaks();
        if (cancelled) return;
        setPeaks((previous) => {
          const next: Record<number, number> = {};
          for (const { pid, peak } of list) {
            // 떨어질 때 바로 0이 되지 않게 직전 값의 일부를 남긴다.
            next[pid] = Math.max(peak, (previous[pid] ?? 0) * 0.68);
          }
          return next;
        });
      } catch {
        // 읽지 못하면 다음 간격에 다시 시도한다.
      }
    };
    void read();
    const id = window.setInterval(read, PEAK_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active]);

  useEffect(() => {
    return () => {
      if (queueTimer.current) window.clearTimeout(queueTimer.current);
      if (masterTimer.current) window.clearTimeout(masterTimer.current);
    };
  }, []);

  const setLevel = (pid: number, level: number) => {
    setApps((previous) => previous.map((app) => (app.pid === pid ? { ...app, level, muted: false } : app)));
    queued.current.set(pid, level);
    if (queueTimer.current) return;
    queueTimer.current = window.setTimeout(() => {
      queueTimer.current = null;
      const entries = [...queued.current.entries()];
      queued.current.clear();
      for (const [appPid, next] of entries) {
        void window.notchApi?.setAppVolume(appPid, next).catch(() => undefined);
      }
    }, 70);
  };

  const setMute = (pid: number, muted: boolean) => {
    setApps((previous) => previous.map((app) => (app.pid === pid ? { ...app, muted } : app)));
    void window.notchApi?.setAppMuted(pid, muted).catch(() => undefined);
  };

  const setMasterLevel = (level: number) => {
    setMaster((previous) => (previous ? { ...previous, level, muted: false } : previous));
    queuedMaster.current = level;
    if (masterTimer.current) return;
    masterTimer.current = window.setTimeout(() => {
      masterTimer.current = null;
      const value = queuedMaster.current;
      queuedMaster.current = null;
      if (value === null) return;
      void window.notchApi?.setVolume(value).catch(() => undefined);
    }, 70);
  };

  const setMasterMute = (muted: boolean) => {
    setMaster((previous) => (previous ? { ...previous, muted } : previous));
    void window.notchApi?.setMuted(muted).catch(() => undefined);
  };

  return (
    <div className="notch-mix">
      <span className="notch-mix-head">
        <span className="notch-mix-title">소리</span>
        <span className="notch-mix-device" title={device}>{device || "출력 장치"}</span>
      </span>
      <div className="notch-mix-list">
        <MixRow
          label="전체 볼륨"
          master
          level={master?.level ?? 0}
          muted={master?.muted ?? false}
          unavailable={!master}
          onLevel={setMasterLevel}
          onMute={setMasterMute}
          onBusy={(busy) => {
            busyRef.current = busy;
          }}
        />
        <span className="notch-mix-divider" aria-hidden="true" />
        {apps.length === 0 ? (
          <span className="notch-mix-empty">소리를 내는 앱이 없습니다.</span>
        ) : (
          apps.map((app) => (
            <MixRow
              key={app.pid}
              label={app.name}
              level={app.level}
              muted={app.muted}
              peak={peaks[app.pid] ?? 0}
              onLevel={(level) => setLevel(app.pid, level)}
              onMute={(muted) => setMute(app.pid, muted)}
              onBusy={(busy) => {
                busyRef.current = busy;
              }}
            />
          ))
        )}
      </div>
      <span className="notch-mix-foot">
        <button
          type="button"
          className="notch-btn"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          뒤로
        </button>
        <button
          type="button"
          className="notch-btn"
          onClick={(event) => {
            event.stopPropagation();
            void window.notchApi?.openSoundSettings();
          }}
        >
          소리 설정
        </button>
      </span>
    </div>
  );
}
