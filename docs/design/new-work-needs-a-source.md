# New work needs a source

Status: proposal, 2026-11-16, tracked in #10943. Design only. Paths without a prefix are under `packages/`.

## Why

Neo can come up with a piece of work itself, write it down as a request in its own words, give it to a worker, and see it merged. The human never asked for it and never sees it. It looks exactly like work the human asked for.

Example: a recent bug fix moved every review session into the daemon's internal read checkout. Here is how it happened:

- Reviewers kept asking Neo for a folder.
- Neo opened an ask whose request already named that folder as the fix.
- A worker built it. The review bot and a cross-model reviewer both checked the code against that request, and it merged as an implementation PR.
- Nobody checked whether the request was right. The human did not ask for it. Every repository now shows an extra project in the desktop apps.

Three gaps allow this:

- `prompts/src/neo/tools/neo.ask.open.md` says an ask records "a human request … in the human's words". The same file says "Any daemon session opens asks". Nothing enforces the first sentence.
- An ask already records where it came from on the two message paths. On the third path, `neo.ask.open`, it does not:
  - **Human messages**: `claimNeoInputAsk` (`daemon/src/storage/repositories/neo-ask-input-worker.ts`) sets `neo_asks.origin_message_id` to the human message and binds every message on that matter in `neo_ask_inputs`.
  - **Session requests**: `recordNeoRequestTodo` (`daemon/src/lib/neo/request-todo.ts`, called from `service.ts`) sets `origin_message_id` to the session message.
  - **Neo's own asks**: `neo.ask.open` (`daemon/src/lib/neo/ask-record-operations.ts`) hard-codes `const origin = null`. It writes the ask and can start inline todos, with nothing to show who asked.
- `work.start` (`daemon/src/lib/drivers/work-operations.ts`) takes `todoId` as optional. A missing or stale one is "recorded without blocking", so a session can start with no todo and no ask behind it.

## The rule

Only the creation of new work changes. New work means opening an ask, adding a todo, or starting a session with `work.start`. A new PR is opened by a worker inside such a session, so it starts from an accepted ask. Merging, and PRs that already exist, are out of scope. Work that already traces to an accepted ask is unchanged.

**1. Where an ask came from is derived from records that already exist.** No new table is added.

- **human**: the ask's `origin_message_id` or a `neo_ask_inputs` row names a human message delivered into Neo's session (a user turn with input kind `human`). One matter told across several messages is already several `neo_ask_inputs` rows on one ask.
- **relayed**: `origin_message_id` names a session message delivered to Neo's session (a `neo_session_messages` row with Neo's session as `to_session`). The message must carry the human's words in a separate quote field, not only in its text. `hyperneo send` gets `--quote "<the human's words>"`, and the quote is stored once in a new `human_quote` column on `neo_session_messages`. The ask shows that quote. A plain message with no quote is never a relay, whoever sends it. The daemon checks that the field is present and does not parse the text. The sender must be a session the human runs, not a session the daemon or Neo runs. That excludes:
  - every `neo:*` sender, on this daemon or another;
  - every `system:*` sender;
  - any session with role `worker` in `work_started_sessions`;
  - the daemon's own agent sessions, such as space and task agents. A relay must come from an external adapter session (Claude Code, Claude Desktop, Codex) that is not a worker.

  This is a fact about where a session came from, not a list the human keeps. No list of allowed senders exists (see section 4). The human decided that a relay is trusted when it quotes them, and they do not want to confirm each one. Whether these sender exclusions stay is an open question to the human. If the human chooses "any quoted relay", the exclusion list goes and only the delivery check remains.
- **card**: the ask has a proposal card (a `neo_questions` row on the ask with cause `proposal`) that the human answered with accept.
- **neo**: none of the above. This is what `neo.ask.open` produces today.

Goals get no exception. An ask opened in a goal cycle follows the same rule.

**2. An ask from `neo` is a proposal.** `neo.ask.open` takes optional `messageIds`. When they pass rule 1, they are bound through the existing `origin_message_id` and `neo_ask_inputs`, and the ask is human or relayed. Without them, the ask opens as a proposal, and a proposal card (cause `proposal`) is asked in the same call: the title, the request and why. If the human declines, the ask closes as declined. If the human accepts, the answered card makes it accepted.

An ask is **accepted** when it is human, relayed or card.

Asks created before this change keep working. They count as accepted, and no data is rewritten. The change ships with a marker migration. An ask whose `created_at` is earlier than that marker's `applied_at` in `migration_markers` counts as accepted.

**3. New todos and sessions trace to an accepted ask.**

- `neo.ask.open` can record and start inline todos. The admission check runs before its write step. A proposal that comes with todos is refused, and nothing is written. Neo calls again without todos.
- A session request takes a fourth path. When a session that is not working on a todo messages Neo, `recordNeoRequestTodo` (`request-todo.ts`, called from `service.ts`) writes an ask and a reply todo directly with `store.openAsk` and `store.addTodo`. It does not go through `neo.ask.open` or `neo.todo.add`. Admission runs in that path too, before either write:
  - The sender is classified by rule 1.
  - From an allowed sender whose message carries a quote, the ask is relayed and accepted.
  - From an excluded sender, or with no quote, the ask is still written, so the request is not lost, but it is not accepted.
  - The reply todo is written in both cases. It has no instruction and no target, so it cannot start a session. It only holds Neo to replying.
  - New todos and starts on a request ask that is not accepted are refused, as for any ask.
- `neo.todo.add` refuses a todo whose ask is not accepted. Its input path, which opens an ask from a human message through `claimNeoInputAsk`, is human by rule 1 and passes.
- `work.start` needs a todo whose ask is accepted. This applies to every agent caller: Neo, workers and other agent roles. Today's `todo_required` warning (`neoTodoRecords`) becomes a refusal and no longer applies only to Neo. These starts are unchanged:
  - starts from the human's devices;
  - internal daemon calls;
  - starts forwarded from another daemon, because the forwarding daemon ran the check for its own caller.
- Every refusal names what is missing.

**4. Remove the relay-sender list.** The human does not choose which sessions may speak for them. A relay is accepted when it quotes the human's own words and comes from a sender allowed by rule 1, for a new ask and for a card answer alike. Delete all of it:

- the `relaySenders` setting (`shared/src/types/settings.ts`, `daemon/src/lib/global-settings-patch.ts`, `daemon/src/storage/repositories/global-settings-writes.ts`);
- the `neo.relaySenders.set` and `neo.relaySenders.recent` operations (`daemon/src/lib/neo/relay-answer.ts`, `shared/src/types/operation-names/neo.ts`, `daemon/src/lib/operations/neo-discovery.ts`), their tool texts (`prompts/src/neo/tools/neo.relaySenders.*.md`, `prompts/src/mod.ts`) and their tests;
- the settings panel (`web/src/components/settings/NeoRelaySendersSettings.tsx` and its place in `NeoModelSettings.tsx`);
- the allow-list check in `planNeoRelayAnswer` (`daemon/src/lib/neo/relay-plan.ts`). It is replaced by the sender rule from section 1. A relayed card answer still needs where, when and the human's words, and cards that need the human's own action still refuse a relay;
- the verify journey `.claude/skills/verify/relay-answer-door.ts`, which exercises `neo.relaySenders.set` and `sender_not_allowed`. It now proves the sender rule instead.

## How it is built

Each entry point is already a superpipe pipeline, and its steps return `Gate<T>`:

- `neo.ask.open` in `ask-record-operations.ts`;
- `neo.todo.add` in `todo-operations.ts`;
- `work.start`, through the `start-work` pipeline (`runStartWork`) in `work-operations.ts`, which calls `routeStart` as one of its steps.

The new checks are added as steps in these pipelines, not as checks beside them.

- **Fact step (one per pipeline).** It reads what the new checks need:
  - for each message id, `{ id, kind: 'human_turn' | 'session_message' | 'missing', fromSession, toSession, senderClass, humanQuote }`, where `senderClass` is `neo`, `system`, `worker`, `internal_agent` or `external`;
  - for an ask, its `origin_message_id`, its `neo_ask_inputs`, its proposal card and whether it was created before the marker.

  The new checks never touch the database. The existing steps, such as the store write in `neo.ask.open`, do not change.
- **Pure checks.** Each takes facts and returns a `Gate`. They do not read the database, the clock or anything else.
  - `classifyAskSource(askFacts, messageFacts, neoSession)` returns `human`, `relayed`, `card`, `neo` or `legacy`.
  - `requireBindableMessages(messageIds, messageFacts, neoSession)` checks the ids passed to `neo.ask.open`.
  - `requireAcceptedAsk(source)` is used by `neo.todo.add` and `work.start`.
- **Storage.** A no-op marker migration; nothing else. The unused `origin = null` in `neo.ask.open` goes away.
- **Verify journeys.** `.claude/skills/verify/work-todo-reference.ts` asserts that untracked Neo work starts with a `todo_required` record. It changes to assert the refusal.

## Tests (written first)

- Pure checks, as unit tests:
  - an ask with a human `origin_message_id` or `neo_ask_inputs` row is `human`;
  - an ask whose origin is a session message from an external, non-worker session is `relayed`;
  - an origin from a `neo:*`, `system:*`, worker or internal-agent sender is not relayed, and the ask is `neo`;
  - a relayed message delivered to another session, or with no `humanQuote`, is not relayed;
  - an ask with an accepted proposal card is `card`, and a declined or open one is not;
  - an ask created before the marker with no origin is `legacy` and accepted;
  - an ask created after the marker with no origin is `neo` and refused for todos and starts;
  - ids passed to `neo.ask.open` that are missing, of the wrong kind or from an excluded sender are refused;
  - a relayed card answer from an external, non-worker session is accepted when it has where, when and words, with no allow-list.
- `neo.ask.open` with no `messageIds` and inline todos is refused, and nothing is written.
- `neo.ask.open` with no `messageIds` opens a proposal and its card. Adding a todo is refused until the card is accepted, then it starts.
- `neo.ask.open` with human `messageIds` and inline todos records the ask and its inputs and starts the todos.
- `neo.todo.add` with a human input message opens an ask through `claimNeoInputAsk`, and the todo starts.
- A session request from an external, non-worker session with `--quote` makes a relayed, accepted ask. A work todo added to it starts.
- The same sender without `--quote` writes its ask and reply todo, but the ask is not accepted. A work todo added to it is refused.
- A session request from a worker, `neo:*`, `system:*` or internal-agent sender writes its ask and reply todo, but the ask is not accepted. A work todo added to it is refused.
- `work.start` with no `todoId` is refused from Neo and from a worker session. Today it starts with a warning.
- `work.start` with no `todoId` still starts from a human device, from an internal call, and when forwarded from another daemon.

## Not in scope

- Which kinds of small fixes Neo may make without asking. If the human later wants such a list, the human sets it. Neo does not.
- Merge rules, and tracing a PR back to its ask. Merging stays as it is.

## Slices

Three PRs, one rung each, as the repo's slicing rule requires:

1. **Build**: the marker migration, the `human_quote` column and `hyperneo send --quote`, the fact readers and the pure checks, with their unit tests. Nothing calls them yet.
2. **Wire**: the steps in `neo.ask.open`, `neo.todo.add`, `start-work` and the session-request path, the proposal card, the end-to-end tests, the `work-todo-reference` journey, and the matching text in `neo.ask.open.md` and the `work.start` description.
3. **Delete**: the relay-sender list (section 4) and its journey, replaced by the sender rule.
