# A clean worker for every job, fewer empty PR notices

Status: proposal, 2026-11-25. Design only. Items 1 and 2 of #11728.

## Why

Every model request re-reads the whole conversation. Over one week and 762 merged pull
requests, that re-reading was about 70% of the cost of a PR. One PR rarely needs a large
conversation: it adds a median of 76k (Claude) and 93k (Codex) tokens, and 2% add more than
400k. But a PR starts at a median of 231k (Claude) and 103k (Codex), because its worker
still carries earlier jobs. `session-reuse.md` already compacts a reused worker before its
next todo; that covers only part of the reuse.

## 1. A new todo gets a clean worker

**The rule.** A todo is one job. A worker the daemon started takes a *new* todo only after a
confirmed compaction; otherwise a new worker takes it. Inside one todo nothing is compacted
by the daemon: later rounds, review findings and failing CI go to the same conversation. The
model's own window stays the only limit there.

**What the current code misses.**

- A `send` todo whose worker cannot compact (Claude Desktop has no `compact`) is sent as it is.
- So is one whose worker belongs to another ask, was already released, or still holds
  another unfinished todo.
- A compaction that fails or is not confirmed is logged and the todo is sent anyway.
- Confirmation waits 60 s. Of 33 compactions with their own Codex turn, the median took 49 s
  and the longest 80 s; 8 took longer than 60 s, so a compaction that worked is reported as
  not confirmed.
- No success is recorded, so coverage cannot be measured.

**Where.** Two places already call `compactBeforeReuse`: `dispatch` in `todo-runner.ts` (a
`send` target) and `reuseIdleWorker` in `work-operations.ts` (a `start` target). Both use one
pure decision in `worker-compaction.ts`:

| Facts about the target worker | Result |
|---|---|
| this todo already ran on it or has a role on it (a later round), or the human named the session, or the daemon did not start it, or it is on another daemon | send, as today |
| same ask, not released, no other `doing` or `blocked` todo on it, adapter has `compact` | compact, then send; not confirmed: fresh |
| anything else | fresh |

*Fresh* in `dispatch` replaces the `send` target by a `start` built from the worker's start
record: adapter, machine, folder, provider, model and effort, and `sandbox: true` when the
record has a preparation. A sandboxed worker is never replaced by an unsandboxed one. The old
worker is added to `excludeRefs`. If the record has no folder or the start is refused, the
todo fails to start as any start does; it is not sent to the old worker. Neo is told once
through the existing `todo.line_moved` note, so it stops aiming at that worker.

The checkout comes from this todo, never from the old worker's earlier todo. `send` targets
get two optional fields, `preparationParameters` and `sandbox`: Neo may set them, and
`queueOn`, which turns a waiting `start` into a `send`, copies them (`{}` when the `start` had
none) instead of dropping them. The replacement `start` uses exactly these. When a
preparation would run (the pack has `prepareExecution` and the sandbox is on for this start,
or the old worker's record has a preparation) and the target carries no
`preparationParameters`, nothing starts and nothing is sent: the todo is blocked, and Neo is
asked to name the target or PR, head and prerequisite commits in a `start`. No new worker is
started on the default branch by guess.

*Fresh* in `reuseIdleWorker` drops the candidate, releases its claim and tries the next, and
at the end starts new. A role's own worker on this todo and a worker shared between roles of
this todo are the same job and are not affected.

Compaction waits up to 180 s for confirmation, in both Codex routes and for a HyperNeo
session.

**Record.** The todo's core fact `worker_reuse`: the worker, `compacted` or `fresh`, and why
(`other_ask`, `released`, `other_todo`, `cannot_compact`, `not_confirmed`). Nothing reads it
to decide; it is for measuring. No migration.

**`sessionReuse`.** `long_lived` and `per_ask` keep their meaning for a worker that can
compact. A worker that cannot is one session per todo under every value, because there is
no clean way to reuse it. Continuing the same job needs no new todo: `neo.todo.continue`
stays in the same conversation.

**Why not also compact inside a job.** Replay of the same week's author sessions, with costs
taken from real compactions (summary, rewritten prefix, extra reading after it), compacting
at every new PR whatever the size. Compactions inside a job are per week.

| Policy | Claude | Codex | Inside a job (Claude + Codex) |
|---|---|---|---|
| **before the next PR only** | **-6%** | **-17%** | **0** |
| also at 400k | -7% | -17% | 22 |
| also at 300k | -10% | -21% | 66 |

A limit inside the job saves a few points more and interrupts work; the replay cannot show
what a summary loses. Compacting only above a size before the next PR changes the result by
at most 2 points, so there is no size setting. Codex is priced flat: OpenAI charges no
long-context surcharge for [subscription use of gpt-6.1-sol](https://learn.chatgpt.com/docs/pricing)
or for [ChatGPT sign-in on credit plans](https://help.openai.com/en/articles/11481834-chatgpt-rate-card-business-enterpriseedu-credit-based-pricing).
A PR that adds more than 300k by itself (5-6%) is a sign that the job was too
large or was reworked too often; that is for measurement, not for a cut. These numbers start a job at a worker's
first round on a PR, and charge a fresh worker like a compaction; the product's unit is a
todo, so measure again after release.

**Not covered.** This reaches jobs that go through a todo. A message Neo sends to a worker
without a todo is not changed.

## 2. No notice that needs no action

Of the daemon's PR notices, two almost never lead to a push:

- **The second merge notice.** A PR the daemon merges sends "Merge confirmed" and then "was
  merged" to the same worker (271 of 311 merges). The daemon merge receipt cannot decide
  this: it is also marked notified when the worker could not be reached and Neo was woken
  instead. So the fact is recorded per recipient, with the per-owner receipt that failing
  reviews already use (`reviewSent` / `markReview`, keyed by event and owner): when `notify`
  in `daemon-merge-sweep.ts` delivers "Merge confirmed" to the owner, and only then, it marks
  the `merged` event of that PR and head as sent to that owner. `deliverCodingPrEvents` reads
  that receipt for `merged` as it does for `failing`, and accepts the event without telling.
  Every other case has no receipt and still sends "was merged": owner delivery failed and Neo
  was woken, the owner changed in between, a crash before the mark, a merge by hand.
- **The reminder while CI runs.** `waiting_ci` and `approved_pending` no longer remind the
  owner (one push in 80 reminders). If CI fails, `failing` still tells the owner at once.
  The last step still goes to Neo, so a stuck check is not lost.

Left alone on purpose: requested changes, failing CI, conflicts (67-72% lead to a push) and
"waiting for review" (half of those turns re-request the review).
Waiting for CI and review together before telling the author is not worth building: both
fired on the same head for 12 of 373 heads.

This part is small, about 1% of the cost. It is here because it removes code paths that
only spend.

## Changes

Two PRs from `dev`, no migration, no new setting.

1. Clean worker: the decision and both callers, the 180 s wait, the fact. Failing tests first,
   through the real dispatch and `reuseIdleWorker` with fake adapters: same ask with `compact`
   is compacted once and then sent; each row of the table that gives *fresh* starts a new
   worker and sends nothing to the old one; unconfirmed compaction starts a new worker; a
   later round, a human-named session and a session the daemon did not start are sent
   unchanged; a sandboxed worker's replacement is sandboxed; the start does not pick the old
   worker again. With a real repository: a queued pinned review keeps its PR, exact head and
   prerequisite commits through the replacement, and the new checkout is at that head; a moved
   head or a missing prerequisite refuses; a `send` with no parameters where a preparation
   would run is blocked and creates no checkout. A week after release, read `worker_reuse` and re-run the same cost numbers
   and review rounds per PR; revert if review rounds rise.
2. The notices: `planCodingPrNudge` skips the owner reminder for the two states and keeps the
   escalation; `notify` marks the per-owner receipt and `deliverCodingPrEvents` reads it. Tests
   through the real sweep order: a daemon merge told to the owner sends one notice; **owner
   delivery fails and Neo's wake succeeds, then the owner is reachable: the owner gets "was
   merged" once**; an owner changed after "Merge confirmed" gets "was merged"; a hand merge
   sends one; pending CI sends no reminder and still escalates.
