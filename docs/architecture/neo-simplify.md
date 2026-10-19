# Neo simplify: one Neo session and the ledger

Status: the human's decision of 2026-10-18. Docs only; each code change ships as its own small PR in §7. There is no trial run first.

This replaces the earlier version of this doc (one session per project, the router, and plan items R1–R33 and L1–L8). Code references are on `dev` at `a0c491a280`. Unprefixed paths are under `packages/daemon/src/lib/neo/`.

## 1. Decisions

- **Exactly one Neo session.** Neo is one session on a strong, fast model (Opus 5.5) that holds all the context. It works like a coordinator: it reads, decides and dispatches, and rarely edits anything itself.
- **No clones, forks or sub-agents of Neo.** Parallel help for Neo is out of scope. Everything that exists only because there were several Neo sessions is deleted (§6). The general session clone operations (`session.clone.spawn`, `session.clone.return`) are not in Neo's catalog.
- **No router, no holders.** There are no per-project holder sessions, so there is nothing to route to. Every human message goes to the one Neo session.
- **No ownership between Neo sessions.** Asks aren't owned by a session. Neo sessions don't forward messages or consult each other.
- **Projects and domains are labels.** Projects and coarse domains (work, home, travel) label asks and todos. They are not sessions.
- **The database is the source of truth.** Asks, todos and the PR ledger live in the database, so a compaction or a restart loses nothing.
- **Deterministic code does the waiting.** CI, reviews, the deadline sweep and merged→done are followed by code, which wakes Neo only for a milestone. Neo's turns stay short.
- **PR events: push state to the worker, wake Neo for milestones, read on demand.** This is a first-class rule (§4):
  1. PR state changes go from the daemon straight to the worker session that owns the PR, once per event, not through Neo.
  2. Neo is woken only for things that need its judgment: a PR merged, a worker stopped or is stuck or keeps failing at the same thing, something needs the human, or a relayed event passed its deadline with no action.
  3. Nothing is piled onto the human's next message. When the human asks, Neo reads the current state from the ledger then.
  4. Each todo card's status line reads straight from the ledger.
- **Workers do the real work.** Worker sessions (HyperNeo, Claude Desktop, Codex) do the coding. Neo dispatches to them and follows the ledger.
- **The human comes first.** A human message preempts a running Neo turn, as it already does (`service.ts:3774` `preemptForHumanMessage`). A "restart Neo" control starts a fresh session on the same database.
- **Compaction works, and caching keeps the cost down.** See §4.
- **No send-time injection.** The daemon never changes what goes to the model at send time. Anything it adds is written into the stored message, so the transcript shows exactly what the model got (§3).
- **These earlier decisions still hold:**
  - A todo with a PR is done only when the ledger reads `merged`.
  - Every PR has a merge owner.
  - One sweep follows up by state and deadline.
  - PR knowledge lives only in the coding pack.
  - Failures and refusals are reported as facts.
  - Questions take one form.
  - Migrations are reversible.

## 2. Why: the nag data and the routing misses

**Nags.** On 2026-10-18, 38 PRs in four repos merged only after the human nudged them, with 49 nags in all. For 25 of them Neo had no linked todo, and its own relay reached 4. The six root causes are unchanged:

1. Neo learns about a PR only from inside a live todo (`packs/coding/todo-prs.ts:140-153`, `drivers/opened-prs.ts`).
2. Assigning PRs to todos loses PRs (`todo-prs.ts:198,204,152`).
3. A todo can be ticked done while its PR is open (`todo-operations.ts:176-195,221-230`).
4. Nothing follows up on a schedule. The reminders loop over `legacy_neo_asks`.
5. A relay is sent once per state (`card-attention.ts:20`).
6. Nobody owns the merge (`prompts/src/neo/packs/coding/goal-merge.md:5`).

**Routing misses.** In a test with 5 unlabelled messages, two went to the wrong session:
- "customer's own Devin key" went to devin-claude, not hyperneo-review (lsm/hyperneo-review#1349, #1356).
- "the doc that teaches agents to set up the server" went to Inbox at confidence 0.4, not dolmen (lsm/dolmen#666).

In both cases the project's own session had done the work and Neo had never heard of it. With one Neo session that sees the ledger, there is no route to get wrong.

## 3. No send-time injection

The daemon never changes what goes to the model at send time. Nothing is injected in `query-runner.ts` before the SDK call.

- **Additions are stored.** Anything the daemon must add (a quote fact, the local time) is written into the stored message itself. The session's own transcript and UI then show exactly what the model got.
- **Daemon messages are stored messages.** A milestone or a snapshot after a restart is a message the daemon writes into the Neo session, so it is in the transcript like any other.
- **The existing injections go.** Three things are added at send time today:
  - the "Recorded conversation since your last input" view (`publication-view.ts`);
  - the project snapshot;
  - the human's local time, added as SDK `additionalContext` by the `UserPromptSubmit` hook in `restrictNeoQuery` (`session-policy.ts:130-147`, `neoLocalNow` in `local-time.ts:15`).

  With one session there is nothing to catch up on, so D1 deletes the view and the snapshot. D1 moves the local time into the stored message at intake, next to the quote fact (`intake.ts:116`), and removes the hook (§6).

## 4. The finished Neo

### One session

- `neo.open` returns the single Neo session. `neo.message.send` always targets it.
- A restart archives that session before it opens a fresh one on the same database, so there is never more than one. The new session's first input is a stored daemon message with the snapshot.
- After a compaction, the same stored message carries the snapshot, so Neo re-reads its state from the database, not from memory.
- Labels: `neo.ask.open` and `neo.todo.add` take an optional project or domain label. `neo.snapshot` can filter by label.

### Tools

| Group | Operations |
|---|---|
| Reading | `neo.snapshot`, `neo.conversation.read`, `neo.pack.read`, `neo.github.read`, `work.find`, `work.read` |
| Asks | `neo.ask.open`, `neo.ask.settle` |
| Todos | `neo.todo.add`, `neo.todo.edit`, `neo.todo.remove`, `neo.todo.continue`, `neo.todo.retry`, `neo.todo.close` |
| Questions | `neo.question.ask`, `neo.question.answer`, `neo.question.retire` |
| Publishing and state | `neo.publication.publish` (with `publicationId` it revises), `neo.project.save` (labels), `neo.rule.save` |

Native tools are Read, Bash, WebSearch and WebFetch. Coding happens in workers.

### The coding pack's PR ledger

This is unchanged from the previous plan:
- One table, `pack_coding_pr_ledger`, holds a row per PR in a project repo that is open now or closed within 7 days.
- Each row records its state (`draft` … `approved_green`, `merged`, `closed`), `state_since`, `author_session`, `merge_owner`, `told_at`, `nudges` and `read_at`.
- It is synced from the GitHub extension's PR events plus a batched GraphQL reconcile every 5 minutes.
- `neo_todo_pr_refs` links todos to rows.

With one session, the ledger also replaces the router's profile: Neo sees every project's open and recently merged PR titles in its snapshot.

### PR events: push to the worker, wake Neo for milestones, read on demand

Waiting is code, not Neo turns. The ledger reconcile and the sweep run in the daemon and send each fact to the one party that acts on it.

**To the worker that owns the PR, once per event.** The message goes to the PR's `merge_owner` session, not to Neo:

| Event | What the worker is told |
|---|---|
| CI failed | The failing check and its link; fix it |
| CI green | Checks passed on the head |
| Changes requested, or new review comments | The comments; address them and push |
| Approved and green | Ready to merge: merge now, manual squash |
| `dirty` | Merge the base in, resolve conflicts, push |

**To Neo, as a stored daemon message, only for milestones:**

| Milestone | Why Neo is woken |
|---|---|
| A linked PR merged | The todo is met: tell the human or plan the next step |
| A linked PR closed without merging | Decide whether the todo fails (open question 6) |
| The worker session stopped, got stuck, or failed at the same thing twice | Reassign, retry, or ask the human |
| Something needs the human | A question or approval only the human can give |
| A relayed event passed its deadline with no action | The sweep's escalation |

**The sweep** re-tells the worker. When a PR sits in one state past its deadline, the sweep tells the `merge_owner` worker again and counts a nudge. At 2 ignored tells the PR passes the deadline with no action, and that is the milestone that wakes Neo.

| State | Deadline |
|---|---|
| `approved_green` | 20 min |
| `approved_pending` | 60 min |
| `dirty` | 20 min |
| `failing` | 30 min |
| `changes_requested` | 30 min |
| `waiting_review` | 30 min |

An idle `doing` todo goes through the same ladder: its worker is told first, and Neo is woken at the second ignored tell.

**On demand, never piled on.**
- The daemon adds nothing to the human's next message. When the human asks about a piece of work, Neo reads the ledger at that moment with `neo.snapshot` or `neo.github.read`, so the answer is current, not something injected earlier.
- Each todo card's status line on web and iOS reads straight from the ledger row, so the human sees the current state without asking Neo.

### Asks, follow-ups and titles

These are unchanged from the previous plan:
- **Overlapping asks.** `neo.ask.open` refuses an ask that overlaps an open one (`ask_open`).
- **PR links.** A PR links to one open todo (`pr_linked`).
- **Merged PRs.** A merged PR takes no more work (`pr_merged`), and a push to its branch is reported.
- **Titles.** Ask and todo titles follow `GlobalSettings.language`, and the daemon checks the script (`title_language`).

### System prompt

There is one coordinator prompt for the one session:
- It is about 6 KB, with the operation names for todos.
- It says that a PR todo ends only when the ledger says merged, and that the owner merges.
- It has no holder, root, consultation or routing sections.
- It changes rarely, so it is a stable, cacheable prefix.

## 5. Status against dev

- **Done and kept:**
  - Reply snapshots: #7487, #7489, and `replyTo` kind `ask` (#7504).
  - Human-message preemption.
  - The todo and question operations.
- **Still to build:** the ledger (L1), the sweep (L2), the todo gate (L3), restart, and labels.
- **Made moot by this decision:**
  - The router-profile item (L1b).
  - Plan items R4–R21: reroute, environment-move, consultations, dispatch, `inbox.promote`, root-Neo migration and router-created projects.
  - The neo-ios session-list items R31–R33. There is one session to show.
  - Backend 2's slash-command fix. With one Neo, the daemon adds nothing to the human's message, so the publication-view and snapshot injection it patched are deleted instead.

## 6. Deletions

Everything that exists only because there were several Neo sessions goes. Sizes are line counts at `a0c491a280`. Daemon paths are under `packages/daemon/src/`; prompt paths are under `packages/prompts/src/`.

**1. The router and route classifier (D2):**
- `lib/neo/router.ts` (708), `lib/neo/route-classifier.ts` (334), `lib/neo/project-route-facts.ts` (135), `lib/neo/section-route-facts.ts` (113), `lib/neo/named-route-facts.ts` (46).
- `lib/neo/route-correct-operation.ts` (83), `lib/neo/route-failure-operation.ts` (25), `lib/neo/work-reroute.ts` (134).
- Tables: `neo_routing_log`, `neo_route_pr_refs`.
- Operations: `neo.route.correct`, `neo.route.failure`.
- Prompts: `neo/route-classifier.md`, `neo/route-request.md`.
- Settings: `NeoRouteModel`, `neo.routeModel`, `routeFallbacks`, `routeTimeoutMs`, `DEFAULT_NEO_ROUTE_TIMEOUT_MS` (`shared/src/types/settings.ts`).

**2. Project holder sessions and their bindings (D3):**
- `lib/neo/holder-turn.ts` (89), `lib/neo/holder-title.ts` (20), `lib/neo/binding-roles.ts` (15).
- The holder and root branches of `lib/neo/session-policy.ts` (161), including `neoCoordinatorBinding`'s project case.
- The `'project'` binding kind in `neo_session_bindings` and in `NeoContext.kind` (`shared/src/types/neo-context.ts:19`).
- Projects stay as labels. `project-tree-operations.ts`, `project-merge.ts` and `project-mirror.ts` lose their session parts only.

**3. Ask ownership by session (D3):**
- The origin and owner resolution in `lib/neo/ask-origin.ts` (176) and `lib/neo/outcome-binding-policy.ts` (104).
- The reply routing to "the session that owns the ask" in `lib/neo/intake.ts`. Replies keep their context line.
- Prompts: `neo/work/done-check-ask-foreign.md` and `neo/work/done-check-ask-owned.md`, which become one done-check.

**4. Forwarding (D3):**
- `lib/neo/ask-forward-operation.ts` (382), `lib/neo/inbox-promote-operation.ts` (150).
- Table: `neo_ask_forwards` (m344).
- Operations: `neo.ask.forward`, `neo.inbox.promote`.
- Prompts: `neo/ask-forwarded.md`, `neo/ask-moved.md`.

**5. Consultations between sessions (D3):**
- `lib/neo/consultation-origin.ts` (31), `consultation-policy.ts` (2), `consultation-recovery.ts` (32), `consultation-reply-content.ts` (33), `consultation-request-content.ts` (22), and `lib/neo/cross-project-operation.ts` (171).
- Tables: `neo_consultations` (m279, with its m282 `origin_message_id` column), `neo_consultation_waiters` (m285), `neo_consultation_publications` (m291), `neo_cross_project_dispatches` and `neo_cross_project_dispatch_members` (m365).
- Operations: `neo.project.consult`, `neo.project.respond`, `neo.project.cancel`, `neo.projects.dispatch`, `neo.receipt.read`.
- Prompts: everything in `neo/consultation/`: `cross-project-request.md`, `request.md`, `review-request.md`, `receipt-closed.md`, `receipt-pending.md`, `receipt-returned.md`, `settled.md`, `settled-failed.md`, `settled-reported.md` and `settled-stopped.md`.

**6. The catch-up "recorded conversation" view and its per-session cursors (D1):**
- `lib/neo/publication-view.ts` (138), and its call in `lib/agent/query-runner.ts:2258-2261` (`readNeoPublicationView`, `withNeoPublicationView`).
- `storage/repositories/neo-publication-anchor-repository.ts` (38) and table `neo_publication_anchors` (m382), with its `cursor_json` column (m384).
- `storage/repositories/neo-session-seen-repository.ts` (27) and table `neo_session_seen` (m340).

**7. The other send-time injections: the fresh-context project snapshot and the local time (D1):**
- `readNeoProjectSnapshot` in `lib/neo/session-policy.ts:68`, called from `lib/agent/agent-session.ts:365` and folded into the turn by `query-runner.ts` beside the catch-up view.
- After a compaction or restart, the snapshot becomes a stored daemon message (S2) instead.
- The local-time `UserPromptSubmit` hook in `restrictNeoQuery` (`session-policy.ts:130-147`), which adds `neoLocalNow` (`local-time.ts:15`) as `additionalContext`. The local time is written into the stored message at intake instead.

**8. Notes that exist only to tell one Neo session what another did (D3):**
- `neo/ask-moved.md` and `neo/ask-forwarded.md` (also in item 4).
- `neo/card-attention-neo.md`, the relay of a card's evidence to the Neo session that owns it. See the relays under PR tracking below.
- `neo/work/environment-move.md`, the reroute notice, with `work-reroute.ts` (in item 1).

**9. Holder and root role prompts (D3):**
- `neo/system/holder-role.md`, `holder-operations.md`, `holder-snapshot-scope.md` and `holder-consultation-return.md`.
- `neo/system/root-role.md`, `root-operations.md`, `root-snapshot-scope.md`, `root-consultation-return.md`, `root-clarify.md` and `root-rule-save.md`.
- `neo/system/prompt.md` stays as the one coordinator prompt (S3).

**PR tracking and relays replaced by the ledger (L4, L5, L9):**
- Every path that relays PR events to a Neo session is replaced by L9's push to the owning worker plus Neo's milestone notes:
  - `lib/neo/card-attention.ts` (39) and prompt `neo/card-attention-neo.md`;
  - `needsOf` and `neoCardPrAttention` in `lib/neo/packs/coding/card-facts.ts` (85), with prompt `neo/packs/coding/card-pr-attention.md`;
  - tables `neo_card_pr_relays` (m347) and `neo_card_event_subscriptions` (m355), with `storage/repositories/neo-card-pr-relay-repository.ts` (25) and `neo-card-event-subscription-repository.ts` (36);
  - their wiring in `lib/neo/packs/coding/pack.ts` and `lib/neo/service.ts`.
- `lib/drivers/opened-prs.ts` and the adapters' `openedPrs`.
- The claim rules in `packs/coding/todo-prs.ts` and table `pack_coding_pr_claims`.
- The legacy ask reminders `lib/neo/ask-idle.ts` (63) and `lib/neo/ask-stall.ts` (26).

**Kept:**
- Asks, todos, questions and their repositories.
- `neo_conversation` and `neo_publications`; publications stay the chat record.
- The projects table, as labels.
- Drivers and the worker sessions.
- `neo/session-track.md`. Tracking a session the human started is a worker session, not a Neo session.
- `look-up-guard.ts`, cut down to the credential-read guard as already planned.

## 7. PR plan

Each PR is opened from fresh `dev` and ships and verifies on its own. Deletions never share a PR with new code. "Accept" lists what must hold after deploy.

| # | PR | Accept |
|---|---|---|
| S1 | One session: `neo.open` and `neo.message.send` always use the single Neo session; new projects are labels; the existing holder sessions are archived, with their open asks re-labelled | A message about any project lands in the one session; no new holder session is created; open asks keep their todos |
| S2 | Restart control: archive the session and open a fresh one on the same database, with the snapshot as a stored daemon message; the same message after compaction | After a restart Neo lists the same open asks and todos; the message is in the session transcript |
| S3 | Coordinator prompt on Opus 5.5 by default | `neo.snapshot` reports the model |
| D1 | Delete the send-time injections: the catch-up view, the snapshot, and the local-time `UserPromptSubmit` hook; write the local time into the stored message at intake | The SDK request for a human turn equals the stored message; `query-runner.ts` adds nothing before the SDK call |
| D2 | Delete the router, route facts, routing log, route operations and prompts, and the route settings | No route classification runs; `neo.route.*` isn't in the catalog |
| D3 | Delete holders, consultations, forwards, cross-project dispatch and `inbox.promote`, with their tables, operations and prompts | None of the operations in §6 is in the catalog; their migrations reverse cleanly |
| L1 | PR ledger and reconcile, feeding the snapshot | `neo.snapshot` lists every open PR in the project repos, including PRs no todo opened |
| L2 | Sweep: deadlines, re-tell the owning worker, wake Neo at 2 ignored tells | An `approved_green` PR with an idle owner: the worker is told at 20 and 40 min, and Neo gets one milestone note after the second tell, not before |
| L3 | Todo gate: no `done` or `close` while a linked PR is open | `neo.todo.close` on a todo with an open PR returns `pr_open`; the merge marks it met |
| L4 | Delete the transcript probe, claim rules, card-attention relay and old route-PR reads | No `openedPrs` in `work.status`; todos still show their PRs, now from the ledger |
| L5 | Idle and awaiting-check todos on the sweep; delete the legacy ask reminders | An idle doing todo is told and then escalated; an awaiting check is decided within one cycle |
| L6 | Prompts: merge owner, ledger-only done | A new coding todo names its session as the merge owner |
| L7 | Follow-ups join the existing ask (`ask_open`, `pr_linked`, `pr_merged`, push notice) | A change to covered work adds a todo to the open ask |
| L9 | Push PR events to the owning worker: CI failed or green, changes requested, review comments, approved-and-green, `dirty`, each once per event, from the ledger to `merge_owner` | A failing check on a worker's PR reaches that worker once and never Neo; the same event replayed doesn't re-send; a PR with no owner goes to the sweep instead |
| L10 | Milestone wakes for Neo: PR merged or closed, worker stopped, stuck or repeating a failure, needs the human, SLA passed; each as a stored daemon message | Neo's transcript for a day of PR traffic has only milestone messages |
| L11 | Card status line from the ledger on web and iOS (split into two PRs, one per client) | A PR's state changes on GitHub and the card line shows it within one reconcile, with no Neo turn |
| L8 | Titles in the human's language | With `zh-Hans`, an English instruction still produces Chinese titles; an English title is refused |

**Order:**
- S1 comes first. S2 and S3 follow it.
- D1 can run any time. D2 and D3 follow S1.
- L1 → L2 → L3 → L4, and L5–L7 as before. They can run alongside the S and D lanes, since they touch the coding pack, not routing.
- L9 needs L1. L10 needs L9 and replaces the card relays that L4 deletes. L11 needs L1.
- L8 is independent.

## 8. Open questions

**Answered or made moot:**
- **Q7, the timer exception.** Answered: the sweep is the only timer, and every other wake is a state change.
- **Router and holder questions.** The routing confidence, the profile size and the consultation timeouts are moot with one session.
- **Q8, overlapping asks.** Simpler: with one session, folding a follow-up into the existing ask needs no forwarding. Refusal with `ask_open` stays the plan.

**Still open:**
1. **Repos.** Should the ledger cover every project repo, or an allowlist?
2. **Deadlines.** Are the sweep deadlines in §4 right?
3. **When Neo acts.** At 2 nudges, should Neo reassign first, or always ask the human?
4. **Neo merging.** May Neo run `gh pr merge` itself on an `approved_green` PR whose owner is gone? It rarely edits, but a merge is not an edit.
5. **Unowned PRs.** Should PRs no session owns be tracked, assigned, or ignored?
6. **Closed without merging.** Should the todo fail, or should Neo ask?
7. **Title language.** Should `'system'` resolve to the latest message's language, or to the device locale?
8. **Holder migration.** Should old holder sessions be archived outright (S1), or kept read-only for a while?

## 9. Acceptance

The first seven cases were seen on 2026-10-18. Each line can be ticked by reading `neo.snapshot`, the chat and GitHub.

| # | Seen | Accepted when | Fixed by |
|---|---|---|---|
| 1 | A web todo was ticked done while lsm/HyperNeo#7492 was still open | It is ticked only when the ledger reads #7492 `merged`; until then `done` and `close` return `pr_open` | L3 |
| 2 | "approved, waiting to merge" was shown after lsm/neo-ios#130 had merged | The PR status line is never older than one reconcile | L1, L3 |
| 3 | One piece of work became two asks | The follow-up is a todo on the original ask | L7 |
| 4 | "waiting for Neo to check" sat with nothing checking it | It is decided, or Neo is told, within one sweep cycle | L5 |
| 5 | Titles mixed Chinese and English | Titles follow `GlobalSettings.language` | L8 |
| 6 | A follow-up was pushed to the merged #7492 branch and reached nothing | `neo.todo.continue` is refused with `pr_merged`; the push is reported | L1, L3, L7 |
| 7 | Two of 5 unlabelled messages went to the wrong project session | There are no project sessions; Neo answers both from the ledger's PR titles for hyperneo-review and dolmen | S1, L1 |
| 8 | The daemon prepended a hidden conversation record and snapshot to Neo's input at send time | Nothing is added at send time; what the model gets for a turn is the stored message, so the transcript shows it | D1 |
| 9 | Neo's context was split across holder sessions | Neo alone has every open ask, todo and PR in its snapshot, and a restart keeps them | S1, S2 |
| 10 | PR state changes went through Neo, or were relayed once and lost | CI failed or green, changes requested, review comments and approved-and-green each reach the owning worker once per event, and none of them wakes Neo | L9 |
| 11 | Neo was woken for routine PR churn | Neo is woken only for: PR merged, PR closed unmerged, worker stopped, stuck or repeating a failure, needs the human, and an event past its deadline with no action | L2, L10 |
| 12 | State piled onto the human's next message, sometimes stale | A human message reaches Neo unchanged; asked about a PR, Neo's answer matches the ledger at that moment | D1, L1 |
| 13 | The human had to ask Neo for a PR's state | Each todo card's status line shows the ledger state, at most one reconcile old, without a Neo turn | L11 |
