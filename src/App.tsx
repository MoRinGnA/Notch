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
      // 입력 중인 값이 있을 때만 접힘을 보류한다. 버튼 포커스는 타이머 자동 접힘을 막지 않는다.
      const active = document.activeElement;
      const editing = active instanceof HTMLElement
        && active.closest(".notch")
        && active.matches("input:not([type=button]):not([type=submit]), textarea, select, [contenteditable='true']");
      if (editing) return;
      setHovering(false);
    }, HOVER_CLOSE_MS);
  };

  return (
    <div className="stage">
      <Notch
        expanded={expanded}
        onToggle={handleToggle}
        onHoverStart={handleHoverStart}
        onHoverEnd={handleHoverEnd}
      />
    </div>
  );
}
