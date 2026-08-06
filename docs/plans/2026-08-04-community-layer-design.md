# Community layer — profiles, tagwall, friends and clans

**Date:** 2026-08-04
**Status:** design. No code exists for any of it yet. This document decides the schema, the
moderation model and the build order before anything is written, because the four features
share tables and a privacy model and designing them one at a time would mean migrating twice.

**Why this exists.** The monetization brainstorm
(`2026-08-04-monetization-and-retention-brainstorm.md` §5.3, §10.4) concludes that this
project's constraint is never server cost — it is audience, and audience is a retention
problem. Its Direction 4 names retention as the highest-leverage work in the document and
community-as-moat as the defensible asset. This is that work.

---

## 1. The gap being closed

An audit of what exists today, and it is worse than "some social features are missing":

| Fact | Evidence |
| --- | --- |
| **No screen renders another player.** Every route is "me": profile, loadout, my leaderboard row. | `src/site/routes.tsx` |
| **`GET /api/players/:id` returns a full public profile and no client has ever called it.** | `tools/account/api.ts`; zero client references |
| **`friends` is granted to every registered account and implemented nowhere** — no table, no endpoint, no UI | `src/account/tiers.ts:54` |
| Leaderboard callsigns are plain text; the server browser's `hostCallsign` is a string | `Leaderboard.tsx`, `Lobby.tsx` |

The third one is a promise being broken in writing: the supporter page renders
`CAPABILITY_LABELS.friends` — "Friends list and squad invites" — to every visitor.
`tiers.ts`'s own header says the single table exists so that "a perk described on the page
that no gate enforces" cannot happen. It happened.

## 2. Prior art: MapMakers Heaven

The project owner ran a DF2 community site (2004–) with thousands of members. Its member
page is the reference, and what it got right is worth naming precisely, because it is not
what a modern game menu does:

- **A profile is a place, not a readout.** It has an owner, and other people leave things on
  it. The **tagwall** — short public messages from other members — is the centre of it.
- **The activity feed is about contribution**, not play: commented on someone's map, tagged
  someone, uploaded a file, had a map approved. The unit of status is *what you made and who
  you talked to*, not how many hours you logged.
- **Medals are images on a shelf**, awarded and displayed, alongside a rank strip.
- **Statistics count artefacts** — posts, maps, images, files, comments, tags — not sessions.
- Everything is reachable from everything: a name in a feed is a link to a person.

The loop is: *see someone → look at their page → leave something on it → they see it.*
Nothing in Distant Front opens that loop today, let alone closes it.

**What is deliberately NOT copied:** the points total (`503 POINTS`). Points aggregate
contribution and play into one score, and the moment a number like that exists people
optimise it. Pillar 11 and the monetization document both reject session-count reward
mechanics. Contribution points would be defensible once user-generated maps exist — there
would be something to earn them *for* — and are rejected until then. See §7.

## 3. Decisions

### 3.1 A profile is public, and it is the hub

`/players/:id` becomes a real route rendering the `PublicProfile` the server already
returns. Every callsign anywhere — leaderboard rows, server-browser hosts, tagwall authors,
clan rosters — links to it. This is the cheapest item in the document (the endpoint exists)
and it is a precondition for the other three: friending, posting and clan rosters all need
somewhere to point.

`/profile` stays as the owner's private view (email, session, rename, sign out). The public
view never shows email or session state — that separation already exists in the
`Account` / `PublicProfile` split and is the reason it exists.

### 3.2 The tagwall is plain text, and it is moderated by the owner

The one peer-to-peer primitive. Decisions that are not obvious:

- **Plain text, escaped, never rendered as markup.** A public field on someone else's page is
  the highest-value XSS target in the product, and there is no feature here that needs bold.
- **The profile owner can delete anything on their own wall**, without asking anyone. The
  wall is their space; a report queue as the only remedy makes harassment the platform's
  problem to schedule rather than the victim's to end.
- **Blocking prevents posting**, and is separate from friendship — not a friendship state.
  Someone you have never met can need blocking.
- **Rate limited and length capped** (below). A wall is a spam target the moment it exists.
- Posting requires a registered account. Guests can read.

### 3.3 Friends are a request and an acceptance, and presence is friends-only

A directed request that becomes a mutual edge on acceptance. Not auto-mutual: a follow model
makes a stranger's name appear on your page without consent.

**Presence — "your friend is in this server" — is the retention mechanism**, and it is the
reason friends rank above clans in the build order. The lobby already queries the
matchmaker; the rooms already track which account each session belongs to
(`GameRoom.sessions`). Joining those two gives "three friends are playing right now" for the
cost of a module-scope registry.

Presence is visible **to accepted friends only**. Broadcasting which room any named player is
in is a stalking primitive, and in a game whose entire premise is concealment it is also a
gameplay leak.

**The registry is keyed by SESSION, not by account**, and that correction matters because one
account genuinely can be in two rooms at once — `recordSession` says so itself where it
explains why the career write is an incrementing `UPDATE` rather than read-modify-write. A flat
`Map<accountId, roomId>` looked sufficient and was not: the second join overwrote the first,
and then the second *leave* deleted the entry outright while the player was still in the other
room, so a friend who was demonstrably playing read as offline. It is now
`Map<accountId, Map<sessionId, roomId>>`, and an account disappears from presence only when
its last session does. The endpoint still publishes one room per friend — it answers "is this
friend in a game", and listing every room a person is in would publish more, not less.

### 3.4 Clans are founded by supporters and joined by anyone

`foundClan` is already a supporter capability; joining is not gated at all. That asymmetry is
the monetization posture stated exactly: **supporters get to run things, players get to do
things.** A clan that only supporters could join would be a paid team advantage, which the
fair-play line forbids.

A clan has a tag (2–5 characters, unique, the thing that appears beside a name), a name, a
founder, a roster with roles, and a page. It is the anchor the community-server product
(monetization Direction 2) later attaches to.

### 3.5 The activity feed is derived, not stored

MapMakers Heaven's feed is the thing that makes a profile feel alive. It is tempting to add
an `activity` table written on every event.

**Do not.** Every row in it would duplicate a fact that already has a home — a medal's
`awarded_at`, a clan membership's `joined_at`, a tagwall post's `created_at` — and a
duplicated fact is a fact that can disagree with itself. The feed is a UNION over those
tables ordered by time, computed per request. It cannot drift, it needs no write path, and it
costs one query on a page nobody loads in a loop. Revisit only if that query is measured to
be slow, and note that the indexes to make it fast are the same ones the tables need anyway.

## 4. Schema

One appended migration. `MIGRATIONS` in `tools/account/database.ts` is append-only and a
shipped entry is never edited.

```
friendships
  id             integer pk
  requester_id   -> users.id  cascade
  addressee_id   -> users.id  cascade
  state          'pending' | 'accepted'
  created_at     text
  responded_at   text null
  pair_key       text not null unique     -- min(a,b):max(a,b). See below; added in a later migration
  unique (requester_id, addressee_id)
  index (addressee_id, state)     -- "my incoming requests"
  index (requester_id, state)

blocks
  blocker_id     -> users.id  cascade
  blocked_id     -> users.id  cascade
  created_at     text
  primary key (blocker_id, blocked_id)

profile_posts                      -- the tagwall
  id             integer pk
  profile_id     -> users.id  cascade   -- whose wall
  author_id      -> users.id  cascade
  body           text                   -- plain, <= 280
  created_at     text
  index (profile_id, created_at desc)

clans
  id             integer pk
  tag            text unique            -- 2-5 chars, [A-Z0-9]
  name           text
  founder_id     -> users.id
  created_at     text

clan_members
  clan_id        -> clans.id  cascade
  user_id        -> users.id  cascade
  role           'leader' | 'officer' | 'member'
  joined_at      text
  primary key (clan_id, user_id)
  unique (user_id)                      -- one clan per player, for now

action_log                              -- added 2026-08-06; see the note below
  id             integer pk
  user_id        -> users.id  cascade
  action         'post' | 'friend_request'
  target_id      integer null           -- whose wall, for a per-target limit
  at             text
  index (user_id, action, at)
```

**`action_log` is append-only, and that is the whole point.** The per-hour limits used to
count LIVE rows — `profile_posts` for the walls, pending `friendships` for requests — so both
were resettable by the actor: deleting your own posts cleared the per-wall limit that exists
to stop harassment, and withdrawing a request cleared the spam bound. A log nobody can delete
is the only counter that holds. Web design record §5.9.

**`unique (user_id)` on `clan_members` is a real decision**, not a shortcut: multi-clan
membership makes "which tag appears beside this name" ambiguous, and the tag beside the name
is the entire visible point of a clan.

**Friendship is stored once, not twice.** A row is the edge; "my friends" queries both
columns. Two rows per friendship is the shape that eventually disagrees with itself.

**`pair_key` is what actually enforces that, and `unique (requester_id, addressee_id)` never
could.** This was written down wrong first, and the wrong version was in a code comment
claiming the repository normalised the order before inserting — it did not, and normalising
the columns would not have been right either, because `friendState` reads
`requester_id` to tell `pending_out` from `pending_in`, so the direction is load-bearing
information rather than an artifact.

The hole: `(A,B)` and `(B,A)` are *different* keys to that index. `requestFriend` reads the
existing edge in both directions and then inserts, which is a window — two people pressing
"add friend" in the same moment both saw no edge, both inserted, and the index accepted both.
The result was two pending rows for one pair, `edge()` returning whichever the engine handed
back first, and an accept that resolved one of them while the other stayed pending in the
recipient's request list forever.

So the direction columns stay authoritative and `pair_key` carries no information of its own:
it is `min(id, id):max(id, id)`, numeric rather than lexicographic (as text, `"10"` sorts
before `"9"`, which would give `(9,10)` and `(10,9)` two different keys and reopen the hole),
and it exists only so the database can refuse. `requestFriend` catches the unique violation
and returns the state the *other* request settled on, because the friendship it was asked for
does now exist — reporting an error for something that in fact happened is the wrong answer.

The migration backfills the column in application code rather than SQL, because two-argument
`min()` is SQLite's spelling and `least()` is Postgres's, and not writing that branch twice is
the whole reason this project uses a query builder. It creates the unique index *after* the
backfill, so a database that already contains a duplicated pair fails the migration — which
is correct: that is precisely the corruption the index exists to prevent, and silently
dropping one side of it would be worse than refusing to start.

## 5. Limits, and what enforces them

Every one of these is enforced **server-side**, with the client mirroring it only as a
courtesy — the same one-rule-two-callers discipline `validateCharacter` already uses.

| Limit | Value | Why |
| --- | --- | --- |
| Tagwall post length | 280 chars | It is a note, not a forum. Longer belongs in a forum this project does not have. |
| Tagwall posts per author per hour | 10 | Spam ceiling low enough to be useless, high enough that a real conversation never hits it. |
| Tagwall posts per author per wall per hour | 3 | Stops one person filling one wall, which is the harassment shape rather than the spam shape. |
| Friend requests pending, outgoing | 50 | A request is a notification; unbounded requests are a spam vector. |
| Clan tag | 2–5 of `[A-Z0-9]` | Same charset rule as callsigns and insignia, for the same homoglyph reason (`accountTypes.ts`). |
| Clan name | 3–32, control characters stripped | It renders in other people's lists. |
| Clans founded per account | 1 | Founding is the supporter perk; hoarding tags is the abuse. |

Capabilities added to `tiers.ts`: **`profilePosts`** (enlisted). `friends` already exists and
is finally enforced. `foundClan` already exists and is finally enforced. Nothing new is
granted to supporters — this phase gives the free tier its social features and makes the
supporter tier's existing promises real.

## 6. Build order

Each step leaves the tree working and is independently useful.

1. **Public profile route.** Client only; the endpoint exists. Link every callsign to it.
2. **Migration + repository + tests** for all five tables at once. One migration, no drift.
3. **Tagwall**: `GET/POST/DELETE /api/players/:id/wall`, rendered on the profile.
4. **Friends**: request / accept / remove / block, a list on the owner's profile.
5. **Presence**: module-scope registry in `server.ts`, `GET /api/friends/presence`, surfaced
   in the lobby as "friends playing now".
6. **Clans**: found (in one transaction), join, leave WITH automatic leader succession,
   promote, roster, `/clans/:tag`, tag beside the name everywhere. §5.9 of the web record has
   why succession exists: refusing a leader's exit with no promote endpoint trapped them.
7. **Activity feed** derived over the tables, on the public profile.

## 7. Rejected, and why

| Proposal | Why not |
| --- | --- |
| **A points total** (MapMakers Heaven's `503 POINTS`) | Aggregates contribution and play into one optimisable number. Pillar 11 rejects session-count rewards, and there is no user-generated content yet for contribution points to measure. Revisit with the map editor (roadmap Phase 6). |
| **Private messages** | A full inbox is a moderation surface — reporting, blocking, retention, deletion-on-request — far larger than the tagwall's, for a job Discord already does for this community. The tagwall is public, which makes it self-policing in a way a DM inbox is not. |
| **A stored activity table** | Duplicates facts that already have a home (§3.5). |
| **Public presence** | Stalking primitive, and a concealment leak in a game about not being seen (§3.3). |
| **Follows / one-way friending** | Puts a stranger's name on your page without consent. |
| **Clan-only or supporter-only servers as a team advantage** | Fair-play line: supporters run things, they do not field better teams. |
| **Multi-clan membership** | Makes the tag beside a name ambiguous, which is the only thing a tag is for (§4). |
| **Markdown or HTML on the tagwall** | The highest-value XSS target in the product, for bold text nobody needs. |

## 8. What this does not settle

- **Moderation at scale.** Owner-delete and blocking are the whole model. There is no report
  queue and no moderator role, because there is no moderator. `DF2_ADMIN` can delete via the
  database. This is honest for a hobby project's size and will not survive a real community —
  when it stops being enough, the answer is a report table and a moderator capability, not a
  bigger rate limit.
- **Notifications.** Nothing tells you a post appeared on your wall or a request arrived,
  beyond seeing it next time you look. An email or a badge is a later phase.
- **Deletion and data export.** An account can be deleted today only by removing the row; the
  cascades above make that clean, but there is no self-service delete and no export. That is
  a real obligation once there are real users in the EU, and it is not built.
- **User-generated maps**, the deepest moat and the thing MapMakers Heaven was actually built
  around, wait on the map editor (roadmap Phase 6). Everything in this document is the social
  infrastructure that UGC would later plug into.
