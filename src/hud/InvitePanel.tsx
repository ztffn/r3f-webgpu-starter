// The private game's invite code, shown to everyone in the room.
//
// Exists because a host could previously start a private game and then have no way
// to invite anyone — the room minted a code and only the server log ever saw it.
//
// Shown to every member rather than only the creator: anyone already inside got
// there with the code, so they know it. The one person who does not is the host, and
// singling them out would mean tracking who created the room for no benefit.
//
// The only HUD element that takes pointer events. `.hud-root` is click-through so a
// look-drag never catches on a panel, so this one re-enables them on itself alone.

import { useEffect, useRef, useState } from "react";

export interface InvitePanelProps {
  /** Null for a public room, and offline. The panel renders nothing then. */
  joinCode: string | null;
}

/** What the last copy attempt did, and to which button it belongs. */
type CopyResult = { what: "code" | "link"; ok: boolean };

export function InvitePanel({ joinCode }: InvitePanelProps) {
  const [copied, setCopied] = useState<CopyResult | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const timer = useRef<number | null>(null);

  // Clear the "copied" flash on unmount as well as on a new copy, or a timer
  // fires into a component that is gone.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  if (joinCode === null) return null;

  const inviteUrl = `${window.location.origin}/lobby?code=${encodeURIComponent(joinCode)}`;

  const copy = (what: "code" | "link", text: string) => {
    // Clipboard access can be refused (insecure origin, denied permission), and a
    // button that silently does nothing is worse than one that says it failed. The
    // code is on screen either way, so a failure is recoverable by reading it.
    const done = (ok: boolean) => {
      setCopied({ what, ok });
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), 1600);
    };
    // No Clipboard API at all is the insecure-origin case, and optional chaining
    // short-circuits the whole chain — so this needs its own branch or the button
    // is inert with no message, which is the thing the comment above rules out.
    const clipboard = navigator.clipboard;
    if (clipboard === undefined) return void done(false);
    clipboard.writeText(text).then(
      () => done(true),
      () => done(false)
    );
  };

  /** What a button says right now. The code stays on screen either way. */
  const label = (what: "code" | "link", idle: string): string => {
    if (copied === null || copied.what !== what) return idle;
    return copied.ok ? "Copied" : "Copy failed";
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className="hud-invite-pill"
        data-dev="invite-expand"
        onClick={() => setCollapsed(false)}
      >
        Invite
      </button>
    );
  }

  return (
    <section className="hud-panel hud-invite notched notched-sm" data-dev="hud-invite">
      <header className="hud-invite-head">
        <span>Private game</span>
        <button
          type="button"
          className="hud-invite-close"
          data-dev="invite-collapse"
          onClick={() => setCollapsed(true)}
        >
          <span className="sr-only">Collapse the invite panel</span>
          <span aria-hidden="true">–</span>
        </button>
      </header>

      {/* Letter-spaced and monospaced: this gets read aloud over voice, and the
          whole point of the alphabet is that each character is unambiguous. */}
      <p className="hud-invite-code" data-dev="invite-code">
        {joinCode}
      </p>

      <div className="hud-invite-actions">
        <button type="button" data-dev="invite-copy-code" onClick={() => copy("code", joinCode)}>
          {label("code", "Copy code")}
        </button>
        <button type="button" data-dev="invite-copy-link" onClick={() => copy("link", inviteUrl)}>
          {label("link", "Copy link")}
        </button>
      </div>
      <p className="hud-invite-note">Anyone with this can join.</p>
    </section>
  );
}
