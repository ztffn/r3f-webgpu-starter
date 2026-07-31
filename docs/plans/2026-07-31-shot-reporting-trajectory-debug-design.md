# Shot reporting and trajectory debug design

## Goal

Make the current local FPS slice easy to judge by a human before adding
ballistics. Every accepted shot should produce one structured result that can
drive target response, HUD history, and an opt-in world-space debug drawing.

This iteration remains hitscan. It validates that the authoritative aim ray,
scope reticle, target damage, reported range, and visible impact all agree.

## Shot result contract

`HitscanResolver` remains the only object that turns shot intent into a world
hit. Its result gains two immutable-by-convention records:

- `TargetHitReport` describes damageable-target truth: target identity, impact
  point and normal, range, health before/after, applied damage, and destruction.
- `ShotTrace` describes geometry useful to presentation and diagnostics: shot
  identity, solver mode, sampled world-space points, optional impact metadata,
  flight time, vertical drop, and lateral drift.

A terrain hit or miss still produces a trace, but not a target hit report. The
current hitscan trace has two points and zero flight/drop/drift. A future
ballistic solver can emit many points without changing HUD or debug consumers.

Targets own health and visible reaction. They do not own input, raycasts, the
shot log, or debug rendering.

## Human-facing diagnostics

The HUD keeps a short recent-shot history. A damageable hit reports target id,
range, damage, remaining health, and whether it was destroyed. World-only hits
and misses remain distinguishable.

`?shotdebug=1` mounts a latest-shot-only debug view:

- cyan: the resolved shot path;
- white: the initial authoritative aim segment;
- red: impact point and surface normal.

The view consumes `ShotTrace`; it does not recompute a trajectory. This prevents
the diagnostic from disagreeing with gameplay. The latest trace persists until
the next accepted shot or an explicit clear.

## Physics and later ballistics

Rapier is the selected world physics engine for player collision, stance,
vehicles, rigid bodies, and broad scene queries. It is not installed in this
iteration because no current runtime path needs it.

Fast rifle rounds will use a small deterministic fixed-step ballistic solver
with swept `WorldQuery` segments. Gravity, wind acceleration, drag, and weapon
ballistic coefficients belong there; Rapier may back collision queries, but a
bullet will not be represented as a dynamic rigid body. This avoids tunnelling
and large per-projectile rigid-body cost while preserving one hit/report/trace
contract for hitscan and ballistic weapons.

## Human test

1. Open `?scene=scope&shotdebug=1`.
2. Fire at several target faces and near their silhouettes.
3. Confirm reticle, cyan path, red impact, reported target id/range, health, and
   visible flash agree.
4. Fire into terrain and sky; confirm the HUD distinguishes world hit from miss.
5. Empty the magazine and reload; confirm rejected/dry shots create no trace or
   target report.
6. Reset targets and confirm health/visibility return without clearing weapon
   state.

Only after this alignment test passes should drop/wind be introduced, so any
ballistic miss is attributable to the solver rather than an existing aim-space
or raycast mismatch.
