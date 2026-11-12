# Minimal asks, todos and cards

Status: proposal for human review, 2026-11-12. Design only. Refs lsm/HyperNeo#10476.
Paths without a prefix are under `packages/daemon/src/lib/neo/`.

## Why

A todo list is a simple thing, and this one stopped being simple. In real use:

- A todo says it waits on the human, and no card exists for the human to answer.
- A todo is parked with a written reason and nothing ever raises it again.
- One stuck or removed step silently stops every step after it.
- Approval is a second fact on every step. A newly added step starts without asking only
  when Neo marks it approved, with `start: true` on add or by binding it to work already
  running. One added without the mark waits for a Start answer even when the human already
  said "go", and some wait with no card at all.
- One matter is opened as many asks, and one failure repeats on many todos, each with its own card.

Two causes sit under all five.

**One fact is stored in five places.** Whether a todo waits on the human is written in
`neo_todos.state` with `blocked_by` (seven states, eight blockers), in
`neo_todos.approved_at`, in `neo_questions.todo_id`, in `neo_questions.start_todos`, and
in `neo_todo_sessions.needs_you_since`. Different code writes each one. The web groups
asks by open cards (`neoAskEntryState` in `ask-entries.ts`); the runner starts and holds
work by `state`, `blocked_by` and `approved_at`. They disagree.

**Progress depends on the model noticing.** A worker's stored report
(`neo.question.storeWorkerReport` in `question-operations.ts`) writes the card and the
`blocked` / `needs-human` state together. Two other paths write only the state: a staged
worker question (`stageNeoWorkerQuestion`) and a worker's final-line blocker
(`worker-blocker.ts`). Both leave a note that Neo must answer the worker or ask the human.
A removed prerequisite tells Neo once (`neoCancelledPrerequisiteNote`). Stall reminders
stop after three. When the model misses a note, the work stays where it is.

## The model

Three records stay: an **ask** (one thing the human wants), its **todos** (steps), and
**cards** (questions for the human, `neo_questions`).

A todo has four stored states:

| State | Meaning |
|---|---|
| `todo` | Not started. |
| `doing` | Started and not finished. |
| `done` | Finished. Anyone may say so. |
| `removed` | Cancelled. |

**Waiting on the human is not stored. A todo waits on the human exactly when an open card
covers it.** The web, the counts and the runner all read that one fact.

A card has one relation to todos: `todos`, the list it covers. A card holds exactly the
todos it lists; one with an empty list is a question about the ask and holds nothing. A
todo covered by more than one open card moves when the last one closes. The daemon never
opens a second card for the same todo and cause: a new reason replaces its earlier card
(`replaced_by`). A todo that becomes `done` or `removed` leaves its cards' lists, and a
card that covered todos and now covers none is retired.

## Rules

The daemon enforces every rule. None depends on a prompt.

**1. Start.** A todo starts by itself when its ask is open, it is `todo`, it has an
instruction and a target, every todo in `depends_on` is `done`, no open card covers it,
and a worker slot is free (rule 9). There is no approval fact and no Start card. Today
`neo.todo.add` records approval when Neo passes `start: true`; here starting is the
default and asking is the explicit act. When the human's word is needed first, Neo asks
with a card; when the human already said to go, the work goes.

A todo with a check and no instruction has nothing to run. Under the same conditions,
without the instruction and the worker slot, it becomes `doing` with no worker, and the
runner's check pass (`listCheckable`, then the pack's `check`) polls it as it does today.

**2. Dependencies are explicit.** Only `depends_on` holds a todo back. `position` is
display order. `neo.todo.add` requires `after`; `[]` means it waits for nothing.

| Prerequisite is | Dependents |
|---|---|
| `done` | start |
| `todo`, `doing`, or waiting on a card | stay queued |
| `removed` | never start by themselves; see rule 4 |

**3. Done.** The human or Neo may mark any live todo `done`, without evidence and
whatever its check says. A plan changes, and a step that is no longer needed is simply
done. Its worker stops, it leaves its cards, its dependents start. A card shared with
other todos stays open for them. A check exists so the
daemon can finish a todo by itself; it never refuses a person.

**4. Remove.** Removing a todo that has live dependents needs an answer for them.
`neo.todo.remove` takes `dependents: 'continue' | 'remove'`. `continue` drops the edge to
the removed todo; `remove` removes them too. When Neo cannot tell from the human's words,
it leaves the field out and the daemon opens one card in the same write, covering the
direct dependents, with those two options and a free reply. Later steps stay queued behind
them. A removed todo that names a live replacement (`replaced_by`) hands its dependents to
it instead, as `neoTodoDependenciesAfterApproval` does today.

**5. Hold.** Holding is a card, not a state. Hold on an unstarted todo opens a card with
the reason and the options Start and Remove. Pause on a running todo stops its worker and
opens the same card with Resume. An unanswered card is the hold.

**6. Every live todo has a place.** A live todo is in exactly one of three places:

- **Waiting on you:** an open card covers it.
- **Queued:** it is `todo` with no card, held back only by worker capacity or by
  prerequisites that can still finish. A `removed` prerequisite cannot.
- **Running:** it is `doing` with no card, and a worker is live on it, the daemon is
  retrying it, or its check is being polled.

A todo in none of these is repaired by the daemon, not by a reminder. An event that needs
a decision (a worker finished, a worker reported a blocker, retries ran out) wakes Neo
once. Neo answers the worker, marks the todo done, removes it, or asks the human. If the
todo is still out of place when that turn ends, the daemon opens the card itself, with the
worker's own words as the card's document. Progress events never wake Neo.

`neo.todo.add` refuses a todo with neither an instruction and target nor a check, since
nothing could ever move it.

**7. Failures.** The daemon retries a failed start or a dead worker itself: the same
worker once, then a fresh one. After that it opens a card with Retry, Mark done and
Remove. Todos failing for the same cause share one card, keyed by the failure code and
place; the answer applies to all of them. A todo that only waits on its check gets a card
once the check has not passed within its deadline, with Keep waiting, Mark done and
Remove.

**8. One ask per matter.** `neo.ask.open` refuses a second open ask for the same matter
and returns the existing one. A pack supplies the matter key (the coding pack: the pull
request or issue); core only compares keys. An open ask with no live todo and no open
card is settled by the daemon after Neo has had one turn to write its outcome.

**9. Limits and priority.** How many todos run at once is decided by the program, in
core: `planWorkQueue` in `packages/daemon/src/lib/work-queue/` is a pure function, and no
pack and no prompt takes part. It is the same for every kind of work. This stays as it is:

- At most 6 todos run in total and 3 per project, by default (`neoTodoLimits`).
- A slot is held only by a todo whose worker is live. A todo covered by an open card
  holds none, so work waiting on the human never stops other work from starting. A todo
  that only waits on its check holds none either.
- Queued todos start in priority order (`urgent`, `high`, `normal`, `low`), then oldest
  first (`orderWork`).
- The limit holds back new starts only. A started todo that an answer sends on continues
  at once and counts against the limit from then.

Both limits are settings (`maxRunningTodos`, `maxRunningTodosPerProject`), read each time
the queue fills, so a change applies without a restart. The per-project number is one
value for every project. Today nothing in the app sets them; a control in Neo's settings
comes with the human controls.

Priority stays on the todo with its four levels. Neo sets it from the human's words, and
the human can change it.

## How it is built

Every rule above is a pure function over recorded facts, run inside one superpipe pipeline
per business path ([ADR 0004](../adr/0004-superpipe-pipelines.md)). This is the point of
the design, not a detail of it: a rule that lives in a prompt, a reminder or hand-written
control flow is the thing being removed.

- **Decisions are pure.** A decision takes facts and returns a plan. It reads nothing and
  writes nothing. The place of a todo (rule 6), which todos start (`planWorkQueue`), what
  a remove does to its dependents (rule 4), which card to open and for which todos
  (rule 7), and the migration of one ask are each one such function.
- **Effects sit at the edges.** Database writes, card creation, worker starts and stops,
  and wakes come after the decision. A state change and its card are one write, so a
  failure leaves both or neither.
- **One pipeline per path,** named for its operation (`neo.todo.done`, `neo.todo.remove`).
  No path gets a second pipeline or a hand-rolled gate cascade, and rejections use the
  `result:` gate shape.
- **Each fact is recorded once.** Waiting comes from cards, order from `depends_on`.
- **Tests need no model.** Each slice is accepted on unit tests of its pure functions,
  facts in and plan out, before it is wired.

## Cards the daemon opens

A daemon card is an ordinary choice card. Its text and options are status codes the
client localizes; Neo may replace it with a better worded one. The daemon applies the
answer itself, so these never wait on a model turn.

| Opened when | Options |
|---|---|
| A worker's blocker or question was left unanswered | free reply, Mark done, Remove |
| A finished report was left unconfirmed | Accept, free reply |
| Retries ran out | Retry, Mark done, Remove |
| A check is past its deadline | Keep waiting, Mark done, Remove |
| A prerequisite was removed | Continue, Remove these |
| Hold or pause | Start or Resume, Remove |

## Operations

Today Neo has 24 ask, todo and question operations (`packages/prompts/src/neo/tools/`).
The todo and card mutations shrink to these:

| Kept | Replaces |
|---|---|
| `neo.todo.add` | `add`; `bind` becomes a target of `add` |
| `neo.todo.edit` | `edit` for title, instruction and `after` before the start |
| `neo.todo.done` | `close`, and `edit` with `done` |
| `neo.todo.remove` | `remove`, `proceed` |
| `neo.todo.continue` | `continue`, `retry` |
| `neo.question.ask` | `ask`, `relay`, `hold` |
| `neo.question.retire` | `retire`, `resolve` |

A human answer goes straight to the bound worker and into Neo's context, as
`question-answer-delivery.ts` does today, so `relayAnswer` has no separate job. Read
operations and the ask operations are unchanged, except the refusal in rule 8.

## What the human sees

One list, in this order:

1. **Needs you:** every open card, answerable in place. Questions come before holds;
   within each, urgent first, then the longest wait.
2. **In progress:** running todos, most recent activity first.
3. **Queued:** in the order they will start.
4. **Done:** collapsed.

Each ask is one row that names who moves next. A step shows its priority when it is not
`normal`; today the list does not show priority at all. A retired card that Neo still points to
shows why it was retired. The "Neo has N still to handle" line goes away, because rule 6
keeps that number at zero.

The human can act on a step directly: Done, Cancel, Hold and its priority. These controls
come in a later slice; Neo's operations cover the same actions first.

## What goes away

| Kind | Removed |
|---|---|
| States | `blocked`, `failed`, `closed_unverified` |
| Columns | `blocked_by`, `blocked_reason`, `next_action`, `approved_at`, `approval_question_id`, `added_after_start` on `neo_todos`; `todo_id`, `start_todos` on `neo_questions` (one `todos` list instead); `needs_you_since` on `neo_todo_sessions` |
| Card kind | `start` |
| Behaviour | positional order as a dependency, per-step approval, evidence required to mark done, the three-reminder ladders, notes told once from in-memory sets |
| Operations | `neo.todo.hold`, `.proceed`, `.retry`, `.close`, `.bind`; `neo.question.relay`, `.relayAnswer`, `.resolve` |

## Moving live rows

Nothing may start on deploy that the human had not approved, and nothing may be lost.

- `blocked` becomes `todo` if it never started, otherwise `doing`. If no open card covers
  it, the migration opens one with the stored `blocked_reason` as its text. This covers
  `needs-human`, `held`, `stalled`, `environment`, `failure`, `check` and `worker`.
- `failed` in an open ask becomes `doing` with a rule 7 card; in a settled ask it becomes
  `removed` and keeps its reason.
- `closed_unverified` becomes `done` if it had started and `removed` if it never started,
  which is how its dependents read it today (`neoTodoFinished`).

Those rewrites come last. Before them, the migration writes down what holds each live todo
today, in this order:

1. **Prerequisites.** Every live todo gets its effective prerequisites in `depends_on`:
   the stored list, or with none stored the immediately preceding todo of its ask, removed
   or not (`neoTodoDependencyNodes`).
2. **Cancelled prerequisites.** Every edge to a prerequisite that counts as cancelled
   today (`neoTodoCancelledDependencies`: removed, or closed unverified without having
   started) moves to that todo's live replacement. With no replacement, the dependents get
   the rule 4 card: today they wait for a `neo.todo.proceed` that may never come, and the
   human has not said they may go on. A dependent already on an open Start card is left
   to that card (step 4).
3. **Cards.** `todo_id` and `start_todos` are copied into `todos`. An open question with
   neither, which today holds its whole ask (`neoTodoWaitReason`), lists the todos it
   holds: every unstarted live todo of the ask and every todo `blocked` by `question`
   under it. Cards that overlap on a todo all stay open.
4. **Start cards.** An open Start card becomes a multi-select choice card whose options
   are its todos, and the answer keeps today's effects (`planNeoStartAnswer`): a ticked
   todo may start, an unticked todo behind a cancelled prerequisite is removed, and any
   other unticked todo gets a hold card (rule 5). An unapproved, unstarted todo on no
   card gets a card of the same form.

## Slices

Each slice is its own issue under one epic and is measured before it is cut.

| # | Slice | Accepted when |
|---|---|---|
| 1 | A card covers a list of todos | Every reader of `todo_id` and `start_todos` reads `todos`; an approved todo under an open ask-level question is still held after the switch |
| 2 | Waiting is read from cards | The web sections, the counts and the runner agree on every live todo |
| 3 | Done without a gate | Neo marks an unstarted todo with an unmet check done and its dependents start |
| 4 | Explicit dependencies and remove with dependents | A removed prerequisite ends in continued dependents, removed dependents, or one card; a migrated todo behind a cancelled prerequisite, stored or implicit, does not start without that decision |
| 5 | Automatic start | An added todo with met prerequisites starts with no Start card; a migrated Start card keeps its per-todo answer |
| 6 | The daemon's cards | A blocker Neo ignores, a twice-failed start and an overdue check each end in exactly one card |
| 7 | One ask per matter | A second ask for the same pull request is refused with the first one's id |
| 8 | Human controls | Done, Cancel, Hold and priority work from the list; the two limits are set in Neo's settings |
| 9 | Deletion | No removed state, column, operation or prompt is left |

## Earlier designs

- [Neo simplify](../architecture/neo-simplify.md) (2026-10-18) set four todo states and
  made `blocked` stored (its B1), because a derived block lost its reason and next action
  on a restart. Here the reason lives on the card, which is stored, so the restart case
  holds without a second copy of the state. Its `ask_open` refusal is not in the code
  today; rule 8 is that refusal.
- [One plan, one ask](neo-plan-dependencies.md) added `depends_on`. This keeps it and
  drops the fallback to positional order and the approvals it relied on.
- The tasks subsystem (`packages/daemon/src/lib/tasks/`, with its runtime in
  `packages/space/`) reads attention from status, uses explicit dependencies and starts
  work from a tick. Those three ideas are taken.
  The system itself is not: it has no cards and does not drive external workers.

## Numbers to confirm

| Number | Proposed | Cost of a higher value |
|---|---|---|
| Automatic retries before a card | 2 | The human hears about a real failure later |
| Deadline for a check-only todo | 24 hours | A merge or deploy that will never happen stays quiet longer |
