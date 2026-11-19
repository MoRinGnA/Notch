import { Fragment } from "react";

// 점판 시계: 시·분의 각 자리를 3×3 점 한 장으로 보여 준다.
// 1~6은 주사위 눈, 7은 6에 가운데를 더하고, 8은 가장자리, 9는 전체를 켠다.
const FACE_PIPS: Record<number, string> = {
  0: "000000000",
  1: "000010000",
  2: "100000001",
  3: "100010001",
  4: "101000101",
  5: "101010101",
  6: "101101101",
  7: "101111101",
  8: "111101111",
  9: "111111111",
};

function Face({ digit }: { digit: number }) {
  const pips = FACE_PIPS[digit] ?? FACE_PIPS[0];
  return (
    <span className="notch-dotclock-face">
      {Array.from(pips, (pip, index) => (
        <i key={index} className={pip === "1" ? "is-on" : undefined} />
      ))}
    </span>
  );
}

export function DotClock({ hours, minutes }: { hours: number; minutes: number }) {
  const digits = [Math.floor(hours / 10), hours % 10, Math.floor(minutes / 10), minutes % 10];
  const label = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  return (
    <span
      className="notch-dotclock"
      role="img"
      aria-label={`${label} 점판 시계`}
      title="점판 시계 · 왼쪽부터 시 십·일 : 분 십·일"
    >
      {digits.map((digit, index) => (
        <Fragment key={index}>
          {index === 2 && (
            <span className="notch-dotclock-sep" aria-hidden="true">
              <i />
              <i />
            </span>
          )}
          <Face digit={digit} />
        </Fragment>
      ))}
    </span>
  );
}
