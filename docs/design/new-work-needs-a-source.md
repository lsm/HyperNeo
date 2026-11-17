# New work needs a source

Status: proposal, 2026-11-16. Design only. Paths without a prefix are under `packages/`.

## Why

Neo can come up with a piece of work itself, write it down as a request in its own words, give it to a worker, and see it merged. The human never asked for it and never sees it. It looks exactly like work the human asked for.

Example: a recent bug fix moved every review session into the daemon's internal read checkout. Here is how it happened:

- Reviewers kept asking Neo for a folder.
- Neo opened an ask whose request already named that folder as the fix.
- A worker built it. The review bot and a cross-model reviewer both checked the code against that request, and it merged as an implementation PR.
- Nobody checked whether the request was right. The human did not ask for it. Every repository now shows an extra project in the desktop apps.

Three gaps allow this:

- `prompts/src/neo/tools/neo.ask.open.md` says an ask records "a human request … in the human's words". The same file says "Any daemon session opens asks". Nothing enforces the first sentence.
- `daemon/src/lib/neo/ask-record-operations.ts` sets `const origin = null` inside the `neo.ask.open` pipeline. Asks opened by Neo therefore never record which message they came from, so a human request and Neo's own idea cannot be told apart.
- `work.start` (`daemon/src/lib/drivers/work-operations.ts`) takes `todoId` as optional. A missing or stale one is "recorded without blocking", so a session can start with no todo and no ask behind it.

## The rule

Only the creation of new work changes. New work means opening an ask, adding a todo, or starting a session with `work.start`. A new PR is opened by a worker inside such a session, so it starts from an accepted ask. Merging, and PRs that already exist, are out of scope. Work that already traces to an accepted ask is unchanged.

**1. Every ask records its source.** A source is one of these:

- **human**: one or more human message ids. Each must be a human message delivered into Neo's own session: a user turn stored with input kind `human`. The human often talks about one matter across several messages, and all of them can be attached to one ask.
- **relayed**: one or more session message ids. Each must be a message that another session delivered to Neo's session (a `neo_session_messages` row with Neo's session as `to_session`), for example a session passing on what the human said. It must quote the human's own words, and the ask stores that quote. No list of allowed senders exists (see section 4).
- **neo**: Neo came up with it.

Goals get no exception. An ask opened in a goal cycle follows the same rule: without a `human` or `relayed` message for that ask, it is a proposal.

`neo.ask.open` requires a source. A request with no source is refused. So is a request whose ids do not match their stated kind, or were not delivered to Neo's session.

**2. An ask from `neo` is a proposal.** It opens as a card for the human: the title, the request and why. Until the human accepts the card, it cannot get a todo started and cannot start a session. If the human declines, the ask closes as declined. Accepting the card changes the source to `human`, with the card answer as the message.

An ask is **accepted** when it has a `human` or `relayed` source, or when it has a `neo` source and the human accepted its card.

Asks that existed before this change have no source rows. They count as accepted, so their new todos and sessions keep working. No data is rewritten. The fact step marks an ask as existing before the change when it has no source rows and was created before the migration that adds the table. The migration records its own time for this.

**3. New todos and sessions trace to an accepted ask.**

- `neo.ask.open` can also record todos inline and start them. The admission check runs before its write step, so a `neo` ask that comes with todos is refused as a whole. The proposal is opened without todos.
- `neo.todo.add` refuses a todo whose ask is not accepted. A proposal holds only its request until the human answers.
- `work.start` needs a todo whose ask is accepted. A start with no todo, with a stale todo, or with a proposal's todo is refused.
- Every refusal names what is missing.

**4. Remove the relay-sender list.** The human does not choose which sessions may speak for them. A relay is accepted when it quotes the human's own words, for a new ask and for a card answer alike. Delete all of it:

- the `relaySenders` setting (`shared/src/types/settings.ts`, `daemon/src/lib/global-settings-patch.ts`, `daemon/src/storage/repositories/global-settings-writes.ts`);
- the `neo.relaySenders.set` and `neo.relaySenders.recent` operations (`daemon/src/lib/neo/relay-answer.ts`, `shared/src/types/operation-names/neo.ts`, `daemon/src/lib/operations/neo-discovery.ts`), their tool texts (`prompts/src/neo/tools/neo.relaySenders.*.md`, `prompts/src/mod.ts`) and their tests;
- the settings panel (`web/src/components/settings/NeoRelaySendersSettings.tsx` and its place in `NeoModelSettings.tsx`);
- the allow-list check in `planNeoRelayAnswer` (`daemon/src/lib/neo/relay-plan.ts`). A relayed card answer still needs where, when and the human's words, and cards that need the human's own action still refuse a relay.

## How it is built

Each entry point is already a superpipe pipeline, and its steps return `Gate<T>`:

- `neo.ask.open` in `ask-record-operations.ts`;
- `neo.todo.add` in `todo-operations.ts`;
- `work.start`, through the `start-work` pipeline (`runStartWork`) in `work-operations.ts`, which calls `routeStart` as one of its steps.

The new checks are added as steps in these pipelines, not as checks beside them.

- **Fact step (one per pipeline).** It reads what the new checks need. For each named id it reads the row it points to, as `{ id, kind: 'human_turn' | 'session_message' | 'missing', fromSession, toSession }`. It also reads the ask, its sources, and the todo and its ask. The new checks themselves never touch the database. The existing steps, such as the store write in `neo.ask.open`, do not change.
- **Pure checks.** Each takes facts and returns a `Gate`. They do not read the database, the clock or anything else.
  - `requireAskSource(input, messageFacts, neoSession)` checks that a source is present. A `human` or `relayed` source must name at least one id. For `human`, every id must be a `human_turn` whose `toSession` is Neo's session. For `relayed`, every id must be a `session_message` whose `toSession` is Neo's session and whose `fromSession` is a different session, and the source must carry a non-empty quote of the human's words.
  - `planAskAdmission(source)` returns open or proposal.
  - `requireAcceptedAsk(askFacts)` is used by `neo.todo.add` and `work.start`.
- **Storage.** A new table `neo_ask_sources (ask_id, kind, message_id)` holds one row per message, so an ask can have many. Card acceptance adds a `human` row. The unused `origin = null` goes away.

## Tests (written first)

- Pure checks, as unit tests:
  - no source is refused;
  - an unknown message id is refused;
  - a `neo` source gives a proposal;
  - a human id that is not a human turn in Neo's session is refused;
  - a `human` or `relayed` source with an empty id list is refused (one test for each);
  - a relayed id that is a human turn, or was delivered to another session, is refused;
  - a relayed id that Neo's own session sent is refused;
  - a relayed source with no quote of the human's words is refused;
  - a relayed card answer from any session is accepted when it has where, when and words, with no allow-list;
  - a todo whose ask is an open proposal is refused;
  - a todo whose ask is accepted passes;
  - an ask from before the change, with no source rows, passes;
  - `neo.ask.open` with source `neo` and inline todos is refused, and nothing is written.
  - `neo.ask.open` with a `human` source and inline todos records the ask and its source rows and starts the todos;
  - a new ask with no source rows, created after the migration, is refused for new todos and starts.
- Neo opens an ask with source `neo`. The ask is not accepted and a card exists. Adding a todo to it is refused. After the card is accepted, a todo can be added and started. Today the todo is added and starts at once.
- `work.start` with no `todoId` is refused. Today it starts.
- An ask that names three human messages records three source rows.

## Not in scope

- Which kinds of small fixes Neo may make without asking. If the human later wants such a list, the human sets it. Neo does not.
- Merge rules, and tracing a PR back to its ask. Merging stays as it is.

## Slices

One PR: storage, the pipeline steps, the pure checks, removing the relay-sender list, the tests, and the matching text in `neo.ask.open.md` and in the `work.start` description.
