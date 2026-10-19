# Neo company: home repo, scheduler, goals

Status: proposal, awaiting the human's approval. Nothing here is built yet.

Root Neo owns the projects it runs for the human (OAP and the review bot first). It
keeps their direction in a small git repo, wakes itself on a schedule to push each
project forward, and tracks each project's goals with a journal of what worked. The
human stays in one conversation with Neo; scheduled work shows there as one quiet row.

Authors: fullstack 3 (home repo, scheduler, shared sections), fullstack 2 (goals, UI).

## 1. Neo home repo (fs3)

### What it is

Neo's folder, `<dataDir>/Neo` (`neoFolderPath()`, `lib/neo/folder.ts:8`), becomes a
git repo of curated text the human can read, diff and edit. It holds direction, not
activity: conversations, asks, todos, ledger rows and journals stay in the daemon DB.
The project mirror already treats this folder as plumbing, so it never becomes a Neo
project itself (`isNeoPlumbingFolder`, `lib/neo/project-mirror.ts`).

### Layout

```
Neo/
  README.md                  what this repo is; written once at init
  direction.md               company direction: what Neo is for, priorities, limits
  projects/<slug>/
    mandate.md               the project's mandate: purpose, goals (one section each,
                             with metric or done-test), boundaries, merge and review rules
    decisions.md             append-only decision log: date, decision, why, who confirmed
    digest.md                rolling progress digest, rewritten weekly (last 4 weeks)
    handoff.md               state handed over by the previous lead, kept as history
  .gitignore                 .coordinators/  (Neo's session cwd and SDK transcripts)
```

`<slug>` is the Neo project's slug, stored on the project as `homePath` so a rename does
not move files. `.coordinators/` already lives in this folder
(`neoCoordinatorRuntimePath`, `lib/neo/session-policy.ts:21`) and must never be
committed: it holds raw transcripts.

### Who writes what, and when

| File | Writer | When | Human confirm |
| --- | --- | --- | --- |
| `direction.md` | Neo | the human asks for a change | yes, always |
| `projects/*/mandate.md` | Neo | a goal is added, changed, met or dropped; scope changes | yes, always (section 4) |
| `projects/*/decisions.md` | Neo | a decision is confirmed (a mandate change, or a human answer that sets policy) | no; it records what was confirmed |
| `projects/*/digest.md` | Neo | weekly, from the goals' journals and the PR ledger | no |
| `projects/*/handoff.md` | Neo, from the outgoing lead's text | once, when Neo takes a project over | no |

Every write goes through one daemon operation, `neo.home.save`; Neo never runs git
itself (see Enforcement). Goals and journals stay in the DB; their milestones reach
`mandate.md` and `decisions.md` only through that operation (see section 3).

### Enforcement

- `neo.home.save {path, content, message, questionId?}`, root Neo or the local human only.
  It writes one file under the home repo, commits it, and pushes when a remote exists.
  It refuses paths outside the repo, `.coordinators/`, and anything git-ignored.
- For `direction.md` and `projects/*/mandate.md` it requires `questionId`: a
  `neo.question.ask` on Neo's ask that the human answered yes, whose body names that path
  and the exact content hash. That rule lives in the operation's gate, not in the prompt.
- Neo's tool guard (`lib/neo/look-up-guard.ts`) already refuses `git push` and git changes
  outside Neo's own folders. It additionally refuses `Write`/`Edit` under the home repo
  (except `.coordinators/`), so the operation is the only write path.
- Commit identity: the daemon's configured git user, with the trailer `Neo-Confirmed-By:
  question <id>` on confirmed changes.

### First use and remotes

- `neo.home.init`, called from the first setup or the first `neo.home.save`: `git init`,
  writes `README.md`, `.gitignore` and an empty `direction.md`, then commits.
- If `gh auth status` succeeds, Neo asks once (`neo.question.ask`, yes/no): create a
  private GitHub repo `<owner>/neo-home`? On yes the daemon runs `gh repo create --private`
  and pushes. On no, or without GitHub, the repo stays local; Neo can ask again later
  only if the human raises it.
- One shared repo across machines: the second daemon (iMac/laptop) clones the remote
  into its own `Neo/` on init when the remote exists (the human picks it once).
- Sync: `neo.home.save` runs `git pull --rebase` before committing and pushes after. On a
  conflict it aborts the rebase, keeps the local file, and returns `conflict`; Neo tells
  the human in one question with both versions. Reads (`neo.home.read`, or Neo's `Read`)
  pull at most once per wake.

## 2. Scheduler subsystem (fs3)

### Why not reuse `lib/schedule` as is

`lib/schedule` (about 1,200 lines including its fire handler) is a Space-task scheduler:

- `task_schedules.space_id` is NOT NULL with a Space foreign key; rows carry task fields
  (priority, workflow, labels) and a `goal_id` with a goal-automation special case
  (`task-schedule-fire.handler.ts:138`).
- Creating one requires an active Space (`schedule-service.ts:73-78`); firing skips paused
  Spaces and always creates a Space task (`task-schedule-fire.handler.ts:81`, `:201`).
- Space recovery hooks recover schedules per Space (`schedule-service.ts:274`).

The generic parts are small and reusable as they are: `cron-utils.ts` (21 lines), the
trigger validation and next-run math in `schedule-trigger.ts` (78 lines), and the
`pending_job_id` compare-and-swap that makes pause/delete race-free with the job queue.
Bending `task_schedules` into a session scheduler would mean a nullable `space_id`, a
target union and a second fire path inside a Space handler. A new subsystem that reuses
those three pieces is cleaner. `task_schedules` stays as the Space-task scheduler; moving
it onto the new subsystem as one more action kind is a later, optional slice.

### Placement

`packages/daemon/src/lib/scheduler/`: a top-level subsystem like `goals/` and `tasks/`
(flat folder, its own operations file). It knows sessions and the job queue; it knows
nothing about Neo, goals or packs. Core and subsystems register **sources**; packs reach
it through their subsystem (for goals, through goals).

### Model

`session_schedules` (new table):

| Column | Meaning |
| --- | --- |
| `id` | uuid |
| `target` | JSON `WorkRef` of the session to wake (any adapter; local HyperNeo first) |
| `source_kind`, `source_id` | who owns it, e.g. `goal`/`<goalId>`; unique together |
| `cadence_kind`, `every_ms`, `cron`, `timezone` | interval or cron |
| `nudge_every` | fire at least every Nth due run even when nothing changed (default 4) |
| `status` | `active`, `paused`, `done` |
| `next_run_at`, `pending_job_id` | as in `task_schedules`; CAS on `pending_job_id` |
| `due_count` | due runs since the last fire, for the nudge rule |
| `facts_digest` | the source's facts digest at the last fire |
| `last_run_at`, `last_outcome`, `last_skip_reason`, `last_message_id` | shown on the session page |
| `created_by_session`, `created_at`, `updated_at` | |

### Source contract

```ts
interface ScheduleSource {
  kind: string;                                    // 'goal'
  facts(id: string): Promise<{ digest: string; summary: string } | null>; // null: source gone
  message(id: string, change: { summary: string; nudge: boolean }): string;
}
```

The scheduler is domain-free: it compares digests and delivers the source's message.
Goals (section 3) supply the facts: metrics, task/todo states, the coding pack's ledger
rows for the goal's repos, and answered questions.

### Fire rule (`sessionSchedule.fire` job)

1. Load the row; stop if it is not `active` or the `pending_job_id` no longer matches.
2. Read the target with `work.status`. If it is `running` or `queued`, record
   `skipped_busy`, re-enqueue for `next_run_at`, stop. `needs_you` also skips
   (`skipped_needs_you`): the human owes it an answer first.
3. `due_count += 1`. Ask the source for facts. If the source answers `null`, mark the
   schedule `done`.
4. Fire when `digest != facts_digest`, or when `due_count >= nudge_every` (a "nothing
   moved" nudge). Otherwise record `skipped_unchanged`.
5. On fire: build the message (with the change summary, so the session need not
   re-derive it), deliver it as a scheduled wake (section 5) with an idempotency key
   `schedule:<id>:<due time>`, store `facts_digest`, reset `due_count`, record `fired`.
6. Compute the next run and re-enqueue (handler self-re-enqueue, as ADR 0002 describes).

Delivery reuses `NeoService.sendToRef`'s routing: direct for local HyperNeo sessions,
`work.send` for other adapters, with the scheduler as the logged origin.

### Operations

`schedule.session.create | list | pause | resume | delete`, roles `neo` and the local
human; `list` is filtered by `target` so a session page can show its schedules.
Sources create schedules through the service, not the operation (goals create one per
goal). Startup recovery re-enqueues active rows whose `pending_job_id` job is gone.

### What the session page shows

Per schedule: source (e.g. "Goal: OAP adapters ship"), cadence, next run, last run, last
outcome and skip reason, and pause/resume. The web and iOS rendering is in section 6.

## 3. Goals subsystem (fs2)

_fs2 to write._

## 4. Human-confirmed mandate changes (fs3)

1. A change starts when the human asks for one, or when Neo proposes one: a goal met,
   stalled for N cycles, or contradicted by a decision.
2. Neo drafts the new `mandate.md` section and asks with `neo.question.ask` on its ask:
   kind `yesno`, the body showing the diff (old and new section) and the path. The
   question records the path and the new content's hash.
3. On yes, Neo calls `neo.home.save` with that `questionId`. The gate checks the answer,
   path and hash, then commits with the `Neo-Confirmed-By` trailer and appends the
   decision to `decisions.md`.
4. On no, nothing is written; Neo records the refusal in the goal's journal so it does
   not re-propose the same change.
5. Goals refine inside HyperNeo freely (metrics, next steps, journal). Only changes to a
   goal's definition (its purpose, metric or done-test, or dropping it) touch the
   mandate and need this flow.

## 5. A quiet chat (fs2, with fs3 on the delivery side)

Delivery side (fs3): a scheduled wake is delivered to root Neo's session with a
`scheduled_wake` origin carrying `scheduleId` and `sourceKind/sourceId`, the same way
input origins are recorded today. The UI collapses the wake and Neo's turn into one row
whose label is Neo's closing one-line summary. Rendering: fs2.

## 6. UI: web and iOS (fs2)

_fs2 to write._

## 7. Boundaries (fs3)

_After sections 3 and 6._

## 8. Data model and migrations (fs3 + fs2)

## 9. Reused vs new

## 10. Slices in order, with sizes

## 11. Risks
