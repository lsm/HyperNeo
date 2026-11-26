# Work that waits: held todos, reserved workers, and what the phone counts

Status: proposal. Design only; no code in this PR.

Three gaps leave approved work sitting without anyone looking at it:

1. A hold records only a sentence. Nothing checks whether the thing it waits for
   has happened, and `nextStepOwner` gives a held todo to nobody
   (`attention/owner.ts`), so Neo is never reminded of it.
2. A todo sent to a named worker queues while another doing todo holds that
   worker, even when that todo only waits for its PR and the worker is idle.
   Neo is told the worker is working, so it leaves the wait alone.
3. The phone's "In progress" chip lists every todo item in progress whose
   owner is not the human, and labels the `daemon`, `worker` and `pack` owners
   all "Running". Most of them are waiting for a review, a merge, a queue slot
   or an earlier step. A Neo step over a day old becomes a `waiting` item with
   owner `neo`, which no chip but "All work" shows.

Each fix reuses what exists: the coding PR reader and ledger, the todo
mutation writer, the owner function, the runner's worker-wait wake, the
`todo.neo_step` wake and the human queue. No worker is shared between todos.

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
`{ heldAt, until, reviewAt, failed }`, where `failed` is `{ at, url, reason }`.
Holding again or releasing replaces it. Review times are always finite.

**Reading the condition.** The timed refresh sweep already runs the todo's own
`check` on every open todo (`todo-runner.ts`, `refresh`). Right after it, for a
todo still held with `until`, the coding pack reads exactly those URLs through
the same PR reader its checks use (`readPrs`). It does not read the todo's turns
and does not accept replacement PRs; the todo's own completion check keeps its
current behaviour, including finishing a held todo.

Results are matched to the named URLs by the coding PR identity
(`codingPrKey`). The first matching row wins:

| PR read | Result |
|---|---|
| the read failed, or any named PR has no result | no change; next sweep reads again |
| any named PR closed without merging | failed |
| every named PR merged | release |
| otherwise (some still open) | no change |

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
- **Failed** keeps the hold and writes `failed` once, with the closed PR's URL.

**Who looks at a hold.** In `nextStepOwner`, the held row becomes:

| Held todo | Owner |
|---|---|
| covered by a card | human (unchanged, first) |
| `failed` set | neo, reason `hold_failed`, since `failed.at` |
| `now >= reviewAt` | neo, reason `hold_review`, since `reviewAt` |
| otherwise | nobody |

`since` is a stored time. The two hold events render only stored hold facts
(the todo id, the hold reason, and for `hold_failed` the PR URL and reason),
not the todo's title, so their text and attention identity (todo, `heldAt`,
reason, rung) stay the same across sweeps and edits. While
the hold stays in place, reminders repeat on the existing ladder.
The sweep raises `todo.neo_step` only for approved or started todos, as today;
a held unapproved todo stays in the approval flow. Neo answers by acting on the
todo, releasing it, or holding it again with a new `reviewAt`.

Holds made before this change get `hold_json` once, in the migration:
`heldAt` is the row's `updatedAt` and `reviewAt` is the migration time plus
24 h. A later title or priority edit does not move it. Each existing hold
reaches Neo within a day of the release; that is the intended clean-up.

Dependencies (`after`) are unchanged.

## 2. The worker-wait wake says when the worker is only reserved

The rule stays: one worker serves one open todo, and the queue and dispatch
rules do not change.

The runner already handles this wait. When a send-target todo waits for its
worker, `recordWaits` (`todo-runner.ts`) stores the reason "Waiting for worker
…, which is working on …", starts its nudge ladder, and at 60 minutes wakes Neo
with `todo.stalled`. That wake is the one path. What is wrong is its text: it
says the worker is working, even when the worker is idle and its todo only
waits for a PR, so Neo leaves it to the daemon.

The reason text changes when the holder is **only reserving** the worker:

- the holder is bound to that worker (an actual ref, not only a send target)
  and is doing;
- its worker's last status is `done` or `stopped` (not `failed`, `needs_you`,
  running, queued or unknown);
- its check is `coding.pr_merged` and one PR that check is still waiting on
  is open. The coding pack answers this through one optional hook,
  `NeoTodoPack.openPr(todoId)`: it takes the open PRs from its existing ledger
  read and keeps only those the current check counts, the same selection
  `codingTodoCheck` makes (the named PRs, or a turn PR only where the check
  accepts it as a replacement). A closed or historical PR, an open PR the
  check would not count, or another check kind does not qualify.

Then the reason reads "Waiting for worker …, which is idle but kept by
"<holder>" while <PR> is open", and the 60-minute wake carries it with the way
on: wait for that PR, or add a replacement todo for another worker to the same
ask first and then remove this one with `replacedBy` (removing first drops the
link). Otherwise the text is unchanged.

The clock is the existing nudge ladder. Today `recordWaits` restarts it only
when a todo enters a worker wait, so a wait that began as "working" would
never wake again once the holder goes idle. `recordWaits` therefore also
restarts it whenever the stored reason changes between the working and the
reserved form, or the target worker or PR changes. A candidate that arrives
after the holder went idle waits its own 60 minutes; one queued while the
holder worked gets a fresh 60 minutes from the moment the holder qualifies.
A holder that works again flips the text back, and a later idle restarts it
again. An earlier "working" wake does not stop the reserved one.

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
| owner neo (including `hold_review`, `hold_failed`) | neo | — |
| owner human | you | — |

`neoStepFacts` keeps the last observed `queued` apart from `running` for this;
the owner rows themselves do not change. "Working" means the last observed
status. It is accurate once blocked todos refresh their worker status (audit
fault 2, fixed separately).

The phone's filters become: Waiting on you, Working, Waiting, Held, All.

Each todo item sits in exactly one of the first four chips:

- Waiting on you: `step: you`, plus open cards as today. It still counts asks.
- Working: `step: working`.
- Waiting: `step: waiting` or `neo`, labelled from `waitingOn` ("Waiting for
  review, CI or merge", "After an earlier step", "Queued", "HyperNeo is
  checking") or "Neo's step". A Neo step over a day old stays here, not in
  Waiting on you.
- Held: held cards as today, plus `step: paused` todos. The ask filtering that
  uses the card-only held predicate keeps that predicate.
- Working, Waiting and Held count items, as today.
- Rows, counts and deep links use the same predicate for each filter, and
  each row's label comes from the same field. A todo blocked on its check
  keeps no owner label, as today.
- Both fields are optional. An absent or unknown value uses today's mapping.

## Slices

1. **Daemon: holds.** `hold_json` and its migration, `until` and `reviewAt`
   validation, the read and fenced write in the refresh sweep, the digest, the
   held owner rows. Tests through the real hold operation and refresh: an
   unstarted and a started todo released on merge, and the next sweep after a
   started release; a merged-plus-missing pair and a closed-plus-missing pair
   change nothing; a closed PR gives `hold_failed` with its URL; a failed read changes nothing; an
   unrelated merged PR of the same todo does not release; the todo's own check
   finishing while held; a re-hold during a pending read; empty or unknown
   `until` refused; a decision card refuses the fields; a migrated hold reaches
   Neo after 24 h and a title edit does not move it; repeated sweeps send one
   digest and one wake per rung, also after a title edit between sweeps.
2. **Daemon: queue steps and the reserved-worker reason.** `step` /
   `waitingOn`, `NeoTodoPack.openPr`, and the reason text in `recordWaits`.
   Tests: each row of the step table; a send-target todo behind an idle holder
   with an open PR gets the reserved text and one wake 60 minutes after both
   were first seen together, none before, also for a candidate that arrives
   late and for one queued while the holder worked (working wake first, then
   a reserved wake 60 minutes after the holder went idle); a changed target
   restarts it; an open PR the check would not count
   (an unrelated one, or a replacement older than the closed named PR) does
   not qualify; a holder whose worker is running, `needs_you`, failed or unknown, a
   closed or historical PR, or a holder with another check kind keeps today's
   text.
3. **Phone: Working and Waiting.** The filters and labels from `step`, legacy
   mapping, one predicate for rows, counts, labels and links, and each todo
   item in exactly one of the four chips (a day-old Neo step included);
   screenshots in light and dark.

## Limits

- A PR read is only as fresh as the refresh sweep.
- Waits no reader can see (quota recovery, a release outside the daemon) use
  `reviewAt` only; Neo decides then.
- A reserved todo still waits until Neo or the human moves it.
