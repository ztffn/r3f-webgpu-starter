export interface WeaponPresentationDefinition {
  readonly modelUrl: string;
  readonly developmentLabel: string;
  readonly animationSegments: {
    readonly fire?: number;
    readonly reload?: number;
    readonly dryFire?: number;
    readonly idle?: number;
  };
  readonly sourceAnimation?: {
    readonly framesPerSecond: number;
    readonly initialPoseSeconds: number;
    readonly segmentsSeconds: readonly (readonly [number, number])[];
  };
}

const PROXY_PRESENTATION: WeaponPresentationDefinition = {
  modelUrl: new URL("../../../testmodels/fps_rig.glb", import.meta.url).href,
  developmentLabel: "PROXY MODEL",
  animationSegments: {
    idle: 1,
    reload: 4,
    fire: 5,
  },
  sourceAnimation: {
    framesPerSecond: 60,
    initialPoseSeconds: 1 / 60,
    segmentsSeconds: [
      [0, 1],
      [1.166667, 7.666667],
      [7.833333, 10.666667],
      [10.833333, 15],
      [15.166667, 15.833333],
      [16, 18.166666],
      [18.316668, 26.5],
      [26.666666, 27.166666],
    ],
  },
};

const PRESENTATIONS: Readonly<Record<string, WeaponPresentationDefinition>> = {
  "prototype-sniper": PROXY_PRESENTATION,
  m4: PROXY_PRESENTATION,
  "glock-9mm": PROXY_PRESENTATION,
  "saw-test": PROXY_PRESENTATION,
};

/** GLTF and animation selection stays on the presentation side of the boundary. */
export function weaponPresentationFor(weaponId: string): WeaponPresentationDefinition {
  return PRESENTATIONS[weaponId] ?? PROXY_PRESENTATION;
}
