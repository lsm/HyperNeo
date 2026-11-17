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

**One rule, in core.** Reuse is decided only in `reuseIdleWorker`, and only among workers
the daemon started. The setting picks which of them may take the work:

| Value | Who may take the next todo | Label shown to people |
|---|---|---|
| `long_lived` (default) | any free worker in the same folder; one that worked on the same ask first (today's core rule) | Long-lived sessions |
| `per_ask` | only a free worker that already worked on this todo's ask; else a new one | One session per matter |
| `per_todo` | none; every todo starts a new worker | One session per step |

`per_ask` uses the `sameAskAt` fact core already reads (`packages/daemon/src/storage/work-started-sessions.ts`
`readStartedWork`): a candidate is allowed only when it is set. `per_todo` skips reuse.
Neo's explicit `send` to a named session is unchanged; this setting only decides what a
`start` may reuse.

**Where it is stored.** A core preference `sessionReuse`, scope `project` (the todo's ask
`projectId`), falling back to `global`, then to `long_lived`. It uses the existing
preference store and the settings page; core declares it as pack id `core`
(`neo/preference-operations.ts` reads declarations by pack id). No question is asked
before first use.

**The coding pack stops choosing sessions.** Its `workerTarget` keeps model-line ranking
and stage model/effort (the second half of `session-target.ts`) and drops the session part:
the strategy preference and its question, the feature reservation
(`pack_coding_feature_sessions`), PR-holder routing, takeover and work-type session names.
A todo for an existing PR that lands on a new worker gets that PR's link (the coding
check's `urls`) in its start brief. In practice a PR's todos almost always share one ask, so `per_ask` covers what
`per_pr` was for.

**Upgrade.** Saved coding `sessionStrategy` values move once to `sessionReuse` on each
project that owns the repo: `long_lived` → `long_lived`, `per_task` → `per_todo`,
`per_pr` → `per_ask`, keeping `set_by`. The old rows and the feature table are then
dropped.

## Change plan

Each slice is one PR from `dev`, failing tests first.

1. **Core setting.** Declare `sessionReuse`, read it in `reuseIdleWorker`, filter
   candidates for `per_ask` and `per_todo`. About 60 production lines.
2. **Coding pack.** Remove the session part of `workerTarget`, the strategy declaration,
   the reservation table and its reads/writes; move saved values. Mostly deletions.
3. **Docs.** Replace the "Session strategy" section of `pack-preferences.md` with a link
   here.

Acceptance, one integration case per row:

| Case | Expected |
|---|---|
| `long_lived`, a free daemon worker that worked on the same ask | reused |
| `per_ask`, a free daemon worker that only worked on another ask | new worker started |
| `per_todo`, any free worker | new worker started |
| any value, a free session the daemon did not start | never reused |
| coding todo whose PR is held by a session the daemon did not start | new worker started, PR link in the brief |
| saved `per_pr` on a repo | the owning project reads `per_ask` |
