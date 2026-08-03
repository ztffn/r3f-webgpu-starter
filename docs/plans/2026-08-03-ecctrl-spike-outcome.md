# Ecctrl spike — outcome

**Status:** closed. Concludes
`2026-08-01-ecctrl-player-vehicle-controller-spike-design.md`.

**Date:** 2026-08-03

## Outcome: 3, continue with custom Rapier controllers

The spike offered three endings: adopt ecctrl behind adapters, reuse selected techniques
from it, or write our own. **Outcome 1 was eliminated before any code ran** — see §4 of
`2026-08-02-multiplayer-motor-and-transport-decisions.md`. Ecctrl is a React component built
around `useFrame` and a mounted rigid body; running it as server authority means forking it,
and the spike's own multiplayer gate already failed anything that only works as an opaque
React render-loop component.

What shipped is outcome 3. `src/motor/` is written from scratch and documented as built in
`12-character-motor-and-networking-spec.md`.

## What this record cannot claim

**Nothing was harvested from ecctrl, because ecctrl was never read.**

That is a real gap and it should be stated rather than dressed up. The spike asked for a
comparison and the honest position is that only one side was built. The choice was driven
by the architectural argument in §4 above — which stands on its own — not by having weighed
ecctrl's slope, step, floating-body and stability techniques against ours.

So this closes the adoption question and leaves the *technique* question open. Concretely,
the areas where reading it might still pay:

- **Floating-body suspension.** Ecctrl uses a ray-and-spring hover rather than a capsule
  resting on geometry. We used Rapier's kinematic character controller, and paid for it
  twice: snap-to-ground stalling on flat lattice seams, and the whole velocity-recovery
  defect in `12-...md` §6. A floating body has neither failure mode, and has its own.
- **Slope handling.** Ours is a soft limit reached after a measured bug; theirs is at least
  a second opinion on the shape of the curve.
- **Step handling.** We take Rapier's autostep as-is and have not tuned it.

None of that blocks anything today. The motor walks, climbs, and holds up under a server.
Revisit only if one of those areas misbehaves — this is a note about where to look first,
not a task.

## What the spike did produce

Not the comparison it planned, but more than the plan asked for on the parts that were
built:

- a character motor that runs unchanged in browser and Node;
- an authoritative room, a transport seam and a working two-client session;
- four of five §7 measurements, in `2026-08-02-motor-measurements.md`;
- the collision-representation tolerance the design flagged as the one with a gameplay
  failure behind it, plus a tested fix that removed the failure from the sample.

Vehicles — the spike's other half — were not attempted at all. No vehicle motor, no
primitive wheeled body, no enter/exit handoff. That remains entirely open and inherits
nothing from this work beyond the command/state pattern.
