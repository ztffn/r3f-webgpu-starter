// Other players' gunfire, made visible and audible: tracer, muzzle flash,
// report, and impact dust for every ShotFired event the server relays.
//
// PRESENTATION ONLY (docs/12 §8.3). The rounds flown here carry zero damage —
// they exist so a bystander sees the shot the authority fired; whether it hurt
// anyone arrives separately, as health in a snapshot.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import type { GameClient } from "../net/GameClient.ts";
import { lookDirection } from "../motor/MotorTypes.ts";
import { BallisticProjectileSystem } from "../combat/BallisticProjectileSystem.ts";
import { DEFAULT_BALLISTIC_ENVIRONMENT } from "../combat/BallisticEnvironment.ts";
import { weaponByWireIndex } from "../combat/weaponDefinitions.ts";
import type { WorldQuery } from "../combat/WorldQuery.ts";
import { impactEffectBus } from "./presentation/ImpactEffectBus.ts";

const TRACER_CAPACITY = 64;
const TRACER_LENGTH_METRES = 2.2;
const TRACER_THICKNESS_METRES = 0.03;
const FLASH_CAPACITY = 8;
const FLASH_SECONDS = 0.06;
const REPORT_AUDIBLE_METRES = 900;

/** Short synthesized rifle report: a hard noise crack over a low thump. */
function createReportBuffer(context: AudioContext, variant: number): AudioBuffer {
  const duration = 0.24;
  const sampleCount = Math.ceil(context.sampleRate * duration);
  const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
  const samples = buffer.getChannelData(0);
  let noiseState = (variant + 1) * 2_463_534_242;
  for (let i = 0; i < sampleCount; i += 1) {
    noiseState = (noiseState * 1_664_525 + 1_013_904_223) >>> 0;
    const noise = (noiseState / 0xffff_ffff) * 2 - 1;
    const time = i / context.sampleRate;
    const crack = Math.exp(-90 * time);
    const thump = Math.exp(-14 * time) * Math.sin(2 * Math.PI * (95 + variant * 12) * time);
    samples[i] = (noise * 0.8 * crack + thump * 0.5) * 0.55;
  }
  return buffer;
}

class RemoteReportPool {
  readonly listener = new THREE.AudioListener();
  readonly group = new THREE.Group();
  private readonly voices: THREE.PositionalAudio[] = [];
  private readonly buffers: AudioBuffer[] = [];
  private readonly scratch = new THREE.Vector3();
  private cursor = 0;

  constructor(private readonly camera: THREE.Camera) {
    this.group.name = "remote-fire-reports";
    for (let i = 0; i < 6; i += 1) {
      const voice = new THREE.PositionalAudio(this.listener);
      voice.setDistanceModel("inverse");
      voice.setRefDistance(14);
      voice.setRolloffFactor(1.1);
      voice.setMaxDistance(REPORT_AUDIBLE_METRES);
      this.voices.push(voice);
      this.group.add(voice);
    }
    for (let variant = 0; variant < 3; variant += 1) {
      this.buffers.push(createReportBuffer(this.listener.context, variant));
    }
  }

  attach(): void {
    if (this.listener.parent !== this.camera) this.camera.add(this.listener);
  }

  detach(): void {
    this.camera.remove(this.listener);
  }

  unlock(): void {
    if (this.listener.context.state === "suspended") {
      void this.listener.context.resume().catch(() => {
        /* A later gesture can retry; audio cannot change gameplay. */
      });
    }
  }

  play(x: number, y: number, z: number, sequence: number): void {
    this.scratch.set(x, y, z);
    if (this.camera.position.distanceToSquared(this.scratch) > REPORT_AUDIBLE_METRES ** 2) {
      return;
    }
    const voice = this.voices[this.cursor++ % this.voices.length];
    if (voice.isPlaying) voice.stop();
    voice.position.set(x, y, z);
    voice.setVolume(0.8);
    voice.setBuffer(this.buffers[sequence % this.buffers.length]);
    if (this.listener.context.state === "running") voice.play();
  }

  dispose(): void {
    for (const voice of this.voices) {
      if (voice.isPlaying) voice.stop();
      voice.disconnect();
    }
    this.detach();
  }
}

export interface RemoteFireEffectsProps {
  client: GameClient;
  worldQuery: WorldQuery;
}

export function RemoteFireEffects({ client, worldQuery }: RemoteFireEffectsProps) {
  const { camera, gl } = useThree();

  const objects = useMemo(() => {
    const group = new THREE.Group();
    group.name = "remote-fire-effects";

    // The SAME flight model the authority flew, damage zero: the tracer a
    // bystander watches curves and lands exactly where the server's round did.
    const ballistics = new BallisticProjectileSystem(
      worldQuery,
      DEFAULT_BALLISTIC_ENVIRONMENT,
      { capacity: TRACER_CAPACITY, maxTracePoints: 2 }
    );

    const tracerGeometry = new THREE.BoxGeometry(
      TRACER_THICKNESS_METRES,
      TRACER_THICKNESS_METRES,
      TRACER_LENGTH_METRES
    );
    const tracerMaterial = new THREE.MeshBasicMaterial({
      color: 0xffc873,
      toneMapped: false,
      transparent: true,
      opacity: 0.9,
    });
    const tracers = new THREE.InstancedMesh(tracerGeometry, tracerMaterial, TRACER_CAPACITY);
    tracers.name = "remote-tracers";
    tracers.frustumCulled = false;
    tracers.count = 0;
    group.add(tracers);

    const flashGeometry = new THREE.SphereGeometry(0.09, 8, 6);
    const flashMaterial = new THREE.MeshBasicMaterial({
      color: 0xffe2a8,
      toneMapped: false,
      transparent: true,
      opacity: 0.95,
    });
    const flashes = new THREE.InstancedMesh(flashGeometry, flashMaterial, FLASH_CAPACITY);
    flashes.name = "remote-muzzle-flashes";
    flashes.frustumCulled = false;
    flashes.count = 0;
    group.add(flashes);

    const reports = new RemoteReportPool(camera);
    group.add(reports.group);

    return {
      group,
      ballistics,
      tracers,
      tracerGeometry,
      tracerMaterial,
      flashes,
      flashGeometry,
      flashMaterial,
      reports,
      flashPool: [] as Array<{ x: number; y: number; z: number; remaining: number }>,
      matrix: new THREE.Matrix4(),
      quaternion: new THREE.Quaternion(),
      forward: new THREE.Vector3(),
      zAxis: new THREE.Vector3(0, 0, 1),
      scale: new THREE.Vector3(1, 1, 1),
      position: new THREE.Vector3(),
    };
  }, [camera, worldQuery]);

  useEffect(() => {
    objects.reports.attach();
    const unlock = () => objects.reports.unlock();
    gl.domElement.addEventListener("pointerdown", unlock);
    return () => {
      gl.domElement.removeEventListener("pointerdown", unlock);
      objects.reports.dispose();
      objects.ballistics.clear();
      objects.tracerGeometry.dispose();
      objects.tracerMaterial.dispose();
      objects.flashGeometry.dispose();
      objects.flashMaterial.dispose();
    };
  }, [gl, objects]);

  useFrame((_, delta) => {
    const clamped = Math.min(Math.max(delta, 0), 0.1);

    client.drainRemoteShots((shot) => {
      const definition = weaponByWireIndex(shot.weaponIndex);
      if (definition === null) return;
      objects.ballistics.spawn({
        sourceId: `remote-${shot.shooterId}`,
        sequence: shot.sequence,
        origin: shot.origin,
        direction: lookDirection(shot.yawRadians, shot.pitchRadians),
        maxDistance: definition.shot.range,
        maxFlightSeconds: definition.shot.maxFlightSeconds,
        damage: 0,
        ammunition: definition.shot.ammunition,
        captureTrace: false,
        // The shooter's own soldier stands at the muzzle; without the
        // exclusion every remote tracer dies instantly in its own shooter.
        excludeObjectId: String(shot.shooterId),
      });
      objects.flashPool.push({
        x: shot.origin.x,
        y: shot.origin.y,
        z: shot.origin.z,
        remaining: FLASH_SECONDS,
      });
      while (objects.flashPool.length > FLASH_CAPACITY) objects.flashPool.shift();
      objects.reports.play(shot.origin.x, shot.origin.y, shot.origin.z, shot.sequence);
    });

    objects.ballistics.update(clamped);
    // Dust, sparks and thuds ride the SAME bus the local shots use, so remote
    // impacts look identical to yours. Damage on these events is always zero.
    objects.ballistics.drainImpactEvents(impactEffectBus.publish);
    objects.ballistics.drainResults(() => {});

    let tracerCount = 0;
    objects.ballistics.visitActiveProjectiles((x, y, z, vx, vy, vz) => {
      if (tracerCount >= TRACER_CAPACITY) return;
      const speed = Math.hypot(vx, vy, vz);
      if (speed < 1) return;
      objects.forward.set(vx / speed, vy / speed, vz / speed);
      objects.quaternion.setFromUnitVectors(objects.zAxis, objects.forward);
      objects.position.set(x, y, z);
      objects.matrix.compose(objects.position, objects.quaternion, objects.scale);
      objects.tracers.setMatrixAt(tracerCount, objects.matrix);
      tracerCount += 1;
    });
    objects.tracers.count = tracerCount;
    if (tracerCount > 0) objects.tracers.instanceMatrix.needsUpdate = true;

    let flashCount = 0;
    for (const flash of objects.flashPool) {
      flash.remaining -= clamped;
      if (flash.remaining <= 0) continue;
      objects.position.set(flash.x, flash.y, flash.z);
      objects.matrix.makeTranslation(flash.x, flash.y, flash.z);
      objects.flashes.setMatrixAt(flashCount, objects.matrix);
      flashCount += 1;
    }
    objects.flashPool.splice(
      0,
      objects.flashPool.length,
      ...objects.flashPool.filter((flash) => flash.remaining > 0)
    );
    objects.flashes.count = flashCount;
    if (flashCount > 0) objects.flashes.instanceMatrix.needsUpdate = true;
  });

  return <primitive object={objects.group} />;
}
