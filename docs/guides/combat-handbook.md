# Combat handbook

How the guns actually behave — written for a person holding one, not for someone
changing the code. The engineering truth lives in
[`docs/11`](../11-weapon-ballistics-and-modifier-system-spec.md) (ballistics) and
[`docs/12`](../12-character-motor-and-networking-spec.md) (networking); how to get
into a match at all is [`PLAYING.md`](../../PLAYING.md). Every number here is
current tuning, not a promise — the ammunition table is explicitly provisional.

## The armoury

Four weapons, selected with `1`–`4`. One placeholder model stands in for all of
them; the *behaviour* is per weapon and real.

| Key | Weapon | Round | Damage | Magazine | Rate | Fire modes | Reload |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: |
| `1` | Sniper | .308 Win 175 gr | 100 | 5 + 20 | 48 rpm | semi | 4.2 s |
| `2` | M4 | 5.56×45 62 gr | 68 | 30 + 120 | 600 rpm | semi, 3-burst | 4.2 s |
| `3` | Glock | 9×19 124 gr | 42 | 17 + 68 | 400 rpm | semi | 4.2 s |
| `4` | SAW | 5.56×45 62 gr | 68 | 100 + 200 | 900 rpm | auto, semi | 4.2 s |

Everyone has 100 health. So: the sniper is a one-shot kill out to its full-damage
range, the 5.56 weapons need two good hits, the pistol three. Switching weapons
takes 0.35 seconds, and online the server keeps its own count of your magazine —
an empty gun is empty no matter what your client claims.

## How bullets fly

Rounds are simulated projectiles, not instant rays. Three things follow from that
and they are most of what there is to learn:

**They take time to arrive.** A .308 needs about **0.4 s to cover 300 m** and
almost a full second for 600 m. A walking soldier crosses more than a body width
in that time — **lead moving targets**, more the further they are.

**They drop.** Approximate hold-over above the target, aiming flat:

| Round | 100 m | 300 m | 600 m |
| --- | ---: | ---: | ---: |
| 9mm | 0.5 m | — out of its depth — | |
| 5.56 | 0.06 m | 0.7 m | 4.4 m |
| .308 | 0.08 m | 0.9 m | 4.6 m |
| .50 BMG | 0.06 m | 0.8 m | 3.6 m |

Or stop holding over and **zero the scope**: while aiming, the up/down arrows set
an elevation zero (100–1,300 m presets, filtered to what the round can actually
reach) and left/right arrows click windage in 0.1 mrad steps. `0` resets both.

**They slow down, and damage follows energy.** Every round does its full listed
damage until it has lost enough energy, then damage falls off smoothly to a floor
of 10%:

| Round | Full damage within | What that means |
| --- | ---: | --- |
| 9mm | ~70 m | a close-quarters tool, honestly |
| 5.56 | ~155 m | rifle fights at village range |
| .308 | ~220 m | one-shot kills end near here; still hits hard far beyond |
| .50 BMG | ~275 m | remains lethal to roughly a kilometre |

There is also a steady crosswind (about 4 m/s by default) that pushes long shots
sideways — the drift is small inside 200 m and very real at 600.

## Hitting things

Your hitbox — and theirs — is the same capsule the movement simulation uses,
sized by stance. Press `V` to see your own. There are no headshot multipliers
yet: a hit is a hit, anywhere on the body.

Accuracy is mostly about what your body is doing. Standing still beats moving,
crouching beats standing, prone beats everything; jumping is a prayer. Aiming
down sights removes hip spread, and holding `Shift` while aimed steadies your
breath for the moment that matters. Sustained fire blooms; short pauses recover.
You cannot fire while sprinting, deliberately.

## Penetration — concealment is not cover

Rounds carry their energy through materials and keep going if enough survives.
Two consequences worth internalising:

- **Bodies are not walls.** A 9mm or 5.56 round stops inside the first person it
  hits square-on. A .308 goes through and comes out dangerous. A .50 BMG barely
  notices — it will drop the person you aimed at *and* wound the one standing
  behind them.
- **Grass stops nothing. Terrain stops everything.** Lying in deep grass makes
  you close to invisible, but a round fired at your patch of grass still arrives.
  Real dirt between you and the shooter is the only thing that actually protects
  you. Hide accordingly — hull-down behind a fold of ground beats flat in the
  open grass, and the combination is what made the original game's fights.

One round interacts with at most a handful of surfaces before it is spent, and
there are no ricochets — what does not penetrate, stops.

## Online: who decides, and how it feels

In a networked match the server owns the fight. Your client sends only "I fired,
in this direction, at what I was seeing" — the server fires the round itself,
with its own copy of your position, your weapon, your magazine and everyone
else's bodies. Health only ever moves on the server; your screen is told.

It is tuned to feel fair on both ends of the barrel:

- **Up close** (inside roughly 80–90 m for rifles, ~35 m for the pistol), the
  server rewinds the world to what *you* were seeing when you pulled the trigger
  — up to a quarter second — so a snap shot at a peeking enemy lands where your
  screen said they were. Aim at them, not ahead of them.
- **At range**, the round genuinely flies: drop, wind, energy loss, flight time,
  against targets where they *are*. Latency stops mattering much because the
  flight time dwarfs it — lead and hold over, exactly as offline.

The server also enforces the boring rules: fire rate, magazine, reload and
weapon-switch timing all run on its clocks, and duplicate or impossible claims
are dropped silently. The `?ammo=` and wind URL experiments from offline play are
ignored online, and the room decides the weather for everyone — fog is
concealment here, so nobody gets a clearer sky than their opponent.

What is missing online today, so it is not mistaken for a bug: you cannot see or
hear the other player's shots (no tracers, flash, or report — only the hits are
real), nobody plays a death animation, and the practice targets are still local
to each browser. The current honesty list lives in
[`PLAYING.md`](../../PLAYING.md#what-is-not-here-yet).
