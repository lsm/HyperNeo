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

Only the creation of new work changes. New work means opening an ask, adding a todo, or starting a session with `work.start`. A new PR is opened by a worker inside such a session, so it is covered too. Work that already traces to an accepted ask is unchanged.

**1. Every ask records its source.** A source is one of these:

- **human**: one or more human message ids. The human often talks about one matter across several messages, and all of them can be attached to one ask.
- **relayed**: a session message that carries the human's words, such as another session passing on what the human said. It records the session message id.
- **neo**: Neo came up with it.

An ask opened under a goal counts as the human's when the human accepted that goal. A goal's mandate is already a card the human answers.

`neo.ask.open` requires a source. A `human` or `relayed` source must name message ids that exist and reached Neo. A request with no source is refused.

**2. An ask from `neo` is a proposal.** It opens as a card for the human: the title, the request and why. Until the human accepts the card, it cannot get a todo started and cannot start a session. If the human declines, the ask closes as declined. Accepting the card changes the source to `human`, with the card answer as the message.

**3. New sessions trace to an accepted ask.** `work.start` needs a todo whose ask has a `human` or `relayed` source, or a `neo` source whose card was accepted. A start with no todo, a stale todo, or a proposal's todo is refused. The refusal names what is missing.

## How it is built

Both entry points are already superpipe pipelines whose steps return `Gate<T>`:

- `neo.ask.open` in `ask-record-operations.ts`;
- `work.start`, through `routeStart` in `work-operations.ts`.

The new checks are added as steps in these pipelines, not as checks beside them.

- **Fact step (one per pipeline).** It reads what the checks need: the ask, its sources, and the todo and its ask. This is the only step that touches the database.
- **Pure checks.** Each takes facts and returns a `Gate`. They do not read the database, the clock or anything else.
  - `requireAskSource(input, knownMessageIds)` checks that the source is present and names messages that exist.
  - `planAskAdmission(source)` returns open or proposal.
  - `requireAcceptedAsk(todoFacts)` is used by `work.start`.
- **Storage.** A new table `neo_ask_sources (ask_id, kind, message_id)` holds one row per message, so an ask can have many. Card acceptance adds a `human` row. The unused `origin = null` goes away.

## Tests (written first)

- Pure checks, as unit tests:
  - no source is refused;
  - an unknown message id is refused;
  - a `neo` source gives a proposal;
  - a todo whose ask is an open proposal is refused.
- Neo opens an ask with source `neo` and a todo with a start target. The todo does not start, and a card exists. After the card is accepted, it starts. Today it starts at once.
- `work.start` with no `todoId` is refused. Today it starts.
- An ask that names three human messages records three source rows.

## Not in scope

- Which kinds of small fixes Neo may make without asking. If the human later wants such a list, the human sets it. Neo does not.
- Merge rules. They stay as they are.

## Slices

One PR: storage, the two pipeline steps, the pure checks, the tests, and the matching text in `neo.ask.open.md` and in the `work.start` description.
