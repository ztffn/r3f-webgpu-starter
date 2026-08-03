# Ecctrl player and vehicle controller spike

**Status:** planned decision spike

**Dependency:** local FPS scaffold and canonical CPU terrain heightfield

**Decision:** Rapier remains the selected physics engine; the controller layer is open

## Goal

Determine whether [ecctrl](https://github.com/pmndrs/ecctrl) can provide production-useful
player and vehicle controllers substantially more cheaply than writing both from scratch,
without sacrificing DF2 movement, performance, or the future server-authoritative network
model. This is an adoption test, not a commitment.

Finished character, weapon, or vehicle assets are explicitly out of scope. Use the current
first-person presentation, capsule/primitive player proxies, and a primitive vehicle body.
The spike evaluates controller behavior and integration cost, not art quality.

## Options and decision outcomes

The spike must end with one measured recommendation:

1. **Adopt ecctrl behind project-owned adapters.** Use this only if ecctrl can accept our
   commands, expose the required simulation state, and avoid owning camera or gameplay
   truth.
2. **Reuse selected Rapier techniques.** Keep our own motors while adapting useful slope,
   suspension, floating-body, or stability techniques permitted by ecctrl's licence.
3. **Continue with custom Rapier controllers.** Choose this if adapting ecctrl costs more,
   weakens stance/vehicle behavior, couples simulation to React, or blocks the authority
   model.

The comparison report must include dependency and maintenance cost. An open-source licence
does not by itself make the integration free.

## Architecture boundary

Ecctrl is never allowed to become the input, camera, weapon, animation, or networking
authority. Both candidates are exercised through project-owned seams:

```text
sequenced PlayerCommand / VehicleCommand
  -> fixed-tick PlayerMotor / VehicleMotor adapter
  -> position, rotation, velocities, contact and stance/vehicle state
  -> camera, character/vehicle model, audio and HUD presentation
```

The adapter must not read DOM keyboard state or GLTF bones. React/R3F may mount the local
presentation and physics world, but simulation commands and snapshots remain plain data.
Bullets continue using the pooled fixed-step ballistic system and `WorldQuery`; the spike
must not turn rifle rounds into Rapier bodies.

## Player evaluation

Exercise the same course with ecctrl and the custom-Rapier baseline:

- precise walk/run movement at fixed simulation cadence;
- standing, crouching, and prone transitions with blocked-stand clearance checks;
- small steps, steep slopes, ridges, descents, ground loss, and recovery;
- stable world-space aim while the body moves over uneven terrain;
- moving/rotating support bodies and modest dynamic-body interaction;
- correction from an authoritative snapshot without moving the camera or weapon into the
  gameplay state.

If ecctrl lacks a required stance, the spike may add the smallest adapter-level experiment
needed to estimate the real integration cost. It must not disguise a missing feature as
completed controller support.

## Vehicle evaluation

Use one primitive wheeled vehicle to test throttle, braking, steering, reverse, suspension
or ground following, slope stability, collision, and enter/exit handoff. Record which
additional DF2 vehicle classes would share the controller and which would still need
separate work; one successful car must not be reported as a complete helicopter, boat, or
tracked-vehicle solution.

## Multiplayer preservation gates

This phase does not build transport or matchmaking, but adoption requires evidence that it
does not foreclose them:

- commands carry sequence/tick identifiers and can be replayed at a fixed cadence;
- the required correction snapshot is explicit and serializable;
- local prediction can restore authority state and replay unacknowledged commands;
- remote entities can consume interpolated snapshots without running local input/camera;
- a server or test harness can execute equivalent motor logic without GLTFs, HUD, or a
  browser camera;
- weapon acceptance, projectile truth, hits, and damage remain server-authoritative and
  outside the controller.

An ecctrl integration that only functions as an opaque React render-loop component fails
the authoritative-motor gate even if its local movement feels good. Its algorithms may
still be useful under outcome 2.

## Performance and verification

Build a repeatable benchmark rather than judging one local avatar. At minimum record:

- one local player with full camera/presentation;
- 32 and 64 simulation-only player controllers;
- a representative mixed case with player controllers and primitive vehicles;
- fixed-step CPU time, frame time, allocations, rigid-body/collider counts, and correction
  replay cost;
- behavior under low render cadence while simulation cadence remains fixed.

Use the same Rapier world, course, timestep, and command recording for both candidates.
Report browser, hardware, dependency versions, configuration, missing behaviors, adapter
code size, and any source fork required. Do not merge a controller choice based only on a
demo scene or average FPS.

## Deliverable and stopping point

The deliverable is the comparison harness, measurements, and a short decision record
selecting one of the three outcomes. It does not include production assets, final handling
tuning, weapons, AI, networking transport, or a complete vehicle library. Implementation
of the selected controller is a following phase.
