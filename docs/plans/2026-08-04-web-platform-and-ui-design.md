# Web platform, onboarding and UI redesign — design record

**Date:** 2026-08-04
**Status:** decided, phase 1 in progress
**Supersedes for this scope:** `01-...md` §2's blanket "do not build the session framework".
That prohibition was correct while the transport was disposable scaffolding. Colyseus is now
adopted (`plans/2026-08-03-colyseus-transport-evaluation.md`), so the framework question it
was waiting on is answered and the layer above it is in scope. Movement authority,
prediction and reconciliation are unchanged by anything here.

---

## 1. What this covers

One web product around the existing game: a public front door, an account a player can
keep, a way to find or host a match, and an in-game HUD that looks designed rather than
instrumented. Nine surfaces:

| Surface | What it is |
| --- | --- |
| Landing | The pitch. Anonymous visitor to "playing" in one click |
| FAQ | What this is, what it is not, legal posture, hardware honesty |
| Sign-in / register | Anonymous, email + password, Discord OAuth |
| Profile | Identity, medals, stats, platform sessions |
| Character | Loadout and appearance, unlock-gated |
| Lobby | Quick match, and where a match is being joined from |
| Servers | Public browser, private game by code, community-hosted servers |
| Supporter | Membership tiers and the community perks behind them |
| In-game HUD | The tactical display, redesigned from `design/df2-hud-1to1-html-v3` |

## 2. Decisions

### 2.1 Brand: **Distant Front**

Every public string uses it. Chosen over "Delta Force 2 Web" for two reasons that agree:
the landing mockup already commits to it, and it keeps someone else's trademark off a page
that will eventually have a checkout button on it. `01-...md` §3's posture is unchanged —
the docs stay honest that this is a reconstruction, and the *product* does not borrow the
name. `index.html`'s title and meta change with this.

The docs and directory names keep saying DF2. That is deliberate: they describe what the
code reconstructs, and renaming `docs/` would break every cross-reference for no gain.

### 2.2 Accounts: `@colyseus/auth`, and **not** `@colyseus/database`

`@colyseus/auth@0.17.9` is adopted. It is on the same 0.17 line as the rest of the project,
and the client half needs no new dependency at all — `@colyseus/sdk` already ships
`client.auth` with `signInAnonymously`, `signInWithEmailAndPassword`,
`registerWithEmailAndPassword`, `signInWithProvider`, `sendPasswordResetEmail`, `onChange`
and `signOut`. Verified against the installed typings, not the docs.

**`@colyseus/database@0.0.13` is rejected**, and this is a deviation from the chosen option
worth stating plainly. Four disqualifying facts, all checked against the published package:

1. Its `package.json` declares `"types": "lib/index.d.js"` — a `.d.js` that does not exist.
   TypeScript cannot resolve the package's types at all, and this repo builds with
   `tsc --noEmit` under `strict`.
2. `peerDependencies` pins `@colyseus/core: ^0.15.0`. This project is on 0.17.
3. It peer-depends on `tsx`. This project runs Node with `--experimental-strip-types` and
   has no `tsx` in the tree.
4. The webgame-template's own `app.config.ts` carries the comment *"@colyseus/database
   migrations are not fully implemented yet"*, and works around it with `createTable` calls
   wrapped in `try {} catch { /* ignore */ }`.

The package is a thin `Database`/`Collection` wrapper over **Kysely**, so the replacement is
Kysely directly (`kysely@0.29`), which is what the wrapper would have given us minus the
0.0.x risk. The user-visible decision — auth and persistence live inside the Colyseus
server, one process, one deploy — is preserved exactly. What changes is which query builder
gets imported.

`better-sqlite3` for local development, Postgres for anything deployed. Kysely's dialects
make that a one-line swap and the schema is authored once.

**The template is 21 months stale** (last push 2024-11-12, Colyseus 0.15, `colyseus.js`
rather than `@colyseus/sdk`, `react-router-dom` v6). It is read as a reference for *shape* —
`auth.settings` callbacks, `auth.prefix`/`auth.routes()`, `auth.middleware()`, the
`AuthProvider` context pattern — and none of its code is copied.

### 2.3 App shape: one Vite SPA, route-split

No monorepo, no second framework. `react-router@8` in the existing app, and **the entire
Three.js tree lazy-loads behind the `/play` route**. This is the load-bearing part: today
`src/components/GameCanvas.tsx` imports `three/webgpu` and calls `extend(THREE)` at module
scope, so a static import anywhere in the router graph would put ~1.5 MB of renderer in
front of a visitor reading the FAQ. A dynamic `import()` at the route boundary is what keeps
the landing page cheap, and the existing `manualChunks` split for `node_modules/three`
already means the game chunk is cached separately.

```
src/ui/        design system — tokens, primitives. No game imports.
src/site/      routes, layout, pages. No game imports.
src/account/   auth + profile + entitlement client. No game imports.
src/hud/       in-game HUD. Game imports allowed.
src/devtools/  dev console. Game imports allowed.
src/game/      the existing scene tree, entered only via lazy import.
```

The rule enforced by that layout: **`src/site/` and `src/ui/` never import Three.js or
`src/df2/`.** It is the same discipline `src/motor/` and `src/net/` already keep for Node,
for the same reason — the boundary is invisible until something crosses it, and then it
costs megabytes rather than an error.

### 2.4 Money: entitlements now, checkout stubbed

The full model ships — supporter tier, medals, unlocks, clan ownership, server slots — and
the grant path is real. The payment provider is not wired. A `VITE_CHECKOUT` flag off means
the supporter page explains the tiers and the dev-only grant endpoint sets the tier
directly; flipping it on later touches one module and no schema.

Reasoning: the entitlement model is what every other surface reads, so it has to be right
now, whereas taking money for a pre-alpha buys a support burden and a refund policy in
exchange for nothing the project currently needs.

### 2.5 Platforms: desktop, tablet and phone are all first-class. No cross-play.

Every surface is built mobile-first and responsive. The game itself needs a touch input
scheme that does not exist yet — that is scheduled, not hand-waved (phase 6) — but three
consequences land **now**, because retrofitting them later means redoing layout work:

1. **The HUD is anchor-based, not a scaled stage.** The mockup is a fixed 1448×1086 canvas
   scaled to fit, which is the right tool for a 1:1 comparison against a screenshot and the
   wrong one for a product: at phone aspect it would letterbox, and text would scale below
   legibility. Panels anchor to viewport edges with `env(safe-area-inset-*)` respected, and
   a density scale adjusts size rather than a transform scaling everything including
   hairlines.
2. **Bottom corners are thumb territory.** On touch, the left and right lower corners are
   where a stick and a fire cluster go. The desktop HUD puts weapon and waypoint panels
   exactly there. So the touch layout is a **different arrangement of the same panels**, not
   the desktop one shrunk — weapon and vitals move up and inward, the waypoint radar moves
   to the top edge beside the compass.
3. **Input class is account data and a matchmaking key.** No cross-play means a room is
   tagged with the input class it accepts and matchmaking filters on it; the server browser
   shows the tag. One account, shared progress, shared cosmetics, separate queues. A player
   signs in on a phone and keeps everything except the lobby they land in.

**Open risk, to be measured not assumed:** WebGPU availability and grass-march cost on iOS
and iPadOS Safari. The renderer already falls back to WebGL2, but the columnar grass march
is a per-fragment raymarch and the near-field layer is 250k instances — neither has ever
been profiled on a mobile GPU. Phase 6 opens with a measurement on real hardware, and the
result may force a reduced grass path for touch. Nothing in phases 1–5 depends on the
answer.

## 3. Design language: two skins, one system

The two mockups are not the same look and should not be forced together. They are two
materials from the same world:

| | Site skin | HUD skin |
| --- | --- | --- |
| Source | `design/distant-front-landing-modern-army` | `design/df2-hud-1to1-html-v3` |
| Metaphor | Embroidered patch, printed brief | Phosphor tactical display |
| Ground | `#0d0e0d`, 5px grid wash | Transparent over the live scene |
| Ink | Parchment `#e8dfc3`, khaki `#b8a373` | Olive `#a9bd61` / `#c1d979`, amber `#ffae24` |
| Accent | Olive `#626348` | Amber for alerts, blue `#63a9c7` for non-vital metrics |
| Panel | 1px hairline, square corners | Notched octagon, gradient border, corner dots, blur |
| Type | Oxanium display, Quantico labels, IBM Plex body | Condensed sans, tabular numerals |

One `tokens.css` holds both, scoped `:root` for shared geometry and `.skin-site` /
`.skin-hud` for the palettes. The notched-panel clip-path is a shared primitive because the
supporter and server-browser pages want it too — it is the one shape that ties the site
back to the game.

**Fonts are self-hosted**, not loaded from Google's CDN as the mockup does. `styles.css`
already committed to that rule and the reason still holds: a webfont from a third-party CDN
is one more thing that fails on a cold deploy. Oxanium and Quantico are both OFL, so
self-hosting is permitted. Each falls back to a system stack so a missing file degrades to
plain rather than to invisible.

## 4. The dev console

The current HUD is nine debug panels wearing a HUD's clothes: terrain identity, position and
frame time, view toggles, a controls legend, a shot log, plus the grass and weather dial
panels under `?debug=1`. All of it stays — it is how the renderer gets tuned — and all of it
moves into **one console behind a toggle**, so the game screen can be the game screen.

Requirements that shape it, from the brief:

- **Openable without a keystroke.** Backtick toggles it, and `?debug=1` starts it open, so a
  browser-automation session reaches it with a URL instead of a synthetic key event.
- **Every control addressable by name.** Real `<button>` and `<input type="range">`
  elements, each carrying `data-dev="<stable-id>"`, each with an accessible name. No
  canvas-drawn controls, no drag-only dials, nothing that only responds to pointer events.
  A slider is settable by value; a tab is clickable by name.
- **State readable.** The console publishes its open tab and every dial's current value to
  `data-*` attributes, so a driver can assert what it did rather than screenshot and guess.

This is the "still in a format that allows Claude in Chrome to use it" requirement, written
as three properties rather than an intention.

### 4.1 Verifying responsive layout under browser automation

**The automation browser's viewport is fixed** — `resize_window` reports success and
`window.innerWidth` does not change, so width media queries cannot be exercised by resizing
and a "mobile screenshot" taken that way is really the desktop layout. This cost a false pass
before it was noticed.

The technique that does work: an **iframe establishes its own viewport for media queries**.
Serve a scratch page from `public/` (same origin, so its frames are scriptable), give it
frames at the target sizes, and measure inside them:

```html
<iframe src="/" width="375" height="667" title="small"></iframe>
```
```js
const f = document.querySelector('iframe[title="small"]');
const cta = f.contentDocument.querySelector('.hero-actions .btn').getBoundingClientRect();
cta.bottom <= f.clientHeight;   // is the primary action above the fold?
```

Measure, do not eyeball: screenshots also arrive mid-animation whenever
`html { scroll-behavior: smooth }` is in play, and they include the browser's own toolbar, so
a y-coordinate read off an image is not a page coordinate.

## 5. Phasing

Each phase is independently shippable and leaves the tree working.

| # | Phase | Depends on | Status |
| --- | --- | --- | --- |
| 1 | Design system, router shell, game lazy-loaded behind `/play` | — | **done** |
| 2 | Landing, FAQ, supporter pages. Static, no backend | 1 | **done** |
| 3 | Dev console: existing panels moved behind it | 1 | **done** |
| 4 | HUD redesign against the mockup, desktop and touch layouts | 1, 3 | **done** |
| 5 | Accounts: auth server, schema, sign-in / register / profile / character | 1 | **done** |
| 6 | Lobby, server browser, private games, leaderboards | 5 | **done** |
| 6b | Clans, community-hosted servers | 6 | not started |
| 7 | Entitlements, medals, supporter perks, checkout stub | 5 | **done** |
| 8 | Touch input scheme, after the mobile GPU measurement | 4 | not started |

Phases 1–4 need no server and no schema, which is why they came first: they are the half
that can be finished and looked at without deciding anything else. Phase 7's data model
already exists (`src/account/tiers.ts`) because the supporter page renders it — what is
missing is the server that grants a tier and the gates that read one.

## 5.1 What phases 1–4 actually landed

```
src/ui/          tokens.css (two skins), primitives.css, brand.ts, Insignia.tsx
public/fonts/    Oxanium + Quantico, self-hosted, 40 KB total
src/site/        routes.tsx, SiteLayout, Booting, useDocumentTitle,
                 pages/{Landing,Faq,Supporter,NotFound}
src/account/     tiers.ts — tiers, capabilities, the `can()` gate
src/devtools/    DevConsole + {Scene,Telemetry,Controls,Grass,Weather}Panel,
                 useDevConsole
src/hud/         GameHud, Compass, compassTape.ts, RadarRose, VitalsPanel,
                 WeaponPanel, hudSignals.ts, HudLab (dev only)
src/game/        GameApp.tsx — the old src/App.tsx, now behind a lazy boundary
tests/hud/       compass-tape.test.ts
```

Deleted: `src/components/Hud.tsx` and `src/components/CollapsiblePanel.tsx`. The nine debug
panels that used to occupy every corner of the game screen are now five tabs in one docked
console, which is what freed those corners for the HUD.

**Route split verified**, not assumed: at this phase the entry chunk was 307 KB (98 KB
gzipped) and mentioned `three-*.js` only inside Vite's `__vite__mapDeps` preload table for the
lazy chunk. Three.js and the game are separate chunks that a visitor reading the FAQ never
fetches. (Re-measured after phase 7 and the review: 382 KB / **115.67 KB gzipped**, still with
the module runtime as its only static import. Growth is site code — the figure moves every
phase, so check it rather than quoting this line.)

**Honesty carried through to the HUD.** Health is real (`fly.net.health`, and
`GameServer.applyDamage` is the only thing that lowers it). Stamina, hydration and armour have
no system behind them, so they render a dashed empty track and a dash — never a full bar —
and publish `data-dev-value="unwired"`. Objective and squad chat have no source at all and
render only under `?hudpreview=1`.

## 5.2 Traps found while building this

Four things that were each invisible until something was measured — the same shape as
`12-...md` §6.

1. **A stylesheet in a lazy chunk is loaded forever once reached.** `src/styles.css` had
   `html, body, #root { overflow: hidden }`. It travels with the game chunk, so after one
   visit to `/play` every site page was unscrollable for the rest of the session. The
   viewport lock is now `body.mode-game`, added by the game and removed when it unmounts.
   Two stylesheets declaring the same selector has the same shape of bug: `.hud-root` was
   briefly defined in both `styles.css` and `hud.css`, where which one wins depends on
   import order. Each selector now has exactly one home.
2. **`requestAnimationFrame` does not fire in a backgrounded or headless tab.** The compass
   and the radar rose are rAF loops writing a DOM transform, so in the automation browser
   their transforms stayed empty and the compass sat on north whatever the heading was —
   which reads exactly like a broken compass. Two consequences, both applied: the loop body
   is called **once synchronously on mount** so the initial orientation is correct without a
   frame, and the tape arithmetic moved into `src/hud/compassTape.ts`, which is pure and
   pinned by tests. A claim that cannot be verified in the environment where verification
   happens is not a claim worth making.
3. **Compositing cost in the HUD lab, and a correction.** The lab page — two full-screen
   1448×1086 JPEGs stacked, under seven panels each running `backdrop-filter` plus
   `filter: drop-shadow` on a clip-path'd element — stopped responding to CDP entirely.
   What actually fixed it was **unmounting the hidden reference image** rather than leaving
   it at `opacity: 0`, where the compositor still pays for it every frame.
   The panel changes made alongside it (one drop-shadow instead of two, `contain: layout
   paint`, and the blur dropped under `(pointer: coarse)` and
   `prefers-reduced-transparency`) are worth keeping on their own merits, because mobile
   GPUs are a first-class target — but note they were **not** what unblocked the page.
   **Correction:** this was written up at the time as "a software renderer" being saturated.
   That was an inference, and it was wrong — the same machine runs the game at 88 fps on
   WebGPU. The backdrop-filter cost is still unmeasured on real mobile hardware (§2.5), and
   the "3 fps" reading that prompted the software-GPU guess was really trap 5 below.
4. **`import.meta.env.DEV` does not drop a top-level dynamic import.** Guarding the *route*
   in a dead branch left `lazy(() => import("../hud/HudLab"))` at module scope, and Rollup
   emitted the HudLab chunk into `dist/` regardless. The `lazy()` call has to sit inside the
   branch. Confirmed by grepping `dist/assets/`, which is the only way this is visible —
   nothing errors, the chunk is simply shipped and never fetched.
5. **A percentage height chain needs EVERY link to be definite, including `html`.**
   `body.mode-game { height: 100% }` was added without `html`, whose height came only from
   `min-height: 100%` — and `min-height` does not make a height definite, so the percentage
   resolved to `auto`. `#root` collapsed to its content and the R3F canvas fell back to a
   `<canvas>` element's intrinsic **150px**. `/play` rendered a 150px sliver of terrain in a
   664px viewport.
   **It was invisible for three reasons, all worth knowing:** the HUD is `position: fixed`,
   so it filled the screen and looked completely correct; the sliver still showed real
   terrain, so the page did not look broken so much as oddly framed; and it was mistaken for
   a slow-GPU artifact and explained away instead of measured. The measurement that would
   have caught it immediately is one line — compare the canvas's client height to
   `innerHeight` — and it now belongs in any check of `/play`:
   ```js
   const c = document.querySelector('canvas');
   Math.abs(c.getBoundingClientRect().height - innerHeight) < 2;   // must be true
   ```
   The class is set on `documentElement` as well as `body` so `html` can carry the height,
   and removed from both on unmount — verified via browser Back, which is a client-side
   unmount and the path that would otherwise leave the site locked.

## 5.3 What phase 5 landed

```
src/account/     accountTypes.ts (Account, effectiveTier, callsign rules)
                 characters.ts   (appearance + loadout, validation, coercion)
                 accountClient.ts (token, /auth and /api calls)
                 AuthProvider.tsx (context + the `can()` gate)
src/site/pages/  SignIn, Register, Profile, CharacterPage, auth.css
tools/account/   database.ts   (Kysely schema + versioned migrations)
                 repository.ts (every account query; row -> Account mapping)
                 authSettings.ts (the seven @colyseus/auth callbacks)
                 api.ts, mount.ts
tests/account/   account-types, characters, repository (49 test cases today)
tsconfig.server.json  — `npm run typecheck` now covers tools/ as well
```

Accounts run **in the game server process**, mounted on the Express app the
Colyseus transport already owns (`transport.getExpressApp()`), so there is one port
and one deployment. `mountAccounts(app)` is the whole seam; `tools/game-server/server.ts`
gained two lines.

**The funnel is verified end to end**, in the browser and against the real server:
a guest signs in with no fields, picks winter camo and a helmet, registers, and
comes out as the SAME account row (`id` unchanged) with those cosmetics intact,
`anonymous` false and tier `enlisted`. That works because `@colyseus/auth`'s
register handler hands `options.upgradingToken` — the verified payload of the
caller's current token — to `onRegisterWithEmailAndPassword`, and the repository
UPDATEs that row instead of inserting a new one.

**One rule, two callers.** `validateCharacter(value, tier)` builds the editor
(disabling what the account cannot use, with the reason beside it) and validates the
PUT. Verified: as a guest, custom insignia and a non-default primary are both
refused by the API and disabled in the UI; after registering, the primary unlocks
and insignia stays locked because it is a supporter capability.

### Security: two real limitations of the chosen auth package

Neither is a reason to drop it, and neither is hypothetical. Both are stated in code
beside the thing they affect.

1. **Passwords are hashed with ONE process-wide salt.** `Hash.make(password, salt)`
   defaults the salt to `process.env.AUTH_SALT` or the literal `"## SALT ##"`, which
   is published in the package source. So an unset `AUTH_SALT` means every
   deployment shares a public salt, and even when set, two accounts with the same
   password store the same hash — the salt is a pepper, not a per-user salt.
   `onHashPassword` cannot fix this: the `/login` and `/register` handlers call
   `Hash.make` directly and never consult it. **Mitigation applied:**
   `requireSecrets()` refuses to start without `JWT_SECRET` (24+ chars) and
   `AUTH_SALT`, and says why. **Proper fix,** when it is worth it: replace those two
   handlers with our own and store a per-user salt.
2. **OAuth pulls in advisories with no upgrade path.** `@colyseus/auth` depends on
   `grant`, whose tree carries `elliptic` and `uuid` advisories that `npm audit`
   reports with `fixAvailable: false`. **Mitigation applied:** a provider is
   registered only when its credentials are in the environment, so with no Discord
   keys configured the OAuth routes are never mounted and that code is unreachable.
   `/api/config` tells the client which providers exist, so the sign-in page offers
   a button only for one that works.

Also worth knowing: tokens now **expire after 30 days** (the package default is no
expiry at all, so a leaked token was valid forever), and they carry only
`{ id }` — `onParseToken` reloads the account, so a rename or a tier change takes
effect on the next request rather than the next login.

### A shape trap the client is built around

`@colyseus/auth` returns **two different user shapes**: `/auth/anonymous` returns
whatever `onRegisterAnonymously` returns (our camelCase `Account`), while
`/auth/login` and `/auth/register` return the database row (snake_case,
`anonymous` as 0/1). So `accountClient.ts` **ignores the `user` field in every auth
response** and reads the canonical account from `GET /api/me`. An auth call is used
for its token and nothing else.

Related: `findUserByEmail` is deliberately NARROWED to eight columns, because
whatever it returns is echoed to the client by those two handlers. `anonymous_id`
and `discord_id` are not selected. A test asserts they stay off the wire.

### Still open after phase 5

- **The game room does not check the token.** `&net=1` still joins
  unauthenticated. Room-scope authentication belongs with matchmaking in phase 6,
  and adding a `static onAuth` now would either break the existing dev URL or be
  dead wiring that verifies nothing.
- **Career and medals are never written.** Both read correctly and both are
  honestly zero, with the profile page saying so rather than inventing numbers —
  the match server does not report results yet.
- **Postgres.** `openDatabase` is SQLite only; the dialect swap is one branch on
  `DATABASE_URL` plus the `pg` driver, deferred until there is somewhere to deploy.
- **Email delivery.** `onForgotPassword` logs the reset link when no provider is
  configured, which is a working development flow and an obvious production gap.

## 5.4 What phase 6 landed

```
tools/account/roomMetadata.ts  join codes, room options, what a room publishes
tools/account/lobbyApi.ts      /api/servers, /api/join-code, /api/leaderboard(s)
tools/account/repository.ts     + recordSession, recordLongestShot, leaderboard
tools/game-server/server.ts     static onAuth, room metadata, private rooms,
                                session reporting, filterBy(["inputClass"])
src/net/ColyseusTransport.ts    token + join options (by id / create private)
src/site/pages/Lobby.tsx        quick match, browser, join by code, host private
src/site/pages/Leaderboard.tsx  four boards with an honest empty state
tests/account/lobby.test.ts     13 test cases today
```

**The career pipeline is now real, and that is what makes a leaderboard possible.**
`Room.onAuth` is **static**, so it runs before any instance exists and cannot reach
the repository through `this` — hence the module-scope `accounts` handle in
server.ts. It resolves the token to an account id, `onJoin` stamps the join time,
and `onLeave` writes matches and seconds played. Verified end to end against a live
server: two joins produced `matches: 2, timePlayedSeconds: 6` and the account
appeared on the matches board at rank 1.

**Room auth is deliberately optional.** An absent or bad token joins as nobody
rather than being refused, because every documented dev URL predates accounts and
`?scene=scope&motor=1&net=1` must keep working. Identity buys career recording,
nothing else. It is **not** a gameplay trust boundary.

**No cross-play is enforced twice, on purpose.** `filterBy(["inputClass"])` stops
`joinOrCreate` matching across queues, and the browser filters the listing. Verified:
`?input=desktop` returned nothing while a touch room was open, and `?input=touch`
returned it.

**Private rooms rely on Colyseus's own `private` flag** rather than custom state, so
they are excluded from matchmaking and from the browser by the framework. The join
code lives in room metadata and is filtered out before any response — which is why
the listing is built server-side rather than by letting the client call Colyseus's
matchmaking endpoint. Verified: a private room returned `{"servers":[]}` while open,
its code resolved to the right room id, lowercase-with-spaces resolved identically,
and a wrong code returned `no_such_game` with no hint that anything exists.

Join codes use a 25-character alphabet with **no O/0, I/1/L, S/5, B/8 or Z/2**,
generated with `crypto.randomInt` rather than `Math.random` — the code is the only
thing protecting a private match, so it must not be predictable from another one
minted moments earlier.

**Empty boards say WHICH kind of empty they are.** Matches and time played fill up
as soon as anyone plays; kills and longest shot are not written by anything yet. The
server marks each board `populated` so the page can distinguish "nobody has done
this" from "nothing records this", because an empty kills board otherwise reads as a
claim that nobody has ever killed anyone.

### Still open after phase 6

- ~~The host cannot see their own join code.~~ **Done.** A `ROOM_INFO` Colyseus
  message carries the code to every member on join, and `src/hud/InvitePanel.tsx`
  shows it with copy-code and copy-link buttons. It is a Colyseus MESSAGE rather
  than a packet inside `PACKET_DOWN` — the opposite of the choice made for weather
  in `12-...md` §8.1, and the difference is the point: weather is gameplay (fog is
  concealment, the authority layer owns it, the Node loopback suite must cover it),
  whereas a join code is read by no simulation code, changes never, and is
  per-client. Putting it in the codec would mean widening `SnapshotCodec`,
  `GameServer` and the packet enum to carry a string nothing will consult — and
  those are exactly the files feat/server-ballistics is working in.
  Sent to every member, not only the creator: anyone already inside used the code to
  get there, so the only person who lacks it is the host. Verified against a live
  server — a private room delivers `{joinCode}`, a public room delivers `{}` and no
  code, a second member joining by id gets the same code, and the
  code shown in the HUD resolves through `/api/join-code` while the room stays
  absent from the public listing. `InvitePanel` is the ONLY HUD element with
  `pointer-events: auto`; `.hud-root` is click-through so a look-drag never catches
  on a panel.
- **Clans and community-hosted servers are not built.** The metadata carries
  `community` and `hostCallsign` and the browser renders them, but nothing sets
  them — `foundClan`, `hostCommunityServer` and `reservedSlot` remain ungranted
  capabilities. That is phase 6b.
- **Kills and deaths.** Waiting on feat/server-ballistics; `recordLongestShot`
  exists and is tested but has no caller yet.

## 5.5 The simplify pass after phase 6

A reviewed pass over phases 1–6, applied as separate commits. Four of its findings
changed where a fact lives rather than what the code does, and those are the ones
worth recording, because the next person to add a board or a page needs to know
which file is now authoritative.

- **`src/site/useAsyncAction.ts`** is the busy/error/done state for anything behind
  a submit button. Five pages had hand-rolled it and had already drifted. `run(kind,
  action)` never rejects — a rejected promise out of an event handler is an
  unhandled rejection nobody sees — and pages that need their own wording pass a
  `describe` defined at module scope so the callback identity stays stable.
- **`src/account/lobby.ts`** is the one declaration of `ServerListing`,
  `BoardSummary`, `LeaderboardRow`, `Leaderboard` and `normaliseJoinCode`. They were
  written out verbatim on both sides of the client/server line and agreed only by
  hand. It sits beside `accountTypes.ts` rather than inside it on the same line the
  server already draws between `lobbyApi.ts` and `api.ts`: these describe the
  matchmaker's view, not an account. **`normaliseJoinCode` had to move out of
  `tools/`** — `src/site/` cannot import from there, which is exactly why a third
  copy had grown in the lobby page. Minting a code stays server-side; it needs
  `node:crypto`.
- **`LEADERBOARD_COLUMNS` now carries `unit` and `populated`.** Both had been
  open-coded conditionals in the route — twice — with the display unit a third
  conditional keyed on the board *id* in `Leaderboard.tsx`. Adding a board is now
  one entry in one table, and a renamed board id can no longer silently print raw
  seconds.
- **Weapon names come from `WEAPON_DEFINITIONS.displayName`** via
  `weaponLabel()`. The character editor had invented a second set — "Bolt-action
  rifle" where the HUD says "Sniper" — so the same rifle had two names depending on
  the screen. Adopting the table changed the visible labels to Sniper / M4 / Glock.

Also applied: one `requireAccount(repository)` middleware in place of the same
resolve-and-401 repeated across three routes; `/api/me` and `publicProfile` issue
their independent reads with `Promise.all` and no longer await `touch`; a new
appended migration indexes the four career columns the boards rank by (verified —
the planner now uses a covering index instead of a scan and sort); and three dead
things are gone: `RoomInfo.label`, `WeaponPanel`'s always-null `utility` with its
`.hud-utility` rule, and `ColyseusTransport.get roomInfo()`.

**Deliberately not "fixed":** `recordLongestShot` has no caller because it is a
tested seam awaiting feat/server-ballistics; `hudSignals.ts` must not import
Three.js because a Node test imports it; and `roomInfo` living on the concrete
`ColyseusTransport` rather than on `ClientTransport` is correct, because that
interface is shared with the loopback and websocket doubles the Node tests drive.

## 5.6 What phase 7 landed

```
src/account/medals.ts          the catalogue, `earnable`, and earnedMedals()
tools/account/authMiddleware.ts requireAccount / accountOf, shared by two routers
tools/account/repository.ts     + setTier, syncMedals
tools/account/api.ts            + POST /api/me/tier (DF2_ADMIN only)
tools/account/lobbyApi.ts       + POST /api/private-game (capability gated)
src/site/pages/Profile.tsx      the whole catalogue, earned / locked / unearnable
src/site/pages/Supporter.tsx    the dev grant, shown only when the server allows it
src/game/CharacterPreview.tsx   turntable soldier, lazy island off /character
tests/account/medals.test.ts    8 test cases today
```

**A supporter perk was enforced by nothing.** `hostPrivateGame` was checked only by
the lobby deciding which button to render — `onCreate` read `visibility: "private"`
straight out of untrusted room options, so `/play?…&private=1` hosted a private game
for anyone, account or not. The room is now created by **`POST /api/private-game`**,
which is the only layer that knows who is asking, and `&private=1` is gone along with
`createPrivate` and the transport's `client.create` path. Verified against a live
server: enlisted gets 403, a granted supporter gets a room id, the room is absent
from `/api/servers`, the join code arrives in the HUD over `ROOM_INFO` as before, and
an unauthenticated caller gets 401.

**A lapsed supporter is refused.** Granting `days: -1` stores the tier and an expiry
in the past; `/api/me` then reports `tier: "supporter"` with `effectiveTier:
"enlisted"`, and hosting is refused. That is `effectiveTier` failing closed, measured
rather than assumed.

**`earnable` on a medal is load-bearing, not a label.** Kills and longest shot are
not written by anything yet, so every combat medal carries `earnable: false` and
`earnedMedals()` checks that flag *before* the medal's own test. Proven on real data:
an account with `longest_shot_metres = 812.4` was awarded the two service medals it
qualified for and **not** the 500 m marksman medal, whose own predicate returns true.
Turning a medal on when the ballistics branch lands is one boolean, deliberately.

Medals are evaluated on `onLeave`, after the session is written and from the STORED
career — so the match that crosses a threshold is the one that awards it, and an
award missed to a crash corrects itself the next time anyone plays. `setTier` and the
medal writers are separate methods on purpose: a tier can be granted and a medal
cannot, and keeping them apart makes that structural rather than a convention.

**The dev grant answers 404, not 403, when `DF2_ADMIN` is off.** "Forbidden" tells a
prober that a self-service tier grant exists on this deployment. It reuses `DF2_ADMIN`
rather than adding a switch, because it answers the same question the room-wide visual
dials already ask, and two variables would eventually be set inconsistently on the one
box where it matters. `/api/config` reports `grantEnabled` so the supporter page shows
the control only where it works — the same rule already applied to `checkoutEnabled`.

### The character preview, and what it deliberately is not

`/character` can load a turntable of the soldier with its idle clip. It is **the one
place `src/site/` reaches the game**, through `lazy(() => import(...))`, and it is
mounted by a button rather than on arrival because the GLB alone is 7 MB. Re-verified
in `dist/`: the entry chunk's only static import is still the Rolldown runtime, its
`three-*.js` reference appears solely inside `__vite__mapDeps`, and the entry grew
from 106.75 to 108.11 kB gzipped — wiring, not a renderer.

**It does not reflect the editor, and the page says so above the canvas.** Camo,
headgear and insignia are stored, validated and gated, but nothing renders them: the
GLB is one soldier with baked materials and there is no variant system. A preview that
silently ignored the controls beside it would read as the player's camo being broken,
which is worse than no preview.

One thing worth knowing if this is extended: the rig's origin is **not** under the
model's middle — a rifle held out to one side moves the bounding box — so spinning the
parent made the soldier orbit the frame instead of turning on the spot. The fix is to
offset the model by its own bounds centre in X and Z before rotating the pivot.

### Still open after phase 7

- **A hand-rolled Colyseus client can still create a private room** by passing
  `visibility: "private"` to `joinOrCreate`. The HTTP gate closes the product
  surface, not the protocol; sealing it needs room-scope authentication, which
  phase 6 deliberately left optional so every documented dev URL keeps working
  (§5.4). Consistent with the standing posture that room auth is not a gameplay
  trust boundary.
- **No checkout.** The grant path is real and the payment provider is not, exactly
  as §2.4 planned. Replacing the dev handler touches one module and no schema.
- **Combat medals are defined and unearnable**, pending feat/server-ballistics.
- **`customInsignia`, `foundClan`, `hostCommunityServer`, `reservedSlot`,
  `earlyAccessMaps` and `supporterMarker`** are granted by the tier table but only
  `customInsignia` is enforced anywhere. The rest are phase 6b or later — the
  supporter page advertises them, which is the drift `tiers.ts` exists to prevent,
  so they are named here rather than left to be discovered.

## 5.7 The review pass over phases 5–7

A full read of the branch before merge. Twenty-one findings, all fixed; the suite went from
271 to 287 tests. Grouped by what the mistake actually was, because the categories repeat and
the categories are the useful part.

```
src/account/accountClient.ts    + a non-JSON 200 is rejected, not parsed to {}
src/account/accountTypes.ts     guestCallsign(seed, digits) — the widening is real now
src/account/playerStats.ts      patienceScore returns null with no stance telemetry
src/site/pages/PlayerProfile.tsx  missing / unreachable / loaded, and state resets on :id
src/hud/InvitePanel.tsx         a failed copy says so, including with no Clipboard API
tools/account/database.ts       + migration 7: friendships.pair_key unique; pairKey(),
                                isUniqueViolation() shared rather than duplicated
tools/account/repository.ts      + leaderboardDefinition() (Object.hasOwn), a reserved
                                stem stops being derived from
tools/account/statsRepository.ts  all three aggregates count in SQL; + players()
tools/account/communityRepository.ts  + requireAccount(), pair_key race handled
tools/account/api.ts            days clamped; /api/config no longer sends `tiers`
tools/game-server/server.ts     seatReservationTimeout=45, session cap, presence by
                                session, const accounts
tests/account/stats-repository.test.ts  NEW — the aggregates had no coverage at all
```

**Unknown rendered as a plausible number.** The one worth leading with, because it is the rule
this project states most often and it still got broken three times.

1. **`patienceScore` answered a confident 40/100 for every player alive.** `match_participation`
   has no writer, so all three stance counters are zero — which the formula read as "never
   moved", giving `stillness` 0 and `restraint` a perfect 1, and `0 x 0.6 + 1 x 0.4` is 40.
   Not a placeholder, not an obvious zero: a mid-range score that looks measured. It now
   returns null when no stance telemetry exists at all, which the profile page already had a
   branch for. Measured before and after rather than reasoned about.
2. **`match_participation` has three readers and no writer**, and unlike `engagements` it is
   *not* blocked on ballistics — it is simply unbuilt, which made it easy to read as done.
   Now stated in the schema and in `player-statistics-design.md` §6, with the warning that
   attaches to it: do not write a partial row to light the section up, because a row with
   zeroed counters makes `available.objectives` true and every figure above it a false claim.
3. **`consistency()` was being called with a permanently empty array.** It has no per-match
   kill source yet, so the board now sends `null` explicitly instead of computing a number
   from nothing.

**A comment that documented an invariant the code did not have.** `friendships`' unique index
was annotated "the repository normalises before inserting so a reversed duplicate cannot be
created either". It did not normalise, and the index could not have enforced it anyway —
`(A,B)` and `(B,A)` are different keys. Fixed with a `pair_key` column; the full argument,
including why normalising the direction columns would have been the *wrong* fix, is in
`community-layer-design.md` §4.

**Costs that were invisible because the tables are empty.** Every one of these is a public,
unauthenticated endpoint whose cost grows superlinearly in population, so none of them would
have shown up in testing and all of them would have shown up at once.

- `/stats/weapons` selected **every shot ever fired** and grouped it with
  `map.set(k, [...previous, row])` — quadratic in rows per weapon on top of an unbounded read.
- `/stats/leaderboard` ran `participation.filter(e => e.user_id === row.id)` inside
  `players.map(...)`: O(players x rows), a hundred million comparisons for a thousand accounts
  against a hundred thousand rows. It also passed every account id as a bound parameter, which
  has a hard ceiling in SQLite.
- `/stats/players` ran the entire scored board to return two columns.

All three now count in SQL, and the reads that genuinely need individual values are restricted
to `fatal = 1` rows — a kill-range median cannot be computed from counts, but it does not need
the shots that hit nobody either. Population medians still want a nightly aggregate eventually
(`player-statistics-design.md` §6).

**A join that changed the answer, not just the cost.** `/stats/maps` attributed engagement
ranges to a map by joining on `match_id`, which duplicated every engagement once per
participant — so each match's ranges were weighted by how many people were in it. Measured
against a fixture: the join read 9 engagement rows where 5 exist and reported a median of 200
where the correct answer is 550. Attribution is now a `match_id -> map` lookup built once. Both
numbers are pinned in `tests/account/stats-repository.test.ts`, which is new — these aggregates
had no coverage at all.

**Two states where there were three.** `PlayerProfile` mapped every failure to "No such
player", and never reset the flag. Because React Router reuses the component across
`/player/:id`, one bad id wedged the route: every later profile fetched fine, set its state,
and still rendered "No such player" until a full reload. `Lobby` had already got this
distinction right for the matchmaker ("a matchmaker that is down must not render as *no
servers*") — the same reasoning simply had not been applied here.

**A guard that could not fire, and a retry that could not escape.**

- `LEADERBOARD_COLUMNS[board]` with a URL segment as the key: `__proto__` returns
  `Object.prototype`, `constructor` and `toString` return functions. All three are
  non-undefined, so they passed the "no such board" check and reached the query as
  `career.undefined` — a 500 where a 404 was meant. Now `Object.hasOwn`.
- `createGuest` retried a collision by drawing a bigger random number, which did nothing
  whatsoever: `guestCallsign` folded it back with `% 10000`, so `guestCallsign(987654321)` and
  `guestCallsign(4321)` were both `Recruit-4321` and all eight attempts drew from one
  exhausted pool. It now widens the *name*.
- `uniqueCallsign` derived a callsign from the email local part and kept the prefix on every
  retry, so `admin@`, `administrator@`, `moderator@`, `official@` and `distantfront@` produced
  twenty-one reserved candidates and a thrown error. **Nobody at those addresses could
  register at all.** A reserved stem now stops being suffixed and stops being derived from.

**A room that disposed before its host could reach it.** `POST /api/private-game` creates the
room and hands back an id, and only then does the browser navigate to `/play` and lazy-load a
~930 kB `GameApp` chunk, ~390 kB of `three`, Rapier and the terrain before it can call
`joinById`. Colyseus arms an auto-dispose timer at creation from `seatReservationTimeout`,
default **15 seconds** — comfortably less than a cold load, so the host arrived at a room that
had already stopped existing.

`GameRoom` now sets `seatReservationTimeout = 45` as a **subclass field**, which is the only
place that works: `__init()` arms the first timer, it runs after the constructor and before
`onCreate`, and `resetAutoDisposeTimeout` is private to the base class — so `onCreate` is too
late. Verified by instrumenting a bare subclass rather than assumed: base default 15, subclass
field 45, `__init()` arms with 45. The cost is that an empty room lingers 45 s and an abandoned
seat reservation holds its slot that long, which with `maxClients = 64` and no rate limit on
matchmaking is a slightly cheaper slot-holding nuisance than before. Reserving the host's seat
server-side would be the tighter fix and needs a client change.

**Smaller, all fixed:** blocking a nonexistent id returned 500 rather than 404 (foreign key,
no existence check, while `post` and `requestFriend` both had one); `POST /api/me/tier` took
`days` unclamped, so `1e21` made `new Date(...).toISOString()` throw; session time was
uncapped wall-clock with no idle detection, on one of only two populated boards, so a parked
socket outranked a player — capped at six hours, with the honest fix named; `/api/config` sent
a `tiers` array that `ServerConfig` never declared and nothing read; the HUD's copy buttons
promised to report a failure and reported nothing, including the insecure-origin case where
optional chaining short-circuited the whole call; `let accounts` was assigned exactly once.

**Two test files were binary to git.** `community.test.ts` and `lobby.test.ts` each embedded a
literal NUL byte in a control-character fixture, so git classified both as binary: no
reviewable diff, no line blame, no textual merge. The tests were correct; the bytes are now
`\u0000`-style escapes. Worth remembering the next time a test needs a control
character: the escape and the raw byte are identical to the runtime and very much not
to the tooling. (Written the wrong way once more while writing this very paragraph.)

**Not a finding, recorded because it was checked:** the lazy boundary holds. The entry chunk is
115.67 kB gzipped and its only static import is the module runtime — no `three`, no
`@react-three`, no game code reachable from `src/site`, `src/ui`, `src/account` or `src/hud`.

## 5.8 The front-end polish pass (2026-08-05)

Six changes, all owner-directed, touching the funnel, the HUD and the dev console.

**The funnel now stops at the loadout screen.** A bare `/play` — every "Play now" button —
redirects to `/character?deploy=1`: the existing loadout screen (soldier, kit, editor) gains a
20-second countdown in its action bar ("Game starts in N") and a Deploy Now button, both
navigating to `/play?loadout=0`. This deliberately revises §6's "the funnel must never gain a
step": the step is a staging beat, not a form — a guest is seeded `DEFAULT_CHARACTER` and never
asked to sign in. While the countdown runs, the page warms the game chunk with the same
dynamic-import shape the route uses (the boundary was re-checked in `dist/` after: entry chunk
116.05 kB gzipped, still only the module runtime as a static import). `?loadout=1` forces the
stop onto any /play URL; `?loadout=0` (what Deploy sends) spends it.

**A parameterless /play runs the full game.** `readLaunchConfig` in `GameApp.tsx` defaults to
`scene=scope&motor=1&net=1` when none of its explicit parameters are present; every documented
dev URL keeps its exact meaning, and the terrain spike stays reachable as `?scene=terrain` (any
unrecognised scene value with no other demo flags). The parse also moved from module scope to
per-mount state — module constants described whichever URL first evaluated the chunk, which is
wrong for every client-side navigation after the first. `readServerUrl` no longer hardcodes
localhost: dev (port 3000 or localhost) targets `:2567` on the page's own host, anywhere else
targets same origin, which is what the VPS serves.

**The dev console gained two tabs.** "HUD": a visibility switch per HUD panel
(`src/hud/hudPanels.ts` is the registry; state session-persisted like the console's tab) plus a
panel-opacity dial — combat feedback deliberately has no switch. "Launch": every URL parameter
the game reads as form controls that bake a fresh /play URL, with an extras field that carries
unrecognised parameters through a round trip, and Apply-and-reload — honest UI for parameters
that are read once at mount by design.

**Panels are more transparent.** The mockup's 0.94/0.83 background alphas read as solid slabs
over live terrain; they are now 0.60/0.44 (0.85/0.74 on coarse pointers, where there is no blur
to carry legibility), scaled by the dial's `--hud-panel-alpha`.

**Wind joined the compass bar.** Same top row, 54px, right edge; the compass tape yields
`440px` of viewport width so ticks never slide under it on narrow desktop windows.

**Death is a reload screen now.** The full-width panel first built as an in-game deploy modal
was repurposed on review (`src/hud/RespawnScreen.tsx`): killer, the kit you come back with, and
the server's own respawn countdown, replacing the small `DeathOverlay` panel. The backdrop is a
vignette, not a blackout — §5.2's "a dead player should still be able to read the ground" is
kept inside the owner's full-screen ask. It carries the old `data-dev` names
(`hud-death`, `death-killer`, `death-respawn`), so existing drivers still find it. Not yet
walked in a real two-client death; the countdown hook and gating are unchanged from the
overlay it replaced.

**Respawn is a flat 5 s** (same day): deriving it from the death clip's length plus a pause
tied the authority's schedule to presentation and the timer drifted in practice, so
`GameServer` now schedules every death from one constant that clears the longest clip
(3.73 s). `respawnPauseSeconds` is gone; `docs/12` §8 carries the amendment.

**The loadout pattern the UI is aiming at** (owner-directed, front-end leading): slots are
**primary / secondary / sidearm / support / aux / outfit** — aux is grenades and medic items,
outfit is ghillie/armor/class. The respawn screen shows all six today: the first four carry
the real development kit (its slot ids already match), aux and outfit render unwired in the
vitals panel's dashed convention. The target weapon roster, with exact case-sensitive
animation segment names per weapon, as handed down 2026-08-05:

```
carbine / ak / smg / pistol / fiftycal:  shoot, reload_fast, reload_slow,
                                         weapon_down, weapon_up, idle, melee
sniper:            shoot, chamber_round, reload, weapon_down, weapon_up, idle, melee
lmg:               shoot, reload, reload_alt, weapon_down, weapon_up, idle, melee
grenadelauncher:   shoot, reload, weapon_down, weapon_up, idle, melee
shotgun:           shoot, pump, reload_single_shell, reload_complete,
                   weapon_down, weapon_up, idle, melee
knife:             idle, attack_slice1, attack_slice2, attack_stab1, attack_stab2,
                   weapon_down, weapon_up   (melee weapon — no shoot/reload/melee)
```

A `pistol_icon.webp` joined the authored silhouettes (SVG-drawn, same greyscale mask
treatment), so the Glock finally has a shape in the HUD, the loadout editor and the respawn
screen.

## 5.9 The pre-merge review of the whole PR (2026-08-06)

A five-slice review (server security, netcode, site/routing, HUD/devtools, tests/config) over
the full 192-file diff. Every finding below was fixed; the suite went 297 → 334. Four
categories are worth carrying forward, and three of them are recurrences of §5.7's:

**(1) A display bug can undo an authority fix one layer up.** The flat 5 s respawn (§5.8) was
correct on the server and the countdown still never reached zero: `useCombatFeed` stamped
`respawnAtMs` with `Date.now()` INSIDE a memo whose deps include a once-per-second expiry
tick, so the anchor reset every second and the overlay oscillated in the 4–5 s band. It is
now stamped once per death sequence, in a ref. This was the "respawn timer is bugged" report,
and the server-side change had already been shipped and verified — measuring the packet is not
measuring what the player sees.

**(2) Advertised capability, enforced nowhere — again, and not on the documented list.**
§5.6 recorded `hostPrivateGame` as this shape; the review found two more. `persistentName` was
checked by nothing, so `POST /auth/anonymous` then `PATCH /api/me` let an unauthenticated
visitor permanently claim any callsign against a unique column, with no release path — and it
erased the `recruit-` prefix that identifies a guest. `joinPrivateGame` was likewise
unenforced because `/api/join-code` had no auth at all. Both are gated now, and the route-level
HTTP harness (`tests/account/routes.test.ts`) is what will keep them that way — every one of
these guarantees had previously been "verified against a live server" by hand and pinned by
nothing.

**(3) A counter with no floor is a counter somebody farms.** `recordSession` incremented
`matches` unconditionally, so 60 zero-second join/leave cycles credited 60 matches and awarded
three of the five earnable medals — measured, not reasoned. There is a 30-second floor now.
The same shape, elsewhere: the community rate limits counted LIVE rows, so deleting your own
posts reset the per-wall limit that exists to stop harassment, and withdrawing a friend request
reset the spam bound. Both count an append-only `action_log` now, which is the only kind of
counter an actor cannot reset.

**(4) A dead end with no exit is a bug even when every individual rule is right.** `leaveClan`
refused a leader with members (`promote_first`) and no promote or kick endpoint existed, while
joining was open to anyone — so a stranger joining permanently trapped the founder AND their
tag. Leaving now hands the clan to its longest-standing member, with `POST /api/clan/promote`
for choosing. Same category: Discord sign-in threw a UNIQUE violation on every attempt, forever,
for any user whose Discord address already existed as a password account.

Also fixed: no rate limiting on any credential route (in-process per-IP limiter; forgot-password
no longer answers differently for a known email); tokens surviving a password reset
(`users.token_version`); `SESSION_SECRET` required whenever a provider is configured, and
documented — without it the whole OAuth flow 500s with nothing pointing at the cause; driver
text and stack traces reaching clients (one error handler, generic bodies); `pair_key` nullable
despite existing to enforce an invariant (NOT NULL via a table rebuild); the two public stats
queries reading whole tables in JavaScript; tracking parameters (`?utm_source=`) skipping the
loadout stop entirely; deploy navigations pushing, so Back out of a match silently redeployed;
four pages rendering "nothing exists" for "could not load"; stale-response races on three
pages; touch-layout panels overlapping each other on a phone; and a `role="status"` wrapper
re-announcing the respawn overlay five times a second.

**Deliberately not fixed:** a dead player's camera stays live. See `docs/12` §8.0 — the corpse
is frozen and its collider disabled, but look still passes through, which is free scouting in a
concealment game. A stricter killscreen is an unmade product decision and `setDead` is the seam
for it.

## 6. Retention model — what the perks actually are

The brief's shape is "easy to play, better to register". Concretely:

**Free, no account.** One click from the landing page into a live match as `Recruit-####`.
Nothing is asked for. This is the funnel's whole job and it must never gain a step that asks
for anything. (Revised 2026-08-05: the funnel now pauses at the loadout screen with a
countdown — a staging beat, not a form; guests pass through without signing in. §5.8.)

**Free, registered.** `@colyseus/auth` supports upgrading an anonymous session in place —
`RegisterWithEmailAndPasswordCallback` receives an `upgradingToken`, so the account keeps
the session's progress instead of starting over. That is the mechanism the funnel needs, and
it is why registration is offered *after* a match rather than before one. Registered gets:
a name that persists, medals and career stats, saved loadouts, friends, and joining private
games by code.

**Supporter.** Paid tier, and the perks are deliberately **community-building rather than
competitive** — nothing bought may affect concealment, ballistics or visibility, because
`00-...md`'s pillars make those the game. So: found and administer a clan, host a persistent
community server that appears in the browser, reserve a server slot, custom insignia and
patch, an early-access channel for new maps, and a supporter marker on the profile.

**Earned, not bought.** Medals, ribbons and career milestones come only from play. This is
the line that keeps the supporter tier from reading as pay-to-win: supporters get to *run
things*, players get to *have done things*.

## 7. What this record does not settle

- **Hosting: a VPS** (decided 2026-08-04, during the phase 5–7 review). One box runs the
  Colyseus server, which already owns the Express app that serves `/auth` and `/api`, and
  serves the built client from the same origin. That is the arrangement the code has always
  assumed — the dev server proxies `/auth` and `/api` to :2567 precisely so that development
  and production share one origin and no CORS or cookie behaviour exists only in one of them.
  Colyseus Cloud and Fly.io remain viable and the choice affects no code in phases 1–7.

  **The one thing a VPS deploy must get right is that `/api` and `/auth` are not swallowed by
  the SPA fallback.** An `nginx` `try_files ... /index.html` or a catch-all rewrite that also
  matches the API returns the client's own HTML, with status 200, to every API call. That was
  a live crash on the static-only deploy: `safeJson` turns the HTML into `{}`, an empty object
  passes every `response.ok` check, and the sign-in page then read `config.providers.length`
  off `undefined` and rendered nothing at all. `accountClient.request` now rejects a 200 whose
  content type is not JSON, so the failure surfaces as "the account service did not answer"
  through each page's existing error path instead of a blank screen — but the proxy still has
  to route those two prefixes to the game server, and the guard is a safety net rather than
  the fix. `netlify.toml` is kept for static previews and is not the deployment target.
- **Email delivery.** Password reset needs a provider. The template uses Resend. Deferred to
  phase 5, and anonymous plus OAuth sign-in both work without it.
- **Anti-cheat.** Out of scope here and still unbuilt. Note that the input-class tag from
  §2.5 is a *matchmaking* filter and a client claim — it is not a trust boundary.
- **`react-router` is pinned to 7.18.2 with one open advisory.** GHSA for RSC-mode CSRF
  covers `>=7.12.0 <8.3.0`, and 8.3.0 is the only clean version but requires Node
  `>=22.22.0` against this machine's 22.21.1 and the project's declared `>=22.6`. The
  advisory needs React Router's RSC mode — server components and server actions — and this
  is a client-only SPA on `createBrowserRouter` with neither, so it is not reachable.
  Going *below* the range is worse, not better: 7.11.0 is exposed to a dozen advisories
  fixed in 7.18.0, including the two that do apply to a client SPA (open redirect via
  `<Link>`/`useNavigate`, and a route-matching DoS). Bump Node to 22.22+ and move to
  `react-router@8` to clear `npm audit` entirely.
