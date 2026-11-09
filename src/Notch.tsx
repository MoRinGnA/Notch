interface NotchProps {
  expanded: boolean;
  onToggle: () => void;
}

export function Notch({ expanded, onToggle }: NotchProps) {
  return (
    <button
      type="button"
      className={`notch ${expanded ? "is-expanded" : "is-collapsed"}`}
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label="Notch"
    >
      <span className="notch-body" />
      <span className="notch-status" />
      <span className="notch-eyes">
        <span className="notch-eye" />
        <span className="notch-eye" />
      </span>
      <span className="notch-axis" />
      <span className="notch-title">NOTCH-01</span>
      <span className="notch-hud">
        <span>CORE 98.4%</span>
        <span>LAT 12MS</span>
        <span>SYNC OK</span>
      </span>
      <span className="notch-scan" />
      <span className="notch-dim notch-dim-h">
        <i>460</i>
      </span>
      <span className="notch-dim notch-dim-v">
        <i>180</i>
      </span>
    </button>
  );
}
