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
| 7 | Entitlements, medals, supporter perks, checkout stub | 5 | not started |
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

**Route split verified**, not assumed: the entry chunk is 307 KB (98 KB gzipped) and mentions
`three-*.js` only inside Vite's `__vite__mapDeps` preload table for the lazy chunk. Three.js
and the game are separate chunks that a visitor reading the FAQ never fetches.

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
tests/account/   account-types, characters, repository (47 assertions)
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
tests/account/lobby.test.ts     12 assertions
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

- **The host cannot see their own join code.** The room mints one and logs it; there
  is no message that delivers it to the host, so the Lobby says so plainly instead
  of promising a code it cannot show. Needs a packet on the game connection.
- **Clans and community-hosted servers are not built.** The metadata carries
  `community` and `hostCallsign` and the browser renders them, but nothing sets
  them — `foundClan`, `hostCommunityServer` and `reservedSlot` remain ungranted
  capabilities. That is phase 6b.
- **Kills and deaths.** Waiting on feat/server-ballistics; `recordLongestShot`
  exists and is tested but has no caller yet.

## 6. Retention model — what the perks actually are

The brief's shape is "easy to play, better to register". Concretely:

**Free, no account.** One click from the landing page into a live match as `Recruit-####`.
Nothing is asked for. This is the funnel's whole job and it must never gain a step.

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

- **Hosting.** The Colyseus server needs a home with WebSocket support; Netlify hosts only
  the static client today. Colyseus Cloud, Fly.io and a plain VPS are all viable and the
  choice does not affect any code in phases 1–7.
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
