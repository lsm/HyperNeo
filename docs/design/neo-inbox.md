# Neo inbox: everything that waits on the human, in one place

Checked against dev 75ab28d622.

## Summary

An ask is an epic: one goal, split into todos that may run in parallel. A card is a question to the human. Today a card hangs on the ask: one open card per ask, so a second question about a different todo is refused, or arrives only after the first is answered. A human step (a todo only the human can do) gets a second daemon card after 24 hours ("waited 24 hours, keep waiting?"). The clients get only a count of asks that wait on the human, not the questions themselves.

This design makes the inbox a small core subsystem:
- A card is a question about one or more todos (or the whole ask). An ask can hold any number of cards; each card stops only the todos it is about.
- A card is `open`, `held` (the human put it aside until a time, or until they come back to it), `answered` or `retired`.
- A human step is a todo blocked on the human with its own card. It never gets a second "keep waiting?" card.
- One pure projection, `neoInbox`, gives the clients every item that waits on the human, with two independent filters: state and ask.

## What exists

- Cards are rows of `neo_questions`. States are `open | answered | retired` (`NeoQuestionState`, `packages/shared/src/types/neo-ask.ts`).
- A card names its todos twice. `todos` (a JSON list) is what coverage reads: `neoQuestionCoversTodo` (`lib/neo/todo-state.ts`). `todo_id` (one id) is written by Neo's own cards and read in about eight places (`human-card.ts`, `question-operations.ts`, `todo-start-gate.ts`, `todo-operations.ts`, `service.ts`). Daemon cards fill only `todos`.
- `onlyCard` in `lib/neo/human-card.ts` refuses a new card while any card with a todo or `retireWhen` is open on the same ask (`card_open`).
- `neoCheckOverdue` in `lib/neo/daemon-cards.ts` opens a `check_overdue` card when a todo has waited 24 hours, its check has not passed, and no open card covers it. In practice these are human steps whose own card was answered or retired while the todo stayed `blocked` on `question`.
- `planNeoBlockCards` in `lib/neo/block-cards.ts` already opens a card for a todo blocked on `needs-human`.
- `neoWorkCounts` in `lib/neo/ask-entries.ts` sends `needsYou`: the number of asks with an open card or a waiting todo. Cards travel inside each ask entry.
- A reply card must ask something (`asksSomething`, `human-card.ts`). Status lines from workers are refused as cards.

## The model

| Thing | Is | Like |
|---|---|---|
| ask | one goal | an epic |
| todo | one piece of it, with dependencies | a sub-issue |
| card | a question to the human about some todos, or about the whole ask | a comment that mentions the human |

Rules, all pure and in core (`lib/neo/human-card.ts`, `lib/neo/inbox.ts`):
1. **Facts once.** `todos` is the only link from a card to todos. An empty list means the whole ask. `todo_id` is folded into `todos` and dropped.
2. **One live card per todo.** A new card is refused (`card_open`) when an `open` or `held` card already covers one of its todos; `replaces` changes it. Cards about the whole ask are not limited. `onlyCard` changes from "per ask" to "per todo".
3. **A card stops only its todos.** Other todos of the ask keep running. The start gate already holds only the todos a card lists (`todo-start-gate.ts`); the per-ask limit is the only coupling.
4. **A blocked todo always has its card.** A todo blocked on `question` or `needs-human` is covered by an `open` or `held` card. When its card is answered or retired and the todo is still blocked, the todo's next step becomes Neo's, under the next-step owner rule of the attention design (`docs/design/neo-attention.md`, in HyperNeo #10684, not yet merged), so its `todo.neo_step` wakes Neo to unblock it or ask again. That replaces the `check_overdue` card: the daemon stops opening it.
5. **A human step is a needs-human todo with its card.** Its options include "done" and "hold". It is the same item in the inbox as any question.

## Held cards

`neo.question.hold {questionId, until?, requestId}` is one superpipe operation:
1. read the card; refuse unless it is `open`;
2. pure `planHold(card, until, now)`: `until` is a time or empty ("until I come back");
3. one transaction: state `held`, `held_until`, `held_at`.

The existing 5-minute pack sweep (`pack-sweep.ts`) reopens held cards whose `held_until` has passed. Opening a held card from the inbox reopens it at once. A held card still covers its todos, so they stay stopped, and the attention subsystem treats it like an open card: no reminders. Answering and retiring work on `held` cards as on `open` ones.

## The inbox projection

`neoInbox({questions, asks, todos, now})` is pure. It returns:
- `items`: one per `open` or `held` card, with its state, ask (id, title), the titles of its todos ("the whole ask" when empty), its kind and options, and its age;
- `counts`: a table of state × ask, so each filter shows the numbers that follow the other's choice.

It reads only rows that exist. The Neo snapshot carries it next to the ask entries; `needsYou` stays and equals `counts.open` summed. Web, phone and iPad render the same data.

## Clients

One rule everywhere:
- Two filter rows that are independent and can be used in either order: **state** (waiting on you, held, running, recent results) and **ask** (all, then each ask). The default is "waiting on you" and "all".
- Each row shows the choices that fit, and the rest under a final "More" menu. No horizontal scrolling.
- Items are grouped by ask. Each item says which todo it is about. The agree button is on the right; "Hold" offers: tomorrow, next week, until I come back, and drop this todo.

## Change plan

Each step is one PR within the repo's slice budget.
1. **Build: fold `todo_id` into `todos`.** A migration copies each `todo_id` into `todos` when missing. Readers switch to `todos`. Then a second PR drops the column. Tests: a card with only `todo_id` covers its todo after migration; every former reader gives the same answer.
2. **Build: one live card per todo.** `onlyCard` checks overlap of `todos` among `open` and `held` cards. Tests: two cards on different todos of one ask are both accepted; a second card on the same todo is refused; an ask-level card is never refused for this.
3. **Build + wire: held cards.** The `held` state, `held_until` and `held_at` columns, `neo.question.hold`, and the sweep reopen. Tests: hold until a time reopens on the sweep after it; hold with no time stays held; a held card still covers its todos; answering a held card works.
4. **Build: `neoInbox`** with its tests (state × ask counts, whole-ask cards, held items). **Wire:** add it to the Neo snapshot.
5. **Wire: clients.** Web first, then the phone app, each its own PR with light and dark screenshots at a wide and a phone width.
6. **Delete: the `check_overdue` card.** Stop opening it; old rows stay readable. This step waits until HyperNeo #10684 is merged and its `todo.neo_step` kind is live, so a todo left blocked after its card ends always has a wake-up path. Until then the `check_overdue` card stays as the safety net.

## Limits

- Holding a card stops its todos until it reopens. "Drop this todo" is the way to stop the work for good.
- Asks are not cards. A whole-ask question is a card with no todos.
- The inbox is a view. It adds no new record of what the human was asked.
