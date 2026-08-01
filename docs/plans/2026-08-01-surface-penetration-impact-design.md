# Surface penetration and impact design

## Goal

Add DF2-scale material response without introducing an ECS, rigid-body bullets,
or renderer-owned gameplay truth. Cloth can conceal without providing cover;
wood and sheet metal provide cartridge-dependent cover; armor stops ordinary
small arms; every impact can drive pooled visual and spatial-audio effects.

The first playable slice supports representative 9x19 mm, 5.56x45 mm, .308
Winchester, and .50 BMG profiles. Only the existing sniper has complete weapon
presentation. The other profiles are selectable diagnostic ammunition, not
claims that the sniper model has changed into those weapons.

## Selected model

Use authored surface resistance and collider thickness against the projectile's
remaining kinetic energy. This is more useful than a binary material table and
far cheaper and more controllable than simulating each rifle round as a Rapier
rigid body.

The ammunition definition owns mass, muzzle velocity, drag coefficient, base
damage, and a penetration multiplier. A surface profile owns resistance per
metre, impact presentation, and whether penetration is allowed. A world-object
registration supplies its surface and simplified collider thickness. Visual
Three.js materials never decide gameplay behavior.

At an impact, the resolver adjusts authored thickness by incidence angle, caps
grazing-path amplification, and computes the energy cost. If sufficient energy
remains, the projectile emits entry and exit interactions, loses speed and
damage potential, advances beyond the simplified collider, and continues. If
not, it stops. Ricochet, projectile deformation, armor spall, and layered armor
remain later extensions behind the same response contract.

## World-object prefab boundary

A prefab composes independent data:

```text
WorldObjectDefinition
  visual
  collider { surface, thickness }
  destructible? { health, damage channels, husk, destruction effect }
```

Health is optional. Terrain, water, and ordinary cover do not become
`Damageable` merely to produce impact effects. A tent may use an opaque cloth
visual, a thin cloth ballistic collider, wood or metal pole colliders, and an
optional explosive-sensitive destructible component. The initial destruction
model is one intact-to-husk transition; staged and sectional destruction are
deferred.

## Events and presentation

Each authoritative contact emits an immutable `ImpactEvent` containing shot and
object identity, surface, entry/exit point, normal, outcome, traversed thickness,
and speed before/after. `ShotTrace` retains the same interactions for debug and
telemetry. Presentation never performs another raycast or penetration solve.

One fixed-capacity instanced particle pool consumes impact events without React
state or per-impact mesh creation. One bounded positional-audio voice pool uses
prebuilt surface-specific buffers, distance culling, and oldest-voice stealing.
Audio context resume happens only from a user gesture. Missing or suspended
audio is a silent presentation failure and cannot affect the shot result.

## Performance constraints

- Keep the existing typed-array projectile pool and allocation-free no-hit loop.
- Permit at most eight material interactions per projectile.
- Perform no more than one normal swept world query per active projectile tick.
- Penetration uses authored thickness, avoiding an extra exit raycast.
- Use one instanced particle draw, a fixed particle count, and a fixed audio
  voice count; distant events may be culled visually or audibly but never from
  gameplay.
- Keep `WorldQuery` as the adapter seam. A production server can replace the
  current Three.js root scan with a spatial index without changing ballistics.

## Diagnostic range and controls

`?scene=scope&impacttest=1&shotdebug=1` adds procedural cloth, wood, thin-metal,
armored-metal, glass, stone, dirt, water, and flesh samples without modifying
terrain or grass rendering. A damageable target behind penetrable cover proves
that the continued projectile, not a second hitscan ray, causes downstream
damage.

The `ammo` query selects `9mm`, `556`, `308`, or `50bmg`; .308 remains the
default. The HUD and trace report the selected ammunition, each material
interaction, effective thickness, and retained speed. Debug markers distinguish
stops, entries, and exits.

## Acceptance

- Cloth is visually opaque but all four profiles pass through it.
- The Glock 9 mm profile stops in representative wood and sheet metal while
  rifle profiles remain cartridge-dependent.
- Ordinary rifle profiles stop on armored metal; .50 BMG can pass the authored
  diagnostic plate.
- A penetrated target receives damage only when the live projectile reaches it.
- Frame cadence does not change penetration outcomes or downstream hits.
- Automatic-fire load tests retain bounded projectile, particle, audio, and
  interaction counts with no per-frame React updates.
- Entry, exit, stop, particles, spatial audio, HUD, and debug trace all consume
  the same authoritative impact event.
