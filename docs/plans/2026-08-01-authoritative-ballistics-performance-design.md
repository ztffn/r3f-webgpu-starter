# Authoritative ballistics and performance design

## Goal

Replace the prototype sniper's temporary hitscan resolver with deterministic
gameplay ballistics. Gravity, drag, wind, time of flight, swept collision,
damage, hit reports, HUD telemetry, and trajectory debug must all describe one
simulation result. The implementation must remain viable for an eventual
16–32-player authority handling automatic weapons; a one-rifle demo is not the
performance target.

## Chosen approach

Use a custom fixed-step active-projectile system. Do not create Rapier rigid
bodies for bullets and do not precompute an entire trajectory at trigger time.
Rigid bodies add tunnelling and per-body overhead. Instant precomputation would
make time of flight telemetry while still applying damage immediately and could
not query moving targets at the time the projectile reaches them.

The system advances at 120 Hz. Each tick integrates velocity against gravity
and air-relative drag, then performs one swept segment query from the old to the
new position. A hit applies damage at that simulated time and emits the single
`BallisticResult` consumed by telemetry and debug presentation. A miss resolves
when its configured path-length limit is exhausted.

## Ammunition and environment data

Ballistic parameters live in weapon/ammunition definitions, not the scope view:

- muzzle velocity;
- G1 ballistic coefficient;
- maximum path length and damage.

The prototype profile starts at 792.48 m/s (2,600 ft/s) with a G1 coefficient
of 0.505. The initial drag implementation is a documented single-coefficient
G1 approximation calibrated against that profile's published short-range
velocity loss. It is deliberately replaceable with a piecewise standard-drag
model without changing projectile, collision, or reporting contracts.

The environment supplies world-space gravity and wind velocity. Default wind is
4 m/s along world +X so drift is present in the human test; `windx` and `windz`
query parameters allow controlled tests, including equal opposite winds.

## Performance architecture

The acceptance baseline is 32 shooters firing 600 RPM continuously: 320 spawns
per second and, at a 2.5-second maximum lifetime, roughly 800 simultaneous
projectiles. A 900 RPM case is the stress test.

Projectile state uses a fixed-capacity pool and structure-of-arrays numeric
storage. Simulation performs no per-projectile object allocation inside a
fixed step. Completed results allocate only at the event boundary. Trace
samples use preallocated numeric storage and are converted to Three.js vectors
only when a completed trace is published.

The projectile system makes at most one swept query per active projectile per
tick. `WorldQuery` remains the collision seam, but the present Three.js adapter
is explicitly a local prototype fallback. A production 16–32-player authority
must provide a spatially indexed/batched implementation (Rapier scene queries,
analytic heightfield queries, or equivalent); multiplying Three.js recursive
raycasts by every registered root is not an accepted production path.

Network presentation is separate from authority. A client predicts its own
shots. It does not re-simulate every remote bullet as gameplay truth; the
authority replicates shot/impact results, while remote tracers are pooled,
culled presentation consumers.

## Data flow

```text
accepted WeaponEvent
  -> BallisticProjectileSystem.spawn(authoritative aim, ammunition, environment)
  -> 120 Hz pooled integration
  -> WorldQuery swept segment
  -> impact at simulated flight time
  -> Damageable.applyDamage
  -> BallisticResult + TargetHitReport + ShotTrace
  -> target response + CombatTelemetry + ShotTrajectoryDebugView
```

The rangefinder remains an optical straight-line query. It reports line-of-
sight range; it does not predict a hit or bypass projectile simulation.

## Failure and capacity behavior

Invalid direction, muzzle velocity, coefficient, range, or damage rejects a
spawn without entering the pool. Pool exhaustion is explicit and observable;
it must never silently overwrite a live projectile. Large render-frame deltas
accumulate fixed steps up to a bounded catch-up window so returning from a
background tab cannot freeze the main thread. Conventional 30, 60, and 144 Hz
frame sequences produce the same completed path and impact.

## Verification

- Still-air tests at 100, 300, 600, 1,000, and 1,300 m show monotonically
  increasing flight time and drop.
- Equal +X/-X winds produce equal and opposite lateral drift within tolerance.
- The same shot advanced with 30, 60, and 144 Hz render deltas resolves to the
  same impact, time, drop, and drift.
- A thin target intersected between fixed positions is hit by the swept query.
- Damage occurs only on the impact step, not when the trigger is accepted.
- 16/32 shooters at 600 RPM and 32 shooters at 900 RPM remain within pool
  capacity; benchmarks report active peak, fixed steps, segment queries, and
  elapsed CPU time rather than asserting a machine-specific millisecond limit.
- Debug points, impact marker, HUD range/time/drop/drift, and target hit report
  all come from the resolved ballistic result.

