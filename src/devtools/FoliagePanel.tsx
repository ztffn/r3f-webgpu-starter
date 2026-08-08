// Dev-console tab for the vegetation layer: false-colour views, spawn dials, readouts.
//
// Split out of the Scene tab rather than grown there. The Scene tab hid the whole foliage
// section behind `?foliage=1`, so with the flag off there was no evidence the controls
// existed at all — the failure this tab is meant to end. It always renders, and says what
// is missing when the layer is off.

import { memo, useEffect, useRef, useState } from "react";
import { BENCH } from "../df2/bench";
import type { FoliageBenchSample } from "../df2/bench";
import type { SceneHandles } from "../df2/DF2Scene";
import type { FoliageOverdrawSample } from "../foliage/FoliageOverdrawProbe";
import {
  FOLIAGE_DEBUG_HINTS,
  FOLIAGE_DEBUG_OVERDRAW,
  FOLIAGE_DEBUG_MODES,
  FOLIAGE_DEBUG_UNAVAILABLE,
  type FoliageDebugControls,
} from "../foliage/foliageDebug";
import { SPECIES } from "../foliage/species";
import { CommitDial } from "./CommitDial";

/**
 * The dials that REBUILD the cell window, so they commit on pointer release.
 *
 * Read and written through `SceneHandles` rather than carrying bound setters, so the
 * table stays a module constant instead of being rebuilt inside JSX every render.
 */
const REBUILD_DIALS = [
  {
    key: "radius",
    label: "Spawner reach",
    min: 96,
    max: 768,
    step: 32,
    read: (s: SceneHandles) => s.foliageRadius,
    write: (s: SceneHandles, v: number) => s.setFoliageRadius(v),
    hint: "how far plants are placed at all. Rebuilds",
  },
  {
    key: "spacing",
    label: "Site spacing",
    min: 1.5,
    max: 8,
    step: 0.25,
    read: (s: SceneHandles) => s.foliageSpacing,
    write: (s: SceneHandles, v: number) => s.setFoliageSpacing(v),
    hint: "metres between candidate sites. Count scales as 1/spacing², so halving it quadruples the plants. Rebuilds",
  },
  {
    key: "far",
    label: "Far ring",
    min: 0,
    max: 1024,
    step: 64,
    read: (s: SceneHandles) => s.foliageFar,
    write: (s: SceneHandles, v: number) => s.setFoliageFar(v),
    hint: "octahedral-impostor reach past the spawner window; 0 turns the ring off. Rebuilds",
  },
] as const;

export interface FoliagePanelProps {
  scene: SceneHandles | null;
  controls: FoliageDebugControls | null;
  /** True when the room owns the world and local edits would desync it. */
  networked: boolean;
}

function count(value: number | undefined): string {
  if (value === undefined) return "—";
  return value >= 10000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

export const FoliagePanel = memo(function FoliagePanel({
  scene,
  controls,
  networked,
}: FoliagePanelProps) {
  // Mirrors the handles rather than owning them: the panel mutates `controls` directly,
  // exactly like the Grass tab writes uniforms, so no control re-renders the canvas tree.
  const [debugMode, setDebugMode] = useState(0);
  const [hidden, setHidden] = useState<readonly boolean[]>(() => SPECIES.map(() => false));
  const [lodScale, setLodScale] = useState(1);
  // Tier buttons read the mutable handles directly; this just forces the repaint.
  const [, setTierNonce] = useState(0);
  const seeded = useRef(false);
  useEffect(() => {
    if (!controls || seeded.current) return;
    setDebugMode(Number(controls.uniforms.debugMode.value));
    setHidden(controls.speciesVisible.map((v) => !v));
    setLodScale(controls.lodDistanceScale);
    seeded.current = true;
  }, [controls]);

  // The published sample, polled rather than pushed — the layer already throttles it to
  // 250 ms and nothing here should re-render the scene.
  const [sample, setSample] = useState<FoliageBenchSample | null>(null);
  const [overdraw, setOverdraw] = useState<FoliageOverdrawSample | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      setSample(window.__foliage ?? null);
      setOverdraw(controls?.overdraw ?? null);
    }, 400);
    return () => window.clearInterval(id);
  }, [controls]);

  if (!BENCH.foliage) {
    return (
      <p className="note" data-dev="foliage-off">
        The vegetation layer is off. Add <code>?foliage=1</code> to the URL and reload —
        it gates the layer itself, not just these controls, so nothing here can turn it
        on. Add <code>?admin=1</code> too if you are in a networked session.
      </p>
    );
  }

  const locked = networked && BENCH.admin !== true;

  return (
    <>
      <span className="eyebrow dev-group">View</span>
      <div className="btns" data-dev="modes-foliageDebug" data-dev-value={debugMode}>
        {FOLIAGE_DEBUG_MODES.map((label, i) => {
          const unavailable = FOLIAGE_DEBUG_UNAVAILABLE.includes(i);
          return (
            <button
              key={label}
              type="button"
              data-dev={`foliageDebug-${i}`}
              aria-pressed={debugMode === i}
              disabled={unavailable || !controls}
              title={
                unavailable
                  ? "Trunk collision is client-only and analytic — there is no authoritative shape to draw yet"
                  : undefined
              }
              onClick={() => {
                if (!controls) return;
                controls.uniforms.debugMode.value = i;
                setDebugMode(i);
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
      {/* What the selected view actually answers. The first two labels were opaque on
          their own — "Tier" told a reader nothing about near versus far. */}
      <p className="note" data-dev="foliage-view-hint">
        <b>{FOLIAGE_DEBUG_MODES[debugMode]}</b> — {FOLIAGE_DEBUG_HINTS[debugMode]}
      </p>
      {/* Stated, not implied by a greyed button: an unexplained disabled control reads as
          broken. Trunks already stop bullets on the client (VegetationWorldQuery), so the
          missing piece is server authority, not the proxy. */}
      <p className="note" data-dev="foliage-collision-pending">
        <b>Collision</b> is reserved. Trunk proxies are analytic and client-side only
        today, so there is no authoritative shape to draw — it lights up when server-side
        trunk collision lands.
      </p>
      {!controls && (
        <p className="note" data-dev="foliage-uniforms-pending">
          Waiting for the layer to mount — views enable once it has.
        </p>
      )}

      <span className="eyebrow dev-group">Species</span>
      {/* Attribution, not styling: a hidden species leaves the frame entirely — no draw
          call in either tier — so the frame-time delta is that species' whole cost. Both
          tiers are hidden together, or the cost would only move from one to the other. */}
      <div className="btns" data-dev="foliage-species">
        {SPECIES.map((species, i) => (
          <button
            key={species.id}
            type="button"
            data-dev={`foliage-species-${species.id}`}
            aria-pressed={!hidden[i]}
            disabled={!controls}
            onClick={() => {
              if (!controls) return;
              const next = !hidden[i];
              controls.speciesVisible[i] = !next;
              setHidden(hidden.map((h, j) => (j === i ? next : h)));
            }}
          >
            {species.id}
          </button>
        ))}
      </div>
      <div className="btns">
        <button
          type="button"
          data-dev="foliage-species-all"
          disabled={!controls}
          onClick={() => {
            if (!controls) return;
            controls.speciesVisible.fill(true);
            setHidden(SPECIES.map(() => false));
          }}
        >
          Show all
        </button>
        <button
          type="button"
          data-dev="foliage-species-none"
          disabled={!controls}
          onClick={() => {
            if (!controls) return;
            controls.speciesVisible.fill(false);
            setHidden(SPECIES.map(() => true));
          }}
        >
          Hide all
        </button>
      </div>

      <span className="eyebrow dev-group">Ranges</span>
      <CommitDial
        devKey="foliage-lodscale"
        label="LOD distance"
        min={0.25}
        max={4}
        step={0.25}
        hint="multiplies every LOD switch distance. Below 1 drops detail sooner (cheaper, more popping); above 1 holds LOD 0 further out. 1 is shipped behaviour. Live, no rebuild"
        unit="×"
        value={lodScale}
        onCommit={(v) => {
          if (!controls) return;
          controls.lodDistanceScale = v;
          setLodScale(v);
        }}
      />

      <span className="eyebrow dev-group">Spawning</span>
      {locked ? (
        <p className="note" data-dev="foliage-locked">
          The room owns the world in a networked session; cover is gameplay, so these are
          read-only here. Go offline, or use <code>?admin=1</code>.
        </p>
      ) : (
        scene && (
          <>
            <CommitDial
              devKey="foliage-density"
              label="Density"
              min={0}
              max={10}
              step={0.25}
              hint="global multiplier on every species. Saturates — spacing is the real lever on count. Live, no rebuild"
              value={scene.foliageDensity}
              onCommit={(v) => scene.setFoliageDensity(v)}
            />
            {REBUILD_DIALS.map((d) => (
              <CommitDial
                key={d.key}
                devKey={`foliage-${d.key}`}
                label={d.label}
                min={d.min}
                max={d.max}
                step={d.step}
                hint={d.hint}
                unit=" m"
                value={d.read(scene)}
                onCommit={(v) => d.write(scene, v)}
              />
            ))}
          </>
        )
      )}

      <span className="eyebrow dev-group">Tiers</span>
      {/* Isolation for attribution. Three exposes no per-pass GPU timestamps, so the only
          honest split is "remove it and measure the difference" against the GPU ms on the
          Telemetry tab. */}
      <div className="btns" data-dev="foliage-tiers">
        {(
          [
            ["near", "Near window", () => controls?.nearVisible ?? true],
            ["far", "Far ring", () => controls?.farVisible ?? true],
          ] as const
        ).map(([key, label, read]) => (
          <button
            key={key}
            type="button"
            data-dev={`foliage-tier-${key}`}
            aria-pressed={read()}
            disabled={!controls}
            onClick={() => {
              if (!controls) return;
              if (key === "near") controls.nearVisible = !controls.nearVisible;
              else controls.farVisible = !controls.farVisible;
              setTierNonce((n) => n + 1);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {debugMode === FOLIAGE_DEBUG_OVERDRAW && (
        <>
          <span className="eyebrow dev-group">Depth complexity</span>
          {overdraw === null ? (
            /* Absent, not zero. No sample has come back yet, or the backend has no
               readback — either way the honest reading is "not measured". */
            <p className="note" data-dev="foliage-overdraw-pending">
              Measuring — no sample yet.
            </p>
          ) : (
            <dl className="rows" data-dev="foliage-overdraw">
              <dt>Layers, where covered</dt>
              <dd data-dev="foliage-overdraw-mean">{overdraw.meanWhereCovered.toFixed(2)}×</dd>
              <dt>Peak on any pixel</dt>
              <dd data-dev="foliage-overdraw-peak">{overdraw.peak.toFixed(0)}×</dd>
              <dt>Screen covered</dt>
              <dd data-dev="foliage-overdraw-coverage">
                {(overdraw.coverage * 100).toFixed(1)}%
              </dd>
              <dt>Over 8 layers</dt>
              <dd data-dev="foliage-overdraw-heavy">
                {(overdraw.fractionOverEight * 100).toFixed(1)}% of covered
              </dd>
              <dt>Layers per screen pixel</dt>
              <dd data-dev="foliage-overdraw-frame">{overdraw.meanOverFrame.toFixed(2)}×</dd>
            </dl>
          )}
          <p className="note">
            Measured, not estimated: the two tiers are rendered alone into a half-float
            target twice a second and the pixels are read back. Counts fragments that pass
            the alpha test and ignores occlusion by terrain, so it is the upper bound on
            shading work — which is the quantity that grows with density.
          </p>
        </>
      )}

      <span className="eyebrow dev-group">Counts</span>
      <dl className="rows" data-dev="foliage-stats">
        <dt>Buckets</dt>
        <dd data-dev="foliage-buckets">{count(sample?.visibleBuckets)}</dd>
        <dt>Instances</dt>
        <dd data-dev="foliage-instances">{count(sample?.visibleInstances)}</dd>
        <dt>Triangles</dt>
        <dd data-dev="foliage-triangles">{count(sample?.trianglesIfAllDrawn)}</dd>
        <dt>Cells cached</dt>
        <dd data-dev="foliage-cells">{count(sample?.cellsCached)}</dd>
        <dt>Far impostors</dt>
        <dd data-dev="foliage-far">
          {/* Absent and zero are different claims: the ring is off below 1 m of reach,
              and the sample simply carries no field until it has reported once. */}
          {sample?.farInstances === undefined ? "off" : count(sample.farInstances)}
        </dd>
        <dt>Building</dt>
        <dd data-dev="foliage-pending">
          {sample === null
            ? "—"
            : sample.pendingBuckets > 0 || sample.farFilling
              ? `${sample.pendingBuckets} buckets${sample.farFilling ? " + ring" : ""}`
              : "settled"}
        </dd>
      </dl>
      <p className="note">
        Variant, alpha mode and cell size are reload-only:{" "}
        <code>?foliagevariant=</code> <code>?foliagealpha=</code>{" "}
        <code>?foliagecell=</code>.
      </p>
    </>
  );
});
