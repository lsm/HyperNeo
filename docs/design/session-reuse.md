# Roles: who works on a todo, and which session they use

Status: proposal, 2026-11-17. Design only. Replaces the "Session strategy" section of
`pack-preferences.md`. Paths without a prefix are under `packages/daemon/src/lib/`.

## Why

A todo often has more than one actor: someone does it, someone checks it. Today only the
coding pack knows this, and it also picks sessions on its own (`NeoPack.workerTarget`,
`neo/packs/coding/session-target.ts`), so work has reached sessions the daemon never
started, including the human's own. No other pack can say "someone else checks this", and
core cannot keep one reviewer across review rounds.

## The design

A **role** is a core label for the part an actor plays on one todo: `do`, `review`,
`verify`, `check`. Neo names it on `work.start`; no role means `do`. Roles are not a fixed
workflow. Core's rules:

1. **Same todo, same role, same session.** A later round goes back to that session; if it
   is busy, the work waits. A new one starts only when it is gone.
2. **Different roles, different sessions.** A pack may let roles share
   (`NeoPack.roles?: Record<string, { shareWith?: string[] }>`); coding keeps all apart.
3. **Only sessions the daemon started.** No pack can change this.

One superpipe in `reuseIdleWorker` (`drivers/work-operations.ts`) picks the session: read
facts, one pure function decides, then send, wait or start new. The decision: (A) this
role's session on this todo, waiting if busy; else (B) a free worker allowed by the
`sessionReuse` setting, skipping sessions in another role on this todo; else (C) start new.

**`sessionReuse`, asked on a card.** A core preference, scope project then global:

| Value | Step B | Card label |
|---|---|---|
| `long_lived` (default) | a free worker of this ask; start new if it is busy | Reuse when free |
| `per_ask` | only a worker of this ask; wait if it is busy | One session per matter |
| `per_todo` | none | One session per step |

The first time it matters, Neo asks one card (`pack.preferences.ask`, not holding the
work); `long_lived` applies until answered. There is no settings page.

A worker reused for another todo of its ask is compacted first, inside the same dispatch, so
the next todo never races the compaction. A failed compaction does not stop the dispatch. A
later round of the same todo, and a session the human named, are not compacted. Nothing is
compacted when a todo finishes: many finished workers are never reused.

**Start record.** When `work.start` starts a session, the daemon records on
`work_started_sessions`: who started it, for which ask, todo and role, the machine and
folder, the confirmed harness, provider, model and effort, its preparation, and at the end
when and why it was released, made unusable or archived. Release, archive and reuse act
only on sessions with this record.

## Change plan

Four PRs from `dev`, in order, failing tests first.

1. **`sessionReuse` and a clearer card.**
   - Applied in `reuseIdleWorker`. `per_ask` waits through `todoWorker.wait`; this PR lets
     `queueOn` and `todoWorker.wait` take a `doing` todo with no worker yet.
   - The settings card changes for every pack (`formatPreferenceChoice`): the title is a
     new per-language `question`; one line per option from a new `valueDescriptions`; no
     tables; "Use the default for now" when nothing is saved; with language `system`, the
     language of the human's latest message.
   - Coding `sessionStrategy` values are copied to the owning project (`per_task` and
     `per_pr` become `per_todo`); the coding pack stops asking. Old rows stay until PR 2,
     so coding keeps its old values in between.
   - Accepted: two todos of one ask starting at once under `per_ask` may each start a
     session. It costs one extra session, never a wrong one.
2. **The coding pack stops picking sessions.** `workerTarget` keeps model-line ranking and
   stage model/effort and drops session strategy, the feature reservation, PR-holder
   routing and takeover. Review findings still reach the author through the PR sweep.
   Until PR 4 a new round may start a new reviewer.
3. **Start record.** The columns above on `work_started_sessions` (only
   `work-started-sessions.ts` reads or writes it); its `role` column is renamed `kind`.
   Trusted = a row this code wrote, or an older row with `kind = 'worker'`, which is the
   rule `readStartedWork` already applies for archive and release. Older rows without it
   are never trusted: the table also holds sessions Neo claimed but did not start.
4. **Roles in core.** `work.start` takes `role`. A new table
   `neo_todo_roles (todo_id, role, adapter, id, at, model, effort)` gets a row per round,
   seeded with `do` from `neo_todo_sessions` for refs that have a start record. The
   superpipe above. Today `reuseIdleWorker` never reuses when a start carries
   `preparation` (worker sandbox), which review and write starts do; PR 4 lifts that and
   reuses only a session whose record has the same preparation.
   Coding passes `do` / `review` / `verify` and the earlier reviewer's model, and drops
   its own `excludeRefs`. The one-worker-per-todo claim becomes per role.

`bun run system-map impact`: `work-operations.ts` has 29 importers; PR 4 only adds an
optional input to `work.start`. `session-target.ts` has one importer, the coding pack.

## Acceptance

| Case | Expected |
|---|---|
| a PR reviewed in three rounds | one author session, one reviewer session |
| reviewer busy at a new round | the round waits for it |
| reviewer archived | a new reviewer, not the author |
| verify after review | a third session |
| a pack lets `do` and `check` share | `check` may reuse the `do` session |
| a free session the daemon did not start | never reused, released or archived |
| a worker started before the upgrade | reused and reclaimed as today |
| a new start | its record has all the fields above |
| no `sessionReuse` saved | one plain card in the human's language; `long_lived` meanwhile |
| `per_ask` | only the ask's worker; waits if busy |
| `per_todo` | never reuses another todo's worker |
| a repository saved as `per_pr` | its project reads `per_todo` |

## Later, only when needed

- A role rule `otherModel: true`, so a check runs on another model.
- Drop `pack_coding_feature_sessions` and old `sessionStrategy` text in
  `pack-preferences.md` and `model-lines.md`.
