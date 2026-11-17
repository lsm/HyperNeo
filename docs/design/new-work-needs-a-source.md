# New work needs the human's yes

Status: proposal, 2026-11-16, tracked in #10943. Design only. Paths without a prefix are under `packages/`.

## Why

Neo can come up with work itself, write it as a request in its own words, give it to a worker, and see it merged. The human never asked for it, and it looks exactly like work the human asked for.

Example: a recent bug fix moved every review session into the daemon's internal read checkout. Here is how it happened:

- Reviewers kept asking Neo for a folder.
- Neo opened an ask whose request already named that folder as the fix.
- A worker built it, two reviewers checked the code against that request, and it merged.
- Nobody asked whether the request was right.

Two gaps allow this:

- `neo.ask.open` (`daemon/src/lib/neo/ask-record-operations.ts`) lets Neo open an ask in its own words and start todos on it at once. Its tool text says an ask records "a human request", but nothing checks that.
- `work.start` (`daemon/src/lib/drivers/work-operations.ts`) takes `todoId` as optional. A missing one is "recorded without blocking", so a session can start with no ask behind it.

Words relayed by another session cannot be trusted either. The session door takes the sender from the request body (`daemon/src/lib/messaging/session-door.ts`), and the CLI reads it from environment variables (`cli/src/session-cli.ts`). Any session with a shell can claim to be any other session and invent a quote. Only the human's own devices are authenticated.

## The rule

New work starts only from the human, and the human always acts on their own device.

**1. What counts as the human asking.**

- A human message to Neo. This already opens an ask through `neo.todo.add` with `input` (`claimNeoInputAsk`).
- Tapping Track on a session (`neo.session.track`).
- "Do it" on a proposal card.

**2. Everything else is a proposal.** When Neo opens an ask with `neo.ask.open`, the same call asks a yes/no card on it ("Do it" / "Don't"). The card shows the request and why. This covers both Neo's own ideas and words another session relayed, which the card shows as a quote.

- The ask takes no todos until the human answers "Do it".
- "Don't" settles the ask as `dropped`.
- If `neo.ask.open` is called with todos for a new proposal, the call is refused and nothing is written. The retry path is refused too.

A session's request to Neo (`recordNeoRequestTodo`) still records its ask and its reply todo, so the request is not lost. That ask only holds Neo to replying. To act on it, Neo opens a proposal.

**3. Todos and sessions need an accepted ask.**

- An ask is accepted unless it has a proposal card that is not yet answered "Do it", or unless it is a session-request ask.
- Every existing ask has no proposal card, so it stays accepted. Asks from human messages, Track and the daemon's own home-conflict cards are accepted the same way. No data changes.
- `neo.todo.add` refuses a todo on an ask that is not accepted.
- `work.start` from an agent (Neo, a worker or another agent role) needs a todo on an accepted ask. Today's `todo_required` warning becomes a refusal.
- Starts from the human's devices, internal daemon calls and starts forwarded from another daemon are unchanged.

**4. Cards are answered only on the human's devices.** Relayed card answers are removed, for the same reason: their sender cannot be trusted. That means:

- the `hyperneo relay` command;
- the relayed path of `neo.question.answer`;
- `relay-answer.ts` and `relay-plan.ts`;
- the `relayAnswer` and `recentRelaySenders` repository reads;
- the `relaySenders` setting and its settings panel;
- the `neo.relaySenders.*` operations and their tool texts;
- the `relay-answer-door` verify journey.

## How it is built

The checks are pure functions added as steps in the existing superpipe pipelines:

- `neo.ask.open`;
- `neo.todo.add`;
- `start-work`, before `routeStart`.

Each check takes facts and returns a `Gate`. The facts are the ask, its proposal card, whether it holds a session-request reply todo (`named.requestFrom`, written by `request-todo.ts`), and the caller. A fact step reads those facts first. No new table or column is added.

## Tests (written first)

- `neo.ask.open` makes a proposal card. A todo on it is refused until "Do it", then accepted. "Don't" drops the ask.
- `neo.ask.open` with todos for a new proposal is refused, and nothing is written. The same holds on retry.
- A human message to Neo opens an accepted ask, and its todo starts.
- An existing ask with no proposal card still takes todos.
- A session request records its ask and reply todo. A work todo on that ask is refused.
- `work.start` with no todo is refused from Neo and from a worker. It still starts from a human device and from an internal call.
- `hyperneo relay` and relayed card answers no longer exist.

## Slices

Two PRs, as the human asked:

1. **The rule**: the proposal card, the checks in `neo.ask.open`, `neo.todo.add` and `start-work`, the tests, and the matching tool text.
2. **Remove relayed answers**: everything listed in rule 4.
