# Playing the build

How to run this and what is actually there to experience. Written for a person at a
keyboard rather than for someone about to change the code — the specs in [`docs/`](./docs)
are the other thing.

This is a reconstruction of **Delta Force 2** (NovaLogic, 1999), aimed squarely at the two
things that made it feel like nothing else: terrain that goes on forever with no edges, and
grass tall enough to disappear into. It is a hobby project. It is not a game yet, and the
sections below are honest about where that line falls.

## Run it

```shell
npm install
npm run dev
```

Then open **http://localhost:3000**. A WebGPU browser is best; it falls back to WebGL2 on
its own. The panel on the right tells you which one actually started — worth a glance before
you judge the frame rate next to it.

The first load decodes a real 1024×1024 map and takes a few seconds on a cold cache.

## Four things to open

Each is a different question the project is trying to answer.

| Open this | What it is for |
| --- | --- |
| `/` | **Look at the world.** Free flight over real DF-era terrain. |
| `/?scene=motor` | **Walk it.** A physically simulated body — gravity, slopes, stances. |
| `/?scene=scope&motor=1` | **Play it.** The above, carrying a rifle. |
| `/?scene=scope` | The weapon slice on the old camera rig, for comparison. |

### Look at the world — `/`

You are flying. Drag to look, `W`/`A`/`S`/`D` to move, `Q` and `E` for down and up, and the
mouse wheel changes how fast you fly. `G` puts you on the ground; `X`, `C` and `Z` switch
between standing, crouching and prone.

**Worth doing:** fly in one direction for a long time. The map never ends and never repeats
a visible seam — it tiles forever, the way the original did. Then press `G` and `Z` to lie
down in the grass, and notice how much of the world disappears.

This mode clamps your eye to the ground rather than simulating a body. It exists because
judging whether terrain and grass *look* right is easier when nothing is fighting you.

### Walk it — `/?scene=motor`

Now there is a real body underneath you: gravity, collision, slopes that slow you down,
stances that refuse to stand up when something is overhead.

| Key | |
| --- | --- |
| `W` `A` `S` `D` | move |
| `Shift` | sprint |
| `Space` | jump |
| `X` `C` `Z` | stand / crouch / prone |
| `V` | show the collision capsule from behind |
| drag | look |

**Worth doing:** press `V` and watch the green wireframe capsule while you crouch, go prone,
and climb. That capsule is the body the simulation actually uses — and the same code runs on
the server. Then walk up the steepest hill you can find. Speed falls away smoothly with
steepness instead of stopping dead: roughly 90% of walking pace on a gentle rise, about a
fifth of it on something near-vertical.

You can retune the feel from the address bar without rebuilding:

```
?scene=motor&climb=70&walk=6&jump=5&step=0.6
```

`climb` is the slope limit in degrees, `walk` and `jump` are speeds in metres per second,
`step` is how high a ledge you can step onto.

### Play it — `/?scene=scope&motor=1`

The rifle, carried by the body. Click the canvas once to capture the mouse — **that first
click does not fire**. `Escape` releases it.

| Input | |
| --- | --- |
| left mouse | fire |
| right mouse | aim down sights |
| `Shift` while aiming | hold breath |
| `R` | reload |
| `1` `2` `3` `4` | sniper / M4 / Glock / SAW |
| `B` | cycle fire mode |
| `,` `.` while aiming | zoom in / out |
| `X` `C` `Z` | stand / crouch / prone |
| `Space` | jump |
| `V` | third-person collision capsule |
| arrow keys | scope zero and windage |
| `T` | reset targets |

**Worth doing:** shoot the same target standing, then crouched, then prone, then while
walking, then in mid-air. Every one of those changes where the round goes, and they are all
resolved from the body rather than guessed from the camera. Then try to fire while sprinting
— you cannot, deliberately, because there is no animation for it.

Add `&targets=1` for something to shoot at, and `&shotdebug=1` to draw the sightline, the
bore line and the curved path the bullet actually takes. The full list of diagnostic
switches is in [`docs/10`](./docs/10-fps-combat-implementation-spec.md#7-controls-and-diagnostic-urls).

## Two players

There is a working authoritative server. It is deliberately crude — it exists to prove the
simulation and the network agree, not to be a game mode.

```shell
npm run session:server   # the authoritative room
npm run session:client   # the harness
```

Open **http://localhost:3100** in **two separate windows, both visible**. Not two tabs in
one window: a hidden tab gets no animation frames at all, so a background tab renders
nothing.

You will see a top-down view with a dot for each player. That plainness is intentional — if
two windows show each other moving smoothly there, the movement and the networking are
right, and anything still wrong is drawing. Putting the real renderer here would make a
network fault and a rendering fault look identical.

### See each other — `/?scene=scope&motor=1&net=1`

```shell
npm run game:server
```

Run that in a second terminal (it simulates the real map on an authoritative server), then
open the URL above in **two separate windows** — windows, not tabs, because a hidden tab
gets zero animation frames and its player freezes. Each window is a player in the same
match: the other appears as an animated soldier that walks, runs, strafes, crouches, jumps
and aims where its player is looking. `V` shows your own body in third person, standing
inside its wireframe collision capsule. A prone player deliberately shows as the low
capsule instead of the soldier — the animation set has no prone clips yet, and an honest
low silhouette beats a kneeling one that betrays your concealment.

### Shoot each other

Same setup as above — and yes, the rounds are real now. What hits, how hard, and who
falls is decided **on the server**, with the same ballistics you see locally: bullets
take time to fly, drop with distance, drift in the wind, lose energy, and will go
through one body into the one behind it if the round is heavy enough. Your health is
the number the server says; when it reaches zero you stop being shootable and respawn
a few seconds later with full kit.

**Worth doing:** go prone in deep grass, let your friend hunt you, and put one .308
round through them when they walk past — that ambush is the whole thesis of this
project in one moment. Then swap and try to spot the muzzle of someone you cannot see.

Up close, aim right at them — inside roughly a hundred metres the server honours what
was on your screen when you pulled the trigger, so a fast peek fight feels fair even
with some latency. At range you are flying a real projectile: **lead a moving target
and hold over for drop**, exactly as offline. The numbers — per-weapon damage, drop,
full-damage ranges, what penetrates what — are in the
[combat handbook](./docs/guides/combat-handbook.md).

Two honest caveats. Ammunition, reload timing and fire rate are enforced by the server
(an empty magazine online is genuinely empty), and the `?ammo=` / wind URL experiments
are ignored online so both players fight under the same physics. And you cannot yet
*see* the other player shooting — no tracer, no muzzle flash, no crack from their
rifle. Their hits on you are real; the theatre of it is still to come.

## FAQ

- **Can we shoot each other?** Yes. PvP damage is server-authoritative: the claim your
  browser sends is only "I fired, this way" — the server runs the ballistics and moves
  the health. See the [combat handbook](./docs/guides/combat-handbook.md) for how hit
  registration, damage falloff, and penetration behave in play.
- **I shot them and nothing happened.** In order of likelihood: they were further away
  than they looked and the round dropped under them (hold over); they were moving and
  you did not lead; the round was still in the air when you looked away — at 600 m a
  .308 takes the best part of a second; or your magazine was empty and the server
  refused the shot. Dead players are also not shootable while they wait to respawn.
- **I killed a *practice target* and the other window didn't notice.** Practice targets
  (`&targets=1`) are still local to each browser — only players have a server owner so
  far. World-object authority is queued work.
- **We see different weather.** You should not anymore: networked, the room owns the
  weather and every visual dial, precisely because fog is concealment and two players
  under different fog is a fairness bug. If two windows genuinely disagree, that is a
  bug worth reporting.
- **The other soldier looks flat or too dark in fog.** The soldier is a lit model in a
  world of pre-shaded terrain, and the atmosphere term for lit materials does not exist
  yet (docs/08 knows). He pops through haze more than he should.
- **Multiplayer over the internet?** Untested; everything so far is localhost/LAN
  (`&server=ws://host:2567` points a client elsewhere).

## What is not here yet

Being clear about this is more useful than a feature list.

- **Nobody dies on screen.** Health falls, the kill is real, the victim respawns — but
  there is no death animation, no kill feed, no score. The death clips exist and wait
  on presentation work.
- **You cannot see or hear the other player's fire.** No remote tracers, muzzle flash,
  or gunshot audio yet; only the consequences replicate.
- **There are no opponents.** No AI, no bots, nothing that shoots back on its own.
- **Grass concealment is not a mechanic yet.** Grass genuinely hides you from a human
  looking at a screen — a prone player measures zero visible pixels even through a scope at
  300 m — but nothing in the game *knows* that, so nothing can act on it. (Against another
  human online, it already works the honest way: they simply cannot see you.)
- **Every weapon uses the same placeholder model,** clearly labelled as a proxy.
- **Prone has no animation** (capsule stand-in).
- **No objectives, match flow, menu or settings screen.**

## If something looks wrong

- **Frame rate is poor.** Check the backend line in the right-hand panel. WebGL2 is the
  fallback path and is slower. Grass is the expensive thing; `?grass=0` will tell you
  quickly whether it is the cause.
- **The terrain panel says "stand-in (not real)".** That is honest labelling, not a fault.
  The shipped map's real grass data was never published, so the canopy's placement is
  invented. Terrain, colours and water are genuinely Green Mile.
- **A dark band along the horizon at eye height.** A known terrain artifact, diagnosed in
  [`docs/07`](./docs/07-grass-visual-reference.md) §9. It is terrain, not grass.
- **Nothing happens when you click in the weapon scene.** The first click only captures the
  mouse. Click again.
