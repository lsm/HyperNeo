# Work that waits: held todos, reserved workers, and what the phone counts

Status: proposal. Design only; no code in this PR.

Three gaps leave approved work sitting without anyone looking at it:

1. A hold records only a sentence. Nothing checks whether the thing it waits for
   has happened, and `nextStepOwner` gives a held todo to nobody
   (`attention/owner.ts`), so Neo is never reminded of it.
2. A todo sent to a named worker queues while another doing todo holds that
   worker, even when that todo only waits for its PR and the worker is idle.
   The queue owner is `daemon`, so nobody is told.
3. The phone's "In progress" counts every todo whose owner is `daemon`,
   `worker` or `pack` and labels all three "Running". Most of them are waiting
   for a review, a merge, a queue slot or an earlier step.

Each fix reuses what exists: the coding PR reader, the todo mutation writer,
the owner function, the `todo.neo_step` wake and the human queue. No worker is
shared between todos.

## 1. A hold can say what it waits for

`neo.todo.hold` gains two optional fields:

```ts
{ todoId, reason, until?: { pack: 'coding'; kind: 'pr_merged'; params: { urls } }, reviewAt?: number }
```

- **`until`** is the release condition. The first slice supports one kind:
  `coding.pr_merged` with a non-empty list of valid PR URLs. Anything else,
  including an empty list, is refused (`unsupported_until`). Another kind is
  added only with its own read-only reader.
- **`reviewAt`** is when Neo looks at the hold again if it is still held. The
  default is 24 hours after the hold without `until`, and 7 days with it. A
  time in the past or more than 30 days away is refused.
- The `decision: true` path (a card for the human) refuses both fields. A todo
  already covered by a card keeps its card first, as today.

Both are stored in one new nullable column, `neo_todos.hold_json`:
`{ heldAt, until, reviewAt, failedAt }`. Holding again or releasing replaces it.

**Reading the condition.** The timed refresh sweep already runs the todo's own
`check` on every open todo (`todo-runner.ts`, `refresh`). Right after it, for a
todo still held with `until`, the coding pack reads exactly those URLs through
the same PR reader its checks use (`readPrs`). It does not read the todo's turns
and does not accept replacement PRs; the todo's own completion check keeps its
current behaviour, including finishing a held todo.

| PR read | Result |
|---|---|
| every named PR merged | release |
| any named PR closed without merging | failed |
| a PR missing, or the read failed | no change; next sweep reads again |

**Writing the result.** The result is applied through the existing todo
mutation writer, which re-plans against the latest row. The write also checks
that the row is still held with the same `heldAt`. A re-hold, a manual release,
completion or a closed ask in between makes the write a no-op.

- **Release** applies exactly today's `reason: null` patch. An unstarted todo
  returns to `todo` and the normal start gates. A started todo becomes
  `blocked` by `worker` with its binding intact. After the write, Neo gets one
  digest line through `neo.attention.tell` (`todo.hold_released`, one-shot,
  identity `todo:<id>:<heldAt>`) naming the PR that merged and, for a started
  todo, that its worker needs continuing. A restart between the write and the
  digest can lose that line; the todo's state still shows the release.
- **Failed** keeps the hold and writes `failedAt` once.

**Who looks at a hold.** In `nextStepOwner`, the held row becomes:

| Held todo | Owner |
|---|---|
| covered by a card | human (unchanged, first) |
| `failedAt` set | neo, reason `hold_failed`, since `failedAt` |
| `now >= reviewAt` | neo, reason `hold_review`, since `reviewAt` |
| otherwise | nobody |

`since` is a stored time, so a sweep never restarts or duplicates the ladder.
The sweep raises `todo.neo_step` only for approved or started todos, as today;
a held unapproved todo stays in the approval flow. Neo answers by acting on the
todo, releasing it, or holding it again with a new `reviewAt`.

Holds made before this change have no `hold_json`. They are read as
`reviewAt = updatedAt + 24 h`, so each existing hold reaches Neo once within a
day of the release. That is the intended clean-up.

Dependencies (`after`) are unchanged.

## 2. Neo is told when a worker is reserved by a todo that only waits

The rule stays: one worker serves one open todo. What changes is that a wait
behind an idle worker is no longer silent.

The queue already gives a send-target todo the reason "Waiting for worker …"
(`todo-worker-wait.ts`), but the attention sweep keeps only `start: 'held'` and
drops the reason. The sweep now keeps it, and also reads the holding todo.

A waiting todo is **reserved** when all of these hold:

- its queue reason is the worker wait;
- the todo holding that worker is doing, and its worker's last status is
  `done` or `stopped` (not `failed`, `needs_you`, running or unknown);
- the holder's owner row is `pack` (its pack reports it waiting on its PR).

A reserved todo's owner is `neo`, reason `worker_reserved`, since the later of
the holder's worker status time and the waiting todo becoming ready. That uses
the `todo.neo_step` ladder, so Neo hears at 1 h. The text names the holding
todo and the two ways on: wait for that PR, or remove this todo and add it again
for another worker (`neo.todo.remove` with `replacedBy`). Any other worker wait
keeps the owner `daemon`.

Letting the idle worker take the next todo automatically would put two open
todos on one binding. Turn reports, blockers, stops, retargeting and follow-up
delivery are all written per binding today, so that needs its own design.

## 3. The phone separates working from waiting

The daemon adds two optional fields to each todo item in `neoHumanQueue`,
computed from the same step row as `owner`:

```ts
step?: 'working' | 'waiting' | 'paused' | 'neo' | 'you';
waitingOn?: 'review' | 'earlier_step' | 'queue' | 'checking';
```

| Step row | `step` | `waitingOn` |
|---|---|---|
| owner worker, last status `running` | working | — |
| owner worker, last status `queued` | waiting | queue |
| owner pack | waiting | review (its review, CI or merge) |
| owner prerequisite | waiting | earlier_step |
| owner daemon, held by the queue's capacity or worker rule | waiting | queue |
| owner daemon, otherwise | waiting | checking |
| owner nobody (held) | paused | — |
| owner neo (including `hold_review`, `hold_failed`, `worker_reserved`) | neo | — |
| owner human | you | — |

`neoStepFacts` keeps the last observed `queued` apart from `running` for this;
the owner rows themselves do not change. "Working" means the last observed
status. It is accurate once blocked todos refresh their worker status (audit
fault 2, fixed separately).

The phone's filters become: Waiting on you, Working, Waiting, Held, All.

- Working: `step: working`. Waiting: `step: waiting` or `neo`, labelled from
  `waitingOn` ("Waiting for review, CI or merge", "After an earlier step",
  "Queued", "HyperNeo is checking") or "Neo's step".
- Held: held cards as today, plus `step: paused` todos. The ask filtering that
  uses the card-only held predicate keeps that predicate.
- Waiting on you keeps its rule and still counts asks. The other chips count
  items, as today.
- Rows, counts and deep links use the same predicate for each filter.
- Both fields are optional. An absent or unknown value uses today's mapping.

## Slices

1. **Daemon: holds.** `hold_json`, `until` and `reviewAt` validation, the
   read and fenced write in the refresh sweep, the digest, the held owner rows.
   Tests through the real hold operation and refresh: an unstarted and a
   started todo released on merge; a closed PR gives `hold_failed`; a missing
   PR or failed read changes nothing; an unrelated merged PR of the same todo
   does not release; the todo's own check finishing while held; a re-hold
   during a pending read; empty or unknown `until` refused; a decision card
   refuses the fields; an old hold reaches Neo after 24 h; repeated sweeps send
   one digest and one wake per rung.
2. **Daemon: queue steps and reserved workers.** The kept queue reason,
   `worker_reserved`, and `step` / `waitingOn`. Tests: each row of the step
   table; a reserved todo wakes Neo at 1 h; a holder whose worker is running,
   `needs_you`, failed or unknown, or whose PR closed, does not.
3. **Phone: Working and Waiting.** The filters and labels from `step`, legacy
   mapping, one predicate for rows, counts and links; screenshots in light and
   dark.

## Limits

- A PR read is only as fresh as the refresh sweep.
- Waits no reader can see (quota recovery, a release outside the daemon) use
  `reviewAt` only; Neo decides then.
- A reserved todo still waits until Neo or the human moves it.
