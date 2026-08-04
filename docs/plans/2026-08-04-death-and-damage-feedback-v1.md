# Death, damage and kill feedback

**Date:** 2026-08-04
**Status:** planned, not started
**Related:** `docs/12-character-motor-and-networking-spec.md` §8 wire format, `docs/10-fps-combat-implementation-spec.md` §2 ownership, `docs/plans/2026-08-03-character-animation-session-handoff.md`

## Objective

Make a kill legible. Server-authoritative damage already works and is measured: a two-window
playtest recorded 17 hits across 23 resolved fire claims with zero rejected, zero discarded and
zero malformed packets. Nothing on screen reported any of it, so a landed kill and a total miss
looked identical, which is what made the system appear broken.

This plan adds the feedback layer and nothing else. No change to how damage is decided, who
decides it, or the rewind that decides it. The work is: carry the facts the server already
knows at the resolution site out to the clients that need them, then present those facts as a
death animation, a kill feed, a death screen, a damage indicator and a hitmarker.

Five absences are being closed. The victim has no damage indicator and no death screen. The
killer has no hitmarker and no kill confirmation. Bystanders see no death animation, because the
six death clips in the soldier GLB have never been referenced. Everyone respawns at a fixed
point six metres from the origin, so death is invisible even when it happens. And the HUD panel
intended for kill and join messages renders hardcoded mockup text behind a preview flag.

Decisions already taken with the user and treated as settled: respawn delay derives from the
death clip's own length plus a configured pause; one clip serves both left and right deaths;
callsigns go on the game wire so the feed reads properly; the damage indicator is directional
and tunable later, with audio treated as a first-class channel. Muzzle flash origin is
explicitly deferred until weapon models carry a muzzle bone.

## Implementation Plan

- [ ] 1. Carry local health to the HUD through the client seam, closing the gap that made this
  session's playtest unreadable. `src/net/GameClient.ts:132` already holds a health field
  assigned only from snapshots, and `src/hud/GameHud.tsx` already takes health as a prop, but
  `src/game/GameApp.tsx:151` passes null because the merge never completed the one call site
  that commit `faab73f` named. Follow the pattern `src/fps/useRoomVisuals.ts` establishes:
  GameClient gains a subscribe and getSnapshot pair beside the two it already exposes for room
  state and world targets, a hook under `src/fps/` adapts it with the external-store hook, and
  DF2Scene reports it upward the way it already reports room info at `src/df2/DF2Scene.tsx:424`.
  Do not reintroduce a health field on the player state report type: that shape was deliberately
  reverted and the reasoning is recorded in the commit message.

- [ ] 2. Put full health on the welcome packet so the HUD can render a fraction without
  inventing a denominator. Player maximum health is currently a server-side constant at
  `src/net/GameServer.ts:195` and never reaches the client, while world targets already carry
  theirs through the snapshot. Welcome is sent once per join and is the natural home for a
  per-room constant, which avoids both a shared magic number and a per-player per-tick byte.
  Update the welcome encoder and decoder in `src/net/SnapshotCodec.ts:260` together with their
  round-trip test.

- [ ] 3. Move the character clip vocabulary to a home the authority can import, following the
  precedent `docs/12-character-motor-and-networking-spec.md` §3 records for the ballistic core.
  `src/fps/presentation/characterClips.ts` is already pure and free of Three.js, but the server
  needs the death clip durations to derive a respawn delay, and the established answer when the
  authority needs something from the FPS slice is to relocate it rather than to import across
  the layer. Preserve every existing export so the animator and its tests are unaffected.

- [ ] 4. Add the death clip table to that shared module: the six clip names from
  `assets/3d/characters/player1/SpecialForcesSoldier_animations.txt`, their durations, and a
  pure selector mapping a death direction sector and a headshot flag to a clip name. Per the
  user's decision the right-side clip serves left-side deaths, so the selector collapses both
  lateral sectors onto it. Mirror the existing eight-way sectoring approach so the arithmetic
  stays testable in bare Node, and extend the startup validation list so a missing or renamed
  clip fails loudly at load rather than silently falling back.

- [ ] 5. Extend the wire with a roster packet carrying player identity, so the feed can name
  people. The game protocol is numeric today, which is why the HUD prints a player number at
  `src/hud/GameHud.tsx:156`; callsigns exist in the account layer and never cross into the game.
  Send the full roster on join and an incremental entry on each join and leave, following the
  low-frequency, send-on-change discipline `docs/12-character-motor-and-networking-spec.md` §8.1
  sets out for room state. This packet is also what produces the joined and left feed lines.

- [ ] 6. Extend the wire with a death broadcast carrying victim, killer, weapon, death direction
  sector, headshot flag and the seconds until respawn. Broadcast rather than targeted, because
  bystanders need it to play the death animation and the feed needs it to print a line. Pattern
  it on the accepted-shot relay already at `src/net/SnapshotCodec.ts` packet type nine, which is
  the closest existing analogue for a presentation-only down packet.

- [ ] 7. Extend the wire with two small targeted packets: a hit confirmation to the shooter
  carrying the claim sequence, the victim and whether the hit was fatal, and a damage
  notification to the victim carrying the attacker, the bearing of the incoming round relative
  to the victim's own facing, and the amount. Two packets rather than one shared shape, because
  the audiences differ and a single packet risks telling a shooter something only the victim
  should know. Keep both strictly presentational, as the shot relay comment already insists:
  damage arrives as health in a snapshot, never as a claim in an effect packet.

- [ ] 8. Emit those three events from the server's existing resolution site. Everything needed is
  already in hand where damage is applied around `src/net/GameServer.ts:616` and
  `src/net/GameServer.ts:584`: the shooter, the victim, the weapon, the direction the round was
  travelling and the victim's own yaw. Compute the death sector from the round's bearing against
  the victim's facing, using the yaw convention owned by the look direction helper in
  `src/motor/MotorTypes.ts` so the animation faces the way the shot came from. Leave the
  headshot flag wired but always false until a head zone exists on the capsule; do not invent
  one here.

- [ ] 9. Derive the respawn delay from the death clip rather than a flat constant, per the
  user's decision. `src/net/GameServer.ts:589` currently schedules respawn a fixed three seconds
  after death, while four of the six death clips run longer than that, so a body would pop away
  mid-fall. Look the duration up from the shared table added earlier, add a configured pause,
  and send the resulting seconds on the death broadcast so the client's counter and the server's
  schedule cannot disagree.

- [ ] 10. Feed callsigns into the room so the roster packet has something to send. The account
  behind a session is already resolved in the static room authentication hook in
  `tools/game-server/server.ts` and recorded per session, so the callsign can be read at join
  and handed to the game server through its existing options seam. Anonymous joiners keep a
  numeric fallback name, because authentication is optional by design and every documented
  development URL must keep working.

- [ ] 11. Decode the new packets on the client and expose them the way the existing ones are
  exposed. `src/net/GameClient.ts` should keep its own React-free and Three-free discipline and
  offer subscribe and getSnapshot pairs for the roster and for a short bounded queue of feed and
  damage events. A queue rather than a single latest value, because two kills in the same tick
  must both appear in the feed; bound it so a client that never drains cannot grow without limit.

- [ ] 12. Play the death animation on every client. `src/fps/presentation/CharacterAnimator.ts`
  already has a one-shot path at line 202 that sets loop-once and clamps the final pose, which
  is exactly what a death needs, so this is clip selection rather than new playback machinery.
  Trigger from the death broadcast, hold the final pose until the victim respawns, and make sure
  the locomotion selector cannot steal the action back while the body is down. Reproduce the
  respawn snap the user observed and confirm it is gone.

- [ ] 13. Turn the mockup chat panel into a real event feed. `src/hud/GameHud.tsx:126` renders
  hardcoded lines behind the preview flag, styled at `src/hud/hud.css:215` with colour classes
  for message kinds already in place from the reference mockup. Drive it from the client's feed
  queue, print kills as killer, victim and weapon, print joins and leaves, expire lines after a
  few seconds, and drop the preview gate so it renders whenever there is something real to say.
  This satisfies the honesty rule the panel's own comment states rather than working around it.

- [ ] 14. Add the death overlay: who killed you and how long until you respawn. Read the killer
  from the death broadcast and count down from the seconds it carries. Render it as a HUD panel
  on the existing phosphor skin rather than a full-screen takeover, so a dead player can still
  read the field they are about to respawn into. Keep it strictly driven by server facts, with
  no client-side guess at the countdown.

- [ ] 15. Add the directional damage indicator and the hitmarker. The victim's indicator takes
  its bearing from the damage packet and its intensity from the amount, following the
  instinct-over-cognition principle from the referenced user-experience analysis: magnitude
  should read without parsing. Keep the direction coarse and tunable behind one constant, and
  record in the design notes that precision here is a concealment decision rather than a styling
  one, since telling a victim exactly where a sniper is undoes what the grass and the fog just
  earned. Structure the treatment so a later post-processing pass can add desaturation, vignette
  and blur at low health without reworking the indicator.

- [ ] 16. Add the audio channel for both events, following the pooled positional pattern the
  remote fire effects already use around `src/fps/RemoteFireEffects.tsx:223`. A hit cue for the
  shooter and a directional impact cue for the victim. Note that the existing remote report pool
  duplicates the impact pool, which was a deliberate earlier skip; do not add a third copy —
  reuse or consolidate.

- [ ] 17. Spread the respawn points so death is visible even without the animation. The default
  spawn at `src/net/GameServer.ts:1134` places each seat at a fixed angle on a six-metre ring, so
  a player reappears essentially where they died. Either scatter within a larger ring or pick the
  candidate furthest from a living enemy, and let the game server pass its own spawn function
  through the options seam it already has rather than hardcoding placement in the shared server.

- [ ] 18. Update the specifications to match. `docs/12-character-motor-and-networking-spec.md` §8
  gains the four new packets and the welcome change; its §2 module map gains any relocated
  module; `docs/10-fps-combat-implementation-spec.md` §2 gains the feedback ownership rows. Record
  the concealment argument behind the indicator's vagueness where a future session will find it,
  and note the headshot flag as wired but unfed.

## Verification Criteria

- Two windows, one kills the other: the victim sees a directional damage indicator, then a death
  overlay naming the killer with a counter that reaches zero as they respawn.
- The killer sees a hitmarker on each damaging hit and a distinct confirmation on the fatal one.
- A bystander in a third window sees the victim play a death animation whose facing matches the
  side the shot came from, hold its final pose, and disappear only at respawn.
- The event feed prints a kill line naming both players by callsign, and prints join and leave
  lines as windows connect and disconnect.
- The respawn counter and the actual respawn agree within one patch interval, and no death clip
  is cut off mid-play.
- The player respawns somewhere visibly different from where they died.
- The health bar reads a real percentage that falls as damage lands and returns to full on
  respawn, in both windows.
- Server telemetry still shows claims resolving and hitting at the rate it did before, proving the
  feedback layer changed no gameplay outcome.
- Bare-Node tests still load every module under the shared directories, so nothing pulled Three.js
  or React across the authority boundary.
- The full gate passes: typecheck across both project configurations, the whole test suite, and a
  clean production build.

## Potential Risks and Mitigations

1. **Wire changes ripple further than expected.** The specification warns that the snapshot layout
   is load-bearing and that a mis-sized field fails silently rather than loudly, citing the input
   bitfield that outgrew a byte and simply dropped inputs.
   Mitigation: add each packet as its own type rather than widening the per-player snapshot, keep
   the per-tick layout untouched, and round-trip every new packet in the codec tests the way the
   existing bitfield test does.

2. **The death animation and the authority disagree about when a player is dead.** The client
   holds a final pose while the server has already respawned, or the reverse, leaving a corpse
   standing or a live player face-down.
   Mitigation: treat the snapshot's health as the only truth for aliveness, use the broadcast
   purely to choose and start the clip, and derive the respawn schedule and the counter from a
   single server-sent duration.

3. **A directional indicator undoes concealment.** Precise direction hands a victim the sniper's
   position, which is exactly what the grass, the fog and the range are designed to withhold.
   Mitigation: keep the direction coarse behind one tunable constant, treat it as a gameplay
   decision rather than a styling one, record the reasoning in the specification, and revisit it
   with the pillar test rather than with a user-experience argument alone.

4. **Relocating the clip vocabulary breaks the animator or its tests.** The module is currently
   imported by presentation code and pinned by tests that assert clip names.
   Mitigation: move the file without changing any export signature, let the typecheck enumerate
   every call site, and treat the existing tests as the regression net rather than writing new
   ones for unchanged behaviour.

5. **Callsigns on the wire become a trust or privacy question.** A name is user-controlled text
   arriving from another player and rendered in everyone's HUD.
   Mitigation: send the server's stored callsign rather than anything the client claims, rely on
   the existing callsign validation that already bars control characters and homoglyph
   impersonation, and render the feed as text, never as markup.

6. **The feed becomes a spam surface.** Rapid joins, leaves or kills could flood the panel or grow
   an unbounded client queue.
   Mitigation: bound the queue at the client, expire lines on a timer, and cap how many render at
   once, mirroring the bounded pools the remote fire effects already use.

7. **Work lands on top of an already crowded tree.** Twenty-three files from the pre-merge review
   are uncommitted, and this plan touches the wire, the animator and the HUD.
   Mitigation: commit the review fixes as their own atomic commits before starting, and keep each
   task above to a single concern so the history stays reviewable.

## Alternative Approaches

1. Derive everything client-side from the health field already in the snapshot: infer death from
   health reaching zero, and skip the death and damage packets entirely. Cheapest possible change
   and no wire risk, but it cannot produce a direction for either the animation or the indicator,
   cannot name a killer, and cannot distinguish a headshot — so it buys a death animation facing
   an arbitrary way and no feed at all.

2. Fold every event into one general-purpose combat event packet with a kind discriminator, rather
   than four narrow ones. Fewer packet types and one decode path, at the cost of a shape whose
   fields are meaningful only for some kinds, and a real risk of sending a shooter a payload that
   only the victim should see — the exact leak the two-audience split exists to prevent.

3. Put the kill feed on the account and statistics layer over HTTP rather than on the game wire,
   reusing the telemetry tables. Attractive because it also feeds the career statistics that
   currently have no writer, but it puts a network round trip and a database write between a kill
   and the line describing it, which is far too slow for combat feedback. Worth doing later as a
   separate consumer of the same server-side event, which the plan's shape leaves open.

4. Take the death animations from a state machine driven purely by the snapshot, adding a death
   state and direction to the per-player payload rather than sending an event. Keeps everything in
   one packet and survives packet loss, since a late joiner still sees the current state, but it
   spends per-tick bytes forever on a fact that matters for a few seconds, and the specification's
   own argument against periodic rebroadcast of room state applies with equal force.
