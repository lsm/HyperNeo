# Only Neo asks the human

Status: proposal, 2026-11-16. Design only. Changes `neo-todo-minimal.md` (the section
"Cards the daemon opens" and rules 4, 5 and 7) and builds on `neo-attention.md`.
Paths without a prefix are under `packages/daemon/src/lib/neo/`.

## Why

`neo-todo-minimal.md` set one rule: a todo waits on the human exactly when an open card
covers it. To keep that rule true, the daemon opens a card by itself whenever a todo has
no worker and no card. It decides from code alone, without the conversation, that the
step belongs to the human.

That guess is usually wrong. A todo with no worker is mostly waiting on something else:
a merge, a deploy, Neo reading an answer, or Neo writing its own card. In one week of real
use the daemon opened 103 cards of its own, and the human answered 17 of them. 75 were
retired unanswered because the situation resolved without the human: 34 of 35
"could not start" cards and 16 of 24 "prerequisite removed" cards among them.

Two traces show the cause:

- The human answers Neo's card about merging a design. Thirty seconds later the daemon
  opens "X is yours to do now. Do it, then mark it done, or remove it?" about the same
  todo. The todo waits on review and merge, not on the human. It looked like a human
  step only because it has a check and no instruction (`humanStep` in `daemon-cards.ts`).
- Neo adds a todo, then sends its card. The daemon looks in between, sees no card, and
  opens its own three seconds before Neo's.

The cards are also hard to act on. They show a todo title and a mechanical choice ("Mark
done", "Remove"), not the decision the human is being asked to make.

Meanwhile `neo-attention.md` already gives every open todo one owner of its next step
(`nextStepOwner` in `attention/owner.ts`) and wakes Neo when that owner is Neo. The two
mechanisms answer the same question differently, and both run.

## The rule

Whose call a step is:

1. **The human already approved it** (said so, answered a card, or set a preference that
   covers it): it runs. Nobody asks again.
2. **The human did not**: Neo decides. Neo has the conversation, the human's preferences
   and the history, so it can tell whether earlier words cover this step.
3. **Neo cannot tell**: Neo asks the human with a card it writes itself.

The daemon never decides that a step is the human's. It only makes sure nothing stops
silently: when a step is nobody's to move, it wakes Neo, not the human.

## The mechanism

**Cards come from Neo only.** The daemon stops opening cards. These go:

| Daemon card today | Becomes |
|---|---|
| worker blocker left unanswered (`worker_blocker`) | `todo.neo_step`, reason `unanswered` (exists) |
| start failed after the automatic retries (`retries_exhausted`) | `todo.neo_step`, reason `failed` (exists) |
| human step (`human_step`) and its 24 h predecessor (`check_overdue`) | the check row below |
| prerequisite removed (`removed_prerequisite`) | `todo.neo_step`, reason `prerequisite_gone` (exists) |
| Neo's hold or pause (`hold`, `pause`) | the hold row below |

The automatic retries themselves stay (`NEO_AUTOMATIC_RETRIES`): the daemon still retries
a failed start twice before it is Neo's.

**Two owner rows change in `nextStepOwner`.** Both use facts the daemon already has.

| Facts | Owner today | Owner after |
|---|---|---|
| The todo has a check, no instruction, and the check deadline has not passed | `neo` (`no_worker`) | `daemon`: it polls the check |
| The same, after the deadline (24 h, `NEO_CHECK_DEADLINE_MS`) | `neo` | `neo`, reason `check_overdue` |
| Neo holds the todo (`neo.todo.hold`) | `nobody` (and a card) | `nobody` until the hold's time, then `neo`, reason `hold_ended` |

`neo.todo.hold` takes an optional `until` (default 24 h) and opens no card. When Neo holds
a step because it needs the human, it writes its own card about it, and that card covers
the todo as any card does.

A human's own hold on a card (`neo.question.hold`, `neo-inbox.md`) is unchanged: the human
did it, so nothing wakes anyone about it.

**Neo's card is written for the human.** Its text names the decision, why it is the
human's, and what each answer does. Its options are the decision itself ("Merge", "Not
yet"), not todo operations. It is written in the language the human uses with Neo, which
is an ordinary preference and is never forced on Neo's other conversations. Worker
questions that need the human reach them the same way: Neo relays them in a card.

**When Neo itself cannot run.** The rule needs Neo. If Neo's own session cannot take a
turn (a resume error, a stalled session), the daemon tells the human directly, as the
resume card does today. That is the one case the daemon speaks to the human, and it is
about Neo, never about a todo.

## What stays

- A card covering a todo still means that todo waits on the human (`neo-todo-minimal.md`).
- `todo.neo_step` and its ladder (1 h, 4 h, 24 h, then every 24 h) stay as built.
- Packs keep their own `waiting` answer: the coding pack's merge sweep merges a ready PR by
  itself, and its stalled merges reach Neo through the attention entry.

## Change plan

Each slice is one PR from `dev`, about 100 to 200 production lines, failing tests first.

1. **Owner rows.** Add the check and hold rows to `nextStepOwner`, with `until` on
   `neo.todo.hold`. Tests: a check-only todo before and after its deadline, a held todo
   before and after `until`.
2. **Stop the daemon cards.** Delete the card writers (`neo-daemon-card-write.ts`, the
   human-step part of `neo-stall-reminder-write.ts`, the removed-prerequisite card in
   `neo-todo-mutation-commit.ts`, the card in `planNeoHoldCard`) and their status codes.
   Open daemon cards are retired with reason `neo decides`, which leaves their todos to
   `nextStepOwner`, so each one reaches Neo once. Test: each former trigger produces one
   `todo.neo_step` wake and no card.
3. **Neo's guidance.** One prompt paragraph: the rule above, how to write a card for the
   human, and that `todo.neo_step` wakes are Neo's to resolve.

Deleting the `blocked` state that `neo-todo-minimal.md` already removes is not in this
design. It is still used in about 140 lines and needs its own plan.

## Risks

- **Neo misjudges approval.** Rule 2 lets Neo run a step the human did not approve. Neo
  asks when unsure, and the human can still hold or stop any card or todo.
- **More Neo turns.** Each former daemon card becomes a Neo wake. The ladder bounds the
  repeats, and in the week above most of those situations resolved on their own before
  the first rung.
- **A silent Neo.** If Neo ignores its wakes, the step waits. The ladder keeps waking it
  every 24 h, and a Neo that cannot run reaches the human directly.
