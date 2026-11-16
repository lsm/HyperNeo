# Only Neo asks the human

Status: proposal, 2026-11-16. Design only. Changes `neo-todo-minimal.md` (the section
"Cards the daemon opens" and rules 4, 5, 6 and 7) and `neo-inbox.md` (rule 5) and builds on `neo-attention.md`.
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

1. **The human already authorized it** (said so, answered a card, or set a preference
   that covers it): it runs. Nobody asks again.
2. **Otherwise Neo decides whether existing authority covers it.** Neo has the
   conversation, the human's preferences and the history, so it can tell whether earlier
   words already cover this step.
3. **When the step needs new authority from the human**, or Neo cannot tell, Neo asks with
   a card it writes itself.

The daemon never decides that a step is the human's. It only makes sure nothing stops
silently: when a step is nobody's to move, it wakes Neo, not the human.

## The mechanism

**Human cards come from Neo only.** These writers stop opening cards:

| Writer today | Card | Becomes |
|---|---|---|
| `packages/daemon/src/storage/repositories/neo-daemon-card-write.ts` | worker blocker left unanswered (`worker_blocker`) | `todo.neo_step`, reason `unanswered` (exists) |
| `packages/daemon/src/storage/repositories/neo-daemon-card-write.ts` | start failed after the automatic retries (`retries_exhausted`) | `todo.neo_step`, reason `failed` (exists) |
| `packages/daemon/src/storage/repositories/neo-stall-reminder-write.ts` | human step (`human_step`, which replaced `check_overdue`) | the check rows below |
| `packages/daemon/src/storage/repositories/neo-todo-mutation-commit.ts` | prerequisite removed (`removed_prerequisite`) | `todo.neo_step`, reason `prerequisite_gone` (exists) |

The automatic retries stay (`NEO_AUTOMATIC_RETRIES`): the daemon still retries a failed
start twice before the step is Neo's. When they run out, the todo's write to `blocked` /
`failure` stays: today it happens inside `openRetriesCard`, so slice 2 keeps that write and
drops only the card. That state is what makes `nextStepOwner` return `failed`.

**A worker's question already goes through Neo, and stays as it is.** The daemon stages
the worker's question on its todo and tells Neo. Its card opens only when Neo calls
`neo.question.ask` with `kind: 'relay'` (role `neo`), with Neo's own title and options;
that reaches `relayWorkerQuestion` and then `createNeoWorkerQuestionWriter`
(`question-operations.ts`, `service.ts`). No other caller reaches that writer, so it is
Neo's decision already, and the answer still reaches the worker by the card's source
session.

**Neo's hold stays a card, written by Neo.** `neo.todo.hold` is Neo asking the human to
decide whether a step goes ahead, so it keeps its card and its stop of a running worker.
What changes is the text: Neo passes the question in its own words instead of a reason
pasted into the daemon template ("X is on hold: … Start it, or remove it?"). The options
stay Start (Resume) and Remove, since the daemon applies them. Nothing new is stored: the
open card is the hold, as today, and it survives a restart because it is a card.

**Two owner rows are added to `nextStepOwner`,** both from facts the daemon has:

| Facts | Owner today | Owner after |
|---|---|---|
| A check, no instruction, and its deadline (24 h from the later of creation and the last prerequisite finishing, `NEO_CHECK_DEADLINE_MS`) has not passed | `neo` (`no_worker`) | `daemon`: it polls the check |
| The same, after the deadline | `neo` (`no_worker`) | `neo`, reason `check_overdue`, `since` = the deadline |

`decideNeoAttention` renders the new reason as "its check has not passed for 24 hours.
Ask whoever it waits on, mark it done, or remove it."
If the wait is still right, Neo does nothing: the ladder reminds it again in 24 hours. No
new timed-wait state is added.

**When Neo is woken.** As built (`decideNeoAttention`), a `todo.neo_step` wakes Neo at
once when Neo becomes the owner, then again at 1 h, 4 h and 24 h after its `since`, then
every 24 h while Neo still owns it. `since` is the reason's own time, as `nextStepOwner`
computes it today; for `check_overdue` it is the deadline.

**Human holds win.** A card the human held (`heldAt`, `neo-inbox.md`) is the human's
decision to wait. It still covers its todos, so they belong to the human and nothing wakes
Neo about them.

**Neo's cards are written for the human.** The text names the decision, why it needs the
human, and what each answer does. The options are the decision ("Merge", "Not yet"), not
todo operations. They are written in the language the human uses with Neo. That is an
ordinary preference that follows the conversation; it is never forced on Neo's other
conversations or on workers.

**When Neo itself cannot run.** The rule needs Neo. If Neo's own session cannot take a
turn (a resume error, a stalled session), the daemon tells the human directly, as the
resume card does today. For todos and work, that is the one case the daemon speaks to
the human, and it is about Neo, never about a todo.

**Out of scope.** Cards that are not about todos keep their current path: the home-sync
conflict card (`reportHomeConflict`, `home/conflicts.ts`), and the proposal cards that Neo
opens through an operation (rules, preferences, and the coding pack's GitHub home). A
later design can apply the same rule to them.

## What stays

- A card covering a todo still means that todo waits on the human (`neo-todo-minimal.md`).
- `todo.neo_step` and its ladder stay as built.
- Packs keep their own `waiting` answer: the coding pack's merge sweep merges a ready PR by
  itself, and its stalled merges reach Neo through the attention entry.

## Existing open cards

Slice 2 deploys with daemon cards still open. Each keeps working as it is:

- An open daemon card is left open. Its answer is applied as today
  (`neoDaemonCardChoice`), so a human who was about to answer loses nothing, and its todos
  stay the human's while it is open.
- A held one stays held, with no wake.
- When one closes, the sweep recomputes each todo's owner. Only a live todo still owned
  by Neo raises `todo.neo_step`, at the rung its existing `since` has reached (the same
  dedup applies), then at later rungs. A todo the answer marked done or removed, one whose
  worker resumed, and one another open card still covers raise nothing.

The answer path for daemon causes is deleted in a later cleanup, once no such card is
open.

## Change plan

Each slice is one PR from `dev` (the repository's default and target branch), about 100
to 200 production lines, failing tests first.

1. **Owner rows.** The two check rows and the `check_overdue` render.
2. **Stop the cards.** Stop the four cards in the table above and the daemon template
   from `neo.todo.hold`, which takes Neo's question text. Keep the answer path for open
   daemon cards.
3. **Neo's guidance.** One prompt paragraph: the rule above, how to write a card for the
   human, and that `todo.neo_step` wakes are Neo's to
   resolve.

Acceptance, as tests on the pure functions and one integration case per row:

| Case | Expected |
|---|---|
| A worker sends a question envelope | staged, Neo told, no card until Neo relays it (unchanged) |
| Each former daemon-card trigger (blocker, retries, removed prerequisite) | no card; owner `neo` with the matching reason |
| Check-only todo before / after its deadline | `daemon` / `neo` `check_overdue`, Neo woken when the deadline passes, then on the ladder |
| Neo holds a todo | one card with Neo's text; a running worker stops; after a restart the card still holds it |
| An open daemon card at deploy | stays open, its answer still applies; after it closes, only a todo still owned by Neo wakes it; done, removed, resumed or still-covered todos do not |
| A human-held card | no wake while held |
| Repeated sweeps with nothing changed | one wake per rung, never two for the same rung |

Deleting the `blocked` state that `neo-todo-minimal.md` already removes is not in this
design. It is still used in about 140 lines and needs its own plan.

## Risks

- **Neo misjudges authority.** Rule 2 lets Neo run a step it believes earlier words
  cover. Neo asks when a step needs new authority or it cannot tell, and the human can
  still hold or stop any card or todo.
- **More Neo turns.** Each former daemon card becomes a Neo wake. The ladder bounds the
  repeats, and in the week above most of those situations resolved on their own before
  the first rung.
- **A silent Neo.** If Neo ignores its wakes, the step waits. The ladder keeps waking it
  every 24 h, and a Neo that cannot run reaches the human directly.
