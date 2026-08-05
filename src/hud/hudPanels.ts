// The HUD's panel registry: one id per toggleable panel, the labels the dev
// console shows for them, and the sessionStorage persistence for visibility and
// panel opacity. GameHud consumes the ids to gate rendering; the dev console's
// HUD tab consumes ids + labels to draw the toggles. One list, both readers —
// a panel absent here simply cannot be hidden, which is the safe default.

export const HUD_PANELS = [
  "crosshair",
  "compass",
  "wind",
  "invite",
  "objective",
  "chat",
  "weapon",
  "vitals",
  "nav",
] as const;

export type HudPanelId = (typeof HUD_PANELS)[number];

export const HUD_PANEL_LABELS: Record<HudPanelId, string> = {
  crosshair: "Crosshair",
  compass: "Compass",
  wind: "Wind",
  invite: "Invite",
  objective: "Objective",
  chat: "Feed",
  weapon: "Weapon",
  vitals: "Vitals",
  nav: "Nav / radar",
};

export type HudPanelVisibility = Record<HudPanelId, boolean>;

const PANELS_KEY = "df2.hud.panels";
const ALPHA_KEY = "df2.hud.panelAlpha";

/** All panels visible — the state every session starts from unless it stored one. */
export function allPanelsVisible(): HudPanelVisibility {
  return Object.fromEntries(HUD_PANELS.map((id) => [id, true])) as HudPanelVisibility;
}

/** Every panel off — what `?hud=0` starts from. Combat feedback stays. */
export function allPanelsHidden(): HudPanelVisibility {
  return Object.fromEntries(HUD_PANELS.map((id) => [id, false])) as HudPanelVisibility;
}

/**
 * Session-scoped, like the dev console's remembered tab: hiding a panel is a
 * debugging posture, and a posture that silently survived into next week's
 * session would read as a missing panel bug.
 */
export function loadPanelVisibility(): HudPanelVisibility {
  const base = allPanelsVisible();
  try {
    const raw = sessionStorage.getItem(PANELS_KEY);
    if (raw === null) return base;
    const stored = JSON.parse(raw) as Partial<Record<string, boolean>>;
    for (const id of HUD_PANELS) {
      if (typeof stored[id] === "boolean") base[id] = stored[id];
    }
  } catch {
    // Corrupt storage means the defaults, not a crash before the HUD mounts.
  }
  return base;
}

export function savePanelVisibility(value: HudPanelVisibility): void {
  sessionStorage.setItem(PANELS_KEY, JSON.stringify(value));
}

/** 1 is the stylesheet's own transparency; the dial scales it either way. */
export function loadPanelAlpha(): number {
  const raw = Number(sessionStorage.getItem(ALPHA_KEY));
  return Number.isFinite(raw) && raw > 0 && raw <= 1.6 ? raw : 1;
}

export function savePanelAlpha(value: number): void {
  sessionStorage.setItem(ALPHA_KEY, String(value));
}
