// Collapsible HUD panel shell.
//
// Every instrument panel shares this: the eyebrow title doubles as the
// expand/collapse toggle, so any panel can be folded away when it sits on top
// of the scene or another readout. Collapse state is per-mount and
// deliberately not persisted — a reload restores each panel's authored
// default (only the controls legend starts closed).

import { useState, type ReactNode } from "react";

export interface CollapsiblePanelProps {
  id: string;
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function CollapsiblePanel({
  id,
  title,
  defaultOpen = true,
  children,
}: CollapsiblePanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="panel" id={id}>
      <button
        type="button"
        className="eyebrow panel-toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {title} {open ? "▾" : "▸"}
      </button>
      {open && children}
    </section>
  );
}
