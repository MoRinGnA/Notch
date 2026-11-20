import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { fetchLyrics, lyricPolicy, type Lyrics } from "./lyrics";
import { cleanTitle, trackName, artistName, displayArtist } from "./mediaText";
import { SoundMixer } from "./AudioControls";
import { DiscordLink, MicStatus, VoiceNow, VoicePanel } from "./VoiceControls";
import { Music, Settings2, Volume2 } from "lucide-react";
import { useAccent } from "./useAccent";
import { HudPanel } from "./HudPanel";
import { DotClock } from "./DotClock";
import { MediaPanel } from "./MediaPanel";

interface NotchProps {
  expanded: boolean;
  onToggle: () => void;
  // 트레이에서 화면을 열 때처럼, 접혀 있으면 펼치기만 한다.
  onExpand: () => void;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
}

interface PendingPlay {
  app: string;
  title: string;
  status: "Playing" | "Paused";
  confirmedAfter: number | null;
  previous: NotchMedia;
}

const MEDIA_POLL_MS = 2000;
// 펼친 화면의 기본 폭(HUD 또는 미디어 패널).
const EXPANDED_WIDTH = 600;
// HUD는 네 줄짜리 판독 화면이라 미디어 패널보다 좁게 잡아 빈 자리를 남기지 않는다.
const HUD_WIDTH = 600;

const EMPTY_MEDIA: NotchMedia = {
  active: false,
  id: "",
  sources: [],
  positionKnown: true,
  status: "",
  title: "",
  artist: "",
  album: "",
  thumbnail: "",
  app: "",
  canPrev: false,
  canNext: false,
  canPlayPause: false,
  position: 0,
  duration: 0,
  updatedAt: 0,
};

const PROGRESS_TICK_MS = 250;

type BoundsRect = { x: number; y: number; width: number; height: number };

// 개발 모드 전용: 전환 프레임마다 노치가 마지막으로 보낸 setShape 사각형 안에 있는지 검사한다.
function startBoundsAudit(notch: HTMLElement, area: () => BoundsRect | null) {
  let frame = 0;
  let frames = 0;
  let violations = 0;
  let maxOverflow = 0;
  let finished = false;
  let settle = 2;
  const sample = () => {
    const rect = notch.getBoundingClientRect();
    const sent = area();
    if (sent) {
      frames += 1;
      const overflow = Math.max(
        0,
        sent.x - rect.left,
        rect.right - (sent.x + sent.width),
        sent.y - rect.top,
        rect.bottom - (sent.y + sent.height),
      );
      if (overflow > 0.5) {
        violations += 1;
        maxOverflow = Math.max(maxOverflow, overflow);
      }
    }
    if (finished && settle-- <= 0) {
      const result = { frames, violations, maxOverflow: Number(maxOverflow.toFixed(2)) };
      const scope = window as Window & { __notchBoundsChecks?: typeof result[] };
      (scope.__notchBoundsChecks ??= []).push(result);
      console.info(`[notch] 전환 잘림 검사 프레임=${frames} 벗어남=${violations} 최대초과=${result.maxOverflow}px`);
      return;
    }
    frame = window.requestAnimationFrame(sample);
  };
  frame = window.requestAnimationFrame(sample);
  return {
    finish() {
      finished = true;
    },
    stop() {
      finished = true;
      settle = -1;
      window.cancelAnimationFrame(frame);
    },
  };
}

type NotchView = "media" | "hud";

function resolveView(hasMedia: boolean): NotchView {
  return hasMedia ? "media" : "hud";
}

// NOW 화면의 소스 버튼에 쓸 짧은 앱 이름. AUMID 꼬리와 .exe를 떼고 알아보기 쉬운 이름으로 바꾼다.
const MEDIA_APP_NAMES: Record<string, string> = {
  chrome: "Chrome", msedge: "Edge", whale: "Whale", firefox: "Firefox", brave: "Brave",
  opera: "Opera", vivaldi: "Vivaldi", chromium: "Chromium", arc: "Arc", spotify: "Spotify",
};
function mediaAppName(app: string): string {
  const target = app.includes("!") ? app.split("!").pop() ?? app : app;
  const file = target.split(/[\\/]/).pop() ?? target;
  let base = file.replace(/\.exe$/i, "");
  // com.example.app 같은 AUMID는 마지막 조각이 알아보기 쉽다.
  if (!/[\\/]/.test(app) && base.includes(".")) base = base.split(".").pop() ?? base;
  const key = base.toLowerCase();
  return (MEDIA_APP_NAMES[key] ?? base).slice(0, 18);
}

export function Notch({ expanded: expandedRequest, onToggle, onExpand: openExpand, onHoverStart, onHoverEnd }: NotchProps) {
  const notchRef = useRef<HTMLDivElement>(null);
  // 펼친 화면도 같은 가사 줄이 한 줄에 들어오도록 넓힌다.
  const lineMeasureRef = useRef<HTMLSpanElement>(null);
  const [expandedWidth, setExpandedWidth] = useState<number | null>(null);

  const [media, setMedia] = useState<NotchMedia>(EMPTY_MEDIA);
  // Discord 음성 상태. 음성 채널에 들어가 있을 때만 접힌 노치 오른쪽에 표시한다.
  const [voice, setVoice] = useState<NotchVoice | null>(null);
  // 펼침은 미디어 재생 중이거나 Discord 음성 채널에 있을 때만 허용한다.
  // 트레이에서 연 연결 화면. 열려 있는 동안은 펼침을 허용한다.
  const [linkOpen, setLinkOpen] = useState(false);
  const expanded = expandedRequest && ((media.active && media.title.length > 0) || !!voice?.inChannel || linkOpen);
  const [lyrics, setLyrics] = useState<Lyrics>({ state: "idle", text: "", synced: [] });
  const [now, setNow] = useState(() => Date.now());
  // 가사가 없을 때 채울 유튜브 썸네일(data URL). 없으면 빈 문자열.
  const [ytThumb, setYtThumb] = useState("");
  const mediaRef = useRef(media);
  // 이벤트 리스너가 처음 렌더링의 값을 붙들지 않도록 최신 화면 상태를 따로 둔다.
  const mediaRequestRef = useRef(0);
  const pendingPlayRef = useRef<PendingPlay | null>(null);
  const [playPending, setPlayPending] = useState(false);
  mediaRef.current = media;

  // 명령 전에 시작된 조회와 늦게 도착한 응답이 새 상태를 덮지 않도록 한다.
  const readMedia = async () => {
    if (!window.notchApi) return;
    const request = ++mediaRequestRef.current;
    try {
      const next = await window.notchApi.getMedia();
      if (request !== mediaRequestRef.current) return;
      const pending = pendingPlayRef.current;
      if (pending) {
        const sameSession = next.active && next.app === pending.app && next.title === pending.title;
        if (pending.confirmedAfter !== null && sameSession && next.status === pending.status) {
          pendingPlayRef.current = null;
          setPlayPending(false);
        } else if (pending.confirmedAfter === null || Date.now() < pending.confirmedAfter) {
          return;
        } else {
          pendingPlayRef.current = null;
          setPlayPending(false);
        }
      }
      mediaRef.current = next;
      setMedia(next);
    } catch (error) {
      if (request === mediaRequestRef.current) {
        const pending = pendingPlayRef.current;
        if (pending && pending.confirmedAfter !== null && Date.now() >= pending.confirmedAfter) {
          pendingPlayRef.current = null;
          setPlayPending(false);
          mediaRef.current = pending.previous;
          setMedia(pending.previous);
        }
        console.warn("미디어 조회 실패:", error);
      }
    }
  };

  useEffect(() => {
    if (!window.notchApi) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await readMedia();
      if (!cancelled) timer = window.setTimeout(poll, MEDIA_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      mediaRequestRef.current++;
      window.clearTimeout(timer);
    };
  }, []);

  // 재생 중에는 마지막 폴링 시점부터 경과 시간을 더해 진행률을 부드럽게 올린다.
  useEffect(() => {
    if (!media.active || media.status !== "Playing") return;
    const id = window.setInterval(() => setNow(Date.now()), PROGRESS_TICK_MS);
    return () => window.clearInterval(id);
  }, [media.active, media.status]);
  // 앱을 켠 순간 이미 낡은 표본이면 그사이 멈춘 시간을 알 수 없다. 새 표본이 올 때까지는 위치를 확정하지 않는다.
  const timeKnown = !media.active || media.positionKnown !== false;
  // Windows는 재생 중 위치를 바꾸지 않고 LastUpdatedTime만 기록하므로, 그 시점부터 경과 시간을 더한다.
  const elapsed = timeKnown && media.status === "Playing" && media.updatedAt > 0 ? (now - media.updatedAt) / 1000 : 0;
  const livePosition = Math.min(media.duration, media.position + Math.max(0, elapsed));

  const mediaKey = `${media.title}|${media.artist}|${media.album}`;
  // 접힌 노치에도 현재 가사를 보여줘야 하므로 펼침 여부와 무관하게 미리 불러온다.
  useEffect(() => {
    const current = mediaRef.current;
    if (!current.active || !current.title) {
      setLyrics({ state: "idle", text: "", synced: [] });
      return;
    }
    let cancelled = false;
    // 영상 재생(뮤직비디오·공연)이면 줄 시각을 믿을 수 없으므로 가사를 띄우지 않는다.
    if (lyricPolicy(current) === "off") {
      setLyrics({ state: "off", text: "", synced: [] });
      return;
    }
    setLyrics({ state: "loading", text: "", synced: [] });
    void fetchLyrics(current).then((result) => {
      if (!cancelled) setLyrics(result);
    });
    return () => {
      cancelled = true;
    };
  }, [mediaKey, media.app]);

  // 직접 정렬은 싱크 가사가 없는 곡에서도 믿을 만한 결과를 내지 못해 지금은 쓰지 않는다.
  // (뮤직비디오 인트로·대사 구간에 가사를 밀어넣는 문제가 실측으로 확인됨)

  // 가사를 찾지 못한 곡은 유튜브 썸네일을 앨범처럼 띄운다. 실패하면 기존 앨범 아트로 돌아간다.
  useEffect(() => {
    if (!expanded || lyrics.state !== "missing" || !media.active) {
      setYtThumb("");
      return;
    }
    const track = trackName(media.title);
    const artist = artistName(media.artist);
    if (!track) return;
    let cancelled = false;
    void window.notchApi
      ?.getYoutubeThumb(track, artist)
      .then((url) => {
        if (!cancelled) setYtThumb(url || "");
      })
      .catch(() => {
        if (!cancelled) setYtThumb("");
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, lyrics.state, mediaKey]);

  const control = (action: "Play" | "Previous" | "Next") => (e: MouseEvent) => {
    e.stopPropagation();
    if (!window.notchApi || pendingPlayRef.current) return;
    const current = mediaRef.current;
    const target = { app: current.app, title: current.title };
    // 현재 실행 중인 조회는 제어 이전의 응답이므로 폐기한다.
    mediaRequestRef.current++;
    let pending: PendingPlay | null = null;
    const command = action === "Play" && current.status === "Playing" ? "Pause" : action;
    if (action === "Play") {
      const nowMs = Date.now();
      const playing = current.status === "Playing";
      const position = playing && current.updatedAt > 0
        ? Math.min(current.duration, current.position + Math.max(0, (nowMs - current.updatedAt) / 1000))
        : current.position;
      pending = { ...target, status: playing ? "Paused" : "Playing", confirmedAfter: null, previous: current };
      pendingPlayRef.current = pending;
      setPlayPending(true);
      const optimistic = { ...current, status: pending.status, position, updatedAt: nowMs };
      mediaRef.current = optimistic;
      setMedia(optimistic);
    }
    void window.notchApi.controlMedia(command, target).then((success) => {
      if (pending && pendingPlayRef.current === pending) {
        if (success) pending.confirmedAfter = Date.now() + 5000;
        else {
          pendingPlayRef.current = null;
          setPlayPending(false);
        }
      }
      if (!success) console.warn("미디어 제어 요청을 처리하지 못했습니다.");
      void readMedia();
    }).catch((error: unknown) => {
      if (pending && pendingPlayRef.current === pending) {
        pendingPlayRef.current = null;
        setPlayPending(false);
      }
      console.warn("미디어 제어 실패:", error);
      void readMedia();
    });
  };

  const hasMedia = media.active && media.title.length > 0;
  const accent = useAccent(hasMedia ? media.thumbnail || ytThumb : "");
  const shownTitle = cleanTitle(media.title);
  // 같은 앱의 탭이 둘 이상이면 번호를 붙여 어느 쪽인지 구분한다.
  const sourceChips = (() => {
    if (media.sources.length < 2) return [];
    const totals = new Map<string, number>();
    for (const source of media.sources) {
      const label = mediaAppName(source.app);
      totals.set(label, (totals.get(label) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    return media.sources.map((source) => {
      const label = mediaAppName(source.app);
      const index = (seen.get(label) ?? 0) + 1;
      seen.set(label, index);
      return { ...source, label: (totals.get(label) ?? 1) > 1 ? `${label} ${index}` : label };
    });
  })();
  // 직접 고른 세션으로 바꾸고, 다음 폴링을 기다리지 않고 바로 다시 읽는다.
  const selectSource = (id: string) => {
    const api = window.notchApi;
    if (!api || playPending || id === media.id) return;
    void api
      .selectMedia(id)
      .then((ok) => {
        if (ok) void readMedia();
      })
      .catch((error: unknown) => console.warn("미디어 소스 전환 실패:", error));
  };
  const view = resolveView(hasMedia);

  // 미디어가 없을 때 펼친 화면은 HUD만 보여준다. 시계와 온도는 그때만 돈다.
  const [hudNow, setHudNow] = useState(() => Date.now());
  const [weather, setWeather] = useState<{ tempC: number; kind: string; city: string } | null>(null);
  // 앱별 볼륨 화면. 펼친 패널 내용만 바꾸고, 접으면 닫힌다.
  const [mixOpen, setMixOpen] = useState(false);
  const [mixRowCount, setMixRowCount] = useState(2);
  const [linkHeight, setLinkHeight] = useState(180);
  const linkRef = useRef<HTMLDivElement>(null);
  // 디스코드 전용 화면.
  const [voiceOpen, setVoiceOpen] = useState(false);
  // 세 화면은 같은 자리를 쓰므로 하나를 열면 나머지는 닫는다.
  const openMix = () => {
    setVoiceOpen(false);
    setMixOpen(true);
  };
  const openVoice = () => {
    setMixOpen(false);
    setLinkOpen(false);
    setVoiceOpen(true);
  };
  // 출력 장치가 바뀌면 잠깐 알린다(접힌 동안에는 OUT 배지로만).
  const [deviceNote, setDeviceNote] = useState<NotchAudioDeviceChange | null>(null);
  useEffect(() => {
    if (!expanded) {
      setMixOpen(false);
      setVoiceOpen(false);
      setLinkOpen(false);
    }
  }, [expanded]);

  // 트레이의 "Discord 연결…"을 누르면 노치를 펼치고 연결 화면을 보여 준다.
  useEffect(() => {
    return window.notchApi?.onDiscordLink(() => {
      openExpand();
      setLinkOpen(true);
    });
  }, [openExpand]);

  useEffect(() => {
    const api = window.notchApi;
    if (!api) return;
    let cancelled = false;
    // IPC 구독 전 이미 도착한 READY/채널 이벤트를 놓치지 않도록 최신 상태를 먼저 읽는다.
    void api.getVoiceState().then((current) => {
      if (!cancelled && current) setVoice(current);
    }).catch(() => undefined);
    const unsubscribe = api.onVoice((next) => setVoice(next));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // 아이콘을 누르면 디스코드에 쓰기 명령을 한 번 보낸다(성공하면 이벤트로 상태가 돌아온다).
  const toggleVoice = (patch: { mute?: boolean; deaf?: boolean }) => {
    void window.notchApi?.setVoice(patch).catch(() => undefined);
  };

  useEffect(() => {
    return window.notchApi?.onAudioDevice((change) => setDeviceNote(change));
  }, []);

  useEffect(() => {
    if (!deviceNote) return;
    const id = window.setTimeout(() => setDeviceNote(null), 9000);
    return () => window.clearTimeout(id);
  }, [deviceNote]);

  // 접힌 유휴 노치의 점판 시계와 펼친 HUD가 같은 시각을 쓰도록 미디어가 없을 때는 항상 돈다.
  useEffect(() => {
    if (hasMedia) return;
    const id = window.setInterval(() => setHudNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasMedia]);

  // 날씨는 미디어가 없는 HUD에서만, 10분 간격으로 읽는다.
  useEffect(() => {
    if (!expanded || hasMedia || !window.notchApi) return;
    let cancelled = false;
    const read = () => {
      void window.notchApi!
        .getWeather()
        .then((next) => {
          if (!cancelled) setWeather(next);
        })
        .catch(() => undefined);
    };
    void read();
    const id = window.setInterval(read, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };  }, [expanded, hasMedia]);

  const collapsedBadge = deviceNote ? "OUT" : "";
  // 미디어 패널에서는 중복되는 NOTCH 문구를 숨기고 전원 상태만 표시한다.
  // 음성 채널에 있을 때는 오른쪽 자리를 마이크 표시에 내준다.
  const voiceActive = !!voice?.inChannel;
  const showMic = !expanded && voiceActive;
  const progress = timeKnown && media.duration > 0 ? Math.min(1, Math.max(0, livePosition / media.duration)) : 0;
  const hudDate = new Date(hudNow);
  const pad2 = (value: number) => String(value).padStart(2, "0");
  // 초는 따로 떼어 어둡게, 숫자는 세 칸 고정폭으로 흔들리지 않게.
  const hudHm = `${pad2(hudDate.getHours())}:${pad2(hudDate.getMinutes())}`;
  const hudSec = pad2(hudDate.getSeconds());
  const hudDay = `${hudDate.getFullYear()}.${pad2(hudDate.getMonth() + 1)}.${pad2(hudDate.getDate())} ${hudDate.toLocaleDateString("ko-KR", { weekday: "short" })}`;
  // 제목과 같은 앨범은 중복이라 메타 줄에서 뺀다.
  const metaAlbum =
    media.album && media.album !== media.title && media.album !== shownTitle ? media.album : "";
  // 위치가 확정되지 않았으면 줄 강조를 끄고 가사 전문만 보준다(잘못된 줄을 짚지 않도록).
  const hasSynced = lyrics.state === "ready" && lyrics.synced.length > 0 && timeKnown;
  // 현재 재생 시각에 해당하는 줄의 인덱스(마지막으로 시작한 줄).
  let activeLine = -1;
  if (hasSynced) {
    for (let i = 0; i < lyrics.synced.length; i++) {
      if (lyrics.synced[i].time <= livePosition) activeLine = i;
      else break;
    }
  }
  // 접힌 노치 오른쪽에 보여줄 현재 가사 한 줄. 빈 줄(간주)에서는 직전 가사를 유지한다.
  const collapsedLyric = (() => {
    if (!hasSynced) return "";
    for (let i = Math.min(Math.max(0, activeLine), lyrics.synced.length - 1); i >= 0; i--) {
      const text = lyrics.synced[i].text.trim();
      if (text) return text;
    }
    return "";
  })();
  const widestLyric = hasSynced
    ? lyrics.synced.reduce((longest, line) => (line.text.length > longest.length ? line.text : longest), "")
    : "";
  // 빛은 그 가사 줄이 화면에 머무는 동안 왼쪽에서 오른쪽으로 정확히 한 번 지나간다.
  const activeLineTime = hasSynced ? lyrics.synced[activeLine]?.time ?? 0 : 0;
  const nextLineTime = hasSynced ? lyrics.synced[activeLine + 1]?.time : undefined;
  const lineEndTime = nextLineTime ?? (media.duration > activeLineTime ? media.duration : activeLineTime + 4);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const lineSpan = Math.min(reduceMotion ? 24 : 12, Math.max(0.6, (lineEndTime - activeLineTime) * (reduceMotion ? 2 : 1)));
  // 이미 줄 중간이면 그만큼 앞선 지점에서 시작해 빛과 가사가 어긋나지 않게 한다.
  const lineElapsed = Math.min(lineSpan, Math.max(0, livePosition - activeLineTime));
  const shineProgress = lineSpan > 0 ? Math.min(1, Math.max(0, lineElapsed / lineSpan)) : 1;
  // 줄 시작에 왼쪽 끝(75%), 줄이 끝나면 오른쪽 끝(25%)에 빛이 닿는다.
  const shinePosition = `${(75 - 50 * shineProgress).toFixed(2)}% 0`;
  // 접힌 가사에도 같은 빛살을 흘린다. 빈 줄(간주)에서는 이전 가사가 남아 있으므로 빛은 두지 않는다.
  const collapsedShine = hasSynced && !!lyrics.synced[activeLine]?.text && !!collapsedLyric;

  // 화면 변경은 이전 내용을 먼저 지우고 새 내용을 나타낸다.
  const panelScreen = linkOpen ? "link" : voiceOpen && voiceActive && voice ? "voice" : mixOpen ? "mix" : view;
  const [displayScreen, setDisplayScreen] = useState(panelScreen);
  const [previousHeight, setPreviousHeight] = useState(0);
  const [contentLeaving, setContentLeaving] = useState(false);
  useEffect(() => {
    if (panelScreen === displayScreen) {
      setContentLeaving(false);
      return;
    }
    setContentLeaving(true);
    const timer = window.setTimeout(() => {
      setDisplayScreen(panelScreen);
      setContentLeaving(false);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [panelScreen, displayScreen]);

  useLayoutEffect(() => {
    const element = linkRef.current;
    if (!element || displayScreen !== "link") return;
    const update = () => setLinkHeight(Math.ceil(element.scrollHeight));
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [displayScreen]);

  // 폭 측정자는 패널의 움직이는 폭과 독립된 고유 너비를 쓴다.
  useEffect(() => {
    if (!expanded || view !== "media" || !hasSynced || !widestLyric) {
      setExpandedWidth(null);
      return;
    }
    const measure = lineMeasureRef.current;
    if (!measure) return;
    let cancelled = false;
    const update = () => {
      if (cancelled) return;
      // 미디어 패널과 좌우 여백을 포함한 폭. 가사가 길면 여기서 늘어난다.
      setExpandedWidth(Math.min(860, Math.max(EXPANDED_WIDTH, Math.ceil(measure.offsetWidth + 40))));
    };
    update();
    void document.fonts.ready.then(update);
    return () => {
      cancelled = true;
    };
  }, [expanded, view, hasSynced, widestLyric, displayScreen]);

  // 렌더링, CSS 크기와 Windows shape가 같은 화면 우선순위를 공유한다.
  const notchWidth = expanded
    ? panelScreen === "media" && hasSynced && widestLyric
      ? expandedWidth ?? EXPANDED_WIDTH
      : panelScreen === "hud" ? HUD_WIDTH : EXPANDED_WIDTH
    : view === "media" ? 440 : null;

  const mediaHeight = deviceNote ? 288 : 248;
  const mixHeight = Math.min(320, 108 + Math.max(2, mixRowCount) * 44 + (deviceNote ? 40 : 0));
  const voiceHeight = Math.min(320, 108 + Math.max(1, voice?.members.length ?? 0) * 38 + (deviceNote ? 40 : 0));
  const desiredHeight = !expanded ? 40 : panelScreen === "mix" ? mixHeight : panelScreen === "voice" ? voiceHeight : panelScreen === "link" ? Math.min(320, Math.max(160, linkHeight + 40 + (deviceNote ? 40 : 0))) : panelScreen === "hud" ? 176 : mediaHeight;
  const targetHeight = expanded && contentLeaving ? Math.max(desiredHeight, previousHeight) : desiredHeight;
  useLayoutEffect(() => {
    if (!contentLeaving) setPreviousHeight(desiredHeight);
  }, [contentLeaving, desiredHeight]);
  // 전환 중 shape는 현재·목표 사각형과 오버슈트를 덮고, 끝난 뒤에만 줄인다.
  const boundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const movingRef = useRef(false);
  useLayoutEffect(() => {
    const notch = notchRef.current;
    const api = window.notchApi;
    if (!notch || !api) return;
    const send = (bounds: { x: number; y: number; width: number; height: number }) => {
      boundsRef.current = bounds;
      // 지금 그려지는 아래 모서리 곡률을 같이 보낸다. 창 마스크가 이보다 작아야 CSS 곡선이 실루엣이 된다.
      const radius = Number.parseFloat(getComputedStyle(notch).borderBottomLeftRadius) || 0;
      api.setNotchBounds({ ...bounds, radius });
    };
    const current = notch.getBoundingClientRect();
    const width = notchWidth ?? 154;
    const targetLeft = (window.innerWidth - width) / 2;
    const prior = boundsRef.current;
    const left = Math.min(current.left, targetLeft) - 8;
    const right = Math.max(current.right, targetLeft + width) + 8;
    const bottom = Math.max(current.bottom, current.top + targetHeight) + 8;
    if (!prior || targetLeft < prior.x - 0.5 || targetLeft + width > prior.x + prior.width + 0.5 || current.top + targetHeight > prior.y + prior.height + 0.5) {
      send({ x: Math.min(left, prior?.x ?? left), y: current.top, width: Math.max(right, prior ? prior.x + prior.width : right) - Math.min(left, prior?.x ?? left), height: Math.max(bottom, prior ? prior.y + prior.height : bottom) - current.top });
    }
    movingRef.current = true;
    const audit = import.meta.env.DEV ? startBoundsAudit(notch, () => boundsRef.current) : null;
    let timer: number;
    let frame: number;
    const finish = () => {
      if (!movingRef.current) return;
      movingRef.current = false;
      window.clearTimeout(timer);
      const { x, y, width: finalWidth, height: finalHeight } = notch.getBoundingClientRect();
      send({ x, y, width: finalWidth, height: finalHeight });
      audit?.finish();
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target !== notch || !["width", "height"].includes(event.propertyName)) return;
      frame = window.requestAnimationFrame(() => {
        const changing = notch.getAnimations().some((animation) => animation instanceof CSSTransition && ["width", "height"].includes(animation.transitionProperty) && animation.playState === "running");
        if (!changing) finish();
      });
    };
    notch.addEventListener("transitionend", onEnd);
    timer = window.setTimeout(finish, 450);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) frame = window.requestAnimationFrame(finish);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      audit?.stop();
      notch.removeEventListener("transitionend", onEnd);
    };
  }, [notchWidth, targetHeight]);

  // CSS 전환이 없는 외부 크기 변경만 보정한다. 전환 프레임에서는 IPC를 보내지 않는다.
  useEffect(() => {
    const notch = notchRef.current;
    if (!notch) return;
    const observer = new ResizeObserver(() => {
      if (movingRef.current) return;
      const { x, y, width, height } = notch.getBoundingClientRect();
      const previous = boundsRef.current;
      if (previous && Math.abs(previous.x - x) < 0.5 && Math.abs(previous.y - y) < 0.5 && Math.abs(previous.width - width) < 0.5 && Math.abs(previous.height - height) < 0.5) return;
      const bounds = { x, y, width, height };
      boundsRef.current = bounds;
      window.notchApi?.setNotchBounds(bounds);
    });
    observer.observe(notch);
    return () => observer.disconnect();
  }, []);

  const showArt = lyrics.state === "missing" || lyrics.state === "instrumental" || lyrics.state === "idle";
  const lyricsText =
    lyrics.state === "ready"
      ? lyrics.text
      : lyrics.state === "instrumental"
        ? "연주곡입니다."
        : lyrics.state === "loading"
          ? "가사를 불러오는 중..."
          : "";

  return (
    <div
      ref={notchRef}
      role="button"
      tabIndex={0}
      className={`notch ${expanded ? "is-expanded" : "is-collapsed"}${view === "media" ? " has-media" : ""}${panelScreen === "media" ? " has-media-screen" : ""}${panelScreen === "hud" ? " has-hud" : ""}${panelScreen === "mix" ? " has-mix" : ""}${media.status === "Playing" ? " is-playing" : ""}${!expanded && collapsedBadge ? " has-status" : ""}${showMic ? " has-voice" : ""}`}
      style={{
        width: `${notchWidth ?? 154}px`,
        height: `${targetHeight}px`,
        "--notch-accent": accent,
      } as CSSProperties}
      onClick={(event) => {
        // 마이크 아이콘의 클릭은 상위로 올리지 않는다(노치 고정/해제로 새면 안 됨).
        if ((event.target as HTMLElement).closest?.(".notch-mic")) return;
        onToggle();
      }}
      onMouseEnter={(event) => {
        // 아이콘으로 곧장 들어온 경우에는 펼치지 않는다.
        // 펼치면서 아이콘이 움직이면 게임 중에 헛클릭이 나기 때문.
        if ((event.target as HTMLElement).closest?.(".notch-mic")) return;
        onHoverStart?.();
      }}
      onMouseLeave={onHoverEnd}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onToggle();
        }
      }}
      aria-expanded={expanded}
      aria-label="Notch"
    >
      <span className="notch-body" />
      {view === "media" && (
        <span className="notch-now">
          {media.thumbnail || ytThumb ? <img className="notch-now-art" src={media.thumbnail || ytThumb} alt="" /> : <Music className="notch-now-art" aria-hidden="true" strokeWidth={1.75} />}
          <span className="notch-now-lyric">
            <span className="notch-now-lyric-line" key={activeLine}>
              {collapsedLyric || shownTitle}
              {collapsedShine && <span className="notch-now-shine" aria-hidden="true" style={{ maskPosition: shinePosition, WebkitMaskPosition: shinePosition }}>{collapsedLyric}</span>}
            </span>
          </span>
          <span className="notch-eq" aria-hidden="true"><i /><i /><i /></span>
        </span>
      )}
      {!expanded && view === "hud" && !showMic && (
        <DotClock hours={hudDate.getHours()} minutes={hudDate.getMinutes()} />
      )}
      {showMic && voice && (
        <>
          <VoiceNow voice={voice} />
          <MicStatus voice={voice} onToggle={toggleVoice} />
        </>
      )}
      {collapsedBadge && <span className="notch-status">
        <Volume2 aria-label="출력 장치 변경" />
      </span>}
      {/* 접힌 동안 패널 안의 버튼이 탭으로 잡히지 않게 inert를 준다. */}
      <div className="notch-panel" inert={!expanded}>
        <div className="notch-main">
          {deviceNote && (
            <span className="notch-device-note" role="status" title={deviceNote.previous ? `이전: ${deviceNote.previous}` : undefined}>
              <span className="notch-device-note-text"><Settings2 size={16} strokeWidth={1.75} aria-hidden="true" /> {deviceNote.name}</span>
              <button
                type="button"
                className="notch-device-note-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  void window.notchApi?.openSoundSettings();
                }}
              >
                설정
              </button>
            </span>
          )}
          <div className={`notch-screen${contentLeaving ? " is-leaving" : ""}`} key={displayScreen}>
          {displayScreen === "link" ? (
            <div ref={linkRef} className="notch-link-measure"><DiscordLink onClose={() => setLinkOpen(false)} /></div>
          ) : displayScreen === "voice" && voice ? (
            <VoicePanel voice={voice} onClose={() => setVoiceOpen(false)} onToggle={toggleVoice} />
          ) : displayScreen === "mix" ? (
            <SoundMixer active={expanded} onClose={() => setMixOpen(false)} onRowCount={setMixRowCount} />
          ) : displayScreen === "hud" ? (
          <HudPanel hudHm={hudHm} hudSec={hudSec} hudDay={hudDay} weather={weather} expanded={expanded} openMix={openMix} voiceActive={voiceActive} voice={voice} openVoice={openVoice} toggleVoice={toggleVoice} />
        ) : (
          <MediaPanel shownTitle={shownTitle} hasMedia={hasMedia} media={media} metaAlbum={metaAlbum} livePosition={livePosition} progress={progress} timeKnown={timeKnown} sourceChips={sourceChips} playPending={playPending} selectSource={selectSource} hasSynced={hasSynced} activeLine={activeLine} lyrics={lyrics} shinePosition={shinePosition} showArt={showArt} ytThumb={ytThumb} lyricsText={lyricsText} lineMeasureRef={lineMeasureRef} widestLyric={widestLyric} voiceActive={voiceActive} voice={voice} openVoice={openVoice} toggleVoice={toggleVoice} control={control} expanded={expanded} openMix={openMix} />
        )}
          </div>
        </div>
      </div>
    </div>
  );
}
