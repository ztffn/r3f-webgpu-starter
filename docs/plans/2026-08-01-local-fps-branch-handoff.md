# Local FPS branch handoff

## Purpose

This records the branch/integration state at the end of the local FPS scaffold
work. Durable runtime contracts live in `../10-fps-combat-implementation-spec.md`;
do not turn this transient git handoff into the architecture source of truth.

## Branch state

- FPS worktree: `/private/tmp/r3f-webgpu-local-fps`
- FPS branch: `local-fps-scaffold`
- Base when the work began: `origin/main` at `13ef3ee`
- The branch was clean and 22 commits ahead of `origin/main` before this final
  documentation commit.
- The independently completed terrain follow-up work remains on
  `perf/grass-march` in the primary worktree.
- `design/` and `docs/df2-walktrough.txt` are untracked user-owned paths in the
  primary worktree. Preserve them; they are not part of FPS work.

The older prototype commit `87b92a7` is already in `origin/main` through the
previous merged terrain PR. Do not extract or cherry-pick it again. A new FPS PR
is the diff from current `origin/main` to `local-fps-scaffold`, not a replay of
all historical prototype work.

## Clean PR integration order

1. Finish and merge the cleaned terrain PR first.
2. Rebase `local-fps-scaffold` onto the resulting `origin/main` from its isolated
   worktree.
3. Resolve only the genuine shared seams: `src/df2/DF2Scene.tsx`,
   `src/df2/FlyControls.tsx`, `src/fps/WeaponPrototype.tsx`, and shared project
   docs/HUD styles if Git reports them.
4. Preserve terrain's renderer/LOD/grass changes and FPS's
   `CompositeWorldQuery(heightfield)` wiring. Visual terrain must not be
   registered in the collider adapter.
5. Accept terrain's deletion of the unreferenced legacy `src/fps/ScopeRig.tsx`;
   current scope presentation lives in `WeaponPrototype.tsx`.
6. Run the verification commands below and inspect the final diff against
   `origin/main` before pushing the FPS branch.

Do not push `perf/grass-march` wholesale as the FPS PR, and do not rewrite
already merged history to make the old prototype appear new.

## Verification before push

```sh
npm ci # if this worktree has no node_modules
npm test
npm run typecheck
npm run build
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
```

After the terrain rebase, also run its normal benchmark/QA procedure. The FPS
automated load tests validate the gameplay projectile/query core; they are not a
substitute for checking browser frame time with the final terrain renderer.

## Review focus

- High-frequency gameplay state remains outside React state.
- Sway, zero, windage, drop, penetration, and damage are authoritative gameplay,
  not duplicated presentation approximations.
- The rangefinder uses the optical sightline; the projectile uses the adjusted
  bore and then follows the simulated trajectory.
- Terrain collision reads the canonical CPU heightfield, never mesh LODs or
  grass proxies.
- Collider, projectile, impact-event, particle, audio, telemetry, and debug
  retention are bounded.
- The actual remaining gaps are stated in `docs/10`, especially the absence of
  a real Glock view/loadout and the absence of a full 32-player match benchmark.
