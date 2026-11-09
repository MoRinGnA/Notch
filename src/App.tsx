import { useState } from "react";
import { Notch } from "./Notch";

export function App() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="stage">
      <Notch expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
    </div>
  );
}
