import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import type { ImpactEvent } from "../combat/ImpactEvent";
import { SURFACE_PROFILES, type ImpactSoundKind } from "../combat/SurfaceProfile";
import { impactEffectBus } from "./ImpactEffectBus";

const PARTICLE_CAPACITY = 384;
const AUDIO_VOICE_CAPACITY = 24;
const AUDIO_VARIANTS = 2;

function hash(seed: number): number {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43_758.5453;
  return value - Math.floor(value);
}

class ImpactParticlePool {
  readonly mesh: THREE.InstancedMesh;
  private readonly px = new Float32Array(PARTICLE_CAPACITY);
  private readonly py = new Float32Array(PARTICLE_CAPACITY);
  private readonly pz = new Float32Array(PARTICLE_CAPACITY);
  private readonly vx = new Float32Array(PARTICLE_CAPACITY);
  private readonly vy = new Float32Array(PARTICLE_CAPACITY);
  private readonly vz = new Float32Array(PARTICLE_CAPACITY);
  private readonly life = new Float32Array(PARTICLE_CAPACITY);
  private readonly initialLife = new Float32Array(PARTICLE_CAPACITY);
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  private cursor = 0;

  constructor() {
    const geometry = new THREE.TetrahedronGeometry(0.035, 0);
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geometry, material, PARTICLE_CAPACITY);
    this.mesh.name = "pooled-impact-particles";
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.matrix.makeScale(0, 0, 0);
    for (let i = 0; i < PARTICLE_CAPACITY; i += 1) this.mesh.setMatrixAt(i, this.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  emit(event: ImpactEvent): void {
    const profile = SURFACE_PROFILES[event.surfaceId].effect;
    this.emitAt(event, event.point, profile.particleCount, 1);
    if (event.exitPoint) {
      this.emitAt(event, event.exitPoint, Math.max(2, Math.ceil(profile.particleCount * 0.55)), -1);
    }
  }

  update(dtSeconds: number): void {
    const dt = Math.min(Math.max(dtSeconds, 0), 0.05);
    let changed = false;
    for (let i = 0; i < PARTICLE_CAPACITY; i += 1) {
      if (this.life[i] <= 0) continue;
      this.life[i] = Math.max(0, this.life[i] - dt);
      if (this.life[i] === 0) {
        this.matrix.makeScale(0, 0, 0);
      } else {
        this.vy[i] -= 7.5 * dt;
        this.px[i] += this.vx[i] * dt;
        this.py[i] += this.vy[i] * dt;
        this.pz[i] += this.vz[i] * dt;
        const scale = Math.max(0.1, this.life[i] / this.initialLife[i]);
        this.matrix.makeScale(scale, scale, scale);
        this.matrix.setPosition(this.px[i], this.py[i], this.pz[i]);
      }
      this.mesh.setMatrixAt(i, this.matrix);
      changed = true;
    }
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }

  private emitAt(
    event: ImpactEvent,
    point: THREE.Vector3,
    count: number,
    normalDirection: 1 | -1
  ): void {
    const profile = SURFACE_PROFILES[event.surfaceId].effect;
    const nx = (event.normal?.x ?? 0) * normalDirection;
    const ny = (event.normal?.y ?? 1) * normalDirection;
    const nz = (event.normal?.z ?? 0) * normalDirection;
    this.color.setHex(profile.color);
    for (let particle = 0; particle < count; particle += 1) {
      const slot = this.cursor++ % PARTICLE_CAPACITY;
      const seed =
        event.shotSequence * 131 + event.interactionIndex * 31 + particle * 17 + normalDirection;
      let rx = hash(seed) * 2 - 1;
      let ry = hash(seed + 1) * 2 - 1;
      let rz = hash(seed + 2) * 2 - 1;
      const length = Math.hypot(rx, ry, rz) || 1;
      rx /= length;
      ry /= length;
      rz /= length;
      const speed = profile.particleSpeed * (0.45 + hash(seed + 3) * 0.75);
      this.px[slot] = point.x + nx * 0.012;
      this.py[slot] = point.y + ny * 0.012;
      this.pz[slot] = point.z + nz * 0.012;
      this.vx[slot] = (nx * 0.68 + rx * 0.55) * speed;
      this.vy[slot] = (ny * 0.68 + ry * 0.55) * speed;
      this.vz[slot] = (nz * 0.68 + rz * 0.55) * speed;
      this.life[slot] = this.initialLife[slot] = 0.22 + hash(seed + 4) * 0.28;
      this.mesh.setColorAt(slot, this.color);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

function soundShape(kind: ImpactSoundKind): {
  duration: number;
  noise: number;
  toneHz: number;
  decay: number;
} {
  switch (kind) {
    case "metal": return { duration: 0.18, noise: 0.45, toneHz: 2_200, decay: 18 };
    case "glass": return { duration: 0.22, noise: 0.7, toneHz: 3_600, decay: 20 };
    case "stone": return { duration: 0.14, noise: 0.9, toneHz: 420, decay: 24 };
    case "wood": return { duration: 0.13, noise: 0.75, toneHz: 680, decay: 27 };
    case "flesh": return { duration: 0.11, noise: 0.65, toneHz: 145, decay: 30 };
    case "water": return { duration: 0.28, noise: 0.82, toneHz: 210, decay: 13 };
    default: return { duration: 0.1, noise: 0.88, toneHz: 260, decay: 32 };
  }
}

function createImpactBuffer(
  context: AudioContext,
  kind: ImpactSoundKind,
  variant: number
): AudioBuffer {
  const shape = soundShape(kind);
  const sampleCount = Math.ceil(context.sampleRate * shape.duration);
  const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
  const samples = buffer.getChannelData(0);
  let noiseState = (variant + 1) * 1_103_515_245;
  for (let i = 0; i < sampleCount; i += 1) {
    noiseState = (noiseState * 1_664_525 + 1_013_904_223) >>> 0;
    const noise = (noiseState / 0xffff_ffff) * 2 - 1;
    const time = i / context.sampleRate;
    const envelope = Math.exp(-shape.decay * time);
    const tone = Math.sin(2 * Math.PI * shape.toneHz * (1 + variant * 0.035) * time);
    samples[i] = (noise * shape.noise + tone * (1 - shape.noise)) * envelope * 0.5;
  }
  return buffer;
}

class SpatialImpactAudioPool {
  readonly listener = new THREE.AudioListener();
  readonly group = new THREE.Group();
  private readonly voices: THREE.PositionalAudio[] = [];
  private readonly buffers = new Map<ImpactSoundKind, AudioBuffer[]>();
  private cursor = 0;

  constructor(private readonly camera: THREE.Camera) {
    this.group.name = "pooled-spatial-impact-audio";
    for (let i = 0; i < AUDIO_VOICE_CAPACITY; i += 1) {
      const voice = new THREE.PositionalAudio(this.listener);
      voice.setDistanceModel("inverse");
      voice.setRefDistance(7);
      voice.setRolloffFactor(1.35);
      this.voices.push(voice);
      this.group.add(voice);
    }
    for (const kind of ["soft", "wood", "metal", "stone", "flesh", "water", "glass"] as const) {
      const variants: AudioBuffer[] = [];
      for (let variant = 0; variant < AUDIO_VARIANTS; variant += 1) {
        variants.push(createImpactBuffer(this.listener.context, kind, variant));
      }
      this.buffers.set(kind, variants);
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
        /* A later user gesture can retry; audio cannot change gameplay. */
      });
    }
  }

  emit(event: ImpactEvent): void {
    const effect = SURFACE_PROFILES[event.surfaceId].effect;
    if (this.camera.position.distanceToSquared(event.point) > effect.audibleDistanceMetres ** 2) {
      return;
    }
    const voice = this.voices[this.cursor++ % this.voices.length];
    if (voice.isPlaying) voice.stop();
    const variants = this.buffers.get(effect.sound)!;
    voice.position.copy(event.point);
    voice.setMaxDistance(effect.audibleDistanceMetres);
    voice.setVolume(event.outcome === "penetrated" ? 0.48 : 0.68);
    voice.setBuffer(variants[(event.shotSequence + event.interactionIndex) % variants.length]);
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

/** Bounded one-draw visual pool plus bounded Web Audio positional voice pool. */
export function ImpactEffects() {
  const { camera, gl } = useThree();
  const objects = useMemo(() => {
    const group = new THREE.Group();
    group.name = "impact-effects";
    const particles = new ImpactParticlePool();
    const audio = new SpatialImpactAudioPool(camera);
    group.add(particles.mesh, audio.group);
    return { group, particles, audio };
  }, [camera]);

  useEffect(() => {
    objects.audio.attach();
    const unsubscribe = impactEffectBus.subscribe((event) => {
      objects.particles.emit(event);
      objects.audio.emit(event);
    });
    const unlock = () => objects.audio.unlock();
    gl.domElement.addEventListener("pointerdown", unlock);
    return () => {
      unsubscribe();
      gl.domElement.removeEventListener("pointerdown", unlock);
      objects.audio.detach();
    };
  }, [gl, objects]);

  useFrame((_, delta) => objects.particles.update(delta));

  useEffect(
    () => () => {
      objects.particles.dispose();
      objects.audio.dispose();
    },
    [objects]
  );

  return <primitive object={objects.group} />;
}
