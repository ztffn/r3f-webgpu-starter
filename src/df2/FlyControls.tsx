// Free-fly / ground camera.
//
// Orbit controls are the wrong tool for this project: judging whether terrain
// and grass feel right means standing in it at eye height and walking, not
// circling a pivot. This gives WASD flight, drag to look, and a ground mode that
// clamps to the surface at a stance height — which is also how the concealment
// mechanic gets evaluated by eye.

import { useThree, useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import type { Heightfield } from "./Heightfield";

/** Eye height above ground, metres. Matches docs/04 §4.2. */
export const STANCE_EYE = { stand: 1.7, crouch: 0.95, prone: 0.35 } as const;
export type Stance = keyof typeof STANCE_EYE;

export interface FlyState {
  position: THREE.Vector3;
  /** Metres above the terrain surface. */
  agl: number;
  speed: number;
  grounded: boolean;
}

export interface FlyControlsProps {
  heightfield: Heightfield;
  grounded: boolean;
  stance: Stance;
  /** Called at most a few times a second with the current rig state. */
  onState?: (s: FlyState) => void;
  onToggleGround?: () => void;
  /** Stance requested from the keyboard. Implies dropping to ground mode. */
  onStance?: (s: Stance) => void;
}

const UP = new THREE.Vector3(0, 1, 0);

export function FlyControls({
  heightfield,
  grounded,
  stance,
  onState,
  onToggleGround,
  onStance,
}: FlyControlsProps) {
  const { camera, gl } = useThree();

  const rig = useMemo(
    () => ({
      yaw: Math.PI,
      pitch: -0.15,
      speed: 60,
      keys: new Set<string>(),
      dragging: false,
      lastX: 0,
      lastY: 0,
      report: 0,
      pos: new THREE.Vector3(0, 0, 0),
      initialised: false,
    }),
    []
  );

  // Scratch vectors, reused every frame.
  const v = useMemo(
    () => ({ dir: new THREE.Vector3(), fwd: new THREE.Vector3(), right: new THREE.Vector3() }),
    []
  );

  useEffect(() => {
    const el = gl.domElement;

    const down = (e: KeyboardEvent) => {
      // Don't fight the browser over scroll/zoom keys while flying.
      if (["Space", "ShiftLeft", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code))
        e.preventDefault();
      rig.keys.add(e.code);
      if (e.code === "KeyG") onToggleGround?.();
      // Stance keys imply going to ground: the whole point of prone here is
      // judging concealment from eye height, and making that a two-step
      // (toggle ground, then pick stance) just adds a wrong first click.
      if (e.code === "KeyX") onStance?.("stand");
      if (e.code === "KeyC") onStance?.("crouch");
      if (e.code === "KeyZ") onStance?.("prone");
    };
    const up = (e: KeyboardEvent) => rig.keys.delete(e.code);
    const blur = () => rig.keys.clear();

    const pdown = (e: PointerEvent) => {
      rig.dragging = true;
      rig.lastX = e.clientX;
      rig.lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const pup = (e: PointerEvent) => {
      rig.dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    };
    const pmove = (e: PointerEvent) => {
      if (!rig.dragging) return;
      rig.yaw -= (e.clientX - rig.lastX) * 0.0032;
      rig.pitch -= (e.clientY - rig.lastY) * 0.0032;
      rig.pitch = Math.max(-1.5, Math.min(1.5, rig.pitch));
      rig.lastX = e.clientX;
      rig.lastY = e.clientY;
    };
    // Wheel adjusts flight speed rather than dollying — there is no pivot to
    // dolly toward, and speed is what you actually want to change mid-flight.
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      rig.speed = Math.max(2, Math.min(600, rig.speed * (e.deltaY > 0 ? 0.88 : 1.14)));
    };

    addEventListener("keydown", down);
    addEventListener("keyup", up);
    addEventListener("blur", blur);
    el.addEventListener("pointerdown", pdown);
    el.addEventListener("pointerup", pup);
    el.addEventListener("pointermove", pmove);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
      removeEventListener("blur", blur);
      el.removeEventListener("pointerdown", pdown);
      el.removeEventListener("pointerup", pup);
      el.removeEventListener("pointermove", pmove);
      el.removeEventListener("wheel", wheel);
    };
  }, [gl, rig, onToggleGround, onStance]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);

    if (!rig.initialised) {
      // Start above the terrain looking across it.
      const h = heightfield.sample(0, 0);
      rig.pos.set(0, h + 180, 320);
      rig.initialised = true;
    }

    v.dir.set(
      Math.sin(rig.yaw) * Math.cos(rig.pitch),
      Math.sin(rig.pitch),
      Math.cos(rig.yaw) * Math.cos(rig.pitch)
    );
    v.fwd.copy(v.dir);
    if (grounded) v.fwd.y = 0;
    v.fwd.normalize();
    v.right.crossVectors(v.fwd, UP).normalize();

    // On foot you move at a walk; flying uses the wheel-set speed.
    let sp = grounded ? (stance === "prone" ? 1.6 : stance === "crouch" ? 2.4 : 5.5) : rig.speed;
    if (rig.keys.has("ShiftLeft") || rig.keys.has("ShiftRight")) sp *= 4;

    const k = rig.keys;
    if (k.has("KeyW") || k.has("ArrowUp")) rig.pos.addScaledVector(v.fwd, sp * dt);
    if (k.has("KeyS") || k.has("ArrowDown")) rig.pos.addScaledVector(v.fwd, -sp * dt);
    if (k.has("KeyA") || k.has("ArrowLeft")) rig.pos.addScaledVector(v.right, -sp * dt);
    if (k.has("KeyD") || k.has("ArrowRight")) rig.pos.addScaledVector(v.right, sp * dt);
    if (!grounded) {
      if (k.has("KeyE") || k.has("Space")) rig.pos.y += sp * dt;
      if (k.has("KeyQ") || k.has("ControlLeft")) rig.pos.y -= sp * dt;
    }

    const ground = heightfield.sample(rig.pos.x, rig.pos.z);
    if (grounded) {
      rig.pos.y = ground + STANCE_EYE[stance];
    } else if (rig.pos.y < ground + 2) {
      rig.pos.y = ground + 2; // don't fly through the terrain
    }

    camera.position.copy(rig.pos);
    camera.lookAt(rig.pos.x + v.dir.x, rig.pos.y + v.dir.y, rig.pos.z + v.dir.z);

    rig.report += dt;
    if (rig.report > 0.15) {
      rig.report = 0;
      onState?.({
        position: rig.pos.clone(),
        agl: rig.pos.y - ground,
        speed: grounded ? sp : rig.speed,
        grounded,
      });
    }
  });

  return null;
}
