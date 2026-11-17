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
- **Only sessions the daemon started.** Reuse never picks a session outside
  `work_started_sessions.role = 'worker'`, whatever any pack says.

A pack can loosen or tighten the second rule for its roles. For example, a life-admin
pack may let `do` and `check` share one session for low-stakes errands; the coding pack
keeps all three apart. A pack cannot loosen the third rule.

## Step 1: roles in core, coding stops picking sessions

Two PRs, in this order.

**PR 1: the coding pack stops picking sessions.** Mostly deletions.

- `NeoPack.workerTarget` in the coding pack keeps model-line ranking and stage
  model/effort (the second half of `session-target.ts`) and drops the session part: the
  `sessionStrategy` preference and its first-dispatch question, the feature reservation
  (its writes and reads; the table is left unused), PR-holder routing, takeover and
  work-type session names. Every coding start then goes through core's reuse, which only
  picks daemon-started workers. This closes the misroute without a separate guard.
- A PR's review findings and CI failures still reach the author through the PR sweep
  (`neo/packs/coding/pr-sweep.ts`, `deps.tell(row.owner, …)`). This is not dispatch.
- Until PR 2 lands, a new review round may start a new reviewer. That is safe, only
  less economical.

**PR 2: roles in core.**

- `work.start` takes an optional `role` (a short label). With a `todoId`, core records
  the session it starts or reuses in a new table `neo_todo_roles (todo_id, role, adapter,
  id, at, preparation_pack, sandbox)`; the last two are null for an unprepared start. A
  start without a role is role `do`. Existing todos seed `do` from `neo_todo_sessions`,
  keeping only refs in `work_started_sessions` with `role = 'worker'`: `neo_todo_sessions`
  also holds pack-chosen sessions the daemon never started (`queueOn`), which must not come
  back through the seed.
- One superpipe decides a start's session, inside `reuseIdleWorker`: read facts (the
  todo's role sessions, the free daemon-started workers, the pack's role rules), decide
  with one pure function, then send, wait or start new. The decision:
  1. this todo already has a session for this role and it is usable → send there; if
     busy, wait for it (`todoWorker.wait`, extended to a todo that is already doing);
  2. otherwise today's core rule (free worker in the same folder, same ask first),
     skipping any session that plays another role on this todo unless the pack's rules
     allow sharing;
  3. otherwise start new.
- A prepared start (worker sandbox on) reuses only a session that was started with the
  same preparation pack and sandbox setting, read from those two columns. The round's
  parameters (PR, head) go in the message, as the review brief already does.
- A start's model and effort still have to match for reuse
  (`workStartConfiguration.confirm`). The coding pack asks for the earlier reviewer's
  model on a new round, read from its own assignment facts, so the same reviewer can be
  kept when a new ranking would pick another line.
- Pack role rules are data on the pack: `NeoPack.roles?: Record<string, { shareWith?:
  string[] }>`. The coding pack uses `do` for the author, plus `review` and `verify`, with
  no sharing, and passes the role on each start. Using core's `do` keeps an author seeded
  before the upgrade. Its explicit `excludeRefs` for the author and earlier
  stage actors (`assign-operation.ts`) become redundant and are removed;
  `workerStartExclusions` stays for cross-todo exclusions.
- The one-worker-per-todo claim (`claimWorker` in
  `packages/daemon/src/storage/repositories/neo-todo-session-repository.ts`) applies per
  role.

Neo's explicit `send` to a named session is unchanged.

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
| a non-coding todo started with role `check` | never the session that did it |

## Later, only when needed

- **How free workers are reused across todos.** Step 1 keeps today's rule (any free
  daemon worker in the folder, same ask first). If the human wants "one session per
  matter" or "one session per step", add a core preference `sessionReuse`
  (`long_lived` / `per_ask` / `per_todo`, project then global scope) that changes rule 2,
  and a block on the settings page to set and clear it
  (`packages/web/src/components/settings/PackSettings.tsx`, plus a human-only
  `pack.preferences.clear`). Saved coding `sessionStrategy` values would move there
  (`per_task` and `per_pr` → `per_todo`).
- **A role that needs another model.** A role rule `otherModel: true`, so a check on a
  contract runs on a different model than the edit, the way the coding pack's
  cross-model review does today.
- **Clean-up.** Drop `pack_coding_feature_sessions` and remove every `sessionStrategy`
  reference from `pack-preferences.md` and `model-lines.md`.
