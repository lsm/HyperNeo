# Neo attention: one subsystem decides what Neo is told

## Summary

About 20 producers write prose straight into Neo's session. Each decides alone whether to wake Neo, whether to repeat, and how to remember it already told Neo, using seven receipt stores and one in-memory set. Nothing re-checks whether an older message is still true.

That fails both ways. Many notices are ones Neo almost never acts on: todo-done notes, notes about todos already waiting on a human card, repeated stalled-ask reminders, "waiting for a worker" notes. Meanwhile facts the daemon holds never reach Neo:
- a PR merged or closed outside a todo is told only to its owner (`deliverCodingPrEvents`, `pr-events.ts`);
- a todo with an idle worker and an open PR gets no reminder, because the coding `waiting` hook exits the nudge pipeline (hook at `todo-prs.ts:533`, exit in `todo-runner.ts`);
- work done by a session the ask does not track has no event;
- turn reports for old turns arrive as new, with nothing checking for a newer report from the same worker;
- a failed todo is told once, and the cancelled-prerequisite note is de-duplicated only in memory;
- a todo whose result is more work (a design, research, a plan) can finish and its ask settle with no follow-up todo.

Wake and hold already exist (`prepareEntry` in `lib/mailbox/registration.ts`; the 15-minute hold flush). What is missing is a decision about whether a message is still worth telling, and anything that brings an unhandled one back.

This design adds one core subsystem, `lib/neo/attention/`. Producers raise typed events (subject, kind, facts) instead of prose. One superpipe reads the current facts, runs a pure `decideNeoAttention`, and records the result: wake, digest, drop with a reason, or wait. One table, one row per subject and kind, also drives repetition: a periodic sweep re-reads each open item, retires a false one, and repeats a true, unhandled one on a backoff. Packs add kinds and fact readers through one `NeoPack.attention` hook.

## Design

## Shape

```
producers ──raise(event)──▶ neo.attention.admit ──▶ neo_attention_items ──▶ mailbox (wake | digest)
                               │  read facts (core + pack)                       ▲
                               │  decideNeoAttention (pure)                      │
pack scans ──raise──▶          └─ record decision ─────────────┐                 │
                                                               ▼                 │
                      neo.attention.sweep (every 5 min) ── re-read open items ───┘
                                                         retire | repeat | keep
```

**Event.**

```ts
type NeoAttentionEvent = {
  kind: string;                        // 'todo.neo_step', 'coding.pr_merged_outside_todo', ...
  subject: { type: 'todo' | 'ask' | 'worker' | 'card' | string; id: string };
  pack: string | null;                 // null for core kinds
  facts: Record<string, unknown>;      // what the producer observed
  sourceId: string;                    // existing idempotency key, kept
  at: number;
};
```

The event carries facts, not prose. The text is rendered after the decision, from the facts read at decision time. That way a stale producer read cannot reach Neo.

**Kind.** A kind is registered by core or by a pack:

```ts
interface NeoAttentionKind<F> {
  kind: string;
  read(subject, event): Promise<F | null>;     // current facts; null = subject gone
  stillTrue(facts: F): boolean;
  revision(facts: F): string;                  // canonical, excludes times and counts
  decide(facts: F, known: Known): Decision;    // pure, per-kind policy (table below)
  render(facts: F): { line: string; verb: string };
  repeat?: readonly number[];                  // backoff in ms; absent = never repeat
}
type Decision =
  | { deliver: 'wake' | 'digest' }
  | { drop: string }                           // reason, logged and counted
  | { wait: { until?: number; untilRevisionChanges: true } };
```

`Known` holds the facts that every kind may consult, read once per admission:
- the subject's current row in `neo_attention_items`;
- the open cards covering the subject, using the existing `neoQuestionCoversTodo` / `neoTodoCovered`;
- whether the human is the one who must act: `neoTodoAwaitsHuman`;
- the latest turn report from the same worker.

**Raising is durable.** A producer raises an event by enqueueing one `neo.attention.admit` job on the existing job queue, in the same write that records its own state change. The job processor runs admission. When a fact read fails, the job fails and is retried with the queue's existing exponential backoff (`JobQueueRepository.fail`); a job that runs out of retries is marked `dead`, and the 5-minute sweep re-enqueues dead admit jobs. Today both cleanup queries delete dead rows of every queue after the retention cutoff: the hourly `jobs.cleanup` op (`cleanupJobs`, run through `cleanupJobsInBatches`) and its fallback `JobQueueRepository.cleanup()`. This design adds one clause to both so they keep dead admit jobs; completed admit jobs are cleaned up as usual. A dead admit job therefore stays until a later admission succeeds, even after downtime longer than the retention cutoff. Retrying is bounded. An event whose kind is no longer registered (a pack removed or a kind renamed) completes at once as dropped with reason `unknown_kind`. A registered kind whose read keeps failing is retired after the sweep has re-enqueued it 2,016 times (7 days of running sweeps, so downtime does not count): the sweep completes the job as dropped with reason `read_failed`, and it is counted like any drop. So a first admission that fails is never lost, even across a restart, and the sweep does not need to rediscover producer-only kinds.

**Pipeline `neo.attention.admit`.** It is one superpipe, with the effects at its edges:
1. `read`: look up the kind and call `kind.read(subject, event)`, plus `Known`.
2. `stillTrue` and `revision`: pure.
3. `decideNeoAttention(kind, facts, known, row, now)`: pure. It handles the cross-kind rules first, then calls `kind.decide`:
   - A delivered item whose revision is unchanged is a duplicate.
   - An item covered by an open card waits while the card is open.
   - A turn report superseded by a newer report from the same worker folds.
4. `record and enqueue`: one gateway operation, in one transaction. It upserts `neo_attention_items` (revision, state, `told_at`, `told_count`, `next_at`) and writes the outbox row: on `wake`, a `mailbox` job (`enqueueMailboxEntry`, `lib/mailbox/handoff.ts`); on `digest`, a `neo_notes` hold (`NeoWakeQueueRepository.hold`). Actual delivery stays with the existing processors. It does not call `deliverForward`, whose enqueue is asynchronous and runs in its own gateway call (`service.ts` `enqueueDelivery`).

Each outbox row's `messageUuid` is derived, not random: `attention:<subject>:<kind>:<episode>:<told_count>`, from the row's `episode` and `told_count` columns. A → B → A is three episodes, so it never reuses a uuid. A retried job after a lost acknowledgement writes the same uuid and must not enqueue twice. The hold side already refuses it (`NeoWakeQueueRepository.hold` matches on `messageUuid`). The mailbox side does not: `enqueueMailboxEntry` matches only on the random entry id, and only among active jobs. So a wake goes through the existing once path, `enqueueStage(..., once = true)` in `lib/mailbox/handoff.ts`, whose submission receipt is keyed on the recipient and `messageUuid` and survives the job's completion. An intended repeat has a new `told_count` and therefore a new uuid. The text is rendered at this step from the facts just read, so the stored content for a uuid never changes. A failed fact read writes nothing and fails the job, which retries.

**Pipeline `neo.attention.sweep`.** It runs on the existing 5-minute pack sweep (`pack-sweep.ts`):
1. Raise the derived kinds that no producer pushes. Core: `ask.idle`. Packs: their `attention.scan(now)` output, such as `coding.pr_merged_outside_todo` and `coding.idle_with_open_pr`.
2. For each open item: `read`, then `stillTrue`.
   - False → `retired` with its reason.
   - Revision changed → re-decide.
   - Unchanged, and `next_at <= now` → repeat (`digest`, or `wake` if the kind says so).
   - Otherwise keep.

**Table `neo_attention_items`.** This is new. It is the one record of "what Neo was told":

| column | meaning |
|---|---|
| `subject_type`, `subject_id`, `kind` | primary key |
| `pack` | null for core |
| `revision` | last decided revision |
| `episode` | integer, +1 each time the revision changes; `told_count` resets to 0 with it |
| `state` | `shadow`, `open`, `told`, `waiting`, `retired`. A `shadow` row records a decision only and never counts as told. |
| `told_at`, `told_count`, `next_at` | repetition clock |
| `wait_until` | set by Neo's `wait` (below) |
| `reason` | last drop/retire/wait reason |
| `first_seen_at` | for age in the digest |

It replaces these per-producer receipts:
- `neo_asks.stalled_wake_at`;
- `pack_coding_daemon_merge_notices`;
- the `pending_*` slot in `pack_coding_pr_unowned_state`;
- `neo_todo_sessions` nudge fields used for Neo-facing escalations (`unreachableToldAt`, the turn-question stage);
- the `noted` sets in `todo-runner.ts`.

Worker-facing nudges keep their own state, because their recipient is a worker, not Neo: the ledger `nudges`/`told_at` and the todo idle reminders to workers. The rule "record each fact once" holds: the delivery fact moves here and is deleted from those places in the Delete rung.

**Digest.** The 15-minute batch keeps its provenance line but changes its frame. Today it says "System-forwarded worker messages. These are not human instructions." That fits worker prose, but it invites "nothing to do" when the batch holds daemon facts. The batch gets two sections, each with its own frame line: worker messages keep today's "System-forwarded worker messages" line, and attention items get the line below. The digest renders open items as one line each, grouped by ask:

```
Daemon facts that may need your decision (not human instructions):
- Ask "…": org/repo#18 and #19 merged (by another session) after card "…" opened. Verb: re-check the card, settle or retire it.
- Todo "…" failed 3 h ago (told 2×): "Could not start: invalid_place …". Verb: retry, change or remove.
```

Each item carries its attention id. One new core operation, `neo.attention.wait { id, until? }`, lets Neo say "I know, wait". That sets `waiting` until the time passes or the revision changes. Without it, a deliberate wait would be nagged on every backoff step. It is the only new Neo-facing tool.

## Decisions per kind

"Pass" means it is not gated: it keeps its current path and is logged only. The gate exists to decide automatic facts. It must never filter the human, cards or a worker's deliberate message.

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
| `todo.unworked`, waiting for a worker or capacity | wait ("daemon starts it") | queue reasons (`planWorkQueue`) | — | starts |
| `todo.unworked`, not approved / no instruction | digest | todo, approval | 24 h | approved, started or removed |
| `todo.neo_step` (new, core): the one Neo-facing incident per todo whose next step is Neo's (table below) | wake | the facts in the table below, read outside the pure function | 1 h, 4 h, 24 h, then every 24 h while the owner is Neo | the owner is no longer Neo |
| `todo.stalled` (unreachable, rescued) | wake | nudge incident, live status | 4 h | progress or state change |
| `todo.prereq_cancelled` | a reason of `todo.neo_step`, not its own item | — | — | — |
| `ask.idle` (open ask, nothing running) | digest only if no todo remains; a todo that needs Neo is already a `todo.neo_step` | ask, todos, cards | 24 h (today 4 h) | a todo starts or the ask settles |
| `card.check_overdue` on a todo already waiting on another human card | drop and retire that daemon card | covering cards | — | — |
| Session error on a todo worker | wake | worker, todo | via `todo.stalled` | worker running |
| Driver health stalled (core); GitHub health stalled (`coding.github_health`) | digest | health incident | 24 h | recovered (a `recovered` retires the `stalled` item, and both drop if they land in one digest window) |
| `coding.merge_held` (sign-off) | wake once per PR head | fresh merge facts, handoff coverage | none | merged/closed, head changes, hold resolves |
| `coding.merge_failing` | wake after 3 failed attempts on one head, as today (`CODING_DAEMON_MERGE_MAX_ATTEMPTS`) | `pack_coding_daemon_merge_failures` | 4 h | merged or head changes |
| `coding.pr_merged_outside_todo` (new) | digest, to the candidate asks | ledger row; asks with a todo PR in that repo; owner's *active* todo | none | retires as soon as it is told |
| `coding.idle_with_open_pr` (new) | digest | todo live status, PR ledger state and `state_since` | 4 h | worker running, PR state changes, merged |
| `todo.follow_up_missing` (new, core; subject: the ask) | wake. Raised when a todo flagged `producesFollowUp` (set by Neo on `neo.todo.add`) is done and no non-removed todo follows it in its ask. The ask may not settle `done` while the item is open (`dropped` stays allowed). | that ask's todos by position and their `producesFollowUp` flag | 1 h, 4 h, 24 h | a non-removed todo exists after the flagged todo; ask settled or dropped |
| `coding.pr_unowned`, `coding.pr_sweep` escalation | wake | ledger | existing | owner assigned / PR closed |

Linking a PR outside a todo to an ask uses, in order:
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
| the todo is failed, or a prerequisite is failed or removed | neo |
| live status unknown | daemon (reconcile first, no wake) |
| worker running | worker |
| a pack says it is waiting (for example an open PR) | pack (its own kind, such as `coding.idle_with_open_pr`) |
| a start target exists and the queue holds it (capacity, busy worker, scheduled retry) | daemon |
| a start target exists and the queue would start it now | daemon |
| no start target, or a worker idle with nothing to wait on | neo |

When the owner is `neo`, one `todo.neo_step` item carries the reason (failed, prerequisite failed or removed, no worker, idle worker). It is the only Neo-facing item for that todo, so a failed idle todo or a removed prerequisite wakes Neo once, with one repeat clock. It keeps waking (1 h, 4 h, 24 h, then every 24 h) while the owner is Neo; a card or Neo's `wait` still silences it. That is how approved work moves while the human is away. The prompt gets no new limits: Neo starts and assigns approved work on its own; starting new asks belongs to the goals system.

Tests give the owner for each row, including a target with a queue hold (daemon), an idle worker with an open PR (pack), unknown live status (daemon), and a failed todo with an idle worker (one `neo` item); and an unchanged Neo-owned todo still wakes after the last ladder step.

## Repetition and death

- A kind with no `repeat` retires as soon as it is told, so the sweep stops re-reading one-shot facts.
- An item repeats only if `stillTrue`, the revision is unchanged, it is not `waiting`, and `next_at` has passed. The backoff comes from the kind (1 h / 4 h / 24 h). It stops after the last step, except where a kind says otherwise (`todo.neo_step`), and stays visible in the work snapshot as "unhandled since …".
- Neo's own action is never tracked directly. Anything Neo does changes the facts: a todo edit, a card, a send, a settle. That makes the condition false (retire) or the revision new (decide again). This keeps "record each fact once": the facts that already exist decide.
- A new revision is a new episode: A → B → A notifies again, as in the earlier root design.
- Stale items die in the sweep, never at render time. An item read but not yet rendered is re-read at render. A failed read keeps the old state and defers.

## Where it sits: core, with a pack hook

`lib/neo/attention/` is core. It knows asks, todos, questions, workers and cards only, as `AGENTS.md` requires. Core kinds: `turn.report`, `todo.*`, `ask.*`, `card.*`, `session.*`, `health.driver`. GitHub health is coding-pack state, so its kind is `coding.github_health`.

Packs extend it through one optional hook in `pack-contract.ts`:

```ts
attention?: {
  kinds: readonly NeoAttentionKind<unknown>[];   // registered by id prefix '<pack>.'
  scan?(now: number): Promise<readonly NeoAttentionEvent[]>;
};
```

- **Coding** moves its Neo-facing `wake` calls behind `attention`: merge held/failing, unowned, sweep escalation. It adds `pr_merged_outside_todo` and `idle_with_open_pr` in `scan`. Its `waiting` hook stays for worker reminders, but it no longer silences Neo: `idle_with_open_pr` is how Neo hears.
- **Delegation** and **life-admin** register no kinds today. A delegation pack would raise `delegation.awaiting_human_step` (a form waiting for the human's last click) the same way.
- **A future usage pack** raises `usage.near_limit` and `usage.limit_reset` from provider usage. It is digest-only. A reset retires the near-limit item.

Core never branches on a pack id. It only dispatches by `kind`.

## Proving it

A replay of one week of a real installation's inputs through the decision table cut about 20% of events, of which under 2% were followed by any Neo action, and added a small number of digest items, mostly PR merges outside todos. Human input, card answers and worker messages were untouched.

The real proof is a shadow week. The first wired PR runs `admit` in shadow: every producer still sends as today, `admit` records its decision with `state = 'shadow'`, and the daemon logs one `neo.attention.shadow kind=… decision=… reason=…` line per event. After a week, a read-only query reports counts per kind and decision, joined to Neo's next-turn actions. Pass mark: cut events have an action rate under 3%, and none is a human input, card answer or worker message. Then each kind switches live, one PR per producer.

## Change plan

These are slices in the `AGENTS.md` rungs, each one about 100–250 production lines, branched from `dev`.

1. **Build: decision core.**
   - Contents: `attention/kinds.ts`, `attention/decide.ts` (pure `decideNeoAttention`, cross-kind rules, the core kind table) and the `NeoPack.attention` contract type.
   - Tests: covered-by-card drops, superseded reports fold, a stale item retires, an unchanged item repeats on backoff, A → B → A re-notifies.
   - Exported, not called.
2. **Build: store and pipelines.**
   - Contents: the `neo_attention_items` migration, its repository on the gateway, the dead-admit-job exclusion in both cleanup queries, and the `neo.attention.admit` and `neo.attention.sweep` superpipes with `state = 'shadow'` support.
   - Tests: a dead admit job older than the cleanup retention survives cleanup and is delivered once by the next sweep; the item row and its outbox row commit together or not at all; a retried job writes no second outbox row; a repeat writes a new one; the first read fails before any row exists, the daemon restarts, and the notice is delivered once.
   - Reachable through the sweep in shadow only.
3. **Wire (shadow): core todo notes.** One call site: `tell` in `service.ts` (`createNeoTodoRunner`), which every `todo-runner.ts` note goes through.
   - `todo.follow_up_missing` lands before this rung, in core, without the pipeline, as two PRs. Build: a `producesFollowUp` flag on `neo_todos`, a pure check over the ask's todos, and a refusal of `done` in `neo.ask.settle` and in auto-settle, rechecked at commit as HyperNeo #10665 already does; nothing sets the flag yet. Wire: `neo.todo.add` accepts the flag, and the existing 5-minute pack sweep wakes Neo.
   - HyperNeo #10665 is being reworked from a coding-pack, `docs/design/` path check to this core flag. After the rework the coding pack has no design logic.
   - Moving the kind onto the pipeline changes neither the pure check nor the settle refusal. The kind's `stillTrue` is that check, the sweep's direct wake is deleted, and the kind gains the 1 h / 4 h / 24 h repeat.
4. **Wire (shadow): turn reports, stalled asks, health.** Three call sites, each in its own PR.
5. **Coding pack `attention`.** Build: the kinds for merge held/failing and unowned, and `scan` for `pr_merged_outside_todo` and `idle_with_open_pr`, registered but not called. Wire, one PR per producer: route those producers through `admit` in shadow.
6. **Wire: digest renderer and `neo.attention.wait`.** One prompt line in `root-turn-end.md`, about digest items and `wait`.
7. **Read the shadow week.** Then switch kinds live, one PR per producer, each a few lines. Shadow rows never count as told: going live starts every item at `open`. Each live switch carries its cutover:
   - The kind's `read` also reads the producer's old receipt (for example `stalled_wake_at`, `pack_coding_daemon_merge_notices`, turn-report receipts) as "already told at". An incident told before the switch is not told again.
   - Old producers enqueue first and write their receipt afterwards (`stalled-asks.ts`, `turn-report-receipts.ts`), so a crash can leave a queued old notice with no receipt. The receipt alone is not enough. The kind's `read` therefore also counts an old notice as told when its message uuid is an active `mailbox` or `neo_notes` job or an existing SDK message for Neo's session, using the checks `enqueueDelivery` already makes (`listActiveByPayload`, `findMessageIdByUuid`). The kind names the uuid its old producer used for the subject.
   - Old queued rows are left to deliver as they are. The old producer stops writing in the same PR, so nothing is queued twice.
   - Tests: an incident told before the switch is not re-told; a queued old notice whose receipt was never written is delivered once and gets no attention notice.
8. **Delete**, at least one release after the last kind went live, so a rollback still finds the old receipts. A rollback in that window can re-tell an incident first told by the new code once; that is accepted. Remove these, one PR each:
   - `stalled_wake_at` use, `pack_coding_daemon_merge_notices`, the unowned pending slot and the in-memory `noted` sets;
   - the Neo-facing nudge fields in `neo_todo_sessions` (`unreachableToldAt`, the turn-question stage) and the turn-report receipts' Neo-delivery part;
   - the per-producer `neoWakeEvent` flags, now set only by `admit`;
   - the check-overdue card for todos already waiting on the human.

## Limits and risks

- **Repeats that annoy.** A wrong `stillTrue` can repeat something Neo chose to ignore. The backoff stops after three steps, and `wait` silences an item until the facts change.
- **Silent drops.** Over-broad coverage can hide a real decision. Every drop is recorded with a reason and counted in shadow before it goes live. The pass kinds are never gated.
- **Remote facts.** A PR can change after the last read. The design only ever acts on its last read, and the next sweep corrects it within 5 minutes.
- **Linking.** Matching merges outside todos to an ask is a heuristic beyond the todo link. The digest names the candidates and lets Neo decide; it never closes anything.
- **Out of scope.** Worker-facing reminders, the front model's own catch-up, and how Neo is prompted to work while the human is away. If starts still fall after the facts arrive, that is a separate prompt change.
