# Work that waits: held todos, parked workers, and what the phone counts

Status: proposal. Design only; no code in this PR.

Three gaps leave approved work sitting without anyone looking at it:

1. A hold records only a sentence. Nothing checks whether the thing it waits for
   has happened, and `nextStepOwner` gives a held todo to nobody
   (`attention/owner.ts`), so Neo is never reminded of it.
2. A todo whose PR waits for review keeps its worker reserved. `planWorkQueue`
   counts every doing todo's worker as busy, idle or not (`capacity.ts`), and
   `claimTodoWorker` refuses a worker bound to another live todo. The next todo
   sent to that worker queues behind it, with the owner `daemon`, so nobody is
   told.
3. The phone's "In progress" counts every todo whose owner is `daemon`,
   `worker` or `pack` and labels all three "Running". Most
   of them are waiting for a review, a merge, a queue slot or an earlier step.

Each fix reuses what exists: the pack check registry, the pack `parked` hook,
the owner function and the human queue.

## 1. A hold can say what it waits for

`neo.todo.hold` gains two optional fields:

```ts
{ todoId, reason, until?: TodoCheck, reviewAt?: number }
```

- `until` is a check of the same shape as a todo's own `check`, from the same
  registered pack kinds (for example `coding.pr_merged` with `urls`). It is
  validated by the same pack `refuse` rules as a todo check, so a merge check
  without URLs is refused here too.
- `reviewAt` is when Neo looks at the hold again if it is still held. The
  default is 24 hours after the hold without `until`, and 7 days with it.

Both are stored on the todo in one new nullable column, `hold_json`
(`{ until, reviewAt }`). Releasing the hold (`reason: null`) or holding it again
replaces it.

**Release.** The timed refresh sweep already runs `check` on every open todo
(`todo-runner.ts`, `refresh`). For a held todo with `until`, the same loop runs
that check read-only (`pack.todos.check(todo with check = until, { readOnly:
true })`, which packs already support). It does not touch the todo's own check
or ledger.

- Met: the daemon releases the hold exactly as `reason: null` does today. An
  unstarted todo returns to `todo` and the queue starts it. A started todo
  becomes `blocked` by `worker` with "Continue the worker", so its owner is
  Neo. Neo gets one digest line through `neo.attention.tell`
  (`todo.hold_released`, one-shot), naming what was met.
- Failed (for example the PR closed without merging): the hold stays, and the
  owner becomes Neo at once with reason `hold_failed`.

**Review.** In `nextStepOwner`, the held row changes from "nobody" to:

| Held todo | Owner |
|---|---|
| `until` failed | neo, reason `hold_failed` |
| `now >= reviewAt` | neo, reason `hold_review`, since `reviewAt` |
| otherwise | nobody |

That reuses the `todo.neo_step` wake and its ladder. Neo answers by acting on
the todo, releasing it, or holding it again with a new `reviewAt`.

Holds made before this change have no `hold_json`. They are treated as
`reviewAt = updatedAt + 24 h`, so each existing hold reaches Neo once within a
day of the release. That is the intended clean-up.

Dependencies (`after`) are unchanged. They still name todos only and still
cannot change after start.

## 2. A parked worker can take the next todo sent to it

A doing todo **yields** its worker when all of these hold:

- its worker's last status is idle (`done` or `stopped`; not `needs_you`, not
  unknown);
- its pack reports it parked (`NeoTodoPack.parked`; for coding, it has a
  tracked PR), so what finishes it is its pack check, not more worker turns.

A yielding todo keeps its worker binding. It no longer makes the worker busy:

- **Queue.** `queueFacts` marks the running row `yields`, and `planWorkQueue`
  leaves yielding rows out of `busy`, as it already leaves idle rows out of the
  totals.
- **Claim.** The start passes the yielding todo ids it read. `claimTodoWorker`
  accepts a worker bound only to those todos and re-checks, in its transaction,
  that each is still doing and its stored worker status is still idle. Any
  other bound live todo still refuses the claim.
- **Only explicit sends.** This applies to a `send` target that names the
  worker. A `start` target creates its own worker.

At most one non-yielding todo uses a worker at a time. Any number may be parked
on it.

**Which todo a turn belongs to.** A worker can now have two open todos, so a
turn must go only to the todo whose input it answers. `observe` already routes
turn reports by the dispatch's `todoId`. It still writes the blocker for the
latest turn of any dispatch; that write gets the same `dispatch.todoId === id`
guard. A turn with no matching dispatch goes to the non-yielding todo, never to
a parked one. A parked todo's follow-up, such as a review fix, is sent as its
own input carrying its id, and the worker answers it after its current turn.
Fencing is unchanged: `fenceRelease` keeps the worker while any live todo is
bound to it.

This fits the work-accounts attribution: inputs with delivery keys still match
exactly, and a worker named by two todos gets no fallback attribution.

## 3. The phone separates working from waiting

The daemon adds one field to each todo item in `neoHumanQueue`, derived from
the owner and the facts the sweep already read:

```ts
step: 'working' | 'waiting' | 'paused' | 'neo' | 'you';
waitingOn?: 'review' | 'earlier_step' | 'queue' | 'daemon';
```

| Owner | `step` | `waitingOn` |
|---|---|---|
| worker, live `running` | working | — |
| worker, live `queued` | waiting | queue |
| pack | waiting | review (its review, CI or merge) |
| prerequisite | waiting | earlier_step |
| daemon, held by the queue (`start: 'held'`) | waiting | queue |
| daemon, otherwise | waiting | daemon |
| nobody (held) | paused | — |
| neo | neo | — |
| human | you | — |

`neoStepFacts` keeps live `queued` apart from `running` for this; the owner
rows themselves do not change.

The phone's filters become: Waiting on you, Working, Waiting, Held, All.
Working counts only `working`. Waiting shows the `waitingOn` label ("Waiting
for review, CI or merge", "After an earlier step", "Queued", "HyperNeo is
checking"). Held todos move from In progress to Held. Rows and counts use the
same field. A daemon without `step` keeps today's behaviour on the phone.

## Slices

1. **Daemon: holds and queue steps.** `hold_json`, `until` validation, release
   and `hold_failed` in the refresh sweep, the `hold_review` owner rows, and the
   `step` / `waitingOn` fields. Tests: a held todo whose PR merges is released
   and starts; a closed PR gives `hold_failed`; a hold past `reviewAt` wakes
   Neo once per rung; an old hold without `hold_json` reaches Neo after 24 h;
   each `step` row in the table.
2. **Daemon: parked workers.** `yields` in the queue and the claim, the
   blocker guard in `observe`. Tests: a todo sent to a worker whose todo waits
   on its PR starts; one sent to a running worker or a `needs_you` worker still
   queues; a turn answering the new todo's input never blocks or reports on
   the parked one; the parked todo's review fix reaches the worker after the
   current turn.
3. **Phone: Working and Waiting.** The five filters and labels from `step`,
   with screenshots in light and dark.

## Limits

- A check that needs a remote read (a PR's state) is only as fresh as the
  refresh sweep.
- A worker serving a parked todo and a new one handles the parked todo's
  review fix after its current turn, so the fix can wait for that turn.
- Waits that no registered check can see (quota recovery, a release outside
  the daemon) use `reviewAt` only; Neo decides then.
