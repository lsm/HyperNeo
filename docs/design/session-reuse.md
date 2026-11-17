# Session reuse follows asks and todos

Status: proposal, 2026-11-17. Design only. Replaces the "Session strategy" section of
`pack-preferences.md`. Paths without a prefix are under `packages/daemon/src/lib/`.

## Why

Neo's work is already shaped as asks and todos, but session reuse is decided twice, by two
rules that use other units:

1. **Core** (`drivers/work-operations.ts` `reuseIdleWorker`, `drivers/worker-reuse.ts`).
   When Neo starts work, the daemon reuses a free worker that it started itself
   (`work_started_sessions.role = 'worker'`) in the same folder, preferring one that worked
   on the same ask.
2. **The coding pack** (`neo/packs/coding/session-strategy.ts`, `session-target.ts`,
   `session-assignments-worker.ts`). Before core starts the work, the pack can turn Neo's
   `start` into a `send` to an existing session. It does this by repo preference
   `long_lived` / `per_task` / `per_pr`, by a feature reservation keyed by repo and ask,
   and by which session already holds the todo's PR. Core then queues the todo on that
   session (`neo/todo-runner.ts`, the `queueOn` write after `workerTarget`). No check is
   made on who started the session.

Because the second rule ignores the first rule's check, work has been sent to sessions the
daemon never started, including the human's own sessions. The units also don't match the
rest of the system: "task" means a todo, and "PR" is a coding idea, so the setting can't
apply to other packs' work.

## The design

Core decides which session takes the work. Packs only say who must not take it and which
model to ask for. Core knows todos and sessions, not authors, reviewers or PRs.

### Core

**A todo's workers.** Core records every session the daemon starts or reuses for a todo:
a new core table `neo_todo_workers (todo_id, adapter, id, at)`, written by `work.start`
whenever it carries a `todoId`. This replaces the one-worker-per-todo claim rule
(`claimWorker` in `packages/daemon/src/storage/repositories/neo-todo-session-repository.ts`
refuses a second claimed worker for the same todo). Today a todo's author is recorded in
`neo_todo_sessions`, and its reviewers only in the coding pack's facts, so core cannot see
them.

**Picking a session.** Reuse happens only in `reuseIdleWorker`, only among sessions the
daemon started (`work_started_sessions.role = 'worker'`), and never among the request's
`excludeRefs`. Order:

1. **The todo's own worker.** A worker in `neo_todo_workers` for this todo, same adapter,
   not excluded. If it is free, send there. If it is busy, the work waits for it: the
   message is queued on that worker and delivered when it is free (the existing todo
   queue, `todoWorker.wait` in `drivers/work-operations.ts`, extended to a todo that is
   already doing). A new session starts only when no such worker is left (archived,
   released or unusable).
2. **Otherwise, the setting** below.

The setting `sessionReuse` decides step 2:

| Value | Step 2 | Label shown to people |
|---|---|---|
| `long_lived` (default) | any free worker in the same folder; one that worked on the same ask first (today's core rule) | Long-lived sessions |
| `per_ask` | only a worker that already worked on this todo's ask; if it is busy, wait for it as in step 1; start new only when the ask has none | One session per matter |
| `per_todo` | none; start a new worker | One session per step |

"Worked on this ask" reads `neo_todo_workers` joined to the ask, so reviewers count too.

**Prepared starts.** `reuseIdleWorker` today gives up before any reuse when the start
carries a `preparation` (`drivers/work-operations.ts`), which review, verify and write
starts do when the worker sandbox is on. Steps 1 and 2 instead also apply to a prepared
start, but only to a candidate that was itself started with the same preparation pack and
sandbox setting; `neo_todo_workers` records both. The per-round parameters (PR, head,
role) go in the message, as the review brief already does. A candidate prepared
differently is skipped.
Neo's explicit `send` to a named session is unchanged; this only decides what a `start` may
reuse.

**Where the setting is stored.** A core preference `sessionReuse`, scope `project` (the
todo's ask `projectId`), falling back to `global`, then to `long_lived`. It uses the
existing preference store; core declares it as pack id `core`
(`neo/preference-operations.ts` reads declarations by pack id). The settings page today
writes pack preferences only at global or repo scope
(`packages/web/src/components/settings/PackSettings.tsx`), so it gains a session-reuse
block that shows, sets and clears the global value and each project's value. No question
is asked before first use.

### Packs

A pack does not pick sessions. When it starts work for a todo it passes two things it
already knows:

- **Who must not take it:** `excludeRefs`, as the coding pack already does for review
  (`neo/packs/coding/assign-operation.ts`) and, for write starts, through
  `workerStartExclusions` (sessions that acted as reviewers or verifiers,
  `neo/packs/coding/pack.ts`).
- **Which model:** the start's `model` and `effort`.

**Coding.**

- Review excludes the author. Verify excludes the author and the reviewer. With the author
  excluded, the todo's remaining worker is the earlier reviewer, so step 1 picks it.
- A new review round asks for the earlier round's reviewer model and effort, read from the
  pack's own assignment facts. Reuse requires a matching model
  (`drivers/work-operations.ts`, `workStartConfiguration.confirm`), so this keeps the
  same reviewer when a new ranking would pick another line.
- A PR's review findings and CI failures still go straight to the author's session through
  the PR sweep (`neo/packs/coding/pr-sweep.ts`, `deps.tell(row.owner, …)`). This is not
  dispatch and the setting does not touch it.
- `workerTarget` keeps model-line ranking and stage model/effort (the second half of
  `session-target.ts`). It drops the session part: the strategy preference and its
  question, the feature reservation (`pack_coding_feature_sessions`), PR-holder routing,
  takeover and work-type session names.

Under `per_todo`, a PR is then one author session plus one reviewer session, kept across
review rounds.

**Other packs** write nothing; they get core's rule as is.

**Upgrade.** Saved coding `sessionStrategy` values move once to `sessionReuse` on each
project that owns the repo: `long_lived` → `long_lived`, `per_task` → `per_todo`,
`per_pr` → `per_todo` (a PR is one todo), keeping `set_by`. The old rows and the feature
table are then dropped. Existing todos seed `neo_todo_workers` from `neo_todo_sessions`
and the coding assignment facts.

## Change plan

Each slice is one PR from `dev`, failing tests first.

1. **Core: a todo's workers.** The table, its writes in `work.start`, the seed, and step 1
   with waiting; drop the one-claim rule.
2. **Core setting.** Declare `sessionReuse` and apply step 2.
3. **Coding pack.** Remove the session part of `workerTarget`, the strategy declaration
   and the reservation table; pass the earlier reviewer's model on a new round; move saved
   values. Mostly deletions.
4. **Settings page.** The session-reuse block: global value plus one row per project,
   each settable and clearable.
5. **Docs.** Replace the "Session strategy" section of `pack-preferences.md` with a link
   here.

Acceptance, one integration case per row:

| Case | Expected |
|---|---|
| `per_todo`, a PR reviewed in three rounds | one author session and one reviewer session throughout |
| the earlier reviewer is busy when a new round starts | the review waits and goes to it; no new session |
| the earlier reviewer was archived | a new reviewer starts |
| worker sandbox on, second review round | the first round's (sandboxed) reviewer is reused |
| verify after review | a third session, neither author nor reviewer |
| `long_lived`, a free daemon worker that worked on the same ask | reused |
| `per_ask`, a free daemon worker that only worked on another ask | new worker started |
| `per_ask`, the ask's daemon worker is busy | the todo waits for it; no second session |
| `per_todo`, a free worker from another todo | not reused |
| any value, a free session the daemon did not start | never reused |
| saved `per_pr` on a repo | the owning project reads `per_todo` |
