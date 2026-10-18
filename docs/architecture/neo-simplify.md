# Neo simplify: one Neo session, the ledger, and a visible model input

Status: the human's decision of 2026-10-18. Docs only; each code change ships as its own small PR in §7. There is no trial run first.

This replaces the earlier version of this doc (one session per project, the router, and plan items R1–R33 and L1–L8). Code references are on `dev` at `a0c491a280`. Unprefixed paths are under `packages/daemon/src/lib/neo/`.

## 1. Decisions

- **Exactly one Neo session.** Neo is one session on a strong, fast model (Opus 5.5) that holds all the context. It works like a coordinator: it reads, decides and dispatches, and rarely edits anything itself.
- **No clones, forks or sub-agents of Neo.** Parallel help for Neo is out of scope. Everything that exists only because there were several Neo sessions is deleted (§6). The general session clone operations (`session.clone.spawn`, `session.clone.return`) are not in Neo's catalog.
- **No router, no holders.** There are no per-project holder sessions, so there is nothing to route to. Every human message goes to the one Neo session.
- **No ownership between Neo sessions.** Asks aren't owned by a session. Neo sessions don't forward messages or consult each other.
- **Projects and domains are labels.** Projects and coarse domains (work, home, travel) label asks and todos. They are not sessions.
- **The database is the source of truth.** Asks, todos and the PR ledger live in the database, so a compaction or a restart loses nothing.
- **Deterministic code does the waiting.** CI, reviews, the deadline sweep and merged→done are followed by code, which wakes Neo only when something changes. Neo's turns stay short.
- **Workers do the real work.** Worker sessions (HyperNeo, Claude Desktop, Codex) do the coding. Neo dispatches to them and follows the ledger.
- **The human comes first.** A human message preempts a running Neo turn, as it already does (`service.ts:3774` `preemptForHumanMessage`). A "restart Neo" control starts a fresh session on the same database.
- **Compaction works, and caching keeps the cost down.** See §4.
- **Nothing is hidden from the human.** Nothing reaches the Neo model that the human can't see in the chat (§3).
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

## 3. Everything the model sees is in the chat

This is a first-class rule. The daemon may add context to a human message (quoted facts, local time, a snapshot) and may send Neo its own notes, but every addition is visible in the conversation:

- **Additions to a human message.** Under the human's message there is a collapsed "added by the daemon" line. It expands to the exact text that was sent.
- **Daemon notes.** Each daemon note to Neo (a todo is done, PR news, an ask is idle) is its own visible row in the chat, marked as from the daemon, not the human.
- **Other senders.** Coordinator and worker messages sent on the human's behalf are labelled with their real sender. They are never shown as the human.
- **The system prompt.** It can be viewed from settings, by version.

**How it is built.** The daemon records the exact model input of every Neo turn in a new table, `neo_turn_inputs`:
- the turn id and the session;
- each content block sent, in order, with its source (`human`, `daemon_addition`, `daemon_note`, `worker`, `coordinator`);
- the system prompt's version hash;
- the usage the SDK reported (input, cache read and cache write tokens).

The web and iOS chats render each turn from that record, so what they show is what the model got.

**Interaction with removed and kept parts:**
- **The catch-up view is deleted.** The "Recorded conversation since your last input" view (`publication-view.ts`) silently prepended conversation records to Neo's input. With one session there is nothing to catch up on. Since the daemon now adds nothing hidden to the human's message, the view and the snapshot injection both go (§6).
- **Prompt caching doesn't change what is recorded.** Caching reuses a prefix of what was sent; it doesn't send something else. The per-turn record holds the full input and the cache tokens, so the chat shows the whole input and the record shows what the cache saved.

## 4. The finished Neo

### One session

- `neo.open` returns the single Neo session. `neo.message.send` always targets it.
- A restart archives that session before it opens a fresh one on the same database, so there is never more than one. The new session's first input is a visible daemon note with the snapshot.
- After a compaction, the same visible note carries the snapshot, so Neo re-reads its state from the database, not from memory.
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

### Waiting is code, not turns

These run in the daemon and wake Neo with a visible daemon note only when a fact changes:

| Waiter | Wakes Neo when |
|---|---|
| Ledger reconcile | A linked PR merges or closes; a todo becomes met |
| Sweep | Two tells to a merge owner were ignored, or a PR has no owner |
| Todo runner | A todo reports, fails, or waits on the human |
| Awaiting-check pass | A pack check can't decide |
| Question answers | The human answers |

The sweep tells a PR's merge owner what to do once the PR has sat in one state past its deadline:

| State | Deadline | Action told to the owner |
|---|---|---|
| `approved_green` | 20 min | Merge now, manual squash |
| `approved_pending` | 60 min | Inspect or re-run the pending check, then merge |
| `dirty` | 20 min | Merge the base in, resolve conflicts, push |
| `failing` | 30 min | Read the failing check and fix it |
| `changes_requested` | 30 min | Address the review and push |
| `waiting_review` | 30 min | Request review, or re-run the review bot |

At 2 ignored tells Neo reassigns the PR to a free worker, or asks the human. An idle `doing` todo goes through the same ladder.

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
- **Still to build:** the ledger (L1), the sweep (L2), the todo gate (L3), the visible model input (V1–V3), restart, and labels.
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

**7. The fresh-context project snapshot injection (D1):**
- `readNeoProjectSnapshot` in `lib/neo/session-policy.ts:68`, called from `lib/agent/agent-session.ts:365` and folded into the turn by `query-runner.ts` beside the catch-up view.
- After a compaction or restart, the snapshot becomes a visible daemon note (S2) instead.

**8. Notes that exist only to tell one Neo session what another did (D3):**
- `neo/ask-moved.md` and `neo/ask-forwarded.md` (also in item 4).
- `neo/card-attention-neo.md`, the relay of a card's evidence to the Neo session that owns it, with `lib/neo/card-attention.ts` (39) and table `neo_card_pr_relays`. The ledger and sweep replace it (L4).
- `neo/work/environment-move.md`, the reroute notice, with `work-reroute.ts` (in item 1).

**9. Holder and root role prompts (D3):**
- `neo/system/holder-role.md`, `holder-operations.md`, `holder-snapshot-scope.md` and `holder-consultation-return.md`.
- `neo/system/root-role.md`, `root-operations.md`, `root-snapshot-scope.md`, `root-consultation-return.md`, `root-clarify.md` and `root-rule-save.md`.
- `neo/system/prompt.md` stays as the one coordinator prompt (S3).

**PR tracking replaced by the ledger (L4, L5):**
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
| V1 | Daemon records the exact model input per Neo turn in `neo_turn_inputs` (blocks with their source, prompt hash, cache usage); read by `neo.turn.input.read` | For any Neo turn, the record matches the SDK request byte for byte; a human message, a daemon addition and a daemon note are each tagged with their source |
| V2 | Web renders each turn from the record: the "added by the daemon" fold under a human message, daemon-note rows, real sender labels, and the system prompt in settings | For a turn with an addition and two notes, the web shows all three; the text in the fold equals the recorded block; nothing shown as the human came from elsewhere |
| V3 | iOS, the same as V2 | The same checks on iOS |
| S1 | One session: `neo.open` and `neo.message.send` always use the single Neo session; new projects are labels; the existing holder sessions are archived, with their open asks re-labelled | A message about any project lands in the one session; no new holder session is created; open asks keep their todos |
| S2 | Restart control: archive the session and open a fresh one on the same database, with the snapshot sent as a visible daemon note; the same note after compaction | After a restart Neo lists the same open asks and todos; the note is visible in the chat |
| S3 | Coordinator prompt on Opus 5.5 by default; prompt version hash shown in settings | `neo.snapshot` reports the model; the settings page shows the prompt for the hash in V1's record |
| D1 | Delete the catch-up view and the hidden snapshot injection | V1's record for a human turn holds only the human's text plus visible additions |
| D2 | Delete the router, route facts, routing log, route operations and prompts, and the route settings | No route classification runs; `neo.route.*` isn't in the catalog |
| D3 | Delete holders, consultations, forwards, cross-project dispatch and `inbox.promote`, with their tables, operations and prompts | None of the operations in §6 is in the catalog; their migrations reverse cleanly |
| L1 | PR ledger and reconcile, feeding the snapshot | `neo.snapshot` lists every open PR in the project repos, including PRs no todo opened |
| L2 | Sweep: deadlines, tell the owner, act at 2 nudges | An `approved_green` PR with an idle owner is told at 20 and 40 min, then reassigned or asked about |
| L3 | Todo gate: no `done` or `close` while a linked PR is open | `neo.todo.close` on a todo with an open PR returns `pr_open`; the merge marks it met |
| L4 | Delete the transcript probe, claim rules, card-attention relay and old route-PR reads | No `openedPrs` in `work.status`; todos still show their PRs, now from the ledger |
| L5 | Idle and awaiting-check todos on the sweep; delete the legacy ask reminders | An idle doing todo is told and then escalated; an awaiting check is decided within one cycle |
| L6 | Prompts: merge owner, ledger-only done | A new coding todo names its session as the merge owner |
| L7 | Follow-ups join the existing ask (`ask_open`, `pr_linked`, `pr_merged`, push notice) | A change to covered work adds a todo to the open ask |
| L8 | Titles in the human's language | With `zh-Hans`, an English instruction still produces Chinese titles; an English title is refused |

**Order:**
- V1 comes first. S1 needs V1, so that the move to one session is visible from day one.
- V2 and V3 follow V1 and can run in parallel.
- S2 and S3 follow S1.
- D1 follows V2 and V3. D2 and D3 follow S1.
- L1 → L2 → L3 → L4, and L5–L7 as before. They can run alongside the V, S and D lanes, since they touch the coding pack, not routing.
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
| 8 | The daemon prepended a hidden conversation record and snapshot to Neo's input | The web and iOS chats show 100% of what was sent to the model for a turn; the system prompt is viewable from settings | V1–V3, D1 |
| 9 | Neo's context was split across holder sessions | Neo alone has every open ask, todo and PR in its snapshot, and a restart keeps them | S1, S2 |
