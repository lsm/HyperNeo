# Neo simplify

Status: the human's decision of 2026-10-18, with the open questions answered. Revised 2026-10-18 against an external review (done at `f8e74900a`); code references are on `dev` at `56701759d7`; unprefixed paths are under `packages/daemon/src/lib/neo/`, `lib/` paths under `packages/daemon/src/`, `shared/` paths under `packages/`, and prompt (`.md`) paths under `packages/prompts/src/`.

## The core

Neo is one session that holds the whole conversation. It listens to the human, decides, and hands work to an executor. Each item it hands off is `todo` (not started), then in one of four states:

- **doing**: the executor is working on it;
- **done**;
- **failed**: an error the executor can't recover from;
- **blocked**: stuck, or waiting for a question to be confirmed.

`removed` stays for withdrawn items. All five states are stored, never derived: `blocked` is a `NeoTodoState` with `blocked_reason` and `next_action` columns. Only a change to done, failed or blocked wakes Neo. Neo then tells the human or plans the next step; it ignores the progress in between.

All state lives in the database, so a restart or a compaction loses nothing. Everything Neo receives is visible in its own session: nothing is injected at send time, and anything the daemon adds is written into the stored message.

There is exactly one Neo session, with no clones, forks or sub-agents. A restart archives it before opening a fresh one on the same database; no new or restarted root session is opened until S2 lands.

A human message preempts a daemon-triggered turn, or a human turn that is already answered. It never preempts an unanswered human turn: the new message queues (`shouldPreemptNeoTurn`, `notification-triggers.ts:291`). That contract is kept, not broadened.

## What a pack provides

The core knows nothing about any one kind of work. A pack supplies the four things the core needs:

- **Done.** How to judge that an item is done. Every completion path, `neo.todo.edit` with `done`, `neo.todo.close` and the runner's pack check, goes through one completion rule; today `planNeoTodoEdit`, `planNeoTodoClose` and `planNeoTodoCheck` each set `done` on their own.
- **Progress.** How the pack's own progress events are handled. For example, they can go straight to the executor and never reach Neo.
- **Failed and blocked.** What counts as each, including a no-progress timeout that turns an item blocked. The pack check result gains `failed` and `blocked` outcomes next to `done` (today `NeoTodoCheckResult` is `{ done, evidence }`).
- **Status line.** The line each item's card shows, so the human sees the current state without asking Neo.

## Tools

| Group | Neo's operations |
|---|---|
| Reading | `neo.snapshot`, `neo.conversation.read`, `neo.pack.read`, `neo.github.read`, `work.find`, `work.read` |
| Asks | `neo.ask.open`, `neo.ask.settle` |
| Todos | `neo.todo.add`, `neo.todo.edit`, `neo.todo.remove`, `neo.todo.continue`, `neo.todo.retry`, `neo.todo.close` |
| Questions | `neo.question.ask`, `neo.question.answer`, `neo.question.retire` |
| Publishing and state | `neo.publication.publish` (revises with `publicationId`), `neo.project.save` (labels), `neo.rule.save` |

Native tools are Read, Bash, WebSearch and WebFetch. Projects and domains such as work and home are labels on asks and todos, not sessions. Ask and todo titles follow `GlobalSettings.language`, where `'system'` means the language of the human's latest message.

## The coding pack

- **Done** is every required pull request merged. One merged PR of two is not done. The migration rewrites legacy `coding.pr_opened` checks to `coding.pr_merged`.
- **Progress** is CI and review events. They go straight to the working session.
- **Failed** is a required pull request closed without merging and with no replacement. Neo asks the human whether to redo it or drop it. A replacement PR takes the closed one's place in the required set.
- **Blocked** is an open human question (`neo_questions`), a stopped worker (`live_status`), the same failure twice, or no progress past the sweep's reassign point. The reason and the next action are stored.
- **Status line.** The card shows the pull request's ledger state.

**PR ledger.**
- The table `pack_coding_pr_ledger` has one row per PR in any project repo that is open, or was closed within 7 days.
- Each row records `repo` and `number`, then `head`, `branch` and `title`, and the `state`: `draft`, `waiting_review`, `changes_requested`, `failing`, `dirty`, `approved_pending`, `approved_green`, `merged` or `closed`.
- It also records `state_since`, `author` and `merge_owner`, which defaults to the author. Both store a full WorkRef `{adapter, id, daemon?}`. The last three fields are `told_at`, `nudges` and `read_at`.
- "Owner gone" is decided by the adapter's lifecycle; a Codex thread has no local session row. After a reassignment the new owner is authoritative, even if the old worker resumes.
- The author comes from `lib/drivers/opened-prs.ts`, which moves into the coding pack as the PR→author source.
- Reconcile runs on GitHub PR events, plus one batched GraphQL read per repo every 5 minutes. A cycle is skipped while fewer than 500 API calls remain. A stale or partial read pauses the sweep clock; it is never evidence of inactivity.
- A PR with no todo but a known author is supervised. A PR with no known author is tracked, but not assigned.

**To the worker, once per event.** These go to the `merge_owner`, never to Neo:
- CI failed, with the failing check;
- CI green;
- changes requested, or new review comments;
- approved and green, which means merge now with a manual squash;
- `dirty`, which means merge the base in.

**Delivery.** Tells and wakes reuse the existing mailbox and job queue.
- Persisting an event records a delivery obligation; it is cleared only after durable handoff. Today `SessionExternalEventStore.store` reports any duplicate as terminal, so a crash between observe and handoff loses the event.
- `work.send` gains an optional `deliveryKey`. Adapters that can't dedupe accept at-least-once delivery; there is no further reconciliation.

**The sweep.**
- The first tell goes at the event. Reminder 1 goes at deadline D, reminder 2 at 2D, and at 3D with still no progress Neo reassigns the PR to a free session. It asks the human only if no session is free.
- Progress is a new push, a state change, or a worker comment or reply. It resets both the clock and `nudges`.
- Neo merges an `approved_green` PR itself only when its owner is gone.
- An idle `doing` todo goes through the same ladder.
- The deadlines stay as below for now and are tuned after a week.

| State | `approved_green` | `dirty` | `failing` | `changes_requested` | `waiting_review` | `approved_pending` |
|---|---|---|---|---|---|---|
| Deadline | 20 min | 20 min | 30 min | 30 min | 30 min | 60 min |

**Neo is woken only for these:** a PR merged; a PR closed unmerged; a worker stopped, got stuck, or failed at the same thing twice; something needs the human; or a sweep escalation. Each arrives as a message stored in Neo's session.

**Todo gate.**
- `neo_todo_pr_refs` links a todo to ledger rows. Its key today is `(reference, todo_id)`, so one PR can link to several todos. The migration keeps the gating link on the newest open todo and marks the others history-only.
- While a linked row is open, `done` and `close` are refused with `pr_open`.
- A PR links to one open todo (`pr_linked`).
- `neo.todo.continue` on a merged PR is refused (`pr_merged`). A push to a merged branch is reported to the worker and Neo.
- `neo.ask.open` refuses an ask that overlaps an open one (`ask_open`).

## Deletions

| What | Files | Tables, operations, prompts |
|---|---|---|
| Router | `router.ts`, `route-classifier.ts`, `project-route-facts.ts`, `section-route-facts.ts`, `named-route-facts.ts`, `route-correct-operation.ts`, `route-failure-operation.ts`, `work-reroute.ts` | `neo_routing_log`, `neo_route_pr_refs`; `neo.route.correct`, `neo.route.failure`; `neo/route-*.md`; route settings in `shared/src/types/settings.ts` |
| Holder sessions | the holder, forward and consult parts of `holder-turn.ts` (after T1), `holder-title.ts`, `binding-roles.ts`; holder and root branches of `session-policy.ts` | the `'project'` binding kind; `neo/system/holder-*.md`, `neo/system/root-*.md`. Old holder sessions are archived outright |
| Ask ownership by session | owner resolution in `ask-origin.ts`, `outcome-binding-policy.ts`, and `intake.ts` routing | `neo/work/done-check-ask-foreign.md` and `-owned.md`, merged into one |
| Forwarding | `ask-forward-operation.ts`, `inbox-promote-operation.ts` | `neo_ask_forwards`; `neo.ask.forward`, `neo.inbox.promote`; `neo/ask-forwarded.md`, `neo/ask-moved.md` |
| Consultations | `consultation-*.ts`, `cross-project-operation.ts` | `neo_consultations`, `neo_consultation_waiters`, `neo_consultation_publications`, `neo_cross_project_dispatches*`; `neo.project.consult`, `.respond`, `.cancel`, `neo.projects.dispatch`, `neo.receipt.read`; `neo/consultation/*.md` |
| Send-time injections | `publication-view.ts` and its call in `lib/agent/query-runner.ts`; `readNeoProjectSnapshot`; the local-time `UserPromptSubmit` hook in `restrictNeoQuery` (`session-policy.ts`) | `neo_publication_anchors`, `neo_session_seen`. The local time is written into the stored message at intake |
| PR relays to Neo | `card-attention.ts`; `needsOf` and `neoCardPrAttention` in `packs/coding/card-facts.ts` | `neo_card_pr_relays`, `neo_card_event_subscriptions`; `neo/card-attention-neo.md`, `neo/packs/coding/card-pr-attention.md` |
| Old PR tracking | the claim rules in `packs/coding/todo-prs.ts`; `ask-idle.ts`, `ask-stall.ts` | `pack_coding_pr_claims` |

## PR plan

Each PR comes from fresh `dev`, ships on its own, and carries about 100–200 production lines. Deletions never share a PR with new code.

In flight: S1a (backend 2), S4 (#7530), D1 (#7532).

| # | PR | What exists → what changes | Accepted when |
|---|---|---|---|
| S1a | Intake goes to the root; m393 moves open asks to the root; forward, consult and dispatch refuse | — | A message about any project lands in the root, and open asks keep their todos |
| S1b | Archive holder sessions. First, pending notes, mailbox entries and queued deliveries bound to holders move to the root | — | No pending item is left bound to an archived holder |
| S2 | Restart control; the snapshot as a stored message after a restart or a compaction | — | After a new session, open asks, todos, unresolved questions, worker refs, recent decisions and pending notifications are in Neo's context, not only in the DB |
| S3 | Coordinator prompt, on Opus 5.5 by default | — | `neo.snapshot` reports the model |
| S4 | The human's local time written into the stored message at intake | — | A stored human message carries its local time |
| D1 | Remove the catch-up view, the fresh-context snapshot and the local-time hook. May land before S2: the root's `getNeoFreshContext` already returns `''` | — | The SDK request for a human turn equals the stored message |
| C1 | One completion rule; migration `coding.pr_opened` → `coding.pr_merged`; replacement PRs | three paths set `done` → one rule | A todo with two required PRs, one merged, stays not-done through an automatic completion via a legacy `pr_opened` check |
| B1 | `blocked` in `NeoTodoState` and the m387 constraint, `blocked_reason`, `next_action`; failed/blocked check outcomes | derived from questions and `live_status` → stored | A blocked todo keeps its reason and next action across a daemon restart |
| T1 | Extract the turn identity and liveness guard into a generic coordinator-turn module | `NeoHolderTurn` wiring in `query-runner.ts:870–892`, live-attempt identity, turn-scoped operation access → kept for the root | An interrupted or superseded turn gets no further state-changing operation accepted |
| L1 | PR ledger and reconcile with WorkRef owners, feeding the snapshot | `opened-prs.ts` finds PRs per worker → ledger rows in the coding pack | Every open PR in the project repos is listed; one with no todo but a known author is supervised; one with no known author is tracked, not assigned |
| L2 | Sweep with reassign-first escalation | nothing → D / 2D / 3D ladder | An idle `approved_green` PR's worker is told at the event, 20 and 40 min, and the PR is reassigned at 60 min; progress resets it; a stale read pauses it; after a reassignment the old worker's resume does not take the PR back |
| L3 | Todo gate and the `neo_todo_pr_refs` migration | key `(reference, todo_id)` → one gating link per PR | `neo.todo.close` on an open PR returns `pr_open`; conflicting links keep only the newest open todo's as gating |
| L9 | Progress pushed to the owning worker, with a durable obligation and `deliveryKey` | extends `routeCardEvent` and `sendToCard` in `service.ts` | A failing check reaches the worker once and never Neo, for a direct session and an external worker, across a duplicate observation, a crash between observe and handoff, and an uncertain adapter send |
| L10 | Milestone wakes for Neo | same path, Neo as recipient | A day of PR traffic gives Neo only milestone messages, each delivered once |
| L11a | Card status line from the ledger on web | card facts from Neo's relays → the ledger row | The web card shows a GitHub change within one reconcile, with no Neo turn |
| L11b | The same in lsm/neo-ios | same | The iOS card does the same |
| L5 | Idle and awaiting-check todos join the sweep | `ask-idle.ts`, `ask-stall.ts` → the L2 ladder | An idle doing todo is told, then escalated |
| L6, L7, L8 | Prompts for merge ownership; follow-ups join the open ask; titles in the human's language | prompt text and refusal codes only | Each one's refusal code fires on the case it names |
| D2, D3, L4 | Delete the router; delete holders, ownership, forwarding and consultations; delete old PR tracking and relays | — | None of the deleted operations is left in the catalog |

**Order:**
- S1a → S1b → S2 → S3. S4 → D1, at any time.
- C1 → B1. T1 before D3.
- L1 → L2 → L3, then L9 → L10, with L11a and L11b after L1.
- D2 and D3 follow S1b. L4 follows L10.
- L5–L8 can run alongside.

## Status against dev

- **Done:**
  - Reply snapshots, including `replyTo` kind `ask` (#7504).
  - Human-message preemption.
  - The todo and question operations.
- **In flight:** S1a, S4, D1.
- **Not started:** everything else in the PR plan.
- **Superseded:** the per-todo claim rules (#7437, #7456) and the one-shot relays (#7445, #7477). L4 removes them.

## Why

On 2026-10-18, 38 PRs merged only after the human nudged them; for 25 of them Neo had no todo at all. Two of 5 unlabelled test messages were routed to the wrong project session. One session that reads a ledger fixes both.
