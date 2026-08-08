// Measures foliage depth complexity by rendering it and reading the pixels back.
//
// Not an estimate. Projected-area arithmetic on the CPU ignores occlusion, the alpha
// cutout and the frustum, and reads high by a factor nobody can bound — which makes it
// exactly the kind of plausible number this project has been burned by before. This
// renders the same additive materials the on-screen view uses into a half-float target
// and counts what actually landed, so the figures are measurements with stated bounds.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  FOLIAGE_DEBUG_OVERDRAW,
  FOLIAGE_OVERDRAW_STEP,
  type FoliageDebugControls,
} from "./foliageDebug.ts";

/**
 * Layer carrying every foliage mesh in both tiers.
 *
 * The probe renders the real scene with the camera restricted to this layer, so the
 * target holds foliage and nothing else. The alternative — reparenting the groups into a
 * scratch scene — fights React Three Fiber for ownership of the graph twice a second.
 */
export const FOLIAGE_LAYER = 5;

/** Sample side, in pixels. Small on purpose: the readback is the expensive part. */
const PROBE_SIZE = 256;

/** Milliseconds between samples. */
const SAMPLE_INTERVAL_MS = 500;

export interface FoliageOverdrawSample {
  /** Fraction of the probe's pixels with any foliage on them, 0-1. */
  coverage: number;
  /** Mean layers over the pixels foliage actually covers. */
  meanWhereCovered: number;
  /** Mean layers over the whole frame, including empty sky and ground. */
  meanOverFrame: number;
  /** Highest layer count on any single pixel. */
  peak: number;
  /** Fraction of COVERED pixels paying more than eight layers, 0-1. */
  fractionOverEight: number;
}

/**
 * IEEE half to float.
 *
 * The target has to be half-float: additive blending needs a blendable format, and
 * `rgba32float` is not blendable in WebGPU without an optional feature, while 8-bit
 * unorm clamps at one — which at a step of an eighth would cap the answer at 8 layers
 * and silently hide the tail this whole tool exists to find.
 */
function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits & 0x7c00) >> 10;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function summarise(red: (index: number) => number, pixels: number): FoliageOverdrawSample {
  let covered = 0;
  let sum = 0;
  let peak = 0;
  let overEight = 0;
  for (let i = 0; i < pixels; i += 1) {
    // Half a step of slack: one layer lands exactly on the step, and half-float rounding
    // must not turn it into zero coverage.
    const layers = red(i) / FOLIAGE_OVERDRAW_STEP;
    if (layers < 0.5) continue;
    covered += 1;
    sum += layers;
    if (layers > peak) peak = layers;
    if (layers > 8) overEight += 1;
  }
  return {
    coverage: pixels === 0 ? 0 : covered / pixels,
    meanWhereCovered: covered === 0 ? 0 : sum / covered,
    meanOverFrame: pixels === 0 ? 0 : sum / pixels,
    peak,
    fractionOverEight: covered === 0 ? 0 : overEight / covered,
  };
}

/**
 * Drives the sampler. Renders nothing itself.
 *
 * Only samples while the overdraw view is selected, so every other view — and normal
 * play — pays nothing at all for this existing.
 */
export function FoliageOverdrawProbe({ controls }: { controls: FoliageDebugControls }) {
  const { gl, scene, camera } = useThree();

  const target = useMemo(() => {
    const rt = new THREE.RenderTarget(PROBE_SIZE, PROBE_SIZE, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    rt.texture.name = "foliage-overdraw-probe";
    return rt;
  }, []);

  useEffect(() => () => target.dispose(), [target]);

  const state = useMemo(() => ({ at: 0, inFlight: false }), []);

  useFrame(() => {
    if ((controls.uniforms.debugMode.value as number) !== FOLIAGE_DEBUG_OVERDRAW) {
      controls.overdraw = null;
      return;
    }
    const now = performance.now();
    if (state.inFlight || now - state.at < SAMPLE_INTERVAL_MS) return;
    state.at = now;
    state.inFlight = true;

    const renderer = gl as unknown as {
      setRenderTarget: (t: THREE.RenderTarget | null) => void;
      render: (s: THREE.Object3D, c: THREE.Camera) => void;
      readRenderTargetPixelsAsync?: (
        t: THREE.RenderTarget,
        x: number,
        y: number,
        w: number,
        h: number
      ) => Promise<ArrayBufferView>;
    };
    if (typeof renderer.readRenderTargetPixelsAsync !== "function") {
      controls.overdraw = null;
      state.inFlight = false;
      return;
    }

    // Restrict the camera to the foliage layer for one render, so the target holds the
    // two tiers and nothing else — no terrain, no sky, no weapon.
    const mask = camera.layers.mask;
    camera.layers.set(FOLIAGE_LAYER);
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    camera.layers.mask = mask;

    void renderer
      .readRenderTargetPixelsAsync(target, 0, 0, PROBE_SIZE, PROBE_SIZE)
      .then((data) => {
        const pixels = PROBE_SIZE * PROBE_SIZE;
        // The array type follows the texture type, and three has returned both a raw
        // half-float view and a decoded float one across versions. Read whichever arrived
        // rather than assuming — guessing wrong here yields numbers that look plausible.
        const red =
          data instanceof Float32Array
            ? (i: number) => data[i * 4]
            : (i: number) => halfToFloat((data as Uint16Array)[i * 4]);
        controls.overdraw = summarise(red, pixels);
      })
      .catch(() => {
        // A failed readback must report nothing rather than a stale or invented figure.
        controls.overdraw = null;
      })
      .finally(() => {
        state.inFlight = false;
      });
  });

  return null;
}
