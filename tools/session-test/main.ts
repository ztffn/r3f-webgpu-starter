// Browser harness for the two-client session test.
//
// Deliberately NOT the game. It draws a top-down 2D view with plain canvas so
// that what you are looking at is unambiguously the network layer: no R3F, no
// WebGPU, no terrain streaming, no weapons. If two tabs show each other moving
// smoothly here, the motor and transport are right and the remaining work is
// presentation.
//
// The terrain function must match tools/session-test/server.ts exactly, or the
// client will predict a different surface and reconcile forever.

import { GameClient } from "../../src/net/GameClient.ts";
import { WebSocketClientTransport } from "../../src/net/WebSocketTransport.ts";
import { createMotorWorld, initRapier } from "../../src/motor/MotorWorld.ts";
import {
  DEFAULT_MOTOR_TUNING,
  MotorInput,
  eyeHeightFor,
  type MotorHeightSource,
} from "../../src/motor/MotorTypes.ts";

const terrain: MotorHeightSource = {
  cellSize: 2,
  sample: (x, z) => Math.sin(x * 0.03) * 2.5 + Math.cos(z * 0.021) * 3,
};

const PORT = new URLSearchParams(location.search).get("port") ?? "8787";
const TICK_SECONDS = DEFAULT_MOTOR_TUNING.fixedTimestepSeconds;
const METRES_PER_PIXEL = 0.08;

const canvas = document.getElementById("view") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const context = canvas.getContext("2d")!;

const held = new Set<string>();
let yaw = 0;
let pitch = 0;
let dragging = false;

addEventListener("keydown", (event) => {
  held.add(event.code);
  if (["Space", "KeyC", "KeyZ"].includes(event.code)) event.preventDefault();
});
addEventListener("keyup", (event) => held.delete(event.code));
addEventListener("blur", () => held.clear());
canvas.addEventListener("pointerdown", () => (dragging = true));
addEventListener("pointerup", () => (dragging = false));
addEventListener("pointermove", (event) => {
  if (!dragging) return;
  yaw -= event.movementX * 0.0035;
  pitch = Math.max(-1.5, Math.min(1.5, pitch - event.movementY * 0.0035));
});

function buttons(): number {
  let bits = 0;
  if (held.has("KeyW")) bits |= MotorInput.Forward;
  if (held.has("KeyS")) bits |= MotorInput.Back;
  if (held.has("KeyA")) bits |= MotorInput.Left;
  if (held.has("KeyD")) bits |= MotorInput.Right;
  if (held.has("Space")) bits |= MotorInput.Jump;
  if (held.has("ShiftLeft") || held.has("ShiftRight")) bits |= MotorInput.Sprint;
  if (held.has("KeyC")) bits |= MotorInput.Crouch;
  if (held.has("KeyZ")) bits |= MotorInput.Prone;
  return bits;
}

function resize(): void {
  const scale = devicePixelRatio || 1;
  canvas.width = Math.floor(innerWidth * scale);
  canvas.height = Math.floor(innerHeight * scale);
  context.setTransform(scale, 0, 0, scale, 0, 0);
}
addEventListener("resize", resize);
resize();

const RAPIER = await initRapier();
const transport = new WebSocketClientTransport(`ws://localhost:${PORT}`);
const client = new GameClient(RAPIER, createMotorWorld(RAPIER), terrain, transport);

let ticks = 0;

/**
 * Simulation is driven by a timer, NOT by requestAnimationFrame.
 *
 * Chrome suspends rAF entirely in a hidden tab — measured at 0 frames per
 * second, not merely reduced — so an rAF-driven client stops simulating the
 * moment it is backgrounded and then floods the server with a backlog when it
 * returns. A timer is still throttled in the background, but it keeps running.
 *
 * The backlog is capped rather than replayed: a client that missed a second of
 * simulation should accept the server's authority for that second, which the
 * reconciliation hard-snap already does, not fast-forward its own input.
 */
const MAX_CATCHUP_TICKS = 4;
let accumulator = 0;
let previousTick = performance.now();

function simulate(): void {
  const now = performance.now();
  accumulator += (now - previousTick) / 1000;
  previousTick = now;

  let budget = MAX_CATCHUP_TICKS;
  while (accumulator >= TICK_SECONDS && budget > 0) {
    client.predict(buttons(), yaw, pitch);
    accumulator -= TICK_SECONDS;
    ticks += 1;
    budget -= 1;
  }
  // Anything still owed is deliberately abandoned.
  if (accumulator > TICK_SECONDS) accumulator = 0;
}

setInterval(simulate, TICK_SECONDS * 1000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  // Returning from hidden: drop the backlog and let the server correct us.
  accumulator = 0;
  previousTick = performance.now();
  held.clear();
});

function drawPlayer(
  centreX: number,
  centreY: number,
  worldX: number,
  worldZ: number,
  facing: number,
  colour: string,
  label: string
): void {
  const x = centreX + worldX / METRES_PER_PIXEL / 10;
  const y = centreY + worldZ / METRES_PER_PIXEL / 10;
  context.fillStyle = colour;
  context.beginPath();
  context.arc(x, y, 9, 0, Math.PI * 2);
  context.fill();
  // Facing needle. Yaw 0 is -Z, which is up on this view.
  context.strokeStyle = colour;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x - Math.sin(facing) * 20, y - Math.cos(facing) * 20);
  context.stroke();
  context.fillStyle = "#9fb0c6";
  context.fillText(label, x + 13, y - 11);
}

let previousFrame = performance.now();

function frame(now: number): void {
  const delta = Math.min(0.1, (now - previousFrame) / 1000);
  previousFrame = now;
  client.interpolateRemotes(delta);

  const width = canvas.width / (devicePixelRatio || 1);
  const height = canvas.height / (devicePixelRatio || 1);
  context.fillStyle = "#0e1116";
  context.fillRect(0, 0, width, height);

  const local = client.localState;
  const centreX = width / 2 - (local ? local.position.x / METRES_PER_PIXEL / 10 : 0);
  const centreY = height / 2 - (local ? local.position.z / METRES_PER_PIXEL / 10 : 0);

  context.strokeStyle = "#1b2432";
  context.lineWidth = 1;
  for (let grid = -400; grid <= 400; grid += 20) {
    const gx = centreX + grid / METRES_PER_PIXEL / 10;
    const gy = centreY + grid / METRES_PER_PIXEL / 10;
    context.beginPath();
    context.moveTo(gx, 0);
    context.lineTo(gx, height);
    context.moveTo(0, gy);
    context.lineTo(width, gy);
    context.stroke();
  }

  for (const remote of client.remotePlayers) {
    drawPlayer(
      centreX,
      centreY,
      remote.position.x,
      remote.position.z,
      remote.yawRadians,
      "#e0705a",
      `#${remote.id}`
    );
  }
  if (local !== null) {
    drawPlayer(centreX, centreY, local.position.x, local.position.z, yaw, "#63c68a", "you");
  }

  if (local === null) {
    hud.textContent = transport.connected
      ? "connected, waiting for the server to seat us…"
      : `connecting to ws://localhost:${PORT}…`;
  } else {
    const speed = Math.hypot(local.velocity.x, local.velocity.z);
    hud.innerHTML =
      `<span class="live">player ${client.playerId}</span>  ` +
      `others ${[...client.remotePlayers].length}\n` +
      `pos    ${local.position.x.toFixed(1)} ${local.position.y.toFixed(1)} ${local.position.z.toFixed(1)}\n` +
      `speed  ${speed.toFixed(2)} m/s   ${local.stance}${local.grounded ? "" : " (air)"}\n` +
      `eye    ${eyeHeightFor(local, DEFAULT_MOTOR_TUNING).toFixed(2)} m\n` +
      `tick   ${ticks}\n` +
      `corr   ${client.corrections} (worst ${client.worstCorrectionMetres.toFixed(3)} m)\n` +
      `replay ${client.replayedCommands} commands`;
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Harness instrumentation. Lets a driver script step the client directly
// instead of waiting on the render loop, which is the only way to exercise this
// page from automation — a hidden tab gets no animation frames at all.
Object.assign(window, {
  __session: {
    client,
    step: (count: number, bits = 0, lookYaw = yaw) => {
      for (let index = 0; index < count; index += 1) client.predict(bits, lookYaw, 0);
      ticks += count;
      return client.localState;
    },
    get info() {
      return {
        playerId: client.playerId,
        state: client.localState,
        remotes: [...client.remotePlayers].map((remote) => ({
          id: remote.id,
          position: remote.state.position,
        })),
        corrections: client.corrections,
        worstCorrectionMetres: client.worstCorrectionMetres,
      };
    },
  },
});
