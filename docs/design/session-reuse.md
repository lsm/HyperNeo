# Roles: who works on a todo, and which session they use

Status: proposal, 2026-11-17. Design only. Replaces the "Session strategy" section of
`pack-preferences.md`. Paths without a prefix are under `packages/daemon/src/lib/`.

## Why

A todo often needs more than one actor: someone does it and someone else checks it. A
pull request is written, reviewed and verified. A booked ticket is checked for the right
date. A contract edit is checked by another model. Today only the coding pack knows this,
and it also picks sessions on its own:

1. **Core** (`drivers/work-operations.ts` `reuseIdleWorker`, `drivers/worker-reuse.ts`)
   reuses a free worker the daemon started itself (`work_started_sessions.role =
   'worker'`) in the same folder, preferring one that worked on the same ask.
2. **The coding pack** (`neo/packs/coding/session-strategy.ts`, `session-target.ts`,
   `session-assignments-worker.ts`) can turn Neo's `start` into a `send` to an existing
   session through `NeoPack.workerTarget`: by a repo preference `long_lived` /
   `per_task` / `per_pr`, a feature reservation (`pack_coding_feature_sessions`), and
   the session that holds the todo's PR. Core then queues the todo there
   (`neo/todo-runner.ts`, after `pack.workerTarget`) without checking who started that
   session.

Because of (2), work has been sent to sessions the daemon never started, including the
human's own. And because roles live only in the coding pack, no other pack can ask for
"someone else checks this", and core cannot keep one reviewer across review rounds.

## The idea

A **role** is a core concept: the part an actor plays on one todo, such as `do`,
`review` or `verify`. Roles are labels, not a fixed workflow. Neo names a role when it
starts work, the same way it decides in natural language that something needs a second
look. A pack may declare rules for its roles; without a declaration core's defaults
apply. The flow of a todo comes out of the collaboration, not from a graph defined up
front.

Core's defaults:

- **Same todo, same role, same session.** Each later round of a role goes back to the
  session that played it before. If that session is busy, the work waits for it. Only
  when it is gone (archived, released or unusable) does a new one start.
- **Different roles on one todo, different sessions.** A session never plays two roles
  on the same todo, so a reviewer is never the author and a verifier is neither.
- **Only sessions the daemon started.** Reuse never picks a session without a start
  record (below), whatever any pack says.

A pack can loosen or tighten the second rule for its roles. For example, a life-admin
pack may let `do` and `check` share one session for low-stakes errands; the coding pack
keeps all three apart. A pack cannot loosen the third rule.

## Step 1

Four PRs, in this order.

**PR 1: the reuse setting, asked on a card.** A core preference `sessionReuse` decides
which free worker another todo may reuse (rule 2 below):

| Value | Rule 2 | Label |
|---|---|---|
| `long_lived` (default) | any free daemon worker in the same folder, one that worked on the same ask first (today's core rule) | Long-lived sessions |
| `per_ask` | only a free worker that already worked on this todo's ask; if it is busy, wait for it | One session per matter |
| `per_todo` | none; start new | One session per step |

- Core declares it (pack id `core`, read by `neo/preference-operations.ts`), scope
  `project` (the todo's ask project), then `global`.
- **It is asked on a card, never on a settings page.** The first time a Neo start in a
  project could reuse a worker and no value is saved for that project or globally, core
  asks one card through `pack.preferences.ask`, without holding the work (`hold: false`),
  as the coding pack's question does today (`neo/packs/coding/session-strategy.ts`).
  Until it is answered, `long_lived` applies and nothing is saved. When the human says
  they want to change it, Neo asks the same card again.
- **The card says plainly what it asks.** Today a settings choice card is built by
  `formatPreferenceChoice` (`neo/preference-proposal.ts`): a generic title ("Choose one of
  these settings?"), one near-identical table per option, a "Keep current settings" option
  even when nothing is set, and the declaration's own `ask` text unused. This PR changes
  that function for every pack, not only this setting:
  - the title is the declaration's question. `ask` is a plain English string today
    (`neo/pack-contract.ts`), so a new `question` field holds it per language, shaped like
    `label` (`{ en, 'zh-Hans' }`); `ask` stays as Neo's instruction;
  - each option is one line: its label and a one-sentence description, a new
    `valueDescriptions` field next to `valueLabels`, also per language; no tables;
  - when nothing is saved, the last option is "Use the default for now (<label>)", and the
    card says the work goes on with the default until it is answered; "Keep current
    settings" stays only when a value is saved;
  - it is written in the human's language. With the language setting at `system`,
    `proposalLocale` uses the machine locale, which produced an English card for a human
    who writes to Neo in Chinese; with `system` it uses the language of the human's latest
    message to Neo instead, and the machine locale only when there is none.
- It applies in `reuseIdleWorker` (`drivers/work-operations.ts`). For `long_lived` and
  `per_todo` it is a candidate filter of `chooseReusableWorker`, which sees free workers
  only. For `per_ask` the fact step also reads the ask's workers that are busy (daemon
  workers that worked on the ask, with their `work.status`). When no free one qualifies
  and one is busy, the decision is "wait": the start is queued on that worker through
  the existing todo queue (`todoWorker.wait`, the path `requireFreeWorker` already takes
  for a busy send) instead of returning null and starting new. `work.start` runs after
  the runner has claimed the todo (`doing`, `startedAt` set), and `queueOn`
  (`packages/daemon/src/storage/repositories/neo-todo-session-repository.ts`) refuses a
  todo that is not `todo`, so this PR extends `queueOn` and `todoWorker.wait` to a todo
  that is already `doing` and has no worker yet. PR 4's rule 1 uses the same extension. "Worked on this ask" reads `neo_todo_sessions` until
  PR 4, then `neo_todo_roles`.
- Saved coding `sessionStrategy` values are copied once: a repository value to each project
  that owns the repository (the most recently set wins when one project owns several), a
  global value to global. A repository with no owning project is reported to Neo and not
  moved. `long_lived` → `long_lived`, `per_task` → `per_todo`, `per_pr` → `per_todo` (a
  PR is one todo). The old rows stay until PR 2, which removes the pack's read of them in
  the same change, so no repository falls back to `long_lived` in between. The coding pack
  stops asking its own question in this PR.

**PR 2: the coding pack stops picking sessions.** Mostly deletions.

- `NeoPack.workerTarget` in the coding pack keeps model-line ranking and stage
  model/effort (the second half of `session-target.ts`) and drops the session part: the
  `sessionStrategy` preference (already replaced by PR 1), the feature reservation
  (its writes and reads; the table is left unused), PR-holder routing, takeover and
  work-type session names. Every coding start then goes through core's reuse, which only
  picks daemon-started workers. This closes the misroute without a separate guard.
- A PR's review findings and CI failures still reach the author through the PR sweep
  (`neo/packs/coding/pr-sweep.ts`, `deps.tell(row.owner, …)`). This is not dispatch.
- Until PR 4 lands, a new review round may start a new reviewer. That is safe, only
  less economical.

**PR 3: the start record.** A session counts as started by the daemon only when it has
a start record. Today `work_started_sessions` keeps only `adapter, id, started_at,
unusable_at, released_at, claimed_by, role`, so it cannot say for whom or on what a
session was started. The daemon writes one record when `work.start` starts new work, in
the same step that records the start today (`recordStarted` in
`rpc-handlers/family-operations/drivers.ts`), and never for a session it found or was
handed. The record holds:

| Group | Fields |
|---|---|
| identity | `adapter` (the driver), `id` |
| when and by whom | `started_at`; `started_by`: the caller's session id (Neo), or `daemon` for a daemon path |
| for what | `ask_id`, `todo_id`, `role`, `title` at start |
| where | `machine`, `folder` |
| what runs | `harness`, `provider`, `model`, `effort` as the adapter confirmed them, not as requested |
| how prepared | `preparation_pack`, `sandbox` (null when unprepared) |
| end | `released_at` and `release_reason`, `unusable_at` and `unusable_reason`, `archived_at` |

These are columns on `work_started_sessions`, so existing reads keep working. Its current
`role = 'worker'` marks the kind of start and is renamed `kind`, to keep it apart from a
todo role.

A **trusted record** is either a row this PR's code wrote (`started_by` set), or a row
written before this PR with `kind = 'worker'`. That is the row the daemon already
requires before an automatic or Neo archive and before a release
(`neo/session-archive-operation.ts` through `readStartedWork`, and `neo/todo-release.ts`,
which keeps such a session as `not_started_by_us`; both since #10965). Older rows without
`kind = 'worker'` are never trusted.

Release, archive and reclaim check the record: the daemon closes or archives a session
only when it has a trusted record, and writes the reason and time into the record's end
fields (`neo/todo-release.ts`, `neo/session-archive-operation.ts`). Reuse picks only
sessions with a trusted record and no end. A pre-upgrade worker row has no ask, todo or
model fields; reuse reads its model from `work.status` as today.

**PR 4: roles in core.**

- `work.start` takes an optional `role` (a short label). A start without a role is role
  `do`. With a `todoId`, core writes one row per assignment in a new table
  `neo_todo_roles (todo_id, role, adapter, id, at, model, effort)`: the first start and
  every later round that reuses the session, each with the model and effort it ran on.
  Existing todos seed `do` from `neo_todo_sessions`, keeping only refs that have a start
  record: `neo_todo_sessions` also holds pack-chosen sessions the daemon never started
  (`queueOn`), which must not come back through the seed.
- One superpipe decides a start's session, inside `reuseIdleWorker`: read facts (the
  todo's role sessions, the free sessions with a live start record, the pack's role
  rules), decide with one pure function, then send, wait or start new. The decision:
  1. this todo already has a session for this role and it is usable → send there; if
     busy, wait for it (`todoWorker.wait`, as extended in PR 1);
  2. otherwise the `sessionReuse` rule from PR 1, skipping any session that plays
     another role on this todo unless the pack's rules allow sharing;
  3. otherwise start new.
- A prepared start (worker sandbox on) reuses only a session whose start record has the
  same `preparation_pack` and `sandbox`. The round's parameters (PR, head) go in the
  message, as the review brief already does.
- A start's model and effort still have to match for reuse
  (`workStartConfiguration.confirm`). The coding pack asks for the earlier reviewer's
  model on a new round, read from `neo_todo_roles`, so the same reviewer can be kept when
  a new ranking would pick another line.
- Pack role rules are data on the pack: `NeoPack.roles?: Record<string, { shareWith?:
  string[] }>`. The coding pack uses `do` for the author, plus `review` and `verify`, with
  no sharing, and passes the role on each start. Using core's `do` keeps an author seeded
  before the upgrade. Its explicit `excludeRefs` for the author and earlier stage actors
  (`assign-operation.ts`) become redundant and are removed; `workerStartExclusions` stays
  for cross-todo exclusions.
- The one-worker-per-todo claim (`claimWorker` in
  `packages/daemon/src/storage/repositories/neo-todo-session-repository.ts`) applies per
  role.

Neo's explicit `send` to a named session is unchanged.

`bun run system-map impact` on `drivers/work-operations.ts`, `drivers/worker-reuse.ts`,
`packages/daemon/src/storage/work-started-sessions.ts`, `neo/packs/coding/session-target.ts`,
`neo/todo-release.ts` and `neo/session-archive-operation.ts`: `work_started_sessions` is
read and written only in `work-started-sessions.ts`, so the start record's columns and the
`role` → `kind` rename stay in that file and its 6 importers. `work-operations.ts` has 29
importers and defines `work.start`, `work.send`, `work.queue`, `work.status`, `work.stop`,
`work.turns`, `work.rename`, `work.withdraw` and `work.adapters` (`work.find`, `work.read`
and `work.health` live in other files); PR 4 adds one optional `role` input to `work.start`
and changes no other operation. `session-target.ts` has one importer, the
coding pack, so PR 2's deletions do not reach core.

Acceptance, one integration case per row:

| Case | Expected |
|---|---|
| a PR reviewed in three rounds | one author session and one reviewer session throughout |
| the reviewer is busy when a new round starts | the round waits and goes to it; no new session |
| the reviewer was archived | a new reviewer starts, not the author |
| verify after review | a third session, neither author nor reviewer |
| worker sandbox on, second review round | the first round's sandboxed reviewer is reused |
| a pack declares `do` and `check` may share | `check` may reuse the `do` session |
| a free session the daemon did not start | never reused, by any role |
| a new start | its record names who started it, for which ask, todo and role, the machine and folder, and the confirmed harness, provider, model and effort |
| a session with no start record | never released, archived or reclaimed by the daemon |
| a free worker started before the upgrade (`kind = 'worker'`, no `started_by`) | may be reused and reclaimed, as today |
| a row from before the upgrade without `kind = 'worker'` | never reused or reclaimed |
| a non-coding todo started with role `check` | never the session that did it |
| no `sessionReuse` saved, first reusable start in a project | one card asks; the work goes on as `long_lived` meanwhile |
| that card | titled with the question, one line per option with its description, a "use the default for now" option, in the human's language, no tables |
| `per_ask`, a free worker that only worked on another ask | not reused; a new worker starts |
| `per_ask`, the ask's worker is busy | the todo waits for it |
| `per_todo`, a free worker from another todo | not reused |
| a repository saved as `per_pr` | its owning project reads `per_todo` |

## Later, only when needed

- **A role that needs another model.** A role rule `otherModel: true`, so a check on a
  contract runs on a different model than the edit, the way the coding pack's
  cross-model review does today.
- **Clean-up.** Drop `pack_coding_feature_sessions` and remove every `sessionStrategy`
  reference from `pack-preferences.md` and `model-lines.md`.
