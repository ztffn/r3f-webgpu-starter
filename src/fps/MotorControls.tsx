// React host for the shared character motor.
//
// The counterpart to `df2/FlyControls`, which stays the default: that rig
// clamps the eye to the terrain and is the right tool for judging how grass and
// terrain look. This one walks a real collided body — gravity, slopes, steps,
// stance clearance — and is the same motor a server runs, so what you feel here
// is what authority will agree to.
//
// It owns nothing but presentation. All simulation lives in `src/motor`, which
// imports no Three.js and no React; this file adapts DOM input into commands
// and the resulting state onto the camera.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as THREE from "three/webgpu";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Heightfield } from "../df2/Heightfield";
import type { FlyState, Stance } from "../df2/FlyControls";
import type { LookSensitivityController } from "./core/LookSensitivityController";
import { MotorRoom } from "../motor/MotorRoom.ts";
import { createMotorWorld, initRapier } from "../motor/MotorWorld.ts";
import {
  DEFAULT_MOTOR_TUNING,
  MotorInput,
  eyeHeightFor,
  type PlayerCommand,
  type PlayerStance,
} from "../motor/MotorTypes.ts";

export interface MotorControlsProps {
  heightfield: Heightfield;
  pointerLock?: boolean;
  lookSensitivity?: LookSensitivityController;
  onState?: (state: FlyState) => void;
  /** Fired when the motor's own stance changes, so the HUD and grass follow it. */
  onStance?: (stance: Stance) => void;
}

const DRAG_RADIANS_PER_PIXEL = 0.0032;
const PITCH_LIMIT = 1.5;
const TICK_SECONDS = DEFAULT_MOTOR_TUNING.fixedTimestepSeconds;
/** Ticks one frame may simulate. Bounds the catch-up after a hitch or a tab switch. */
const MAX_CATCHUP_TICKS = 5;
const LOCAL_ID = "local";

export function MotorControls({
  heightfield,
  pointerLock = false,
  lookSensitivity,
  onState,
  onStance,
}: MotorControlsProps) {
  const { camera, gl } = useThree();
  const [rapier, setRapier] = useState<typeof RAPIER | null>(null);

  const rig = useMemo(
    () => ({
      yaw: 0,
      pitch: -0.1,
      keys: new Set<string>(),
      dragging: false,
      lastX: 0,
      lastY: 0,
      accumulator: 0,
      report: 0,
      stanceIntent: "stand" as PlayerStance,
      reportedStance: "stand" as PlayerStance,
      tick: 0,
    }),
    []
  );
  // `PlayerCommand` is readonly because it is wire data; this one scratch
  // instance is rewritten every tick so the hot path allocates nothing.
  const command = useRef<{ -readonly [K in keyof PlayerCommand]: PlayerCommand[K] }>({
    tick: 0,
    buttons: 0,
    yawRadians: 0,
    pitchRadians: 0,
  });
  const commands = useMemo(() => new Map<string, PlayerCommand>(), []);
  const eye = useMemo(() => ({ x: 0, y: 0, z: 0 }), []);

  useEffect(() => {
    let alive = true;
    void initRapier().then((loaded) => {
      if (alive) setRapier(loaded);
    });
    return () => {
      alive = false;
    };
  }, []);

  const room = useMemo(() => {
    if (rapier === null) return null;
    const created = new MotorRoom(rapier, createMotorWorld(rapier), heightfield);
    created.add(LOCAL_ID, { x: 0, z: 0 });
    return created;
  }, [rapier, heightfield]);

  useEffect(() => () => room?.dispose(), [room]);

  useEffect(() => {
    const el = gl.domElement;
    let alive = true;

    const down = (event: KeyboardEvent) => {
      if (["Space", "ShiftLeft", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
        event.preventDefault();
      }
      rig.keys.add(event.code);
      // Stances toggle rather than being held: this rig is for standing in the
      // grass and judging concealment, which means staying prone hands-free.
      if (event.code === "KeyX") rig.stanceIntent = "stand";
      if (event.code === "KeyC") rig.stanceIntent = rig.stanceIntent === "crouch" ? "stand" : "crouch";
      if (event.code === "KeyZ") rig.stanceIntent = rig.stanceIntent === "prone" ? "stand" : "prone";
    };
    const up = (event: KeyboardEvent) => rig.keys.delete(event.code);
    const blur = () => {
      rig.keys.clear();
      rig.dragging = false;
    };

    const rotate = (movementX: number, movementY: number) => {
      const radiansPerCount =
        pointerLock && lookSensitivity
          ? lookSensitivity.radiansPerCountForMovement(movementX, movementY)
          : DRAG_RADIANS_PER_PIXEL;
      rig.yaw -= movementX * radiansPerCount;
      rig.pitch = Math.max(
        -PITCH_LIMIT,
        Math.min(PITCH_LIMIT, rig.pitch - movementY * radiansPerCount)
      );
    };

    const pdown = (event: PointerEvent) => {
      if (pointerLock) {
        if (document.pointerLockElement !== el) {
          try {
            void el.requestPointerLock();
          } catch {
            /* denied; the next gesture can retry */
          }
        }
        return;
      }
      if (event.button !== 0) return;
      rig.dragging = true;
      rig.lastX = event.clientX;
      rig.lastY = event.clientY;
      el.setPointerCapture(event.pointerId);
    };
    const pup = (event: PointerEvent) => {
      if (pointerLock) return;
      rig.dragging = false;
      try {
        el.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
    };
    const pmove = (event: PointerEvent) => {
      if (!rig.dragging) return;
      rotate(event.clientX - rig.lastX, event.clientY - rig.lastY);
      rig.lastX = event.clientX;
      rig.lastY = event.clientY;
    };
    const lockedMove = (event: MouseEvent) => {
      if (!pointerLock || document.pointerLockElement !== el) return;
      rotate(event.movementX, event.movementY);
    };

    addEventListener("keydown", down);
    addEventListener("keyup", up);
    addEventListener("blur", blur);
    el.addEventListener("pointerdown", pdown);
    el.addEventListener("pointerup", pup);
    el.addEventListener("pointermove", pmove);
    document.addEventListener("mousemove", lockedMove);
    return () => {
      alive = false;
      void alive;
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
      removeEventListener("blur", blur);
      el.removeEventListener("pointerdown", pdown);
      el.removeEventListener("pointerup", pup);
      el.removeEventListener("pointermove", pmove);
      document.removeEventListener("mousemove", lockedMove);
      if (pointerLock && document.pointerLockElement === el) document.exitPointerLock();
    };
  }, [gl, rig, lookSensitivity, pointerLock]);

  useFrame((_, delta) => {
    if (room === null) return;
    const motor = room.get(LOCAL_ID);
    if (motor === undefined) return;

    rig.accumulator += Math.min(delta, 0.25);
    let budget = MAX_CATCHUP_TICKS;
    while (rig.accumulator >= TICK_SECONDS && budget > 0) {
      const entry = command.current;
      entry.tick = rig.tick;
      entry.buttons = buttonsFrom(rig.keys, rig.stanceIntent);
      entry.yawRadians = rig.yaw;
      entry.pitchRadians = rig.pitch;
      commands.set(LOCAL_ID, entry);
      room.step(commands);
      rig.tick += 1;
      rig.accumulator -= TICK_SECONDS;
      budget -= 1;
    }
    // A frame that could not afford its whole backlog drops the rest rather
    // than compounding it into the next one.
    if (rig.accumulator > TICK_SECONDS) rig.accumulator = 0;

    const state = motor.state;
    eye.x = state.position.x;
    eye.y = state.position.y + eyeHeightFor(state, DEFAULT_MOTOR_TUNING);
    eye.z = state.position.z;
    camera.position.set(eye.x, eye.y, eye.z);
    // Yaw 0 faces -Z, matching the motor's movement basis.
    const cosPitch = Math.cos(rig.pitch);
    camera.lookAt(
      eye.x - Math.sin(rig.yaw) * cosPitch,
      eye.y + Math.sin(rig.pitch),
      eye.z - Math.cos(rig.yaw) * cosPitch
    );

    // The motor refuses a stand-up with no headroom, so its stance is the truth
    // and the app's copy follows it rather than driving it.
    if (state.stance !== rig.reportedStance) {
      rig.reportedStance = state.stance;
      rig.stanceIntent = state.stance;
      onStance?.(state.stance);
    }

    rig.report += delta;
    if (rig.report > 0.15) {
      rig.report = 0;
      onState?.({
        position: camera.position.clone() as THREE.Vector3,
        // AGL is the EYE above ground, matching what FlyControls reports and
        // what `position` above already is. Reporting the feet instead makes
        // the readout sit at 0.0 m whenever the player is standing on anything.
        agl: eye.y - heightfield.sample(state.position.x, state.position.z),
        speed: Math.hypot(state.velocity.x, state.velocity.z),
        grounded: state.grounded,
      });
    }
  });

  return null;
}

function buttonsFrom(keys: ReadonlySet<string>, stance: PlayerStance): number {
  let bits = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) bits |= MotorInput.Forward;
  if (keys.has("KeyS") || keys.has("ArrowDown")) bits |= MotorInput.Back;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) bits |= MotorInput.Left;
  if (keys.has("KeyD") || keys.has("ArrowRight")) bits |= MotorInput.Right;
  if (keys.has("Space")) bits |= MotorInput.Jump;
  if (keys.has("ShiftLeft") || keys.has("ShiftRight")) bits |= MotorInput.Sprint;
  if (stance === "crouch") bits |= MotorInput.Crouch;
  if (stance === "prone") bits |= MotorInput.Prone;
  return bits;
}
