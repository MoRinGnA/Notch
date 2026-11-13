import { useEffect, useRef, useState } from "react";
import { Notch } from "./Notch";

// 마우스가 스치기만 해도 열리지 않도록, 머무를 때만 펼친다.
const HOVER_OPEN_MS = 140;
// 노치를 벗어난 뒤 바로 접히지 않게 여유를 둔다.
const HOVER_CLOSE_MS = 320;

export function App() {
  // 클릭/단축키로 고정한 상태와 마우스가 올라와 있는 상태를 따로 둔다.
  const [pinned, setPinned] = useState(false);
  const [hovering, setHovering] = useState(false);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  // 접힌 뒤 마우스가 그 자리에 남아 있어도 다시 열리지 않게 잠시 막는다.
  // 단, 마우스가 노치 밖에 있을 때 접은 경우에는 막지 않는다(다음 호버가 무시되는 문제 방지).
  const hoverBlocked = useRef(false);
  const insideRef = useRef(false);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  // settings.json의 값. 아직 못 읽었으면 기본 동작(호버 펼침)을 쓴다.
  const [settings, setSettings] = useState<NotchSettings | null>(null);
  const hoverOpen = settings?.hoverOpen ?? true;

  const expanded = pinned || hovering;

  const clearTimers = () => {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  useEffect(() => clearTimers, []);

  useEffect(() => {
    let alive = true;
    void window.notchApi
      ?.getSettings()
      .then((next) => {
        if (alive) setSettings(next);
      })
      .catch(() => {});
    const off = window.notchApi?.onSettings((next) => setSettings(next));
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  // 테마는 루트에 표시만 해 두고, 실제 색은 CSS 변수가 바꾼다.
  useEffect(() => {
    document.documentElement.dataset.theme = settings?.theme === "light" ? "light" : "dark";
  }, [settings?.theme]);

  // 호버 펼침을 끄면 열려 있던 호버 상태도 바로 접는다(고정은 그대로 둔다).
  useEffect(() => {
    if (hoverOpen) return;
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    setHovering(false);
  }, [hoverOpen]);

  useEffect(() => {
    return window.notchApi?.onToggle(() => {
      if (pinnedRef.current) {
        setPinned(false);
        setHovering(false);
        hoverBlocked.current = insideRef.current;
        clearTimers();
      } else {
        setPinned(true);
      }
    });
  }, []);

  // 트레이에서 특정 화면을 열 때는 펼치기만 하고 접지는 않는다.
  const handleExpand = () => {
    setPinned(true);
  };

  const handleToggle = () => {
    if (pinnedRef.current) {
      setPinned(false);
      setHovering(false);
      hoverBlocked.current = insideRef.current;
      clearTimers();
    } else {
      setPinned(true);
    }
  };

  const handleHoverStart = () => {
    insideRef.current = true;
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (!hoverOpen) return;
    if (hoverBlocked.current || hovering) return;
    if (openTimer.current) return;
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      setHovering(true);
    }, HOVER_OPEN_MS);
  };

  const handleHoverEnd = () => {
    insideRef.current = false;
    hoverBlocked.current = false;
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setHovering(false);
    }, HOVER_CLOSE_MS);
  };

  return (
    <div className="stage">
      <Notch
        expanded={expanded}
        onToggle={handleToggle}
        onExpand={handleExpand}
        onHoverStart={handleHoverStart}
        onHoverEnd={handleHoverEnd}
      />
    </div>
  );
}
