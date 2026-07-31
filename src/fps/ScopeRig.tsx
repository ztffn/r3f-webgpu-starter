// First-person optic prototype.
//
// The world is rendered once normally, and (only while aiming) once more from
// the optical centre of the scope.  The small second render target is then used
// by the lens material.  Keeping the terrain and grass in the SAME scene is
// intentional: the scope sees precisely the same heightfield, fog and canopy as
// the unaided camera rather than a cheaper-but-divergent copy of the world.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { float, mix, smoothstep, texture, uniform, uv, vec2, vec3 } from "three/tsl";
import { CAMERA_FAR, CAMERA_NEAR } from "../df2/config";

const WORLD_LAYER = 0;
const WEAPON_LAYER = 1;
const TARGET_SIZE = 512;
// A 5.5° view is a clear magnification over the player's 60° view while still
// leaving enough terrain context to tune the grass pass through the optic.
const SCOPE_FOV = 5.5;

// The lens sits in front of the player camera when aiming.  It is deliberately
// derived from this physical position, not the screen centre: moving the weapon
// changes the scope camera's viewpoint, which is what makes the PiP useful.
// The source model's rear lens is at z=0.181 m. In ADS it sits just beyond this
// app's 0.05 m camera near plane, filling the view like an actual shouldered
// scope rather than appearing as a floating object in front of the player.
const AIM_OFFSET = new THREE.Vector3(0, 0.001, -0.237);
const HIP_OFFSET = new THREE.Vector3(0.34, -0.31, -0.58);
const REAR_LENS_OFFSET = new THREE.Vector3(0, -0.00119, 0.18112);
const SCOPE_CAMERA_OFFSET = new THREE.Vector3(0, 0, -0.175332);

interface ScopeRigProps {
  /** A prototype scene starts shouldered so the feature is immediately visible. */
  initiallyAiming?: boolean;
}

function buildScopeDisplay(lensMaterial: THREE.Material) {
  const weapon = new THREE.Group();
  weapon.name = "fps-scope-rig";

  // The demo's GLB has a 0.01657 m rear lens at this exact location.  Keep the
  // display separate from the model so it can be a WebGPU node material.
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.01657, 48), lensMaterial);
  lens.position.copy(REAR_LENS_OFFSET);
  lens.renderOrder = 10;
  weapon.add(lens);

  weapon.traverse((object) => object.layers.set(WEAPON_LAYER));
  return weapon;
}

/**
 * A WebGPU-safe PIP optic. A positive frame priority takes ownership of the
 * canvas render: all normal R3F updates still run first, then the world is drawn
 * into the scope target and finally to the canvas from the player camera.
 */
export function ScopeRig({ initiallyAiming = false }: ScopeRigProps) {
  const { camera, gl, scene } = useThree();
  const aiming = useRef(initiallyAiming);
  const target = useMemo(() => new THREE.RenderTarget(TARGET_SIZE, TARGET_SIZE, { depthBuffer: true }), []);
  const scopeCamera = useMemo(() => {
    const c = new THREE.PerspectiveCamera(SCOPE_FOV, 1, CAMERA_NEAR, CAMERA_FAR);
    c.layers.set(WORLD_LAYER);
    return c;
  }, []);
  const eyeOffset = useMemo(() => uniform(new THREE.Vector2()), []);
  const reticleOffset = useMemo(() => uniform(new THREE.Vector2()), []);

  const lensMaterial = useMemo(() => {
    const material = new THREE.MeshBasicNodeMaterial();
    const lensUv = uv();
    const centred = lensUv.sub(vec2(0.5)).mul(2);
    // The world texture shifts slightly less than the reticle. This mirrors the
    // reference shader's deliberately fake (but readable) parallax.
    // The sight picture must respond to an off-axis eye. A scope camera's small
    // physical translation is almost invisible against a distant landscape, so
    // this is the reference shader's deliberately amplified depth/parallax cue.
    // WebGPU's render target needs a vertical correction here. Keep X in the
    // camera's native order: flipping both axes rotated the image correctly in
    // Y but still mirrored left/right through the optic.
    const uprightUv = vec2(lensUv.x, float(1).sub(lensUv.y));
    const sampleUv = uprightUv.sub(reticleOffset.mul(0.32));
    const world = texture(target.texture, sampleUv).rgb;
    const opticEdge = smoothstep(float(0.78), float(1.0), centred.length());
    const shadow = smoothstep(float(0.6), float(1.02), centred.sub(eyeOffset).length());

    const reticle = centred.sub(reticleOffset.mul(0.22));
    // `value.step(edge)` is GLSL's step(edge, value). Keep the threshold on the
    // left so the mask is one INSIDE a thin line, not everywhere except it.
    const horizontal = float(0.009).step(reticle.y.abs()).mul(float(0.36).step(reticle.x.abs()));
    const vertical = float(0.009).step(reticle.x.abs()).mul(float(0.36).step(reticle.y.abs()));
    const reticleMask = horizontal.add(vertical).min(float(1));
    const withReticle = mix(world, vec3(1.0, 0.13, 0.04), reticleMask.mul(0.86));
    material.colorNode = mix(withReticle, vec3(0), opticEdge.max(shadow));
    material.toneMapped = false;
    return material;
  }, [eyeOffset, reticleOffset, target]);

  const weapon = useMemo(() => buildScopeDisplay(lensMaterial), [lensMaterial]);
  const offset = useMemo(() => new THREE.Vector3(), []);
  const worldLens = useMemo(() => new THREE.Vector3(), []);
  const time = useRef(0);

  useEffect(() => {
    const toggleKeyboard = (event: KeyboardEvent) => {
      if (event.code !== "KeyR" || event.repeat) return;
      aiming.current = !aiming.current;
    };
    const togglePointer = (event: PointerEvent) => {
      if (event.button !== 2) return;
      event.preventDefault();
      aiming.current = !aiming.current;
    };
    const preventMenu = (event: MouseEvent) => event.preventDefault();
    addEventListener("keydown", toggleKeyboard);
    gl.domElement.addEventListener("pointerdown", togglePointer);
    gl.domElement.addEventListener("contextmenu", preventMenu);
    return () => {
      removeEventListener("keydown", toggleKeyboard);
      gl.domElement.removeEventListener("pointerdown", togglePointer);
      gl.domElement.removeEventListener("contextmenu", preventMenu);
    };
  }, [gl]);

  useEffect(() => {
    let alive = true;
    const loader = new GLTFLoader();
    loader.load(
      "/assets/scope/hunting_scope.glb",
      (gltf) => {
        if (!alive) return;
        gltf.scene.traverse((object) => {
          object.layers.set(WEAPON_LAYER);
          // The original Godot scene replaces this rear glass with the scope
          // display shader. The Three lens above is the equivalent material slot.
          if (object.name === "BodyLenseRear") object.visible = false;
        });
        weapon.add(gltf.scene);
      },
      undefined,
      (error) => console.error("Unable to load the scope model", error)
    );
    return () => {
      alive = false;
    };
  }, [weapon]);

  useEffect(() => {
    scene.add(weapon);
    return () => {
      scene.remove(weapon);
      weapon.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
    };
  }, [scene, weapon]);

  useEffect(
    () => () => {
      target.dispose();
      lensMaterial.dispose();
    },
    [lensMaterial, target]
  );

  useFrame((_, delta) => {
    time.current += delta;
    const isAiming = aiming.current;
    // ADS should read as controlled breathing, not an exaggerated weapon-inspect
    // animation. Hip fire remains looser so the state change is still clear.
    const sway = isAiming ? 0.0012 : 0.018;
    const source = isAiming ? AIM_OFFSET : HIP_OFFSET;
    offset.copy(source);
    offset.x += Math.sin(time.current * 1.7) * sway;
    offset.y += Math.cos(time.current * 2.1) * sway * 0.45;

    // Weapon is kept in the player's camera space but lives directly in the scene
    // so the scope camera can cleanly exclude it with layers.
    camera.updateMatrixWorld();
    weapon.position.copy(camera.position);
    weapon.quaternion.copy(camera.quaternion);
    weapon.translateX(offset.x);
    weapon.translateY(offset.y);
    weapon.translateZ(offset.z);
    // The lens, its display and its capture camera are one rigid optical unit.
    // Copying only the player camera rotation made the body sway around a view
    // that stayed locked to the horizon.
    weapon.rotateY(Math.sin(time.current * 1.7) * (isAiming ? 0.0015 : 0.018));
    weapon.rotateX(Math.cos(time.current * 2.1) * (isAiming ? 0.001 : 0.012));
    weapon.updateMatrixWorld();

    // The small offset between eye and lens is the physical input to the eyebox
    // shadow. It also drives the reticle's slight fake-parallax shift.
    eyeOffset.value.set(offset.x / 0.15, offset.y / 0.15);
    reticleOffset.value.copy(eyeOffset.value);

    if (isAiming) {
      worldLens.copy(SCOPE_CAMERA_OFFSET).applyMatrix4(weapon.matrixWorld);
      scopeCamera.position.copy(worldLens);
      scopeCamera.quaternion.copy(weapon.quaternion);
      scopeCamera.updateMatrixWorld();
      const renderer = gl as unknown as THREE.WebGPURenderer;
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, scopeCamera);
    }

    const renderer = gl as unknown as THREE.WebGPURenderer;
    renderer.setRenderTarget(null);
    camera.layers.enable(WEAPON_LAYER);
    renderer.render(scene, camera);
  }, 1);

  return null;
}
