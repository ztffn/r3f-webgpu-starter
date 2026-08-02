# Session test

Two browser clients against one authoritative server, over real WebSockets. It exists to
produce the §7 measurements in
`docs/plans/2026-08-02-multiplayer-motor-and-transport-decisions.md` and is explicitly
disposable — §5 of that record defers the session framework until those measurements exist.

## Running it

```sh
npm run session:server   # authoritative room on ws://localhost:8787
npm run session:client   # harness on http://localhost:3100
```

Open the harness in **two separate browser windows, both visible**. Not two tabs in one
window: Chrome suspends `requestAnimationFrame` entirely in a hidden tab, so a background
tab renders nothing. Simulation itself is driven by a timer and survives backgrounding at a
reduced rate, but you cannot watch two tabs at once.

Controls are WASD to move, Shift to sprint, Space to jump, C to crouch, Z to go prone, and
drag to look.

## What it is not

A top-down 2D canvas, deliberately. No R3F, no WebGPU, no terrain streaming, no weapons —
if two windows show each other moving smoothly here, the motor and transport are right and
everything left is presentation. Putting the real renderer in would make a network fault
and a rendering fault look the same.

## The one thing to keep in step

`main.ts` and `server.ts` each define a `terrain` height function, and **they must be
identical**. The client predicts against its copy and the server simulates against its own;
if they differ the client reconciles forever and the cause is not obvious from the symptom.
They are separate rather than shared because the real `Heightfield` sits behind the terrain
spike's asset loading, which this harness deliberately does not pull in.

## Automation

The page exposes `window.__session` with `step(ticks, buttonBits, yaw)` and an `info`
getter, so a driver script can advance the client directly. This is the only way to exercise
the harness from browser automation, where every tab is hidden and no animation frames run.
