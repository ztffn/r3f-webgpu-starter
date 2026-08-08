// Open/closed state and tab selection for the dev console.
//
// Two ways in, on purpose: backtick for a human at the keyboard, and `?debug=1`
// for anything driving a browser, which cannot reliably synthesise a keypress
// before the app has mounted. The selected tab is remembered in sessionStorage so
// tuning a dial, reloading to rebake a URL parameter, and carrying on does not
// cost two clicks each time.

import { useCallback, useEffect, useState } from "react";
import { readSession, writeSession } from "../hud/hudPanels";

export const DEV_TABS = [
  "scene",
  "hud",
  "launch",
  "telemetry",
  "grass",
  "foliage",
  "weather",
  "controls",
] as const;
export type DevTab = (typeof DEV_TABS)[number];

const TAB_KEY = "df2.devtools.tab";

function initialTab(): DevTab {
  // Through the guarded readers: with cookies blocked, touching sessionStorage
  // throws, and this runs in a useState initializer.
  const stored = readSession(TAB_KEY);
  return DEV_TABS.includes(stored as DevTab) ? (stored as DevTab) : "scene";
}

export interface DevConsoleState {
  open: boolean;
  tab: DevTab;
  setTab: (tab: DevTab) => void;
  toggle: () => void;
  close: () => void;
}

export function useDevConsole(startOpen: boolean): DevConsoleState {
  const [open, setOpen] = useState(startOpen);
  const [tab, setTabState] = useState<DevTab>(initialTab);

  const setTab = useCallback((next: DevTab) => {
    setTabState(next);
    writeSession(TAB_KEY, next);
  }, []);

  const toggle = useCallback(() => setOpen((was) => !was), []);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Ignore the shortcut while a field has focus, or typing a backtick into
      // any future text input would close the panel under the cursor.
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      // A range input is an input but cannot receive a backtick, and the dials are
      // the thing most likely to hold focus while the panel is being toggled.
      const isRange = target instanceof HTMLInputElement && target.type === "range";
      if (event.key === "`" && (!typing || isRange)) {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return { open, tab, setTab, toggle, close };
}
