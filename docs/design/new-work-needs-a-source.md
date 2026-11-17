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

Only the creation of new work changes. New work means opening an ask, adding a todo, starting a session with `work.start`, or merging a new PR. Work that already traces to an accepted ask is unchanged.

**1. Every ask records its source.** A source is one of these:

- **human**: one or more human message ids. Each must be a human message delivered into Neo's own session: a user turn stored with input kind `human`. The human often talks about one matter across several messages, and all of them can be attached to one ask.
- **relayed**: one or more session message ids. Each must be a message delivered to Neo's session (a `neo_session_messages` row with Neo's session as `to_session`). Its sender must also be in the human's relay-sender list (`relaySenders`). Only the local user can set that list (`neo.relaySenders.set`), and today it already decides who may relay the human's card answers. The human chooses which sessions may speak for them, so the code does not try to judge whether a text is the human's words.
- **neo**: Neo came up with it.

Goals get no exception. An ask opened in a goal cycle follows the same rule: without a `human` or `relayed` message for that ask, it is a proposal.

`neo.ask.open` requires a source. A request with no source is refused, and so is one whose message ids fail the checks above.

**2. An ask from `neo` is a proposal.** It opens as a card for the human: the title, the request and why. Until the human accepts the card, it cannot get a todo started and cannot start a session. If the human declines, the ask closes as declined. Accepting the card changes the source to `human`, with the card answer as the message.

An ask is **accepted** when it has a `human` or `relayed` source, or when it has a `neo` source and the human accepted its card.

**3. New todos and sessions trace to an accepted ask.**

- `neo.todo.add` refuses a todo whose ask is not accepted. A proposal holds only its request until the human answers.
- `work.start` needs a todo whose ask is accepted. A start with no todo, with a stale todo, or with a proposal's todo is refused.
- Every refusal names what is missing.

**4. A new PR merges only if it traces to an accepted ask.** A worker can open a PR on GitHub for anything, so the check happens before the daemon merges. The PR must be linked to a todo of an accepted ask through the coding pack's todo-PR record. Otherwise the daemon does not merge it and hands it to the human.

## How it is built

Each entry point is already a superpipe pipeline, and its steps return `Gate<T>`:

- `neo.ask.open` in `ask-record-operations.ts`;
- `neo.todo.add` in `todo-operations.ts`;
- `work.start`, through the `start-work` pipeline (`runStartWork`) in `work-operations.ts`, which calls `routeStart` as one of its steps;
- the merge decision `coding.decide-daemon-merge` in `daemon/src/lib/neo/packs/coding/daemon-merge-gates.ts`.

The new checks are added as steps in these pipelines, not as checks beside them.

- **Fact step (one per pipeline).** It reads what the new checks need: the message rows, the relay-sender list, the ask, its sources, and the todo and its ask. The new checks themselves never touch the database. The existing steps, such as the store write in `neo.ask.open`, do not change.
- **Pure checks.** Each takes facts and returns a `Gate`. They do not read the database, the clock or anything else.
  - `requireAskSource(input, knownMessageIds)` checks that the source is present and names messages that exist.
  - `planAskAdmission(source)` returns open or proposal.
  - `requireAcceptedAsk(askFacts)` is used by `neo.todo.add` and `work.start`.
  - `requireAcceptedAskPr(prFacts)` is a merge step. A PR that fails it is handed to the human.
- **Storage.** A new table `neo_ask_sources (ask_id, kind, message_id)` holds one row per message, so an ask can have many. Card acceptance adds a `human` row. The unused `origin = null` goes away.

## Tests (written first)

- Pure checks, as unit tests:
  - no source is refused;
  - an unknown message id is refused;
  - a `neo` source gives a proposal;
  - a human id that is not a human turn in Neo's session is refused;
  - a relayed id from a sender not in `relaySenders` is refused;
  - a todo whose ask is an open proposal is refused;
  - a PR linked to no accepted ask is not merged.
- Neo opens an ask with source `neo`. The ask is not accepted and a card exists. Adding a todo to it is refused. After the card is accepted, a todo can be added and started. Today the todo is added and starts at once.
- `work.start` with no `todoId` is refused. Today it starts.
- An ask that names three human messages records three source rows.

## Not in scope

- Which kinds of small fixes Neo may make without asking. If the human later wants such a list, the human sets it. Neo does not.
- Merge rules other than the one new step. They stay as they are.

## Slices

One PR: storage, the pipeline steps, the pure checks, the tests, and the matching text in `neo.ask.open.md` and in the `work.start` description.
