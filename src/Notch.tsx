interface NotchProps {
  expanded: boolean;
  onToggle: () => void;
}

export function Notch({ expanded, onToggle }: NotchProps) {
  return (
    <div className="notch-wrap">
      <svg className="notch-defs" aria-hidden="true">
        <defs>
          <filter id="notch-refract" x="-20%" y="-20%" width="140%" height="140%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.012 0.03"
              numOctaves={2}
              seed={3}
              result="noise"
            >
              <animate
                attributeName="baseFrequency"
                dur="9s"
                values="0.012 0.03;0.018 0.022;0.012 0.03"
                repeatCount="indefinite"
              />
            </feTurbulence>
            <feDisplacementMap
              in="SourceGraphic"
              in2="noise"
              scale={expanded ? 18 : 10}
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>

      <button
        type="button"
        className={`notch ${expanded ? "is-expanded" : "is-collapsed"}`}
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label="Notch"
      >
        <div className="notch-body" />
      </button>
    </div>
  );
}
