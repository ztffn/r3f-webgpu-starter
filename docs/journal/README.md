# Journal — raw session write-ups

This is where a session dumps a raw, unpolished technical write-up right after doing
non-trivial work — before it's been shaped into anything public. `docs/plans/` is for
design decisions going forward; this is for capturing what actually happened, close
to when it happened, before the details are forgotten. Nobody edits these for voice —
that happens later, in `docs/devlogs/`.

A feature often stretches across several sessions. Each session gets its own journal
entry. When the feature is far enough along to write up, `/devlog` reads every journal
entry for that feature and rewrites them into **one** post in `docs/devlogs/`
— chaptered if the sessions were genuinely distinct enough to warrant it, one flowing
piece if they weren't. Don't force chapters onto two entries that read fine as one.

## File convention

`docs/journal/YYYY-MM-DD-<feature-slug>.md`

```markdown
# [Title] — journal

**Feature:** <feature-slug>
**Date:** YYYY-MM-DD
**Status:** raw

[Whatever's useful to remember: the goal, what broke, what you measured, what you
tried and threw away, what shipped, what's still open. Own voice, no polish pass.]
```

Use the same `<feature-slug>` across every entry for the same feature — that's the
only thing that links them together later. Doesn't need to match a `docs/plans/*.md`
filename, but reuse one if it's the same piece of work.

Once `/devlog` folds an entry into a published post, it flips the status:

```markdown
**Status:** folded — see `docs/devlogs/<feature-slug>.md`
```

A folded entry stays in place — it's the source record, not deleted once published.

## What goes here vs. `docs/plans/`

- **`docs/plans/`** — decisions. What we're going to do and why, written *before or
  during* the work, meant to be read as project history / rationale.
- **`docs/journal/`** — what happened. Written *after* a session, raw, meant to be
  source material, not a finished artifact.
- **`docs/devlogs/`** — the finished, public-voice write-up assembled from one or
  more journal entries. See `.claude/skills/devlog/SKILL.md`.
