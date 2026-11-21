# New work needs the human's yes

Status: proposal, 2026-11-16, tracked in #10943. Design only. Paths without a prefix are under `packages/`.

## Why

Neo can come up with work itself, write it as a request in its own words, give it to a worker, and see it merged. The human never asked for it, and it looks exactly like work the human asked for.

For example: sessions keep asking Neo for something. Neo opens an ask whose request already names its own fix, a worker builds it, reviewers check the code against that request, and it merges. Nobody asked whether the request was right.

Two gaps allow this:

- `neo.ask.propose` (`daemon/src/lib/neo/ask-record-operations.ts`) lets Neo open an ask in its own words and start todos on it at once. Its tool text says an ask records "a human request", but nothing checks that.
- `work.start` (`daemon/src/lib/drivers/work-operations.ts`) takes `todoId` as optional. A missing one is "recorded without blocking", so a session can start with no ask behind it.

Words relayed by another session cannot be trusted either. The session door takes the sender from the request body (`daemon/src/lib/messaging/session-door.ts`), and the CLI reads it from environment variables (`cli/src/session-cli.ts`). Any session with a shell can claim to be any other session and invent a quote. Only the human's own devices are authenticated.

## The rule

New work starts only from the human, and the human always acts on their own device.

**1. What counts as the human asking.**

- A human message to Neo. This already opens an ask through `neo.todo.add` with `input` (`claimNeoInputAsk`).
- Tapping Track on a session (`neo.session.track`).
- Yes on a proposal card.
- The human's answer to a relayed session question (`neo.question.relaySession`, written through the Track path). That card is the proposal: its ask is accepted once the human answers it, and not before.

**2. Everything else is a proposal.** When Neo opens an ask with `neo.ask.propose`, the same call asks a yes/no card on it. Neo writes the two button labels in the human's language, such as 发出去 / 先不做; without them each app shows its default (web: Confirm / Cancel; iOS: Yes / No). The card shows the request and why. This covers Neo's own ideas, words another session relayed (shown as a quote), and asks in a goal's cycle (`neo.ask.propose` with `goalId`). A confirmed goal mandate does not skip the card: any session can create a goal and point it at a confirmed revision, so it cannot prove the human wanted this ask.

- The ask takes no todos until the human answers yes.
- No settles the ask as `dropped`.
- If `neo.ask.propose` is called with todos for a new proposal, the call is refused and nothing is written. The retry path is refused too.

A session's request to Neo (`recordNeoRequestTodo`) still records its ask and its reply todo, so the request is not lost. That ask only holds Neo to replying. To act on it, Neo opens a proposal.

**3. Todos and sessions need an accepted ask.**

- An ask is accepted unless it has a proposal card that is not yet answered yes, or a relayed session question not yet answered, or unless it is a session-request ask.
- Asks from human messages, Track and the daemon's own home-conflict cards are accepted. Existing asks stay accepted too, except session-request asks. The relayed-session-question gate applies only to cards created after this change; older cards do not block work.
- `neo.todo.add` refuses a todo on an ask that is not accepted.
- `work.start` from an agent (Neo, a worker or another agent role) needs a todo on an accepted ask. Today's `todo_required` warning becomes a refusal.
- `work.send` and `work.queue` from an agent to a worker follow the same rule: they name a todo on an accepted ask. `notice: true` without a todo is kept only for replying to a session that sent Neo a message.
- Starts and sends from the human's devices, internal daemon calls and starts forwarded from another daemon are unchanged.

**4. Cards are answered only on the human's devices.** Relayed card answers are removed, for the same reason: their sender cannot be trusted. That means:

- the `hyperneo relay` command;
- the relayed path of `neo.question.answer`, so `answeredByHuman` then means a device answer;
- `relay-answer.ts` and `relay-plan.ts`;
- the `relayAnswer` and `recentRelaySenders` repository reads;
- the `relaySenders` setting and its settings panel;
- the `neo.relaySenders.*` operations and their tool texts;
- the `relay-answer-door` verify journey.

## How it is built

The checks are pure functions added as steps in the existing superpipe pipelines:

- `neo.ask.propose`;
- `neo.todo.add`;
- `start-work`, before `routeStart`;
- `work.send` and `work.queue`, beside `requireSendPurpose`.

Each check takes facts and returns a `Gate`. The facts are the ask, its proposal card, its relayed session question, whether it holds a session-request reply todo (`named.requestFrom`, written by `request-todo.ts`), the caller, and for a notice, whether the target session sent Neo a message. A fact step reads those facts first. No new table or column is added.

## Tests (written first)

- `neo.ask.propose` makes a proposal card. A todo on it is refused until yes, then accepted. No drops the ask.
- `neo.ask.propose` with todos for a new proposal is refused, and nothing is written. The same holds on retry.
- A human message to Neo opens an accepted ask, and its todo starts.
- An existing ask with no proposal card still takes todos, unless it is a session-request ask or has an unanswered relayed question.
- An ask in a goal's cycle is a proposal, even when the goal's mandate was confirmed.
- A relayed session question's ask takes no todos until the human answers its card.
- A session request records its ask and reply todo. A work todo on that ask is refused.
- `work.start` with no todo is refused from Neo and from a worker. It still starts from a human device and from an internal call.
- A Neo `work.send` to a worker without a todo on an accepted ask is refused. A notice reply to a session that messaged Neo is still sent.
- `hyperneo relay` and relayed card answers no longer exist.

## Slices

Two PRs, as the human asked. Relayed card answers exist today (`daemon/src/lib/neo/relay-answer.ts`). Slice 1 removes them. Proposal cards exist only from slice 2, which merges after slice 1, so no proposal can ever be approved by a relayed answer:

1. **Remove relayed answers**: everything listed in rule 4. Removal only.
2. **The rule**: the proposal card, the checks in `neo.ask.propose`, `neo.todo.add`, `start-work` and `work.send`/`work.queue`, the tests, and the matching tool text in `neo.ask.propose.md` and `goal-cycle.md`. It merges only after slice 1.
