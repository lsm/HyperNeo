# Neo simplify

Status: the human's decision of 2026-10-18, with the open questions answered. Code references are on `dev` at `a0c491a280`; unprefixed paths are under `packages/daemon/src/lib/neo/`.

## The core

Neo is one session that holds the whole conversation. It listens to the human, decides, and hands work to an executor. Each item it hands off is in one of four states:

- **doing**: the executor is working on it;
- **done**;
- **failed**: an error the executor can't recover from;
- **blocked**: stuck, or waiting for a question to be confirmed.

Only a change to done, failed or blocked wakes Neo. Neo then tells the human or plans the next step; it ignores the progress in between.

All state lives in the database, so a restart or a compaction loses nothing. Everything Neo receives is visible in its own session: nothing is injected at send time, and anything the daemon adds is written into the stored message.

There is exactly one Neo session, with no clones, forks or sub-agents. A restart archives it before opening a fresh one on the same database. A human message preempts a running Neo turn (`service.ts:3774`).

## What a pack provides

The core knows nothing about any one kind of work. A pack supplies the four things the core needs:

- **Done.** How to judge that an item is done.
- **Progress.** How the pack's own progress events are handled. For example, they can go straight to the executor and never reach Neo.
- **Failed and blocked.** What counts as each, including a no-progress timeout that turns an item blocked.
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

- **Done** is a merged pull request.
- **Progress** is CI and review events. They go straight to the working session.
- **Failed** is a pull request closed without merging. Neo asks the human whether to redo it or drop it.
- **Blocked** is a CI check that keeps failing, or no progress past a deadline.
- **Status line.** The card shows the pull request's ledger state.

**PR ledger.**
- The table `pack_coding_pr_ledger` has one row per PR in any project repo that is open, or was closed within 7 days.
- Each row records `repo` and `number`, then `head`, `branch` and `title`, and the `state`: `draft`, `waiting_review`, `changes_requested`, `failing`, `dirty`, `approved_pending`, `approved_green`, `merged` or `closed`.
- It also records `state_since`, `author_session` and `merge_owner`, which defaults to the author. The last three fields are `told_at`, `nudges` and `read_at`.
- Reconcile runs on GitHub PR events, plus one batched GraphQL read per repo every 5 minutes. A cycle is skipped while fewer than 500 API calls remain.
- PRs that no session owns are tracked, but not assigned.

**To the worker, once per event.** These go to the `merge_owner` session, never to Neo:
- CI failed, with the failing check;
- CI green;
- changes requested, or new review comments;
- approved and green, which means merge now with a manual squash;
- `dirty`, which means merge the base in.

**The sweep.**
- When a PR sits in one state past its deadline, the worker is told again and `nudges` goes up.
- At 2 ignored tells, Neo reassigns the PR to a free session, and asks the human only if no session is free.
- Neo merges an `approved_green` PR itself only when its owner is gone.
- An idle `doing` todo goes through the same ladder.
- The deadlines stay as below for now and are tuned after a week.

| State | `approved_green` | `dirty` | `failing` | `changes_requested` | `waiting_review` | `approved_pending` |
|---|---|---|---|---|---|---|
| Deadline | 20 min | 20 min | 30 min | 30 min | 30 min | 60 min |

**Neo is woken only for these:** a PR merged; a PR closed unmerged; a worker stopped, got stuck, or failed at the same thing twice; something needs the human; or a sweep escalation. Each arrives as a message stored in Neo's session.

**Todo gate.**
- `neo_todo_pr_refs` links a todo to ledger rows.
- While a linked row is open, `done` and `close` are refused with `pr_open`.
- A PR links to one open todo (`pr_linked`).
- `neo.todo.continue` on a merged PR is refused (`pr_merged`). A push to a merged branch is reported to the worker and Neo.
- `neo.ask.open` refuses an ask that overlaps an open one (`ask_open`).

## Deletions

| What | Files | Tables, operations, prompts |
|---|---|---|
| Router | `router.ts`, `route-classifier.ts`, `project-route-facts.ts`, `section-route-facts.ts`, `named-route-facts.ts`, `route-correct-operation.ts`, `route-failure-operation.ts`, `work-reroute.ts` | `neo_routing_log`, `neo_route_pr_refs`; `neo.route.correct`, `neo.route.failure`; `neo/route-*.md`; route settings in `shared/src/types/settings.ts` |
| Holder sessions | `holder-turn.ts`, `holder-title.ts`, `binding-roles.ts`; holder and root branches of `session-policy.ts` | the `'project'` binding kind; `neo/system/holder-*.md`, `neo/system/root-*.md`. Old holder sessions are archived outright |
| Ask ownership by session | owner resolution in `ask-origin.ts`, `outcome-binding-policy.ts`, and `intake.ts` routing | `neo/work/done-check-ask-foreign.md` and `-owned.md`, merged into one |
| Forwarding | `ask-forward-operation.ts`, `inbox-promote-operation.ts` | `neo_ask_forwards`; `neo.ask.forward`, `neo.inbox.promote`; `neo/ask-forwarded.md`, `neo/ask-moved.md` |
| Consultations | `consultation-*.ts`, `cross-project-operation.ts` | `neo_consultations`, `neo_consultation_waiters`, `neo_consultation_publications`, `neo_cross_project_dispatches*`; `neo.project.consult`, `.respond`, `.cancel`, `neo.projects.dispatch`, `neo.receipt.read`; `neo/consultation/*.md` |
| Send-time injections | `publication-view.ts` and its call in `agent/query-runner.ts`; `readNeoProjectSnapshot`; the local-time `UserPromptSubmit` hook in `restrictNeoQuery` (`session-policy.ts`) | `neo_publication_anchors`, `neo_session_seen`. The local time is written into the stored message at intake |
| PR relays to Neo | `card-attention.ts`; `needsOf` and `neoCardPrAttention` in `packs/coding/card-facts.ts` | `neo_card_pr_relays`, `neo_card_event_subscriptions`; `neo/card-attention-neo.md`, `packs/coding/card-pr-attention.md` |
| Old PR tracking | `drivers/opened-prs.ts`; the claim rules in `packs/coding/todo-prs.ts`; `ask-idle.ts`, `ask-stall.ts` | `pack_coding_pr_claims` |

## PR plan

Each PR comes from fresh `dev` and ships on its own. Deletions never share a PR with new code.

| # | PR | Accepted when |
|---|---|---|
| S1 | One session: every human message goes to the one Neo session; holder sessions archived; projects become labels | A message about any project lands in the one session, and open asks keep their todos |
| S2 | Restart control; the snapshot as a stored message after a restart or a compaction | After a restart Neo lists the same open asks and todos |
| S3 | Coordinator prompt, on Opus 5.5 by default | `neo.snapshot` reports the model |
| D1 | Remove the send-time injections; store the local time at intake | The SDK request for a human turn equals the stored message |
| L1 | PR ledger and reconcile, feeding the snapshot | `neo.snapshot` lists every open PR in the project repos |
| L2 | Sweep, with reassign-first escalation | An idle `approved_green` PR's worker is told at 20 and 40 min, then the PR is reassigned |
| L3 | Todo gate | `neo.todo.close` on an open PR returns `pr_open`, and the merge marks it met |
| L9 | Progress pushed to the owning worker | A failing check reaches the worker once and never Neo |
| L10 | Milestone wakes for Neo | A day of PR traffic gives Neo only milestone messages |
| L11 | Card status line from the ledger, on web and on iOS | The card shows a GitHub change within one reconcile, with no Neo turn |
| L5 | Idle and awaiting-check todos join the sweep | An idle doing todo is told, then escalated |
| L6, L7, L8 | Prompts for merge ownership; follow-ups join the open ask; titles in the human's language | Each one's refusal code fires on the case it names |
| D2, D3, L4 | Delete the router; delete holders, ownership, forwarding and consultations; delete old PR tracking and relays | None of the deleted operations is left in the catalog |

**Order:**
- S1 → S2 → S3. D1 can run any time.
- L1 → L2 → L3, then L9 → L10, with L11 after L1.
- D2 and D3 follow S1. L4 follows L10.
- L5–L8 can run alongside.

## Status against dev

- **Done:**
  - Reply snapshots, including `replyTo` kind `ask` (#7504).
  - Human-message preemption.
  - The todo and question operations.
- **Not started:** everything in the PR plan.
- **Superseded:** the per-todo claim rules (#7437, #7456) and the one-shot relays (#7445, #7477). L4 removes them.

## Why

On 2026-10-18, 38 PRs merged only after the human nudged them; for 25 of them Neo had no todo at all. Two of 5 unlabelled test messages were routed to the wrong project session. One session that reads a ledger fixes both.
