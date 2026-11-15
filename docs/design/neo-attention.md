# Neo attention: one entry for everything the daemon tells Neo

## Summary

About 20 producers write prose straight into Neo's session. Each decides alone whether to wake Neo, whether to repeat, and how to remember it already told Neo, using seven receipt stores and one in-memory set. Nothing re-checks whether an older message is still true.

That fails both ways. Many notices are ones Neo almost never acts on: todo-done notes, notes about todos already waiting on a human card, repeated stalled-ask reminders, "waiting for a worker" notes. Meanwhile facts the daemon holds never reach Neo:
- a PR merged or closed outside a todo is told only to its owner (`deliverCodingPrEvents`, `pr-events.ts`);
- a todo with an idle worker and an open PR gets no reminder, because the coding `waiting` hook exits the nudge pipeline (hook at `todo-prs.ts:533`, exit in `todo-runner.ts`);
- work done by a session the ask does not track has no event;
- turn reports for old turns arrive as new, with nothing checking for a newer report from the same worker;
- a failed todo is told once, and the cancelled-prerequisite note is de-duplicated only in memory;
- a todo whose result is more work (a design, research, a plan) can finish and its ask settle with no follow-up todo.

Wake and hold already exist (`prepareEntry` in `lib/mailbox/registration.ts`; the 15-minute hold flush). What is missing is one place that decides whether a message is worth telling, and anything that brings an unhandled one back.

This design adds one core entry, `lib/neo/attention/`: one superpipe, `neo.attention.tell`, and one pure decision. Every automatic message the daemon sends Neo goes through it; no producer writes to Neo's session directly. Messages from the human, card answers and a worker's deliberate message do not go through it and are never filtered. It adds no table. Packs add kinds through one `NeoPack.attention` hook.

## The entry

A producer calls `neo.attention.tell(event)` where it calls `tell` or `wakeNeo` today:

```ts
type NeoAttentionEvent = {
  kind: string;                        // 'todo.neo_step', 'coding.merge_held', ...
  subject: { type: string; id: string };
  since: number;                       // when this state of the subject began
  facts: Record<string, unknown>;
};
```

The superpipe:
1. **Read** the facts every kind may consult: the open cards covering the subject (`neoTodoCovered`), whether the human must act (`neoTodoAwaitsHuman`), and the latest turn report from the same worker.
2. **Decide**, pure: `decideNeoAttention(event, known, now)` returns `wake`, `digest` or `drop` with a reason, from the kind's row below. Cross-kind rules come first, and apply only to the kinds in the table that are not `pass`: a subject covered by an open card is dropped; a turn report superseded by a newer report from the same worker is dropped.
3. **Render**, pure, from the event's facts only, with absolute times. The same event always renders the same text.
4. **Deliver.** The message uuid is `<kind>:<subject>:<since>:<step>:<text hash>`, where `step` is how many repeats are due (below) and the hash is of the rendered text. Both delivery primitives refuse a seen uuid but throw when a seen uuid arrives with different content (`PromptContentConflictError` in `NeoWakeQueueRepository.hold`, `idempotency_conflict` in the job queue), so the text is part of the key: the same step with the same text is refused as seen, and a real change in what Neo would be told is a new message. The render therefore uses only facts that matter to Neo (no live counters, no relative times), so a flapping detail cannot resend. A wake goes through the mailbox once primitive the external events use (`submitSessionEvent`), and a digest item through the existing timed hold (`NeoWakeQueueRepository.hold`) and its 15-minute grouped flush. Both refuse a uuid they have seen, so the same step is never sent twice. A drop is logged with its reason.

**Repeating without a table.** A kind that repeats has a ladder, for example 1 h, 4 h, 24 h. `step` is the number of ladder rungs that `now - since` has passed. The 5-minute sweep re-raises every such subject from current state, so a new rung is a new uuid and is sent; an unchanged rung is refused as seen. `since` is the subject's own change time (a todo's `updatedAt`, a PR ledger row's `state_since`), so anything Neo does to the subject restarts the ladder, and a subject that is no longer true is simply not raised again. One-shot kinds have no ladder and are sent once.

## Decisions per kind

"Pass" means it keeps its current path and never enters `decideNeoAttention`. The entry must never filter the human, cards or a worker's deliberate message.

| Kind | Decision | Facts read | Repeat | Dies when |
|---|---|---|---|---|
| Human input, card answer, relayed answer, front hand-off, schedule, external event, preference changed, question retired, restart cut | pass | — | — | — |
| Worker message (`hyperneo send`, peer) | pass | — | — | — |
| `listening` on/off | record only, never wakes | — | — | — |
| `turn.report` done/running, with todo | digest. Wake if it carries a question, a `Blocked (…)` line, or the todo is `blocked`. | latest report from the same worker; todo state; covering card | none | a newer report from the same worker (fold); todo closed |
| `turn.report` notice (no todo) | digest, latest per worker | same | none | a newer report |
| `turn.report` failed / needs_you | wake | todo, cards | via `todo.neo_step` / `todo.stalled` | todo leaves state |
| `turn.report` focused status | drop ("status only, focused") | ask.focusedSession | — | — |
| `todo.done` | drop as its own item; raises `ask.finished` when it was the last open todo | ask todos | — | — |
| `ask.finished` (all todos finished) | wake once per finish | ask, todos | 24 h | ask settled or a todo added |
| `todo.blocked` waiting on a human card | drop ("covered by card") | `neoTodoAwaitsHuman`, covering card | — | — |
| `todo.blocked` other (needs-human without card, environment, check) | digest once per blocker revision | todo blocker, cards | 4 h, 24 h, then stop | blocker changes or clears |
| `todo.failed` | a reason of `todo.neo_step`, not its own item | — | — | — |
| `todo.unworked`, waiting for a worker or capacity | drop ("daemon starts it") | queue reasons (`planWorkQueue`) | — | starts |
| `todo.unworked`, not approved / no instruction | digest | todo, approval | 24 h | approved, started or removed |
| `todo.neo_step` (new, core): the one Neo-facing incident per todo whose next step is Neo's (table below) | wake | the facts in the table below, read outside the pure function | 1 h, 4 h, 24 h, then every 24 h while the owner is Neo | the owner is no longer Neo |
| `todo.stalled` (unreachable, rescued) | wake | nudge incident, live status | 4 h | progress or state change |
| `todo.prereq_cancelled` | a reason of `todo.neo_step`, not its own item | — | — | — |
| `ask.idle` (open ask, nothing running) | digest only if no todo remains; a todo that needs Neo is already a `todo.neo_step` | ask, todos, cards | 24 h (today 4 h) | a todo starts or the ask settles |
| `card.check_overdue` on a todo already waiting on another human card | drop | covering cards | — | — |
| Session error on a todo worker | wake | worker, todo | via `todo.stalled` | worker running |
| Driver health stalled (core); GitHub health stalled (`coding.github_health`) | digest | health incident | 24 h | recovered |
| `coding.merge_held` (sign-off) | wake once per PR head | fresh merge facts, handoff coverage | none | merged/closed, head changes, hold resolves |
| `coding.merge_failing` | wake after 3 failed attempts on one head, as today (`CODING_DAEMON_MERGE_MAX_ATTEMPTS`) | `pack_coding_daemon_merge_failures` | 4 h | merged or head changes |
| `coding.pr_event` (later; from Neo's PR topic subscriptions): a merge or close outside a todo | digest, to the candidate asks | the event; asks with a todo PR in that repo; owner's *active* todo | none | retires as soon as it is told |
| `coding.idle_with_open_pr` (new) | digest | todo live status, PR ledger state and `state_since` | 4 h | worker running, PR state changes, merged |
| `todo.follow_up_missing` (new, core; subject: the ask) | wake. Raised when a todo flagged `producesFollowUp` (set by Neo on `neo.todo.add`) is done and no non-removed todo follows it in its ask. The ask may not settle `done` while the item is open (`dropped` stays allowed). | that ask's todos by position and their `producesFollowUp` flag | 1 h, 4 h, 24 h | a non-removed todo exists after the flagged todo; ask settled or dropped |
| `coding.pr_unowned`, `coding.pr_sweep` escalation | wake | ledger | existing | owner assigned / PR closed |

Linking a PR outside a todo to an ask (for `coding.pr_event`) uses, in order:
1. A todo PR link. This exists today.
2. A repo where exactly one open ask has todo PRs.
3. The owner session's *currently active* todo.
4. Otherwise, one line with no ask, listing the candidate asks.

The owner-history link alone can put a merge on the wrong ask (the owner's last tracked todo may be elsewhere), so the repo rule comes first.

## Every open todo has one owner of its next step

The sweep computes a pure `nextStepOwner(facts)` for each approved, unfinished todo. The facts are read outside it: the todo, its target and worker ref, the worker's live status, the work queue's decision (`capacity.ts`), a scheduled retry, the pack's `waiting` answer, open cards covering the todo, and its prerequisites. The first matching row wins:

| Facts | Owner |
|---|---|
| an open card covers the todo | human |
| Neo put the todo on hold (`neo.todo.hold`) | nobody until Neo continues it |
| the todo is failed, or a prerequisite is failed or removed | neo |
| a prerequisite is still unfinished | that prerequisite's owner (no item for this todo) |
| blocked on `question` or `needs-human` with no open card: an answer still being delivered | daemon (the delivery resumes it) |
| blocked on `question` or `needs-human` with no open card, otherwise (even with a start target) | neo |
| live status unknown | daemon (reconcile first, no wake) |
| worker running | worker |
| a pack says it is waiting (for example an open PR) | pack (its own kind, such as `coding.idle_with_open_pr`) |
| a start target exists and the queue holds it (`planWorkQueue`: total or per-project limit reached, assigned worker busy, in priority order; or a scheduled retry) | daemon |
| a start target exists and the queue would start it now | daemon |
| no start target, or a worker idle with nothing to wait on | neo |

When the owner is `neo`, the sweep raises one `todo.neo_step` event with the reason (failed, prerequisite failed or removed, no worker, idle worker). It is the only Neo-facing message for that todo. It wakes Neo at 1 h, 4 h, 24 h, then every 24 h while the owner is Neo. Neo stops it by acting on the todo, by asking the human, or by holding it (`neo.todo.hold`). That is how approved work moves while the human is away. The wake names the todo, why the step is Neo's, and the one action that unblocks it, for example: "Its prerequisite is done and it has no instruction or worker: write the instruction and start it, or remove it." The prompt gets no new limits: Neo starts and assigns approved work on its own; starting new asks belongs to the goals system.

Tests give the owner for each row, including a todo waiting on an unfinished prerequisite (no message), a target with a queue hold (daemon), an idle worker with an open PR (pack), unknown live status (daemon), a held todo (nobody), and a failed todo with an idle worker (one `neo` message); and an unchanged Neo-owned todo still wakes after the last ladder step.

## Where it sits: core, with a pack hook

`lib/neo/attention/` is core. It knows asks, todos, questions and workers only, as `AGENTS.md` requires; a card is a question (`neo_questions`). Packs add kinds through one optional hook in `pack-contract.ts`:

```ts
attention?: {
  kinds: readonly NeoAttentionKind[];      // decide and render, registered by id prefix '<pack>.'
  scan?(now: number): Promise<readonly NeoAttentionEvent[]>;   // repeated kinds, raised each sweep
};
```

Core never branches on a pack id; it dispatches by `kind`. Coding moves its Neo-facing wakes (merge held/failing, unowned, sweep escalation) behind it and adds `idle_with_open_pr` in `scan`. Its `waiting` hook stays for worker reminders, but no longer silences Neo.

## Change plan

Slices in the `AGENTS.md` rungs, each about 100–250 production lines, branched from `dev`.

1. **Build: the entry.** `attention/decide.ts` (pure `decideNeoAttention`, the kind table, the ladder), `attention/owner.ts` (pure `nextStepOwner`), the render, the `NeoPack.attention` type, and the `neo.attention.tell` superpipe. Tests: the owner rows, covered-by-card drops, superseded reports drop, a rung is sent once and the next rung is sent, a change of `since` restarts the ladder, the same event renders the same text.
2. **Wire: `todo.neo_step`.** The 5-minute sweep raises it for every Neo-owned todo, next to the follow-up wake, which moves onto the entry in the same PR. One prompt line says what these wakes are.
3. **Wire: each producer, one PR each.** The core todo notes (`tell` in `service.ts`, which every `todo-runner.ts` note goes through), turn reports, stalled asks, driver health, and the coding pack's kinds. Each PR routes the producer through the entry and deletes that producer's own "already told" record in the same PR (for example `stalled_wake_at` for stalled asks, `pack_coding_daemon_merge_notices` for merge notices). An incident told just before its switch may be told once more; that is accepted.

Later, as its own small change: Neo's session subscribes to the PR topics of repos with open asks through the external events' topic subscriptions (`session_event_subscriptions`, `route-session-external-event`), and the route hands those events to the entry as `coding.pr_event`. That is how Neo learns of a merge done by another session.

## Limits and risks

- **Repeats that annoy.** A wrong owner row can repeat something Neo chose to leave. Neo holds the todo to stop it.
- **Silent drops.** Over-broad coverage can hide a real decision. Every drop is logged with its reason. The pass kinds are never gated.
- **Remote facts.** A PR can change after the last read. The entry only acts on its last read, and the next sweep corrects it within 5 minutes.
- **Linking.** Matching merges outside todos to an ask is a heuristic beyond the todo link. The digest names the candidates and lets Neo decide; it never closes anything.
- **Out of scope.** Worker-facing reminders and the front model's own catch-up.
