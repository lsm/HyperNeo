# Neo inbox: everything that waits on the human, in one place

Checked against dev 75ab28d622.

## Summary

An ask is an epic: one goal, split into todos that may run in parallel. A card is a question to the human. Today a card hangs on the ask: one open card per ask, so a second question about a different todo is refused, or arrives only after the first is answered. A human step (a todo only the human can do: it has a check but no instruction and no worker) gets its first card only after 24 hours, and that card asks "waited 24 hours, keep waiting?" instead of asking the human to do the step. The clients get only a count of asks that wait on the human, not the questions themselves.

This design makes the inbox a small core subsystem:
- A card is a question about one or more todos (or the whole ask). An ask can hold any number of cards; each card stops only the todos it is about.
- A card is open, held (the human put it aside until a time, or until they come back to it), answered or retired.
- A human step gets its own card as soon as it can start, asking the human to do it. The "keep waiting?" card goes away.
- One pure projection, `neoHumanQueue`, gives the clients every item that waits on the human, with two independent filters: state and ask.

## What exists

- Cards are rows of `neo_questions`. States are `open | answered | retired` (`NeoQuestionState`, `packages/shared/src/types/neo-ask.ts`).
- A card names its todos twice, and every question read selects both (`QUESTION_SELECT`, `neo-ask-todo-repository.ts`). `todos` (a JSON list) is what coverage reads: `neoQuestionCoversTodo` (`lib/neo/todo-state.ts`). `todo_id` (one id) is written by Neo's own cards and read in about eight places (`human-card.ts`, `question-operations.ts`, `todo-start-gate.ts`, `todo-operations.ts`, `service.ts`). Daemon cards fill only `todos`.
- `onlyCard` in `lib/neo/human-card.ts` refuses a new card while any card with a todo or `retireWhen` is open on the same ask (`card_open`).
- The stall reminder sweep (`neoStallReminderWrite`, `storage/repositories/neo-stall-reminder-write.ts`) opens a `check_overdue` card for a todo in state `todo` with a check, no instruction and no session (`listCheckable`, `neo-ask-todo-repository.ts`), once it is 24 hours old and no open card covers it (`neoCheckOverdue`, `lib/neo/daemon-cards.ts`). That is a human step, and this card is its first card. The card then blocks the todo on `question`.
- `planNeoBlockCards` in `lib/neo/block-cards.ts` already opens a card for a todo blocked on `needs-human`.
- `neoWorkCounts` in `lib/neo/ask-entries.ts` sends `needsYou`: the number of asks with an open card or a waiting todo. Cards travel inside each ask entry.
- A reply card must ask something (`asksSomething`, `human-card.ts`). Status lines from workers are refused as cards.

## The model

| Thing | Is | Like |
|---|---|---|
| ask | one goal | an epic |
| todo | one piece of it, with dependencies | a sub-issue |
| card | a question to the human about some todos, or about the whole ask | a comment that mentions the human |

Rules, all pure and in core (`lib/neo/human-card.ts`, `lib/neo/human-queue.ts`):
1. **Facts once.** `todos` is the only link from a card to todos. An empty list means the whole ask. `todo_id` is folded into `todos`; readers stop using it, and the column is dropped one release later (Change plan, step 1).
2. **One live card per todo.** A new card is refused (`card_open`) when an open or held card already covers one of its todos; `replaces` changes it. Cards about the whole ask are not limited. `onlyCard` changes from "per ask" to "per todo".
3. **A card stops only its todos.** Other todos of the ask keep running. The start gate already holds only the todos a card lists (`todo-start-gate.ts`); the per-ask limit is the only coupling.
4. **A blocked todo always has its card, or Neo owns it.** A todo blocked on `question` or `needs-human` is normally covered by an open or held card. When none covers it:
   - an answered card whose answer is still being delivered (`question-answer-delivery.ts`) keeps the todo with the daemon: the delivery resumes it, and nobody is woken;
   - otherwise the next step is Neo's, even if the todo keeps a start target. This row comes before the queue rows of the next-step owner table in the attention design (`docs/design/neo-attention.md`, HyperNeo #10684, not yet merged; that PR gains the row), so `todo.neo_step` wakes Neo once to unblock it or ask again.
5. **A human step gets its card when it can start.** A todo with a check, no instruction and no worker is a human step. When its prerequisites are done, the daemon opens one card asking the human to do it, with "done", "hold" and "remove". This takes the place of the `check_overdue` card: same producer (the stall reminder sweep) and selection, but at once instead of after 24 hours, and asking for the step instead of "keep waiting?". Existing open `check_overdue` cards stay until answered.

## Held cards

A held card is an open card with a hold, so old readers still see it as open and no state value is added. Two new nullable columns on `neo_questions`: `held_at` and `held_until` (empty means "until I come back").

`neo.question.hold {questionId, until?, requestId}` is one superpipe operation:
1. read the card; refuse unless it is open;
2. pure `planHold(card, until, now)`;
3. one transaction: set `held_at` and `held_until`.

The existing 5-minute pack sweep (`pack-sweep.ts`) clears the hold when `held_until` has passed. Opening a held card from the inbox clears it at once. A held card still covers its todos, so they stay stopped, and the attention subsystem treats it like any open card: no reminders. Answering and retiring work as before and clear the hold.

## The inbox projection

`neoHumanQueue({questions, asks, todos, delivering, now})` is pure. `delivering` is the set of todos whose answered card is still being delivered (`question-answer-delivery.ts`). Each todo and each card lands in exactly one state bucket, first match wins:
1. **waiting on you**: an open card without a hold (one item per card, with the titles of its todos, or "the whole ask");
2. **held**: an open card with a hold;
3. **in progress**: every other unfinished todo (`todo`, `doing`, `blocked`, `failed`) that no card covers. Each item says whose step it is, first match: `delivering` when the todo is in `delivering`; `running` or `queued` from the existing `neoTodoPlace` (`lib/neo/todo-state.ts`); otherwise `neo` (rule 4: Neo unblocks it or asks again);
4. **recent results**: a todo `done` or `removed` in the last 7 days, shown once even if it had an answered card.

A todo covered by a card appears only under its card. Nothing unfinished can fall outside bucket 3. It returns `items` for the selected state and `counts`, a state × ask table, so each filter shows the numbers that follow the other's choice. Tests: running work with no card; a finished todo with an answered card (results, once); a card covering two todos (one item); a whole-ask card; an answered card still being delivered with its blocked todo (in progress, `delivering`) next to an uncovered blocked check todo (in progress, `neo`); a failed todo with no card (in progress, `neo`).

It reads only rows that exist. The Neo snapshot carries it next to the ask entries; `needsYou` stays and equals the waiting-on-you count. Web, phone and iPad render the same data.

## Clients

One rule everywhere:
- Two filter rows that are independent and can be used in either order: **state** (waiting on you, held, in progress, recent results) and **ask** (all, then each ask). The default is "waiting on you" and "all".
- Each row shows the choices that fit, and the rest under a final "More" menu. No horizontal scrolling.
- Items are grouped by ask. Each item says which todo it is about. The agree button is on the right; "Hold" offers: tomorrow, next week, until I come back, and drop this todo.

## Files

`lib/neo/inbox.ts` already exists and is the default "Inbox" project, so the projection gets its own name.

```
packages/shared/src/types/neo-ask.ts          NeoQuestion gains heldAt, heldUntil
packages/daemon/src/
  storage/schema/m513-neo-question-holds.ts   todo_id → todos copy; held_at, held_until
  storage/repositories/
    neo-ask-todo-repository.ts                QUESTION_SELECT reads todos only; hold write
    neo-stall-reminder-write.ts               opens the human-step card (rule 5)
  lib/neo/
    human-card.ts                             onlyCard per todo (rule 2)
    question-hold.ts                          new: pure planHold
    question-operations.ts                    neo.question.hold superpipe
    pack-sweep.ts                             clears expired holds
    daemon-cards.ts                           human-step card text
    human-queue.ts                            new: pure neoHumanQueue
    operations.ts                             adds it to the Neo snapshot
packages/web/src/neo/                         filter rows and items
```

The migration number is taken when its PR lands.

## Change plan

Each step is one PR within the repo's slice budget.
1. **Build: fold `todo_id` into `todos`.** A migration copies each `todo_id` into `todos` when missing. Readers switch to `todos`; writers keep filling `todo_id` too for one release, so a rolled-back daemon still reads every card. The column is dropped in a later PR, at least one release after. Tests: a card with only `todo_id` covers its todo after migration; every former reader gives the same answer; a card written by the new code is read correctly by the old `QUESTION_SELECT`.
2. **Build: one live card per todo.** `onlyCard` checks overlap of `todos` among open cards, held or not. Tests: two cards on different todos of one ask are both accepted; a second card on the same todo is refused; an ask-level card is never refused for this.
3. **Build + wire: held cards.** The `held_at` and `held_until` columns, `neo.question.hold`, and the sweep reopen. Tests: hold until a time reopens on the sweep after it; hold with no time stays held; a held card still covers its todos; answering a held card works.
4. **Build: `neoHumanQueue`** with its tests (state × ask counts, whole-ask cards, held items). **Wire:** add it to the Neo snapshot.
5. **Wire: clients.** Web first, then the phone app, each its own PR with light and dark screenshots at a wide and a phone width.
6. **Build: the human-step card** replaces the `check_overdue` card in the stall reminder sweep (rule 5). Old `check_overdue` rows stay readable. Tests: a check-only todo whose prerequisites are done gets its card at once; one that already has a card gets none; replay of a check-only todo that today waits 24 hours.
7. **Wire: the uncovered-blocker rule** (rule 4), after HyperNeo #10684 is merged and `todo.neo_step` is live. Tests: a retired card on a todo that keeps a start target wakes Neo once; an answered card awaiting delivery wakes nobody and resumes the todo.

## Limits

- Holding a card stops its todos until it reopens. "Drop this todo" is the way to stop the work for good.
- Asks are not cards. A whole-ask question is a card with no todos.
- The inbox is a view. It adds no new record of what the human was asked.
