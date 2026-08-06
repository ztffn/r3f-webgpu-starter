# Player statistics — the metric catalogue, the telemetry it needs, and the pages

**Date:** 2026-08-04
**Status:** design. The pages and the metric set are decided here FIRST; the engine is then
changed to emit what they need. That order is deliberate — designing the stats around
whatever the server happens to log already is how a stats page ends up being a list of
counters nobody asked for.

**Reference:** `dfhub.net` is the statistics site for Delta Force, the game this project is a
spiritual successor to. Its metric vocabulary is therefore **the spec, not a comparison
point.** DF players already know what Sniper Kill %, Zone Time and Dominance mean, and
inventing a private vocabulary would throw away that recognition for nothing. Where this
document departs from dfhub it is only to add metrics DF1 server logs could not produce and
ours can.

---

## 1. What a stats page is for

One question, asked by two people:

- A player: *am I getting better, and at what?*
- A clan recruiter: *is this person worth inviting, and what would they bring?*

Both are answered by **derived** figures, not counters. "225 kills" answers nothing;
"K/D 1.57, headshot rate 3.6%, 86% specialised on one weapon, patience 15/100" is a verdict.
Every page below is built to render a verdict.

## 2. The metric catalogue

Adopted from dfhub, grouped as it groups them. **Bold** entries are ones this project can
produce that DF1 log parsing could not, because we own the server and the ballistics.

### 2.1 Career and activity
Time played · matches played · first seen · last seen · match participation rate ·
matches per week · online streak (best, current) · favourite game type · rank points ·
rank with progress to next

### 2.2 Combat
Kills · deaths · K/D · dominance factor · consistency (σ over matches) ·
sniper kills and share · pistol kills and share · knife kills and share ·
headshots and rate · total shots · accuracy · combat score · combat rating ·
suicides · team kills · highest kill streak · best weapon

**Added:** median engagement range · range-band histogram (0–200 / 200–500 / 500–800 /
800–1200 / 1200 m+) · first-round hit rate · cold-bore hit rate · **time concealed**.
The last one is the only metric here unique to this game: concealment is the system DF2 is
remembered for, `grassHeightField` already answers "is this player hidden", and nothing else
in the genre can report it.

### 2.3 Objectives
Flags · pickups · saves · flag efficiency · flags per life · flag carrier kills ·
zone defend · zone attack · zone time and share · zone time per life ·
objective score · support/defence score

### 2.4 Match results
Team and solo matches · wins / losses / draws · win % · team MVP · solo MVP · first bloods

### 2.5 Personal bests
Most kills · most headshots · longest streak · best objective score · best support score —
each carrying **the map and the date**, because a record without its circumstances is a
number rather than a story.

### 2.6 Relationships
Nemeses (who kills you, and how often) · victims (who you kill). This is the social half of
the stats and it feeds the community layer directly: a nemesis is a name you want to click.

### 2.7 Derived profile — the verdict
- **Play style:** primary role plus a secondary trait ("Assault — Reckless")
- **Aggression index** and **patience score**, 0–100
- **Weapon profile:** preferred class, sniper share, diversity, specialisation %, shots/kill
- **Tactical profile:** objective vs combat focus, team contribution, first-blood rate

### 2.8 Breakdowns
Per weapon: kills, share, shots, shots/kill, headshots, HS%, KPM, time used, mastery level.
Per map: matches, kills, deaths, K/D, **versus the site average**, KPM, shots/kill, HS%, time.

## 3. Telemetry the engine must emit

This is the whole engine ask, and it is three tables. Everything in §2 derives from them; no
metric gets its own column.

```
match_participation      one row per player per match
  user_id, match_id, map, mode, team,
  joined_at, left_at, result ('win'|'loss'|'draw'),
  score, objective_score, support_score,
  prone_ms, crouch_ms, stand_ms, moving_ms, concealed_ms,
  shots_fired, best_streak

engagement               one row per shot that resolved against a player
  match_id, shooter_id, target_id, at,
  weapon_id, range_metres, hit, fatal, headshot,
  shooter_stance, hold_ms          -- stationary time before the trigger
  first_of_engagement              -- for first-round and cold-bore rates

objective_event          one row per objective action
  match_id, user_id, at, kind ('flag_take'|'flag_cap'|'flag_save'|'zone_attack'|'zone_defend'),
  zone_id, held_ms
```

Three properties this schema has on purpose:

1. **`engagement` carries `range_metres`.** dfhub can report Sniper Kill % because DF logged a
   weapon; it cannot report the distance. Our ballistics layer knows it exactly, and range is
   the axis this game is actually about. Every range metric in §2.2 comes from this column.
2. **Nothing stores a derived value.** K/D, consistency and the play-style verdict are
   computed on read. A stored ratio is a ratio that goes stale the moment a row is corrected.
3. **`career` stays** as the authoritative totals. These tables are the history, exactly as
   `sessions` already is — re-deriving lifetime totals from events on every page load would
   be slower and could disagree after any pruning.

**Blocked on `feat/server-ballistics`:** everything in `engagement`. That branch owns the
authority for a resolved shot, and inventing kills from client reports is the one thing this
project has consistently refused. `match_participation` and `objective_event` are not blocked
and can land first, which is why the page design below degrades cleanly.

## 4. The pages

| Route | Job | Ranks / keys on |
| --- | --- | --- |
| `/players/:id` | The scouting report. The flagship. | — |
| `/leaderboard` | Who is best, on several axes at once | rank points, K/D, win %, rating, objective, consistency, time |
| `/weapons` | Which weapons the population actually uses | kills, share, shots/kill, HS% |
| `/weapons/:id` | One weapon's profile and its top users | — |
| `/maps` | Which maps play how | matches, average K/D, average range |
| `/compare?a=&b=` | Two players side by side | every §2 figure, diffed |
| `/clans/:tag` | A unit's aggregate, and its roster ranked | member contribution |

### 4.1 `/players/:id` — the scouting report

The layout already built (hero plate, DOPE column, wall) is the right frame; this fills it.
Order matters — a recruiter reads top to bottom and stops when they have decided:

1. **Identity and verdict.** Callsign, clan tag, rank with progress, and the one-line play
   style: *"Overwatch — patient, long-range specialist."* The verdict is the headline because
   it is the answer to the question the page is open for.
2. **The four figures that settle it.** K/D, median engagement range, headshot rate, win %.
   Set large, in mono, with the population median beside each so a number means something to
   someone who has never seen another profile.
3. **Range-band histogram.** The signature chart of this game: where this player kills from.
   A wall of bars at 200 m and a wall at 900 m are two completely different players, and no
   other statistic separates them as fast.
4. **Play style, weapon profile, tactical profile** — dfhub's three tables, unchanged.
5. **Personal bests**, each with map and date.
6. **Weapons table**, then **maps table**, both sortable, `vs average` on the map rows.
7. **Nemeses and victims**, as two short ranked lists of links.
8. **Match history**, the last 20, one row each.
9. **Ribbons and activity**, which already exist.
10. **The wall**, which already exists.

**Degradation is designed, not incidental.** Until `engagement` exists, sections 2–4 and 7
have no data. They are not rendered as zeroes and they are not silently dropped: each shows
its frame with the label *"needs the combat authority work"* — the same honesty the
leaderboards already use for an unpopulated board, and the same reason.

### 4.2 `/leaderboard`

dfhub's shape, which is right: one row per player WITH ACTIVITY on the ranked axis — the query
excludes anonymous and zero-valued accounts and bounds the scored pool, because it is a public
route (§5.9) — ranked by composite points, with K/D,
win %, rating, objective, consistency and time as columns so the eye can re-rank without
another request. Rank insignia at the left, callsign as the link, numerics right-aligned in
mono. Add a **range column** — median engagement range — because it is this game's axis and
it is the column that will make somebody click a stranger.

## 5. Rejected

| Proposal | Why |
| --- | --- |
| A private metric vocabulary in place of dfhub's | DF players know these terms. Recognition is worth more than novelty, and the successor should feel continuous with the game it succeeds. |
| Storing derived ratios | They go stale the moment a source row changes (§3.3). |
| Rendering unavailable sections as zero | An empty kills table that looks populated is a claim nobody has killed anyone. The frame-with-a-reason pattern already in use is the honest one. |
| Rank points as a purchasable or grantable thing | Fair-play line: earned, never bought (`web-platform-and-ui-design.md` §6). |
| Public per-match location traces | A concealment game cannot publish where people hide. Aggregate range bands are fine; a heatmap of firing positions is a cheat sheet. |

## 6. Open

- **`match_participation` has no writer, and it is NOT blocked on ballistics** — it is simply
  unbuilt, which makes it different from `engagements` and easy to mistake for done. Three
  readers already depend on it (`playerStats`, `StatsRepository.leaderboard`, `.maps`), so
  until a writer exists every win, loss, draw, stance duration and shot count is absent.
  The room knows the match identity, map and join/leave times at `onLeave` already; the
  per-player stance and shot counters are the part that does not exist.
  Do **not** write a partial row to light the section up: a row with zeroed counters makes
  `available.objectives` true and every figure above it a false claim. This is exactly what
  `patienceScore` did before it was fixed — with all three stance counters at zero the formula
  read "never moved" and answered a confident 40/100 for every player alive.
- **Composite rank points formula.** dfhub's is not published. Ours needs to weight objective
  play and survival, not only kills, or it becomes a K/D ladder with extra steps. Unsolved.
- **Population medians** need a nightly aggregate; computing them per request will not hold.
  The per-request cost is now counts-in-SQL plus one read of the FATAL engagement rows
  (`/stats/weapons`, `/stats/maps`), which is bounded by total kills rather than total shots —
  enough for a small population and still the next thing to materialise.
- **Game modes.** Zone and flag metrics assume King of the Hill and Capture the Flag exist.
  Neither is built; the columns are specified so the schema does not need migrating when they
  are.
