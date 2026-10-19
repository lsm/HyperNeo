# Neo company: home repo, scheduler, goals

Status: proposal, awaiting the human's approval. Nothing here is built yet. Section 0 (workers message Neo mid-work) is the top requirement and its slices go first.

Root Neo owns the projects it runs for the human (OAP and the review bot first). It
keeps their direction in a small git repo, wakes itself on a schedule to push each
project forward, and tracks each project's goals with a journal of what worked. The
human stays in one conversation with Neo; scheduled work shows there as one quiet row.

Authors: fullstack 3 (home repo, scheduler, worker messages, shared sections),
fullstack 2 (goals, UI).

## 0. Workers message Neo mid-work (fs3; the human's top requirement)

Workers must be able to tell Neo things while they work, the way Claude sessions message
each other today: ask a question and keep going, report progress, flag a block, say
done. Turn-end reports alone are too rigid. This section's slices come first (section 10).

### Today

No worker can deliberately message Neo mid-work. Neo learns by polling `work.status`
(`session-watcher.ts`, `settle-driver-work.ts`) and from Claude inbox replies.

- **HyperNeo workers** get the operations MCP server (`query-options-builder.ts:318`), but
  no operation reaches Neo: `work.report` is not registered and nothing creates `worker`
  bindings; `neo.message.send` is local-human only (`intake.ts:71`).
- **Claude Code / Desktop** sessions can reply with `SendMessage`, but only after the
  daemon has messaged them over the inbox; the `claude -p` start carries no reply address.
  Replies land in Neo as `system` input and wait for Neo's turn to end
  (`claude-inbox-submit.ts:20`, `mailbox/registration.ts:108`).
- **Codex** threads start with nothing attached: no MCP server, no environment
  (`codex-desktop-adapter.ts:1039`).
- **Receiving:** only `human` inputs steer a running Neo turn (`service.ts:906`); system
  notes are deferred to the turn's end (`service.ts:926`).

### Sending

One operation, `neo.worker.message`, with one store behind it, reached three ways:

```
neo.worker.message { kind: 'progress' | 'question' | 'blocked' | 'done',
              text,                      // up to 4,000 chars
              forHuman?: boolean,        // a question only the human can answer
              todoId? }                  // optional; resolved from the sender if absent
-> { accepted: true, messageId } | { accepted: false, reason }
```

| Worker | Path | Sender identity |
| --- | --- | --- |
| HyperNeo session | the operations MCP server it already has; `neo.worker.message` admits worker sessions | the daemon-assigned caller session id (MCP door) |
| Claude Code / Desktop | `SendMessage` to the HyperNeo inbox address. Right after a start, the daemon sends one inbox note giving that address and the kind tags (`[question]`, `[blocked]`, `[done]`, `[for human]`). Replies become `neo.worker.message` calls. | the reply's socket path matched to the live registration (`claude-inbox-endpoint.ts:72`), as today |
| Codex thread | a stdio MCP server, `hyperneo --hyperneo-worker-mcp`, put in the thread's `config.mcp_servers` at `thread/start`, with a per-thread token. Same bridge pattern as the ACP MCP proxy (`acp/mcp-proxy-bridge.ts`). | the token, which the daemon issued and maps to that thread |
| Anything with Bash | `hyperneo neo message --kind question "…"`, reading `HYPERNEO_WORKER_TOKEN`; only where the daemon controls the environment (HyperNeo sessions, the Codex app-server). Optional. | the token |

The sender is always resolved by the daemon, never read from the text. A sender must be a
session Neo dispatched: it resolves to a todo session or a Neo work target; anything else
is refused (`not_a_worker`). The todo is the one whose session ref matches the sender,
unless `todoId` names another todo of the same ask.

### Receiving

- Every message is stored in `neo_worker_messages` (sender ref, todo, kind, text,
  forHuman, created, delivered, dedupe hash), then delivered to root Neo as input kind
  `worker`, attributed: `From "<session title>" (<adapter>) on todo "<title>", <kind>: …`.
- **Neo mid-turn:** the message steers into the running turn, the same path as human
  steering (`steerHumanMessages`), widened from `human` to `human | worker`.
- **Neo idle:** it wakes Neo, as todo notes do (`continues`).
- **Batching:** messages that arrive while a steer or wake is pending merge into one input
  ("3 worker messages"), oldest first, so a chatty worker costs one interruption.
- **`forHuman` questions:** the daemon files a `neo.question.ask` (kind `reply`) on the
  todo's ask, so the human sees it among Neo's questions. The answer goes back to the
  worker (below) and to Neo as a note.
- **Chat:** each delivered batch shows as one collapsible row, `role: 'worker'` in
  `neo.conversation.read`, the same pattern as wake rows (section 5): sender, todo, kind
  chips and the first line, expanding to the texts. Rendering is fs2's.

### Replying

- `neo.worker.reply { messageId, text }` (root Neo, or the human through the question
  path) resolves the sender's ref and calls `work.send` with a `replyTo` line naming the
  message, and a new `steer: true` flag.
- With `steer`, adapters that can steer do: Codex `turn/steer`, Claude through the inbox at
  `priority: 'next'` (lands at the next tool round). HyperNeo sessions queue until the
  worker is idle (no steer there yet). Without steer support it is a normal send.
- The worker never waits for a reply; it keeps working, and the reply arrives mid-turn or
  at its next idle point.

### Guardrails

- **Rate limit** per sender: 6 a minute and 60 an hour. Past that, messages are stored
  but delivered as one "N more messages from <worker>" line per batch.
- **Dedupe:** the same sender, kind and text hash within 10 minutes is dropped, and the
  sender gets `{accepted: true, duplicate: true}`.
- **No human authority:** input kind `worker` is never `human`. Operations that need the
  human's word (archive, standing rules, mandate changes, start answers) already check
  human input origins and refuse it. Neo's prompt treats worker text as data from that
  worker, never as the human's instruction.
- **Scope:** a worker can message only about its own todos, and only while its todo is
  open.

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
- Neo's tool guard (`lib/neo/look-up-guard.ts`) today refuses `git push` and deletes
  outside Neo's folders, and only nudges on other changes outside them
  (`planNeoLocalChange`). Inside Neo's own folder, which holds the home repo, it allows
  everything. H1 adds a deny rule for the home repo (except `.coordinators/`): `Write`,
  `Edit` and `NotebookEdit` there, and Bash git write verbs (`add`, `commit`, `reset`,
  `checkout`, `rebase`, `merge`, `stash`, `rm`, `mv`) with the repo as their working
  directory or `-C` target. With that rule, the operation is the only write path the
  guard sees. A script that writes files without git is still possible (section 11).
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
   Then `due_count += 1`: every due run counts, skipped or not.
2. Read the target with `work.status`. If it is `running` or `queued`, record
   `skipped_busy`, re-enqueue for `next_run_at`, stop. `needs_you` also skips
   (`skipped_needs_you`): the human owes it an answer first. Because busy runs count,
   the first idle run after a busy stretch past `nudge_every` fires.
3. Ask the source for facts. If the source answers `null`, mark the schedule `done`.
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

### What we keep, what changes

We keep the existing goal system: `space_goals`, `space_goal_events`, `lib/goals/`
and the `goal.*` operations. Its model is already the brief's: one_shot, measurable and
recurring types, metrics, progress, summary, next steps and check-ins. Two things tie it
to Spaces today:

- **Scope.** `space_id` is `NOT NULL` with a cascade foreign key, every operation input
  carries a `spaceId` (`goal-operation-scope.ts`), and `service.ts:149` throws without
  one.
- **Work.** Goals work through `space_tasks` (`task-pointers.ts`) and check in through
  Space `task_schedules`.

A goal gains an owner session instead: root Neo for now. It works through that session's
asks and todos, not Space tasks, and its cadence is a `session_schedules` row
(section 2). Space goals keep working unchanged; they are goals whose scope is a Space.

### Model

- `space_goals` (table rebuild, details in section 8):
  - `space_id` becomes nullable.
  - New `owner_session_id`. Exactly one of the two is set.
  - New `done_test` text. A goal needs a metric target or a done-test.
  - New `mandate_ref`: the mandate section that defines the goal (`mandate.md#<goal
    slug>`).
  - New `mandate_rev`: the home-repo commit the goal last reconciled with.
  - New `works_note`, `works_note_through` and `facts_lines`.
  - The name stays. A rename touches about 30 files and many foreign keys for no
    behaviour change.
- `space_goal_events` stays the audit trail, with the same nullable `space_id`. It
  gains event type `journal_compacted` and sources `neo` and `human`.
- New `goal_journal`: one row per work cycle with `goal_id`, `run_id` (the scheduler
  run; null for a cycle the human started), `done`, `effect`, `evidence` (JSON
  `{kind: pr|todo|metric|url|commit|text, ref, note}[]`), `worked`, `failed`,
  `session_id` and `created_at`.
- `neo_asks.goal_id` (nullable): the asks Neo files in a goal's cycle carry it. Their
  todos, PRs and questions are the goal's facts.

### Operations

- `goal.create | get | list | update | event.list` take `spaceId` or `ownerSessionId`.
  - The scope gate resolves an owner-session goal only for its own session.
    `space_mismatch` becomes `scope_mismatch`.
  - Space-only operations refuse it with `space_goal_only`: `goal.task.*`,
    `goal.owner.*` and `goal.outcome.*`.
  - `goal.create` for an owner session creates its schedule through the scheduler
    service. `goal.update` to `paused` pauses it, and `completed` or `archived` deletes
    it.
- `goal.journal.append {goalId, runId?, done, effect, evidence[], worked, failed?}` is
  for the owner session only. A second append with the same `runId` replaces the first,
  so a retried turn leaves one entry.
- `goal.journal.list {goalId, before?, limit}`.
- `goal.facts {goalId}` is a read: the same facts the scheduler sees, so Neo and the UI
  agree with it.
- `neo.ask.open` takes an optional `goalId`, and its gate checks that the caller owns
  the goal.

### Goals as a schedule source

Goals registers `ScheduleSource` kind `goal` (section 2).

`facts(goalId)` returns `null` once the goal is completed or archived, which marks the
schedule done. Otherwise it returns the facts below. Each becomes one sorted line, and
the digest is their hash:

- the metric values and progress;
- the states of the goal's asks and todos;
- the coding pack's PR rows for those todos, through its existing `statusLine` and `prs`
  hooks (no new pack API);
- the questions answered since the last cycle;
- `mandate changed` when the home repo's HEAD for `mandate.md` is past `mandate_rev`.

The goal stores its last lines (`facts_lines`), so the summary names only the lines that
changed.

`message(goalId, {summary, nudge})` builds the wake: `Goal "<title>": <summary, or
"nothing moved since <time>" on a nudge>. Read <mandate_ref> and the note below, act,
then append a journal entry for run <runId>.` The goal's "what works" note is inlined,
so Neo needs no extra read.

### The cycle

1. The scheduler fires (section 2).
2. Neo acts with its usual tools. Asks it opens carry `goalId`.
3. Neo calls `goal.journal.append` with the run id and updates `progress`, `summary`
   and `next_steps` with `goal.update`.
4. Neo ends with its one-line summary, which labels the chat row (section 5).

A nudge cycle that finds nothing to do still appends an entry ("nothing moved; waiting
on X"). The run then shows on the goal, and a goal stuck for N nudges becomes a reason to
propose a mandate change (section 4).

### What works

When 10 entries are past `works_note_through`, or on a nudge, the wake message also asks
Neo to rewrite the note:
- Neo folds the new entries into it and calls `goal.update {worksNote}`.
- That records `journal_compacted` and moves `works_note_through`.

Compaction is a summarizing model step; goals only decides when to ask for it. Journal
rows are kept, so a poor note can be rebuilt from them.

### Mandate and milestones

- The mandate defines a goal (section 4); HyperNeo holds its refinement (metrics,
  done-test, progress, journal).
- Neo creates a goal from a mandate section with `mandate_ref` and `mandate_rev`, and
  reconciles when the `mandate changed` fact appears.
- A milestone (completed, metric target crossed, done-test met) that changes the goal's
  definition, or that belongs in a progress digest, goes through section 4's flow:
  - On yes, the commit sha goes into the journal as evidence and becomes the new
    `mandate_rev`.
  - On no, a journal entry records the refusal, and the next cycle reads it.
- Goals never writes git itself.

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
whose label is Neo's closing one-line summary.

Rendering side (fs2). Today `NeoConversation.tsx` drops every `inputKind: 'system'`
input, and `neo.conversation.read` returns only human asks and Neo publications. A wake
would be invisible, and the raw transcript would flood the chat. The rule is "show the
visible additions": one row per fired wake.

`neo.conversation.read` items gain a third role:

```ts
{ role: 'wake', cursor, wake: {
    scheduleId, sourceKind, sourceId,    // e.g. 'goal', goalId
    title,                               // goal title, or the source's label
    firedAt, settledAt: number | null,   // null while Neo's turn runs
    summary: string | null,              // Neo's closing line for that turn
    additions: { kind: 'ask' | 'todo' | 'question' | 'publication' | 'journal';
                 id: string; label: string }[] } }
```

- **Additions.** The daemon gathers the rows the turn created that carry the wake's
  delivered message id: asks by `origin_message_id`, their todos and questions, the
  publications with that origin, and the journal entry with that run id.
- **Edge cases.**
  - A wake that added nothing still gets a row, with its summary only.
  - Skipped runs get no row; they show on the session page (section 6).
  - A question Neo asks during a wake also shows as its own ask card. It needs an
    answer, so it is never folded away.

## 6. UI: web and iOS (fs2)

Web and iOS read the same operations. There is no logic only one client has; Neo iOS
owns the Swift side against these contracts.

### Wake rows

- **Web.** `NeoPublicConversation` renders the `wake` item as one collapsed row: a clock
  icon, title, summary and time.
  - Expanding it lists the additions as links into "Your work".
  - While `settledAt` is null the row reads "working…".
  - It reuses `SyntheticMessageBlock`'s chevron pattern and theme tokens.
- **iOS.** The same item as a disclosure row. The additions carry their labels, so no
  extra reads are needed.

### Goals

- **Web.** A "Goals" section in Neo's side panel, beside "Your work" (`NeoLive.tsx`,
  next to `NeoAskTodos`), listing root's active goals.
  - Each row shows the title, type, a progress bar or "done-test" chip, the next wake,
    and the last journal `effect`.
  - Opening a goal shows its metrics, done-test, `mandate_ref` (linked to the home
    repo's remote when it has one), next steps, the "what works" note, and the journal,
    newest first with evidence as links and paged by `goal.journal.list`.
- **Why a new component.** `GoalDetailPanel` stays the Space view. It reads
  `spaceStore` tasks and agents that owner-session goals do not have, so the Neo panel
  is a new, smaller component.
- **iOS.** `goal.list {ownerSessionId}`, `goal.get` and `goal.journal.list`. Layout is
  Neo iOS's call.

### Schedules on the session page

The session view (`/session/<id>`) and Neo's page get a "Schedules" strip, from
`schedule.session.list` filtered to that session as the target. Per schedule it shows:
- the source label (for a goal, its title linking to the goal), cadence and next run;
- the last run with its outcome and skip reason;
- "nudge in k", from `nudge_every - due_count`;
- pause and resume.

The same list feeds iOS.

## 7. Boundaries (fs3)

- **Scheduler** (`lib/scheduler/`, new top-level subsystem): sessions, cadence, the skip
  rule and delivery. It knows no domain. Anything that wants wakes registers a
  `ScheduleSource`.
- **Goals** (`lib/goals/`, existing subsystem): goal state, the journal and the facts.
  It is a schedule source and an operations owner. It never writes git and never
  delivers messages itself.
- **Neo core** (`lib/neo/`): worker messages (`neo.worker.message`, `neo.worker.reply`, the
  store, delivery and steering), the home repo (`lib/neo/home/`: `neo.home.init | save |
  read`), the mandate confirm gate, and the prompt that tells Neo how a goal cycle runs.
- **Drivers** (`lib/drivers/`): the per-adapter halves of worker messages: the Claude
  inbox intro note and reply mapping, the Codex worker MCP config and token, and
  `work.send`'s `steer` flag.
  Neo is the only goal owner for now, but goals take any owner session.
- **Packs**: the coding pack contributes to a goal's facts through its existing
  `statusLine` and `prs` hooks. Packs never call the scheduler or the home repo directly.
- **Adapters**: unchanged. The scheduler reads `work.status` and delivers through the same
  routing as `sendToRef`.

## 8. Data model and migrations (fs3 + fs2)

Worker messages, scheduler and home repo (fs3):

| Change | Migration | Notes |
| --- | --- | --- |
| `neo_worker_messages` | new table | `id`, `sender_ref` (JSON), `todo_id`, `kind`, `text`, `for_human`, `dedupe_hash`, `created_at`, `delivered_at`, `batch_id`, `reply_of`. Index on (`delivered_at`, `created_at`) and on `todo_id`. |
| `neo_worker_tokens` | new table | `token_hash`, `sender_ref`, `todo_id`, `created_at`, `revoked_at`. Tokens are stored hashed and revoked when the todo closes. |
| Input kind `worker` | none | The mailbox `inputKind` gains `worker`; input origins record the message ids. |
| `session_schedules` | new table | Columns as in section 2. Unique (`source_kind`, `source_id`); index on (`status`, `next_run_at`) and on `target`. No foreign keys: targets may be on other adapters. |
| `neo_concerns.home_path` | `ADD COLUMN` | Nullable. The project's folder under `projects/` in the home repo, set once. |
| `neo_questions.confirm_json` | `ADD COLUMN` | Nullable `{path, sha256}` that the home-save gate checks. |
| Input origin kind `scheduled_wake` | none | Stored in the existing input-origin row with `scheduleId` and the source. |

Goals (fs2):

| Change | Migration | Notes |
| --- | --- | --- |
| `space_goals.space_id` nullable; `owner_session_id`; CHECK exactly one of the two | table rebuild | Keeps all six inbound foreign keys: `space_goal_events` (rebuilt in the next row), `space_goal_outcome_notifications`, `goal_automation_cursors`, `evolution_scopes` (`ON DELETE SET NULL`), `space_long_horizon_agent_goals` and `space_agent_goal_assignments`. Run `pragma_foreign_key_check` on all six inside the rebuild. Update `space-test-db.ts` for parity. |
| `space_goals.done_test`, `mandate_ref`, `mandate_rev`, `works_note`, `works_note_through`, `facts_lines` | same rebuild | All nullable. |
| `space_goal_events.space_id` nullable; event type `journal_compacted`; sources `neo` and `human` | table rebuild | Its CHECKs change, so a rebuild is needed anyway. |
| `goal_journal` | new table | FK `goal_id` with cascade; index on (`goal_id`, `created_at`); unique (`goal_id`, `run_id`) where `run_id` is not null. |
| `neo_asks.goal_id` | `ADD COLUMN` | Nullable, with an index. |

## 9. Reused vs new

Reused as is:
- `lib/schedule/cron-utils.ts`, the trigger validation and next-run math in
  `schedule-trigger.ts`, and the `pending_job_id` CAS pattern.
- The job queue's one-shot `runAt` with handler self-re-enqueue (ADR 0002).
- `work.status` for busy checks; `sendToRef` routing for delivery; input origins.
- `neo.question.ask` for confirmations; Neo's tool guard for write denial.
- The goal model, `lib/goals`, the `goal.*` operations and `space_goal_events`.
- The coding pack's ledger and status hooks for facts.

Reused for worker messages: the operations MCP server on HyperNeo sessions, the Claude
inbox and its registration-based sender check, the ACP MCP proxy bridge pattern, human
steering, `continues` delivery, and `neo.question.ask`.

New:
- `neo.worker.message`, `neo.worker.reply`, `neo_worker_messages`, worker tokens, the Codex
  worker MCP bridge and `work.send`'s `steer` flag.
- `lib/scheduler/` with `session_schedules`, the fire handler, sources and five operations.
- `lib/neo/home/` with `neo.home.init | save | read` and the confirm gate.
- Owner-session goals, `goal_journal`, `goal.journal.*` and `goal.facts`.
- The `wake` conversation item, the goals panel and the schedules strip.

## 10. Slices in order, with sizes

Worker messages first (fs3 unless marked), each one PR from dev; sizes are production
lines:

- **W1. `neo.worker.message` for HyperNeo workers** (~200): `neo_worker_messages`, the
  operation with sender resolution, scope, rate limit and dedupe, and delivery to root Neo
  as attributed `worker` input with batching (wake when idle).
- **W2. Steering** (~60): `worker` inputs steer a running Neo turn, the same way as
  human steering.
- **W3. Replies** (~120): `neo.worker.reply`, `work.send`'s `replyTo` and `steer`, Codex
  `turn/steer`, Claude inbox at `next`, HyperNeo queue.
- **W4. Claude workers** (~120): the intro inbox note after a start, and inbox replies
  mapped to `neo.worker.message` with kind tags.
- **W5. Worker chat rows** (fs2, ~150): the `worker` item in `neo.conversation.read`, the
  web row, and `forHuman` questions filed as Neo questions.
- **W6. Codex workers and the CLI** (~200): `neo_worker_tokens`, the
  `--hyperneo-worker-mcp` bridge in `thread/start` config, and
  `hyperneo neo message`.

Scheduler and home repo (fs3):

- **S1. Scheduler model and operations** (~180): `session_schedules`, the service with
  CAS pause/resume/delete, startup recovery, the source registry and
  `schedule.session.*`. No source registers yet; tests use a fake source.
- **S2. Fire and delivery** (~150): the `sessionSchedule.fire` handler with the skip rule
  and nudge counter, delivery through the `sendToRef` routing, and the `scheduled_wake`
  origin.
- **H1. Home repo** (~230): `neo.home.init | save | read`, the layout and `.gitignore`,
  `neo_concerns.home_path`, the guard rule that denies write tools and git write verbs
  in the repo, a dirty-file refusal, and the new secret
  content check in `neo.home.save` (section 11). Local git only.
- **H2. Mandate confirm gate** (~100): `neo_questions.confirm_json`, the save gate for
  `direction.md` and `mandate.md`, the decision-log append and the commit trailer.
- **H3. Remote and sync** (~120): the GitHub proposal, `gh repo create --private`, the
  clone on the second machine, and pull-rebase with conflict refusal.
- **P1. Neo prompt** (prompt only): how a goal cycle runs, reading the mandate, the
  journal entry, the closing one-line summary, and proposing mandate changes.

Combined order (who, and what each needs):

| Step | fs3 | fs2 |
| --- | --- | --- |
| W-a | W1 `neo.worker.message` for HyperNeo workers | G1 goals scope migration |
| W-b | W2 steering, then W3 replies | W5 worker chat rows (needs W1) |
| W-c | W4 Claude workers, then W6 Codex and CLI | G2 owner-session goals |
| 1 | S1 scheduler model | G3 journal |
| 2 | S2 fire and delivery | |
| 3 | H1 home repo | G4 goals as a source (needs S1, S2) |
| 4 | H2 confirm gate | G5 wake rows (needs S2, W5), G7 schedules strip (needs S1) |
| 5 | P1 Neo prompt (needs G4, H2) | G6 goals panel |
| 6 | H3 remote and sync | G8 what works and mandate reconcile (needs H1, G4) |

After W-b, HyperNeo workers can message Neo mid-work and get replies, and the human sees
those exchanges as rows. W-c brings Claude and Codex workers in. After step 5 the goal
loop works end to end on one machine: a goal wakes Neo, Neo acts and journals, and
mandate changes need a yes. Step 6 adds the second machine. Then the OAP and review-bot
mandates and handoffs get written (not code).

Total: about 1,480 fs3 lines and 1,270 fs2 lines over 20 PRs.

Goals and UI (fs2), each one PR from dev; sizes are production lines:

1. **Goals scope migration** (~120): the two rebuilds, the new columns, parity and the
   migration test.
2. **Owner-session goals in the operations** (~150): the scope gate, Space-only
   refusals and done-test validation.
3. **Journal** (~150): `goal_journal`, `goal.journal.append` and `list`, run-id
   idempotence.
4. **Goals as a schedule source** (~150): `facts`/`message`, `goal.facts`,
   `neo_asks.goal_id` and the `neo.ask.open` gate, and the schedule lifecycle on
   create/pause/close. Needs the scheduler service.
5. **Wake rows** (~150): the `wake` item in `neo.conversation.read` and the web row.
   Needs the `scheduled_wake` origin. Reuses W5's collapsible row and its extra item
   role in `neo.conversation.read`, so only the wake data and its additions are new.
6. **Neo goals panel** (web, ~200).
7. **Schedules strip** (web, ~100). Needs `schedule.session.list`.
8. **What works and mandate reconcile** (~100): the compaction trigger and the
   `mandate changed` fact. Needs the home repo.

iOS work for 5 to 7 is Neo iOS's, against the contracts in sections 5 and 6.

## 11. Risks

Worker messages (fs3):

- **Interrupting Neo.** Steering worker messages into Neo's turn while it talks to the
  human could derail the human's request. Batching and the rate limit bound it. If it
  still hurts, steer only `blocked` and `question` messages and defer `progress` to the
  turn's end; that switch is one line.
- **Claude sender proof is a same-user file check**, not authentication: the reply socket
  is matched to `~/.claude/sessions/<pid>.json`. Any process running as the user could
  forge it. That is today's trust level for the inbox, and acceptable on a single-user
  machine.
- **Injected text.** A worker message can contain anything. It is tagged `worker`, so it
  never passes a human-authority check, and Neo's prompt says so. A worker can still
  mislead Neo about facts. Neo checks claims that matter (PR merged, tests green) with its
  own reads before acting on them.
- **Codex config.** `config.mcp_servers` at `thread/start` is not yet used anywhere. If
  the Codex desktop handoff drops it, W6 falls back to the CLI with the token in the
  app-server environment. This needs a live check before W6.

Scheduler and home repo (fs3):

- **Cost without a budget.** Each fire is a Neo turn. The busy skip, the unchanged skip
  and `nudge_every` bound it, and pausing a goal pauses its schedule. A per-schedule cap
  can come later.
- **Starvation.** If Neo is always busy in the human's chat, wakes keep skipping. The
  session page shows `skipped_busy`, and the nudge fires on the first idle due run.
- **Noisy facts.** A fact line that changes on every read (a timestamp, an unordered
  list) fires every time. Facts must be sorted and stable; the fire tests cover it.
- **Guard bypass.** Neo has Bash, so a script (Python, a shell redirect) could still write
  a home-repo file or run git indirectly; the guard checks commands, not what a script
  does. It already blocks `git push` and inline code that pushes, and H1 denies the write
  tools and git write verbs there. A bypass would skip the decision log, but an
  uncommitted change shows in `git status` and the next `neo.home.save` refuses a dirty
  file it did not write.
- **Two machines.** Each daemon has its own schedules, so only the machine that owns a
  goal wakes for it. The home repo is shared; a conflict is refused, not merged.
- **Private data in git.** Only curated text goes in; transcripts stay in the ignored
  `.coordinators/`. Neo's guard only knows secret file and path names, not secret
  content, so H1 adds a content check to `neo.home.save`: it refuses private-key blocks,
  known token prefixes (`sk-`, `ghp_`, `github_pat_`, `xox`, `AKIA`), and
  `KEY=`/`TOKEN=`/`SECRET=`/`PASSWORD=` assignments with a long value. This matters most
  once H3 pushes to GitHub.

Goals and UI (fs2):

- **The goal table rebuilds touch a table with six inbound foreign keys and live
  Space data.** Rebuild migrations have broken here before, so test on a copy of the
  schema, never a real DB, and keep Space goal behaviour pinned by its existing tests.
- **Additions attribution relies on the wake's message id reaching every row the turn
  creates.** If another message lands mid-turn, a row may carry the other origin. The
  wake row then lists only what carries its own id; nothing is lost, it shows under the
  other turn.
- **Compaction quality is a model judgment.** Journal rows are kept, so the note can be
  rebuilt.
