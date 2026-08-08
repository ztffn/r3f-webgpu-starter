// Dev-console tab for how a first-person weapon is held: hip and ADS placement, the tilt
// an iron sight needs, and how fast the weapon comes up — all per weapon.
//
// Exists because the alternative is guessing from screenshots. The authored models differ
// enough that one placement cannot serve them all, and the aimed pose in particular cannot
// be judged without holding ADS, which is why this tab can hold it. Everything persists
// across reloads and prints back as source, so a session's work is not lost to a reload.

import { useEffect, useState } from "react";
import {
  RIG_WEAPON_KEYS,
  type RigWeaponKey,
} from "../fps/presentation/WeaponPresentationDefinition";
import { POSE_MODES, weaponPoses } from "../fps/presentation/weaponPoseStore";
import type { WeaponBobGait } from "../fps/presentation/WeaponBob";
import { CommitDial } from "./CommitDial";

/**
 * The bob dials. `weight` leads because it is the "too strong" knob — it scales every
 * amplitude at once without touching the stride, so the gait survives being quietened.
 */
const BOB_FIELDS: readonly {
  field: keyof WeaponBobGait;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  hint: string;
}[] = [
  { field: "weight", label: "Weight", min: 0, max: 2.5, step: 0.05, unit: "x", hint: "scales every axis below at once" },
  { field: "lateralMetres", label: "Side to side", min: 0, max: 0.06, step: 0.001, unit: " m", hint: "the wide swing; usually about twice the vertical" },
  { field: "verticalMetres", label: "Up and down", min: 0, max: 0.04, step: 0.001, unit: " m", hint: "one dip per footfall" },
  { field: "forwardMetres", label: "Forward surge", min: 0, max: 0.03, step: 0.001, unit: " m", hint: "with the vertical, not the swing" },
  { field: "rollDegrees", label: "Cant", min: 0, max: 6, step: 0.1, unit: "\u00b0", hint: "rolls with the swing" },
  { field: "yawDegrees", label: "Weave", min: 0, max: 6, step: 0.1, unit: "\u00b0", hint: "turns with the swing" },
  { field: "pitchDegrees", label: "Nod", min: 0, max: 4, step: 0.1, unit: "\u00b0", hint: "with the vertical" },
  { field: "metresPerCycle", label: "Stride", min: 0.8, max: 8, step: 0.05, unit: " m", hint: "distance per TWO footfalls. Longer = slower, longer paces" },
];

/**
 * Which gameplay weapon each rig weapon backs, so the printed ADS block names the
 * definition to paste it into. Only the four the game actually defines appear.
 */
const GAME_WEAPON_BY_RIG_KEY: ReadonlyMap<RigWeaponKey, string> = new Map([
  ["sniper", "SNIPER_DEFINITION (prototype-sniper)"],
  ["carbine", "M4_DEFINITION (m4)"],
  ["pistol", "GLOCK_DEFINITION (glock-9mm)"],
  ["lmg", "SAW_DEFINITION (saw-test)"],
]);

/**
 * Axis ranges. Hip is a whole eye-space placement; ADS on a weapon WITH an optic is a
 * nudge around glass already aligned to the eye, so its useful range is much tighter —
 * but the same control serves both, because on an optic-less weapon ADS is a full raise.
 */
const AXES = [
  { field: "x", label: "Right / left", min: -0.6, max: 0.6, step: 0.005, unit: " m" },
  { field: "y", label: "Up / down", min: -0.6, max: 0.4, step: 0.005, unit: " m" },
  { field: "z", label: "Forward / back", min: -1.2, max: 0.3, step: 0.005, unit: " m" },
  // Degrees. Pitch is the one an iron sight needs — the authored models carry the barrel
  // level, so lining up a rear notch means nosing the weapon down toward the eye.
  { field: "pitch", label: "Tilt down / up", min: -30, max: 30, step: 0.5, unit: "°" },
  { field: "yaw", label: "Turn left / right", min: -30, max: 30, step: 0.5, unit: "°" },
  { field: "roll", label: "Cant", min: -45, max: 45, step: 0.5, unit: "°" },
] as const;

export function WeaponPosePanel() {
  // The equipped weapon is mutable module state the frame loop writes, so poll it rather
  // than expecting a render. 4 Hz is far below the dial's own responsiveness and keeps
  // the panel honest about what is actually on screen.
  const [equipped, setEquipped] = useState<RigWeaponKey | null>(weaponPoses.equipped);
  const [hasOptic, setHasOptic] = useState(weaponPoses.equippedHasOptic);
  const [selected, setSelected] = useState<RigWeaponKey | null>(null);
  const [forceAds, setForceAds] = useState(weaponPoses.forceAds);
  const [forceSprint, setForceSprint] = useState(weaponPoses.forceSprint);
  // Bumped on every commit so the readouts re-render from the store. Functional form:
  // two dials committed in the same tick would otherwise both write the same value.
  const [, bumpRevision] = useState(0);
  const rerender = () => bumpRevision((n) => n + 1);

  useEffect(() => {
    const id = setInterval(() => {
      setEquipped(weaponPoses.equipped);
      setHasOptic(weaponPoses.equippedHasOptic);
    }, 250);
    return () => clearInterval(id);
  }, []);

  // Follow the equipped weapon unless the user has pinned one, so the common case —
  // switch weapon, tune it — needs no clicks.
  const target = selected ?? equipped;

  if (!target) {
    return (
      <div className="dev-section">
        <p className="dev-hint">
          No first-person rig mounted. Open <code>?scene=scope</code>; these dials place the
          rig relative to the eye and have nothing to act on until one is equipped.
        </p>
      </div>
    );
  }

  const pose = weaponPoses.get(target);
  const tuned = !weaponPoses.isDefault(target);
  const adsTiming = weaponPoses.adsTimingFor(target);

  return (
    <div className="dev-section">
      <p className="dev-hint">
        Placing <b>{target}</b>
        {target === equipped ? " (equipped)" : " — pinned; the equipped weapon is " + equipped}.{" "}
        <b data-dev="weaponpose-state">{tuned ? "Tuned this browser" : "Shipped defaults"}</b>.
        Tuning is kept in localStorage, so it survives closing the tab and restarting the
        browser — but it lives on THIS machine only. Paste the block below into source to
        keep it.
      </p>

      <label className="dial-row">
        <span>Weapon</span>
        <select
          data-dev="weaponpose-weapon"
          value={selected ?? ""}
          onChange={(event) =>
            setSelected(event.target.value === "" ? null : (event.target.value as RigWeaponKey))
          }
        >
          <option value="">Follow equipped</option>
          {RIG_WEAPON_KEYS.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
      </label>

      <label className="dial-row">
        <span>Hold ADS</span>
        <input
          type="checkbox"
          data-dev="weaponpose-forceads"
          checked={forceAds}
          onChange={(event) => {
            weaponPoses.forceAds = event.target.checked;
            setForceAds(event.target.checked);
          }}
        />
      </label>
      <label className="dial-row">
        <span>Hold sprint</span>
        <input
          type="checkbox"
          data-dev="weaponpose-forcesprint"
          checked={forceSprint}
          onChange={(event) => {
            weaponPoses.forceSprint = event.target.checked;
            setForceSprint(event.target.checked);
          }}
        />
      </label>
      <p className="dev-hint">
        Both hold their state without pointer lock, so the aimed and running poses can be
        tuned while the pointer is on a slider. ADS is layered last, so with both held the
        weapon aims.
      </p>

      {POSE_MODES.map((mode) => (
        <div key={mode}>
          <h4>
            {mode === "hip"
              ? "Hip"
              : mode === "sprint"
                ? "Sprint — mostly rotation: cant, turn off centre, nose down"
                : hasOptic && target === equipped
                  ? "ADS — eye relief behind the glass"
                  : "ADS — placeholder raise (no optic)"}
          </h4>
          {AXES.map(({ field, label, min, max, step, unit }) => (
            <CommitDial
              key={`${mode}-${field}`}
              devKey={`weaponpose-${mode}-${field}`}
              label={label}
              min={min}
              max={max}
              step={step}
              unit={unit}
              hint={
                mode === "hip"
                  ? "where the weapon rests when not aiming"
                  : mode === "sprint"
                    ? "where the weapon goes while the player is running"
                    : "applied once the optic is aligned to the eye"
              }
              value={pose[mode][field]}
              onCommit={(value) => {
                weaponPoses.set(target, mode, field, value);
                rerender();
              }}
            />
          ))}
        </div>
      ))}

      <button
        type="button"
        data-dev="weaponpose-reset"
        disabled={!tuned}
        onClick={() => {
          weaponPoses.reset(target);
          rerender();
        }}
      >
        Reset {target} to shipped
      </button>

      <h4>ADS timing — how fast this weapon comes up</h4>
      {adsTiming ? (
        <>
          {(["enterSeconds", "exitSeconds"] as const).map((field) => (
            <CommitDial
              key={field}
              devKey={`weaponpose-ads-${field}`}
              label={field === "enterSeconds" ? "Raise" : "Lower"}
              min={0.05}
              max={0.6}
              step={0.01}
              unit=" s"
              hint="authored in weaponDefinitions.ts; this overrides it live, offline only"
              value={adsTiming[field]}
              onCommit={(value) => {
                weaponPoses.setAdsTiming(target, field, value);
                rerender();
              }}
            />
          ))}
          <p className="dev-hint">
            A GAMEPLAY value — it drives sway and pointer sensitivity, not just the model.
            It belongs in <code>weaponDefinitions.ts</code>; paste the block below back
            there. Ignored while networked, where the server scores with the authored
            timings.
          </p>
        </>
      ) : (
        <p className="dev-hint">
          Equip <b>{target}</b> once to seed its timing from the weapon definition.
        </p>
      )}

      <h4>Movement bob — {target}</h4>
      <p className="dev-hint">
        Per weapon. Weight scales every axis at once and is the knob for "too strong".
        Stride is the other big one: it sets distance per two footfalls, so a LONGER stride
        means slower, longer paces at the same speed. The camera never bobs, only the
        weapon. Untuned weapons share the sourced defaults and print nothing below.
      </p>
      {(["walk", "sprint"] as const).map((gait) => (
        <div key={gait}>
          <h4>{gait === "walk" ? "Walking" : "Running"}</h4>
          {BOB_FIELDS.map(({ field, label, min, max, step, unit, hint }) => (
            <CommitDial
              key={`${gait}-${field}`}
              devKey={`weaponbob-${gait}-${field}`}
              label={label}
              min={min}
              max={max}
              step={step}
              unit={unit}
              hint={hint}
              value={weaponPoses.bobFor(target)[gait][field]}
              onCommit={(value) => {
                weaponPoses.setBob(target, gait, field, value);
                rerender();
              }}
            />
          ))}
        </div>
      ))}
      <button
        type="button"
        data-dev="weaponbob-reset"
        disabled={weaponPoses.bobIsDefault(target)}
        onClick={() => {
          weaponPoses.resetBob(target);
          rerender();
        }}
      >
        Reset {target} bob to shipped
      </button>
      <h4>Paste into BOB_BY_WEAPON in weaponPoseStore.ts</h4>
      <textarea
        data-dev="weaponbob-source"
        readOnly
        rows={20}
        value={weaponPoses.serializeBob()}
        onFocus={(event) => event.currentTarget.select()}
      />

      <h4>Paste over DEFAULT_POSES in weaponPoseStore.ts</h4>
      <textarea
        data-dev="weaponpose-source"
        readOnly
        rows={11}
        value={weaponPoses.serialize()}
        onFocus={(event) => event.currentTarget.select()}
      />

      <h4>Paste into the matching weapon in weaponDefinitions.ts</h4>
      <textarea
        data-dev="weaponpose-ads-source"
        readOnly
        rows={6}
        value={weaponPoses.serializeAdsTiming(GAME_WEAPON_BY_RIG_KEY)}
        onFocus={(event) => event.currentTarget.select()}
      />
    </div>
  );
}
