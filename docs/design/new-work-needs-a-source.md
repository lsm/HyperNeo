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
- Every ask records an origin in `neo_asks.origin_message_id` (a nullable column), except the ones Neo opens itself. The writers are:
  - `claimNeoInputAsk` (`daemon/src/storage/repositories/neo-ask-input-worker.ts`, reached from `neo.todo.add` with `input`): the human message. Every message on the matter is bound in `neo_ask_inputs`.
  - `recordNeoRequestTodo` (`daemon/src/lib/neo/request-todo.ts`, called from `service.ts`): the session message that asked.
  - `neo.session.track` (`daemon/src/storage/repositories/neo-session-track-write.ts`): `neo-track:…`, written when the human taps Track.
  - home-conflict asks (`daemon/src/lib/neo/home/conflicts.ts`): null. The daemon opens these, and they only ask the human a card.
  - `neo.ask.open` (`daemon/src/lib/neo/ask-record-operations.ts`): hard-codes `const origin = null`. It writes the ask and can start inline todos. Nothing shows who asked.

  The column is also read: wake matching (`neo-conversation-wake-repository.ts`) and `findAsk`'s same-turn retry inside `neo.ask.open` both use it.
- `work.start` (`daemon/src/lib/drivers/work-operations.ts`) takes `todoId` as optional. A missing or stale one is "recorded without blocking", so a session can start with no todo and no ask behind it.

## The rule

Only the creation of new work changes. New work means opening an ask, adding a todo, or starting a session with `work.start`. A new PR is opened by a worker inside such a session, so it starts from an accepted ask. Merging, and PRs that already exist, are out of scope. Work that already traces to an accepted ask is unchanged.

**1. The two paths that can create unasked work record it when they write.** Every other path keeps writing what it writes today. The rule needs no new table and no data rewrite.

- `neo.ask.open` without `messageIds` writes the fixed value `origin_message_id = neo-proposal`. This is Neo's own idea. The value is the same for every proposal, so `findAsk`'s same-turn retry (session, origin, title, goal) matches a retried call exactly as it matches `null` today, and no duplicate ask or card is made.
- `recordNeoRequestTodo` classifies the sender before it writes:
  - A **relay** is a session message delivered to Neo's session that carries the human's words in a separate quote field. `hyperneo send` gets `--quote "<the human's words>"`, and the quote is stored once in a new `human_quote` column on `neo_session_messages`.
  - The sender must be a session the human runs: an external adapter session (Claude Code, Claude Desktop, Codex) that is not a `neo:*` session (on any daemon), not a `system:*` sender, not a session with role `worker` in `work_started_sessions`, and not one of the daemon's own agent sessions.
  - A relay keeps today's origin, the message id.
  - Anything else gets `origin_message_id = unaccepted-request:<messageId>`. The request is still recorded, and its reply todo is still written. That todo has no instruction and no target, so it cannot start a session. It only holds Neo to replying.
  - The daemon checks that the quote field is present. It does not parse the text.

  These sender exclusions are an open question to the human. If the human chooses "any quoted relay", only the quote and delivery checks remain. No list of allowed senders exists (see section 4). The human decided that a relay is trusted when it quotes them, and they do not want to confirm each one.
- `neo.ask.open` gets a new optional input, `messageIds` (an array of message ids), added to its `Open` schema and its tool text. With it, the call binds human messages delivered into Neo's session (user turns with input kind `human`) or relays as defined above, through the existing `origin_message_id` and `neo_ask_inputs`. It refuses an id already bound to another open ask, and never rebinds one. The ask shows the bound messages' words, as the input path does today.

An ask is **accepted** unless its origin is `neo-proposal` or starts with `unaccepted-request:` and it has no proposal card answered with yes. Every ask written before this change, and every ask from the input, track or home-conflict paths, is therefore accepted, with no marker and no rewrite. Goals get no exception: an ask Neo opens in a goal cycle through `neo.ask.open` is a proposal.

**2. A proposal is a yes/no card.** In the same call, `neo.ask.open` without `messageIds` asks a yes/no card on the ask (`yesLabel` "Do it", `noLabel` "Don't"), carrying the title, the request and why. It is accepted when the card is answered with its yes label. A no answer settles the ask as `dropped`, an existing status, with the outcome "declined by the human". No schema change is needed. An `unaccepted-request:` ask becomes accepted the same way, if Neo asks the human a card on it.

**3. New todos and sessions trace to an accepted ask.**

- `neo.ask.open` can record and start inline todos. The admission check runs before its write step. A proposal that comes with todos is refused, and nothing is written. Neo calls again without todos.
- `neo.todo.add` refuses a todo whose ask is not accepted. Its input path, through `claimNeoInputAsk`, writes a human origin and passes.
- `work.start` needs a todo whose ask is accepted. This applies to every agent caller: Neo, workers and other agent roles. Today's `todo_required` warning (`neoTodoRecords`) becomes a refusal and no longer applies only to Neo. The new step runs before `routeStart` in `start-work`. These starts are unchanged:
  - starts from the human's devices;
  - internal daemon calls.

  A start forwarded from another daemon is exempt only when the forwarding daemon marks it `admitted`, which an upgraded daemon does after running this step. A forwarded start without that mark is checked here like any agent start. While versions differ, such a start from an older peer is refused rather than let through.
- Every refusal names what is missing.

**4. Remove the relay-sender list.** The human does not choose which sessions may speak for them. A relay is accepted when it quotes the human's own words and comes from a sender allowed by rule 1, for a new ask and for a card answer alike. Delete all of it:

- the `relaySenders` setting (`shared/src/types/settings.ts`, `daemon/src/lib/global-settings-patch.ts`, `daemon/src/storage/repositories/global-settings-writes.ts`);
- the `neo.relaySenders.set` and `neo.relaySenders.recent` operations (`daemon/src/lib/neo/relay-answer.ts`, with the `recentRelaySenders` read in `daemon/src/storage/repositories/neo-ask-input-worker.ts` that only it uses, `shared/src/types/operation-names/neo.ts`, `daemon/src/lib/operations/neo-discovery.ts`), their tool texts (`prompts/src/neo/tools/neo.relaySenders.*.md`, `prompts/src/mod.ts`) and their tests;
- the settings panel (`web/src/components/settings/NeoRelaySendersSettings.tsx` and its place in `NeoModelSettings.tsx`);
- the allow-list check in `planNeoRelayAnswer` (`daemon/src/lib/neo/relay-plan.ts`). It is replaced by the sender rule from section 1. A relayed card answer still needs where, when and the human's words, and cards that need the human's own action still refuse a relay;
- the verify journey `.claude/skills/verify/relay-answer-door.ts`, which exercises `neo.relaySenders.set` and `sender_not_allowed`. It now proves the sender rule instead.

## How it is built

Each entry point is already a superpipe pipeline, and its steps return `Gate<T>`:

- `neo.ask.open` in `ask-record-operations.ts`;
- `neo.todo.add` in `todo-operations.ts`;
- `work.start`, through the `start-work` pipeline (`runStartWork`) in `work-operations.ts`.

The session-request path in `service.ts` gets the same pure check before `recordNeoRequestTodo` writes.

- **Fact step (one per path).** It reads what the new checks need:
  - for each message id, `{ id, kind: 'human_turn' | 'session_message' | 'missing', toSession, senderClass, humanQuote, boundAsk }`, where `senderClass` is `neo`, `system`, `worker`, `internal_agent` or `external`;
  - for an ask, its `origin_message_id` and its yes/no proposal card, if any.

  The new checks never touch the database. The existing steps, such as the store write in `neo.ask.open`, do not change.
- **Pure checks.** Each takes facts and returns a `Gate` or a value. They do not read the database, the clock or anything else.
  - `classifyRequest(messageFact, neoSession)` returns `relay` or `unaccepted`.
  - `requireBindableMessages(messageIds, messageFacts, neoSession)` checks the ids passed to `neo.ask.open`.
  - `isAcceptedAsk(askFacts)` checks the origin prefix and the card.
  - `requireAcceptedAsk(askFacts)` is used by `neo.todo.add` and `work.start`.
- **Inputs and storage.** The new `messageIds` input on `neo.ask.open`, the `human_quote` column on `neo_session_messages`, and the `admitted` mark on forwarded starts. Nothing else. The `origin = null` in `neo.ask.open` goes away.
- **Verify journeys.** `.claude/skills/verify/work-todo-reference.ts` asserts that untracked Neo work starts with a `todo_required` record. It changes to assert the refusal.

## Tests (written first)

- Pure checks, as unit tests:
  - asks with a human, session-message, `neo-track:` or null origin are accepted;
  - asks with a `neo-proposal` or `unaccepted-request:` origin are not accepted, unless their yes/no card was answered with its yes label;
  - a request from an external, non-worker session with a `humanQuote` is a relay;
  - the same sender without a quote is unaccepted;
  - a request from a `neo:*`, `system:*`, worker or internal-agent sender is unaccepted;
  - ids passed to `neo.ask.open` that are missing, of the wrong kind, from an excluded sender, or bound to another open ask are refused;
  - a relayed card answer from an external, non-worker session is accepted when it has where, when and words, with no allow-list.
- An ask written today by `recordNeoRequestTodo`, with a session-message origin and no quote, still takes new todos after the change.
- `neo.ask.open` with no `messageIds` and inline todos is refused, and nothing is written.
- Calling `neo.ask.open` twice in one turn with the same title and no `messageIds` returns the same proposal ask and one card.
- `neo.ask.open` with no `messageIds` opens a proposal and its yes/no card. Adding a todo is refused. After a yes answer, it starts. After a no answer, the ask is `dropped`.
- `neo.ask.open` with human `messageIds` and inline todos records the ask and its inputs and starts the todos.
- `neo.todo.add` with a human input message opens an ask through `claimNeoInputAsk`, and the todo starts.
- A session request with `--quote` from an external session makes an accepted ask, and a work todo on it starts. Without `--quote`, the reply todo exists, and a work todo is refused.
- `work.start` with no `todoId` is refused from Neo and from a worker session. Today it starts with a warning.
- `work.start` with no `todoId` still starts from a human device and from an internal call.
- A forwarded start marked `admitted` starts. A forwarded start without the mark and without a local accepted todo is refused.

## Not in scope

- Which kinds of small fixes Neo may make without asking. If the human later wants such a list, the human sets it. Neo does not.
- Merge rules, and tracing a PR back to its ask. Merging stays as it is.

## Slices

Three PRs, one rung each, as the repo's slicing rule requires:

1. **Build**: the `human_quote` column, `hyperneo send --quote`, the fact readers and the pure checks, with their unit tests. Nothing calls them yet.
2. **Wire**: the `messageIds` input on `neo.ask.open` (schema and tool text), the checks in `neo.ask.open`, `neo.todo.add`, `start-work` (with the `admitted` mark) and the session-request path, the yes/no proposal card, the end-to-end tests, the `work-todo-reference` journey, and the matching text in `neo.ask.open.md` and the `work.start` description.
3. **Delete**: the relay-sender list (section 4) and its journey, replaced by the sender rule.
