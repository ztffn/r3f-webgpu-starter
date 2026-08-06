# Handover: server-authoritative combat, weather, and the missing animations

**Status:** handoff brief for the next session. PR #9 (animated soldier on the motor and
netcode) is merged; main is the working base. Written 2026-08-03.

## State

- Main carries: Colyseus adoption (PR #8), and the character layer (PR #9): soldier GLB
  assets, `characterClips`/`CharacterAnimator`/`CharacterView` under `src/fps/presentation/`,
  remotes as animated soldiers with a capsule fallback, aim rig mounted on wire pitch,
  ADS mirror on the snapshot flags byte, collapsible HUD panels.
- Gate: 129 Node tests, typecheck, build — green at merge. Two QA passes ran on-branch
  (4-angle simplify; 27-agent xhigh review, 12/13 findings fixed).
- Run: `npm run game:server` (Colyseus :2567, real gmile terrain) + `npm run dev`;
  `?scene=scope&motor=1&net=1` per window; V = third person. Two visible windows, never
  tabs (hidden tabs get zero frames — docs/12 §6).
- Human-verified: movement, stances, remote soldiers, aim pose. NOT yet human-verified in
  motion: the review's landing/phase-carry/hysteresis fixes (logic-verified only).
- Working-tree note: the user locally deleted `docs/df2-scale.webp`,
  `docs/df2_grass_1..6.*`, `docs/df2_hud_moderncomparison.jpg` (uncommitted deletions on
  main). Resolve with them before committing doc work.

## Inserted 2026-08-03: admin visual dials — DONE

Not one of the four below; added by the user during the weather-authority session. All 25
live dials can now be driven room-wide by an admin (`DF2_ADMIN=1` on the server), on top of
the replicated preset — both on ONE `RoomState` packet. Measured as not perf-gated: no dial
allocates, and the only two that move a drawn count are bounded by per-client pools
allocated at load. Rules and traps are `docs/12-...md` §8.1-8.2. Sequencing was the user's
call: this went ahead of items 3 and 4.

## The four work items, in the user's own priority order

### 1. Weather and fog are not server-authoritative — DONE 2026-08-03

Landed, with one approved divergence from the direction below: it rides the **codec** as
`PacketType.RoomState` owned by `GameServer`, not Colyseus Schema. Reasons and the traps it
is shaped around are recorded in `docs/12-...md` §8.1; the short version is that weather has
a gameplay consumer coming (fog is concealment), so it belongs with the simulation rather
than in the room shell, and a packet is reachable by the Node loopback suite while Schema is
not. Server picks it with `DF2_WEATHER=<id>|random|rotate`. Original direction below, kept
as the record.


Weather is per-client state: `readWeather(window.location.search)` in `DF2Scene`
(`src/df2/weather.ts`), switchable live from the debug panel. Two clients in one match can
see different fog ranges and grades — a fairness problem, since fog IS concealment here.
Direction: the server (GameRoom in `tools/game-server/server.ts`) picks the preset per
room and replicates it. This is lobby-scope, low-frequency state — exactly what the
Colyseus adoption record (docs/plans/2026-08-03-colyseus-transport-evaluation.md §5)
reserved Schema/room metadata for; do NOT put it on the 60 Hz binary path. Client side:
`DF2Scene` already supports live preset switching (`setWeather` state), so replication is
a matter of feeding that setter from the room instead of the URL when `?net=1`.
Related: the soldier still bypasses `atmosphere.shade` (lit GLB — the one deliberately
deferred review finding). Weather-auth and that fog gap together decide whether weather
concealment is real; docs/08 §8 invariant 7 and its known-open post-lighting variant are
the relevant spec.

### 2. Missing animations (prone, deaths, turn-in-place)

- **Prone is BLOCKED ON SOURCE CLIPS** (confirmed 2026-08-03 against the 49-clip manifest:
  6 deaths, turn-in-place, crouch and sprint sets, nothing prone). Nothing can be baked
  until prone source animation is bought or authored, so this item was deliberately skipped
  and items 3+4 taken instead. The prone capsule special case in `RemotePlayers.tsx` stands.
- **Prone is the priority** — prone-and-snipe is the game's core pillar (docs/00), and
  today a prone remote renders as the stance-scaled capsule (honest silhouette, ugly).
  The pack has no prone clips; the bake path is the runbook §4 world-space retarget
  (`assets/3d/characters/player1/SpecialForcesSoldier_Pipeline_Runbook.md`) — needs prone
  source clips (buy/author), then extend `characterClips.ts` (drop the crouch fallback)
  and delete the prone-capsule special case in `RemotePlayers.tsx`.
- **Deaths**: 6 death clips ship in the GLB. `CharacterAnimator`'s hips pin must be
  EXEMPTED during death clips (their hips translation is the animation — harness lesson,
  `assets/3d/animations/index.html`). Blocked on item 3 for the trigger (no damage on
  remotes yet).
- **Turn-in-place**: clips ship; the harness documents the trap — the clip bakes 90° of
  hips yaw, and the model root must bank that yaw in lockstep as the clip ends or the
  character over-rotates. Polish, do last.

### 3. Player-vs-player damage (server-authoritative shooting)

Today ballistics run entirely client-side (`WeaponPrototype` → `FiringTimeline` →
`CompositeWorldQuery`); nothing reaches the server, so remotes cannot be hit. Hard
constraints from the specs: bullets NEVER become Rapier bodies and hits are never resolved
by reading bones (docs/10 §10, docs/11 §11). Remotes therefore need either registration
as simplified colliders in the server-side world query, or a dedicated server hit path
against the motor capsules. The measured two-representation disagreement and its tolerance
(docs/plans/2026-08-02-motor-measurements.md §7.5) is the accuracy budget for that choice.
Wire-wise: fire events go up (command stream or a second message type), damage/death come
back in snapshots or events. `MotorState.aiming` is an intent mirror, not weapon truth
(docs/12 §5 invariant 8) — server-side weapon simulation is what makes damage authoritative.

### 4. Destructible/target state is not replicated

`TestTargets` health lives in client-local `HealthDamageable`; killing a target in one
browser does nothing in the other. Same authority root cause as item 3: world-object
state needs a server owner and replication. Suggest folding into item 3's design rather
than solving separately — a target is just a damageable the server owns.

## Standing constraints (unchanged)

Ask before ANY git command. Atomic typed commits, no trailers. TSL only, never raw
WGSL/GLSL. Visual terrain/grass are never collision. Node >= 22.9 with
`--experimental-strip-types`; no TS parameter properties. Keybinds by keycap, not
event.code position (Norwegian keyboard). Read docs/08 before touching render code,
docs/12 before motor/netcode, docs/10+11 before weapon code. The catch-up spiral
(docs/12 §11) and scale calibration remain open. `_tempAssets/` and the raw character
sources are local-only by design.

## Start

1. `npm test && npm run typecheck && npm run build` — expect 129 passing.
2. Two-window session; jump and circle-strafe to human-verify the landing/phase fixes.
3. Item 1 (weather auth) is the smallest self-contained slice and exercises the Schema
   /metadata half of Colyseus for the first time — good warm-up before item 3's
   authority work.
