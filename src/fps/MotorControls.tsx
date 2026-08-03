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
import * as THREE from "three/webgpu";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Heightfield } from "../df2/Heightfield";
import type { FlyState, Stance } from "../df2/FlyControls";
import type { LookSensitivityController } from "./core/LookSensitivityController";
import type { PlayerMotorSnapshotTarget, PlayerWeaponIntent } from "./core/PlayerMotor.ts";
import type { GameClient } from "../net/GameClient.ts";
import { MotorRoom } from "../motor/MotorRoom.ts";
import { createMotorWorld, initRapier } from "../motor/MotorWorld.ts";
import {
  DEFAULT_MOTOR_TUNING,
  MotorInput,
  eyeHeightFor,
  type PlayerCommand,
  type MotorTuning,
  type PlayerStance,
} from "../motor/MotorTypes.ts";

export interface MotorControlsProps {
  heightfield: Heightfield;
  /**
   * Networked mode: predict through this client against the authoritative
   * server instead of stepping a private room. Present means networked, absent
   * means the local path — there is deliberately no in-between state; the
   * scene withholds this mount until the client exists.
   */
  client?: GameClient | null;
  pointerLock?: boolean;
  lookSensitivity?: LookSensitivityController;
  onState?: (state: FlyState) => void;
  /** Fired when the motor's own stance changes, so the HUD and grass follow it. */
  onStance?: (stance: Stance) => void;
  /**
   * Written every frame, before the weapon host reads it. Supplying this is
   * what lets weapon handling use real grounded state and real velocity instead
   * of inferring both from the camera.
   */
  pose?: PlayerMotorSnapshotTarget | null;
  /** Aim intent from the weapon host, consumed as a movement input. */
  weaponIntent?: PlayerWeaponIntent | null;
}

/**
 * Live tuning overrides, following the diagnostic-URL convention in
 * `docs/10-...md` §7. Slope limits especially: what counts as a climbable hill
 * is a feel judgement that cannot be settled by measurement, so it needs to be
 * dialled while walking rather than rebuilt between guesses.
 *
 * `?scene=motor&climb=70&slide=78&walk=6&jump=5`
 */
function readTuning(): MotorTuning {
  const params = new URLSearchParams(window.location.search);
  const degrees = (key: string, fallback: number): number => {
    const raw = Number(params.get(key));
    return Number.isFinite(raw) && raw > 0 && raw < 90 ? (raw * Math.PI) / 180 : fallback;
  };
  const positive = (key: string, fallback: number): number => {
    const raw = Number(params.get(key));
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };

  const base = DEFAULT_MOTOR_TUNING;
  const walk = positive("walk", base.stances.stand.speed);
  const climb = degrees("climb", base.maxSlopeClimbRadians);
  return {
    ...base,
    maxSlopeClimbRadians: climb,
    // Sliding must begin above where climbing stops, or the character is
    // refused the slope and then slid back down it in the same tick.
    minSlopeSlideRadians: Math.max(degrees("slide", base.minSlopeSlideRadians), climb + 0.05),
    jumpSpeedMetresPerSecond: positive("jump", base.jumpSpeedMetresPerSecond),
    maxStepHeightMetres: positive("step", base.maxStepHeightMetres),
    stances: {
      ...base.stances,
      stand: { ...base.stances.stand, speed: walk },
    },
  };
}

const DRAG_RADIANS_PER_PIXEL = 0.0032;
const PITCH_LIMIT = 1.5;
const THIRD_PERSON_DISTANCE = 4.5;
/**
 * The proxy capsule is built once at these dimensions and scaled per stance,
 * so a stance change costs a scale write rather than rebuilding geometry.
 */
const PROXY_RADIUS = 0.5;
const PROXY_HEIGHT = 2;
const TICK_SECONDS = DEFAULT_MOTOR_TUNING.fixedTimestepSeconds;
/** Ticks one frame may simulate. Bounds the catch-up after a hitch or a tab switch. */
const MAX_CATCHUP_TICKS = 5;
const LOCAL_ID = "local";

export function MotorControls({
  heightfield,
  client = null,
  pointerLock = false,
  lookSensitivity,
  onState,
  onStance,
  pose,
  weaponIntent,
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
      thirdPerson: false,
      tick: 0,
    }),
    []
  );
  const bodyRef = useRef<THREE.Mesh | null>(null);

  /**
   * The collider proxy, drawn so the body the motor actually simulates is
   * visible. Unlit and deliberately not run through `atmosphere.shade` — this
   * is a diagnostic overlay, and fogging it would hide the thing being
   * diagnosed. Do not copy this into scene content; see docs/08 §8 invariant 7.
   */
  const proxy = useMemo(() => {
    const geometry = new THREE.CapsuleGeometry(
      PROXY_RADIUS,
      PROXY_HEIGHT - PROXY_RADIUS * 2,
      6,
      16
    );
    const material = new THREE.MeshBasicMaterial({
      color: 0x63c68a,
      wireframe: true,
      depthTest: true,
    });
    return { geometry, material };
  }, []);

  useEffect(
    () => () => {
      proxy.geometry.dispose();
      proxy.material.dispose();
    },
    [proxy]
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
    if (client !== null) return;
    let alive = true;
    void initRapier().then((loaded) => {
      if (alive) setRapier(loaded);
    });
    return () => {
      alive = false;
    };
  }, [client]);

  // Networked, the client's tuning is the truth: a URL-tuned client would
  // steer differently from the server and reconcile every single tick.
  const tuning = useMemo(() => client?.tuning ?? readTuning(), [client]);

  const room = useMemo(() => {
    if (client !== null || rapier === null) return null;
    const created = new MotorRoom(rapier, createMotorWorld(rapier, tuning), heightfield, {
      tuning,
    });
    created.add(LOCAL_ID, { x: 0, z: 0 });
    return created;
  }, [client, rapier, heightfield, tuning]);

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
      // Third person exists to watch the collider, not as a camera mode: it is
      // how you see the capsule stand, crouch, go prone and climb.
      if (event.code === "KeyV") rig.thirdPerson = !rig.thirdPerson;
    };
    const up = (event: KeyboardEvent) => rig.keys.delete(event.code);
    const blur = () => {
      rig.keys.clear();
      rig.dragging = false;
    };
    // Chrome gives a hidden tab ZERO animation frames. On return, drop the
    // accumulated backlog and the held keys instead of replaying a stale
    // burst; networked, the reconciliation path absorbs the gap.
    const visibility = () => {
      if (document.visibilityState === "visible") {
        rig.accumulator = 0;
        rig.keys.clear();
      }
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
    document.addEventListener("visibilitychange", visibility);
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
      document.removeEventListener("visibilitychange", visibility);
      el.removeEventListener("pointerdown", pdown);
      el.removeEventListener("pointerup", pup);
      el.removeEventListener("pointermove", pmove);
      document.removeEventListener("mousemove", lockedMove);
      if (pointerLock && document.pointerLockElement === el) document.exitPointerLock();
    };
  }, [gl, rig, lookSensitivity, pointerLock]);

  useFrame((_, delta) => {
    if (client === null && room === null) return;
    const motor = room?.get(LOCAL_ID);
    if (client === null && motor === undefined) return;

    // Networked but not yet welcomed: nothing to simulate or aim the camera
    // with. Keep the throttled report alive so a stuck join reads as
    // "connecting" on the HUD rather than being indistinguishable from a hang.
    if (client !== null && client.localState === null) {
      rig.report += delta;
      if (rig.report > 0.15) {
        rig.report = 0;
        onState?.({
          position: camera.position.clone() as THREE.Vector3,
          agl: 0,
          speed: 0,
          grounded: false,
          net: netPhaseOf(client),
        });
      }
      return;
    }

    rig.accumulator += Math.min(delta, 0.25);
    let budget = MAX_CATCHUP_TICKS;
    while (rig.accumulator >= TICK_SECONDS && budget > 0) {
      const buttons = buttonsFrom(rig.keys, rig.stanceIntent, weaponIntent);
      if (client !== null) {
        // The client owns tick numbering and quantises before predicting.
        client.predict(buttons, rig.yaw, rig.pitch);
      } else {
        const entry = command.current;
        entry.tick = rig.tick;
        entry.buttons = buttons;
        entry.yawRadians = rig.yaw;
        entry.pitchRadians = rig.pitch;
        commands.set(LOCAL_ID, entry);
        room!.step(commands);
        rig.tick += 1;
      }
      rig.accumulator -= TICK_SECONDS;
      budget -= 1;
    }
    // A frame that could not afford its whole backlog drops the rest rather
    // than compounding it into the next one.
    if (rig.accumulator > TICK_SECONDS) rig.accumulator = 0;

    const state = client !== null ? client.localState : motor!.state;
    if (state === null) return;
    eye.x = state.position.x;
    eye.y = state.position.y + eyeHeightFor(state, tuning);
    eye.z = state.position.z;

    // Yaw 0 faces -Z, matching the motor's movement basis.
    const cosPitch = Math.cos(rig.pitch);
    const forwardX = -Math.sin(rig.yaw) * cosPitch;
    const forwardY = Math.sin(rig.pitch);
    const forwardZ = -Math.cos(rig.yaw) * cosPitch;

    const body = bodyRef.current;
    if (body !== null) {
      body.visible = rig.thirdPerson;
      if (rig.thirdPerson) {
        const dimensions = tuning.stances[state.stance];
        body.position.set(
          state.position.x,
          state.position.y + dimensions.height / 2,
          state.position.z
        );
        body.rotation.y = rig.yaw;
        body.scale.set(
          dimensions.radius / PROXY_RADIUS,
          dimensions.height / PROXY_HEIGHT,
          dimensions.radius / PROXY_RADIUS
        );
      }
    }

    if (rig.thirdPerson) {
      // Pull straight back along the view ray and keep the camera out of the
      // ground; no collision sweep, because this is a diagnostic view.
      const ground = heightfield.sample(
        eye.x - forwardX * THIRD_PERSON_DISTANCE,
        eye.z - forwardZ * THIRD_PERSON_DISTANCE
      );
      camera.position.set(
        eye.x - forwardX * THIRD_PERSON_DISTANCE,
        Math.max(eye.y - forwardY * THIRD_PERSON_DISTANCE, ground + 0.5),
        eye.z - forwardZ * THIRD_PERSON_DISTANCE
      );
      camera.lookAt(eye.x, eye.y, eye.z);
    } else {
      camera.position.set(eye.x, eye.y, eye.z);
      camera.lookAt(eye.x + forwardX, eye.y + forwardY, eye.z + forwardZ);
    }

    // Mounted ahead of the weapon host so this lands first, but nothing depends
    // on that: the object persists, so the worst case is handling context one
    // frame stale, which is already sampled once per frame anyway. Position is
    // the EYE, matching what the weapon host uses as a shot origin.
    if (pose != null) {
      pose.position.set(eye.x, eye.y, eye.z);
      pose.stance = state.stance;
      pose.grounded = state.grounded;
      pose.sprinting = state.sprinting;
      pose.planarSpeedMetresPerSecond = Math.hypot(state.velocity.x, state.velocity.z);
    }

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
      const report: FlyState = {
        position: camera.position.clone() as THREE.Vector3,
        // AGL is the EYE above ground, matching what FlyControls reports and
        // what `position` above already is. Reporting the feet instead makes
        // the readout sit at 0.0 m whenever the player is standing on anything.
        agl: eye.y - heightfield.sample(state.position.x, state.position.z),
        speed: Math.hypot(state.velocity.x, state.velocity.z),
        grounded: state.grounded,
      };
      if (client !== null) report.net = netPhaseOf(client);
      onState?.(report);
    }
  });

  return (
    <mesh
      ref={bodyRef}
      geometry={proxy.geometry}
      material={proxy.material}
      visible={false}
      frustumCulled={false}
    />
  );
}

function netPhaseOf(client: GameClient): NonNullable<FlyState["net"]> {
  return {
    phase: client.connectionLost
      ? "dropped"
      : client.playerId < 0
        ? "connecting"
        : "playing",
    playerId: client.playerId,
  };
}

function buttonsFrom(
  keys: ReadonlySet<string>,
  stance: PlayerStance,
  intent: PlayerWeaponIntent | null | undefined
): number {
  let bits = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) bits |= MotorInput.Forward;
  if (keys.has("KeyS") || keys.has("ArrowDown")) bits |= MotorInput.Back;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) bits |= MotorInput.Left;
  if (keys.has("KeyD") || keys.has("ArrowRight")) bits |= MotorInput.Right;
  if (keys.has("Space")) bits |= MotorInput.Jump;
  if (keys.has("ShiftLeft") || keys.has("ShiftRight")) bits |= MotorInput.Sprint;
  if (stance === "crouch") bits |= MotorInput.Crouch;
  if (stance === "prone") bits |= MotorInput.Prone;
  if (intent?.aiming === true) bits |= MotorInput.Ads;
  if (intent?.reloading === true) bits |= MotorInput.Reloading;
  return bits;
}
