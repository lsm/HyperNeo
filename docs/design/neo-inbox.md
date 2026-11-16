# Neo inbox: everything that waits on the human, in one place

Checked against dev 0511903008.

## Summary

An ask is an epic: one goal, split into todos that may run in parallel. A card is a question to the human. Today a card hangs on the ask: one open card per ask, so a second question about a different todo is refused, or arrives only after the first is answered. A human step (a todo only the human can do: it has a check but no instruction and no worker) gets its first card only after 24 hours, and that card asks "waited 24 hours, keep waiting?" instead of asking the human to do the step. The clients get each ask's open cards inside its ask entry, but no single list across asks, no way to put a card aside, and a count of asks rather than questions.

This design makes the inbox a small core subsystem:
- A card is a question about one or more todos (or the whole ask). An ask and a todo can hold any number of cards, like comments on an issue; each card stops only the todos it is about.
- A card is open, held (the human put it aside until a time, or until they come back to it), answered or retired.
- A human step gets its own card as soon as it can start, asking the human to do it. The "keep waiting?" card goes away.
- One pure projection, `neoHumanQueue`, gives the clients every item that waits on the human, with two independent filters: state and ask.

## What exists

- Cards are rows of `neo_questions`. States are `open | answered | retired` (`NeoQuestionState`, `packages/shared/src/types/neo-ask.ts`).
- A card names its todos twice, and every question read selects both (`QUESTION_SELECT`, `neo-ask-todo-repository.ts`). `todos` (a JSON list) is what coverage reads: `neoQuestionCoversTodo` (`lib/neo/todo-state.ts`). `todo_id` (one id) is written by Neo's own cards, worker-blocker cards (`neo-daemon-card-write.ts`) and hold cards (`planNeoHoldCard`, `daemon-cards.ts`), always together with `todos`, and read in about eight places (`human-card.ts`, `question-operations.ts`, `todo-start-gate.ts`, `todo-operations.ts`, `service.ts`).
- A card written without `todos` or `todo_id` gets `todos` filled at write time with the ask's todos that have not started or are blocked on `question` (`neoAskQuestionHolds`, in `askQuestion`, `neo-ask-todo-repository.ts`). `neo.question.ask` has no `todos` input, so this is how every ask-level card Neo writes stops work.
- `onlyCard` in `lib/neo/human-card.ts` refuses a new card while any card with a todo or `retireWhen` is open on the same ask (`card_open`).
- The stall reminder sweep (`neoStallReminderWrite`, `storage/repositories/neo-stall-reminder-write.ts`) opens a `check_overdue` card for a todo in state `todo` with a check, no instruction and no session (`listCheckable`, `neo-ask-todo-repository.ts`), once it is 24 hours old and no open card covers it (`neoCheckOverdue`, `lib/neo/daemon-cards.ts`). That is a human step, and this card is its first card. The card then blocks the todo on `question`.
- `planNeoBlockCards` in `lib/neo/block-cards.ts` plans a card for a todo blocked on `needs-human`, but nothing calls it yet; today such cards come from the worker-blocker path. So blocked todos with no card exist (rule 4).
- `neoWorkCounts` in `lib/neo/ask-entries.ts` sends `needsYou`: the number of asks with an open card or a waiting todo. Cards travel inside each ask entry.
- A reply card must ask something (`asksSomething`, `human-card.ts`). Status lines from workers are refused as cards.

## The model

| Thing | Is | Like |
|---|---|---|
| ask | one goal | an epic |
| todo | one piece of it, with dependencies | a sub-issue |
| card | a question to the human about some todos, or about the whole ask | a comment that mentions the human |

Rules, all pure and in core (`lib/neo/human-card.ts`, `lib/neo/human-queue.ts`):
1. **Facts once.** Coverage already reads only `todos` (`neoQuestionCoversTodo`), and it lists exactly the todos the card stops. `todo_id` stays as it is; this design adds no reader of it.
2. **No limit on cards.** Neo may ask as many questions as it has, about the same todo or different ones. The `card_open` refusal in `onlyCard` is removed; `replaces` still lets Neo replace its own card. A todo stays stopped while any open card covers it, and starts when the last one is answered or retired. An ask-level card (written without todos) keeps today's backfill unchanged.
3. **A card stops only its todos.** Other todos of the ask keep running. The start gate already holds only the todos a card lists (`todo-start-gate.ts`); the per-ask limit was the only coupling.
4. **A blocked todo with no card is Neo's.** A todo blocked on `question` or `needs-human` that no open card covers is handled by the next-step owner table of the attention design (`docs/design/neo-attention.md`): the daemon while an answer is still being delivered, otherwise Neo, which `todo.neo_step` wakes. Nothing is added here for it.
5. **A human step gets its card when it can start.** A todo with a check, no instruction and no worker is a human step. When its prerequisites are done, the daemon opens one card asking the human to do it, with "done" and "remove". Putting it aside is the ordinary card hold below, which every card has; it changes no todo. This takes the place of the `check_overdue` card: same producer (the stall reminder sweep), but the selection changes in two ways. Today `listCheckable` picks a check-only `todo` by age alone, with no readiness condition; the new selection drops the 24-hour age and adds that the todo's prerequisites are finished (`neoTodoReady`, `todo-dependencies.ts`). And the card asks for the step instead of "keep waiting?". Existing open `check_overdue` cards stay until answered.

## Held cards

A held card is an open card with a hold, so old readers still see it as open and no state value is added. Two new nullable columns on `neo_questions`: `held_at` and `held_until` (empty means "until I come back").

`neo.question.hold {questionId, until?, requestId}` is one superpipe operation:
1. read the card; refuse unless it is open;
2. pure `planHold(card, until, now)`;
3. one transaction: set `held_at` and `held_until`.

The existing 5-minute pack sweep (`pack-sweep.ts`) clears the hold when `held_until` has passed. Opening a held card from the inbox clears it at once. A held card still covers its todos, so they stay stopped, and the attention subsystem treats it like any open card: no reminders. Answering and retiring work as before and clear the hold.

## The inbox projection

`neoHumanQueue({questions, asks, todos, owners, now})` is pure. `owners` is `nextStepOwner` for each unfinished todo, read once by the caller. Each todo and each card lands in exactly one state bucket, first match wins:
1. **waiting on you**: an open card without a hold (one item per card, with the titles of its todos, or "the whole ask");
2. **held**: an open card with a hold;
3. **in progress**: every other todo in `todo`, `doing`, `blocked` or `failed` that no card covers. Each item says whose step it is, from the attention design's `nextStepOwner` (`lib/neo/attention/owner.ts`), so the inbox and Neo's wakes always agree;
4. **recent results**: a todo that ended in the last 7 days, by `finishedAt`, shown once even if it had an answered card: `done`; `closed_unverified` after it started (closed, check not passed); `removed`, or `closed_unverified` before it started (both count as cancelled, as in `neoTodoCancelledDependencies`).

A todo covered by cards appears only under its cards. Every todo state lands in bucket 3 or 4, so nothing falls outside. It returns `items` for the selected state and `counts`, a state × ask table, so each filter shows the numbers that follow the other's choice. Tests: running work with no card; a finished todo with an answered card (results, once); a card covering two todos (one item); two open cards on the same todo (two items; the todo appears under both); an ask-level card; an uncovered blocked todo (in progress, with the owner `nextStepOwner` gives); `closed_unverified` with and without `startedAt` (results).

It reads only rows that exist. The Neo snapshot carries it next to the ask entries; `needsYou` keeps its meaning, a number of asks: the asks with at least one waiting-on-you item. `neoWorkCounts` stops counting held cards, so a held card no longer raises it. Web, phone and iPad render the same data.

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
  storage/schema/mNNN-neo-question-holds.ts   held_at, held_until
  storage/repositories/
    neo-ask-todo-repository.ts                hold write
    neo-stall-reminder-write.ts               opens the human-step card (rule 5)
  lib/neo/
    human-card.ts                             no card_open refusal (rule 2)
    question-hold.ts                          new: pure planHold
packages/shared/src/types/operation-names/neo.ts   registers neo.question.hold
.claude/skills/verify/                        worker-question-storage journey: a second card is accepted
    question-operations.ts                    neo.question.hold superpipe; todoId description without the one-card limit
    pack-sweep.ts                             clears expired holds
    daemon-cards.ts                           human-step card text
    human-queue.ts                            new: pure neoHumanQueue
    operations.ts                             adds it to the Neo snapshot
packages/web/src/neo/                         filter rows and items
api-surface.json                              regenerated for the description change
```

The migration number is taken when its PR lands.

## Change plan

Each step is one PR within the repo's slice budget.
1. **Build: no limit on cards.** Remove the `card_open` refusal from `onlyCard`, and in the same PR the agent-facing sentence that states it: the `todoId` description of `neo.question.ask` (`question-operations.ts`, "One card may be open per ask; a second returns card_open"), with `api-surface.json` regenerated, and the verify journey that asserts the old refusal (`worker-question-storage.ts` and `journeys/worker-question-storage.md` in `.claude/skills/verify/`) changed to expect the second card accepted and both open. The other `card_open`, which refuses settling an ask while a card is open (`neo-ask-settlement.ts`), stays. Tests: a second and a third card on the same todo are accepted; the todo starts only after the last one is answered; `replaces` still replaces.
2. **Build + wire: held cards.** The `held_at` and `held_until` columns, `neo.question.hold` (registered in `operation-names/neo.ts`), and the sweep reopen. Tests: hold until a time reopens on the sweep after it; hold with no time stays held; a held card still covers its todos; answering a held card works.
3. **Build: `neoHumanQueue`** with its tests (state × ask counts, several cards on one todo, ask-level cards, held items), after attention step 1 has added `nextStepOwner`. **Wire:** add it to the Neo snapshot.
4. **Wire: clients.** Web first, then the phone app, each its own PR with light and dark screenshots at a wide and a phone width.
5. **Build: the human-step card** replaces the `check_overdue` card in the stall reminder sweep (rule 5). Old `check_overdue` rows stay readable. Tests: a check-only todo whose prerequisites are done gets its card at once; one whose prerequisites are unfinished gets none; one that already has a card gets none; replay of a check-only todo that today waits 24 hours.

## Limits

- Holding a card stops its todos until it reopens. "Drop this todo" is the way to stop the work for good.
- Asks are not cards. An ask-level question is a card written without todos; it stops the ask's waiting todos.
- The inbox is a view. It adds no new record of what the human was asked.
