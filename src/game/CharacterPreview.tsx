// A turntable view of the soldier, for the character editor.
//
// Lives in src/game/ because it imports Three.js, and src/site/ may not — the
// character page reaches it through `lazy()` so the site's entry chunk never
// grows by a renderer. It is mounted on demand rather than on page load: the GLB
// alone is 7 MB.
//
// IT DOES NOT REFLECT THE EDITOR. Camouflage, headgear and insignia are stored
// and validated but nothing renders them yet — the GLB is one soldier with baked
// materials — so this shows the model and its idle, and the page says so rather
// than implying the sleeve on screen is the one that was picked.

import { Canvas, extend, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { CLIP_IDLE } from "../fps/presentation/characterClips";
import { instantiateSoldier, loadSoldier, type SoldierAsset } from "../fps/presentation/soldierAssets";

// Make the three namespace available as JSX elements. Idempotent, and this
// module can be the first one in the graph to need it.
extend(THREE as never);

/** Radians per second. Slow enough to read the silhouette, not a spinning icon. */
const TURNTABLE_RATE = 0.35;

function Soldier({ asset }: { asset: SoldierAsset }) {
  const pivot = useRef<THREE.Group>(null);
  const camera = useThree((state) => state.camera);

  const { object, mixer } = useMemo(() => {
    // Cloned through SkeletonUtils by `instantiateSoldier`; a plain clone shares
    // the skeleton, which matters here only because the template must stay clean
    // for the game to use later in the same session.
    const object = instantiateSoldier(asset);
    const mixer = new THREE.AnimationMixer(object);
    const idle = asset.animations.find((clip) => clip.name === CLIP_IDLE);
    if (idle !== undefined) mixer.clipAction(idle).play();
    return { object, mixer };
  }, [asset]);

  // Framed from the model's own bounds rather than from a guessed height, so a
  // re-export at a different scale reframes itself instead of showing knees.
  //
  // The horizontal recentre is not cosmetic: the rig's origin is not under the
  // model's middle — a rifle held out to one side moves it — so spinning the
  // parent made the soldier ORBIT the frame instead of turning on the spot.
  useEffect(() => {
    const bounds = new THREE.Box3().setFromObject(object);
    const size = bounds.getSize(new THREE.Vector3());
    const centre = bounds.getCenter(new THREE.Vector3());
    object.position.set(-centre.x, 0, -centre.z);
    const distance = Math.max(size.y, size.x) * 1.35 + 0.6;
    camera.position.set(0, centre.y, distance);
    camera.lookAt(0, centre.y, 0);
    camera.updateProjectionMatrix();
  }, [object, camera]);

  useEffect(
    () => () => {
      // The mixer holds the only references that outlive this component; the
      // geometry and materials belong to the shared template.
      mixer.stopAllAction();
      mixer.uncacheRoot(object);
    },
    [mixer, object]
  );

  useFrame((_state, delta) => {
    mixer.update(delta);
    if (pivot.current !== null) pivot.current.rotation.y += delta * TURNTABLE_RATE;
  });

  return (
    <group ref={pivot}>
      <primitive object={object} />
    </group>
  );
}

export default function CharacterPreview() {
  const [asset, setAsset] = useState<SoldierAsset | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    loadSoldier()
      .then((loaded) => {
        if (live) setAsset(loaded);
      })
      .catch((error: unknown) => {
        // `loadSoldier` throws loudly when a clip the animator needs is missing,
        // which is a real failure worth showing rather than a blank panel.
        console.warn("[character] soldier preview failed to load:", error);
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  if (failed) {
    return (
      <p className="field-error" role="alert" data-dev="character-preview-error">
        The model could not be loaded.
      </p>
    );
  }

  return (
    <div className="character-preview" data-dev="character-preview">
      {asset === null ? (
        <p className="auth-note" data-dev="character-preview-loading">
          Loading the model…
        </p>
      ) : (
        <Canvas
          dpr={[1, 1.5]}
          camera={{ fov: 35, near: 0.1, far: 50, position: [0, 1, 3] }}
          gl={async (props) => {
            const renderer = new THREE.WebGPURenderer(
              props as ConstructorParameters<typeof THREE.WebGPURenderer>[0]
            );
            await renderer.init();
            return renderer;
          }}
        >
          {/* Lit rather than unlit: these are the GLB's own PBR materials, and
              `atmosphere.shade` is for unlit scene materials only (docs/08 §8). */}
          <hemisphereLight args={[0xdcd6bb, 0x30301f, 2.2]} />
          <directionalLight position={[2.5, 4, 3]} intensity={2.4} />
          <directionalLight position={[-3, 2, -2]} intensity={0.7} />
          <Soldier asset={asset} />
        </Canvas>
      )}
    </div>
  );
}
