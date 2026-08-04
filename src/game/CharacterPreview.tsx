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

/** Headroom around the figure once it is fitted. 1 would touch every edge. */
const FRAME_MARGIN = 1.12;

function Soldier({ asset }: { asset: SoldierAsset }) {
  const pivot = useRef<THREE.Group>(null);
  const camera = useThree((state) => state.camera);
  // Framing depends on the viewport, so it must be recomputed when the stage
  // resizes — otherwise the first measurement (taken at whatever aspect existed
  // on mount) decides the composition forever.
  const size = useThree((state) => state.size);

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
    const extent = bounds.getSize(new THREE.Vector3());
    const centre = bounds.getCenter(new THREE.Vector3());
    object.position.set(-centre.x, 0, -centre.z);

    // Fitted from the actual field of view and aspect rather than from a
    // multiplier on the model's height. A guessed multiplier framed correctly at
    // one window size and cropped the soldier's head at another, because the
    // binding axis changes with the shape of the stage: a tall narrow column is
    // limited by WIDTH, a short wide one by height.
    const perspective = camera as THREE.PerspectiveCamera;
    const aspect = size.height > 0 ? size.width / size.height : 1;
    const halfFov = (perspective.fov * Math.PI) / 360;
    const fitHeight = extent.y / 2 / Math.tan(halfFov);
    const fitWidth = extent.x / 2 / (Math.tan(halfFov) * aspect);
    const distance = Math.max(fitHeight, fitWidth) * FRAME_MARGIN;

    perspective.position.set(0, centre.y, distance);
    perspective.lookAt(0, centre.y, 0);
    perspective.updateProjectionMatrix();
  }, [object, camera, size]);

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

  return (
    <>
      {/* The Canvas mounts IMMEDIATELY, before the GLB has arrived, and the
          soldier is added to it when it does.
          Two reasons, and the first one is a bug this fixes. R3F measures its
          container once on mount; mounting the Canvas late — after an 8-second
          download, into an absolutely-positioned box — measured stale and left
          the canvas at its intrinsic 300x150, the same class of collapse as
          design record §5.2 trap 5. Mounting with the rest of the layout gets a
          real measurement. Second, the WebGPU device now initialises in PARALLEL
          with the model download instead of after it, which is straightforwardly
          faster to first pixel on the screen that is meant to sell the game.

          No wrapper box and no background: the host element is the stage, and
          the canvas is transparent so the screen's own vignette shows through
          behind the soldier. */}
      <Canvas
        dpr={[1, 1.5]}
        camera={{ fov: 35, near: 0.1, far: 50, position: [0, 1, 3] }}
        gl={async (props) => {
          const renderer = new THREE.WebGPURenderer({
            ...(props as ConstructorParameters<typeof THREE.WebGPURenderer>[0]),
            alpha: true,
          });
          await renderer.init();
          return renderer;
        }}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0);
        }}
      >
        {/* Lit rather than unlit: these are the GLB's own PBR materials, and
            `atmosphere.shade` is for unlit scene materials only (docs/08 §8).
            A key from the front right and a cool rim from behind left, so the
            silhouette separates from a near-black ground. */}
        <hemisphereLight args={[0xdcd6bb, 0x2a3020, 1.9]} />
        <directionalLight position={[2.5, 4, 3]} intensity={2.6} />
        <directionalLight position={[-3.5, 2.5, -2.5]} intensity={1.1} color={0xa9bd61} />
        {asset !== null && <Soldier asset={asset} />}
      </Canvas>

      {asset === null && !failed && (
        <p className="stage-loading" data-dev="character-preview-loading">
          Standing by
        </p>
      )}
      {failed && (
        <p className="stage-loading" role="alert" data-dev="character-preview-error">
          Model unavailable
        </p>
      )}
    </>
  );
}
