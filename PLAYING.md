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

## What is not here yet

Being clear about this is more useful than a feature list.

- **You cannot see another player in the game world.** The multiplayer session and the game
  are still separate programs; remote players exist as dots in the harness above, not as
  bodies in the world.
- **There are no opponents.** No AI, no bots, nothing that shoots back.
- **Grass concealment is not a mechanic yet.** Grass genuinely hides you from a human
  looking at a screen — a prone player measures zero visible pixels even through a scope at
  300 m — but nothing in the game *knows* that, so nothing can act on it.
- **Every weapon uses the same placeholder model,** clearly labelled as a proxy.
- **There is no character to look at.** The third-person view shows a wireframe capsule,
  which is the collision shape, not a person.
- **No objectives, score, match, menu or settings screen.**

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
