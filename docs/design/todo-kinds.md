# A plan todo cannot end without its steps

Status: proposal, 2026-11-17. Design only. Paths without a prefix are under
`packages/daemon/src/lib/neo/`. Builds on the live-dependent rule of #11013.

## Why

A design or plan is finished only when the work it describes is filed and done. Today:

- A todo counts as producing more work only if Neo sets `producesFollowUp` on
  `neo.todo.add` (`todo-operations.ts`). If Neo forgets, nothing checks, and a design with
  four planned steps can end after step 1.
- The follow-up guard (`todo-follow-up.ts`) needs only one live dependent todo, however
  many steps the design described, and nobody checks that the filed steps match it.
- Cross-model review is one repository switch (`crossModelReview`). Turning it off for
  small fixes also turns it off for designs, which should always get it.

## The design

**One kind, `plan`.** A todo is a plan when Neo marks it so (the existing
`producesFollowUp`, called `plan` in the tool text, same column), or when a pack says so
through a new optional hook `NeoTodoPack.plan?(todo): Promise<boolean>` (`pack-contract.ts`),
read by the fact step; core never names a pack. The coding pack answers true when the
todo's PR changes `docs/design/**`. A plan cannot be marked done, and its ask cannot settle
`done`, until it:

1. **has steps:** at least one live todo that depends on it (`after`). A removed step is
   not live; a done step is;
2. **was checked:** a passing check, recorded on the plan, by a session other than its
   doer, listing exactly the current steps. The checker runs another model when one is
   usable; when the doer's model is the only usable one, another session on that model
   counts. A check stops counting when the steps change before the plan is done;
3. **was signed:** an answered sign-off card naming those steps.

Each item is needed: (1) is the bug; (2) is what catches steps that do not match the
design; (3) is the human's approval of the step list, which no existing record holds.

**Sign-off card.** `neo.question.ask` gains `signoff: true`: valid only on a plan, as a
one-option choice whose `todos` are exactly the plan's live steps; only choosing that
option signs. It is exempt from the existing link rule in `planNeoQuestion` (a todo card
needs `retireWhen` or a todo `check`) and from the check sweep that retires such cards
(`question-retirement.ts`): it retires only when answered or when the steps change. For
a design PR this card is the sign-off; the PR still merges the way the repository's
`humanSignoff` says (`packs/coding/human-signoff.ts`), and no merge gate is added.

**After a plan is done** its check and sign-off stay valid: a step added later is a normal
follow-up and needs no new sign-off. Only rule 1 still applies, through the last-step
guard below, so a done plan's ask can always settle.

**Check.** It is written by the daemon, never by Neo, into one new column
`neo_todos.plan_check_json`. In every pack, coding included, Neo starts the checker with
`work.start`, the plan's `todoId` and `checkPlan: true`. For such a start the daemon writes
the brief itself from the recorded plan: its instruction, done-when, artifacts and
evidence (the design itself), and the current steps with their titles and instructions;
Neo's message is added only as notes. The checker reports with `message.send` to Neo
carrying `check: { verdict, stepIds }`. The daemon records a pass only from a session that
got a `checkPlan` delivery for this plan whose step list matches `stepIds`, and that is not
its doer, with the checker's confirmed model and whether another model was usable:
`chooseLine` (`pack-selection.ts`) over the configured lines without the doer's model.

The coding pack's review stage, reviewer policy (`codingReviewerPolicy` and its four
callers), review-bot routing and merge checks are not touched: a design PR is reviewed and
merged exactly as today, and the plan check is a separate core check on the plan todo.
This is why the plan check works the same in a repository whose reviews go to a bot.

**Old todos.** The migration adds `plan_check_json TEXT` with no default and fills only that
new column with `{"legacy":true}` on existing rows in one `UPDATE`; no other data
changes. New rows get NULL without any insert change. A legacy todo keeps the old rule: one live dependent if it was marked
`producesFollowUp`, nothing otherwise. Legacy wins: the coding design-PR mark does not
make a legacy todo a plan.

**One pure function decides.** `neoPlanRefusal(facts)` in `todo-follow-up.ts` takes the
plan, its live steps, its check and its answered cards and returns the first unmet
requirement or null. It replaces `neoTodoFollowUpRefusal` and `neoTodoWithoutFollowUp` at
their call sites:

| Where | Refuses |
|---|---|
| `planNeoQuestion` (a `signoff` card) | steps not exactly the plan's live steps, or no steps, or no current check |
| `planNeoTodoDone`, the `done` input of `planNeoTodoEdit` | a plan missing any of the three |
| the runner's automatic done (`planNeoTodoCheck` and the pack judge, `todo-runner.ts`) | leaves the plan open with the unmet item as its reason and wakes Neo |
| `neo.ask.settle` (`ask-record-operations.ts`) | settling `done`; `dropped` stays allowed |
| the settle sweep (`service.ts`) and the follow-up wake (`packages/daemon/src/storage/repositories/neo-todo-session-repository.ts`) | the same: not settled `done`, Neo is woken |
| every removal in `todo-removal.ts` (`planNeoTodoRemoval`, including `dependents: 'remove'`, and `planNeoRemovedPrerequisiteAnswer`, the human's "Remove these"), and an `after` change in `planNeoTodoEdit` | any change that leaves a plan with no live step, unless a removed step's `replacedBy` is another live step of the plan |

Steps wait without new code: they depend on the plan, so they become ready when it is
done (`neoTodoReady` in `todo-dependencies.ts`).

`bun run system-map impact` on `todo-follow-up.ts`, `todo-operations.ts`,
`question-operations.ts` and `todo-runner.ts`: `neo.todo.done` and `neo.todo.remove` are
also called by the web todo controls (`packages/web/src/neo/todo-controls.ts`) and the
daemon's cards (`daemon-cards.ts`) through `todo-mutation-operation.ts`, so the same rule
covers them and the web shows the refusal.

## Change plan

Two PRs from `dev`, failing tests first; the second is a few lines.

1. **Core.** `neoPlanRefusal` and its fact step, the call sites above, the `todos.plan`
   hook, `signoff` cards, `checkPlan` starts with the daemon-written brief, the `check`
   report and its recording, the column, tool text.
2. **Coding.** `todos.plan` returns true when the todo's PR changes `docs/design/**`,
   read from the PR facts the pack already has. Nothing else in the pack changes.

## Acceptance

One integration case per row. "One usable model" means a fixture whose configured model
lines resolve to a single model.

| Case | Expected |
|---|---|
| a plan with no steps asks for sign-off | refused: steps missing |
| steps filed, no check, sign-off asked | refused: check missing |
| checked and signed, then a step removed | refused until checked and signed again |
| re-signed after the step change | the card names the new steps; the plan can be done |
| check from the plan's own session, from a session with no `checkPlan` delivery, or with steps other than those it was given | not recorded |
| a `checkPlan` start | the brief carries the plan's instruction, artifacts and steps whatever Neo's message says |
| check on the doer's model while another model is usable | not accepted |
| check on the doer's model, one usable model | accepted |
| a reply, or a card without `signoff`, on a plan | does not sign it |
| plan signed and done | its steps become ready |
| all steps done | the plan still has its steps; the ask settles |
| the last live step removed without `replacedBy`, or edited off the plan's `after` | refused |
| an abandoned plan's ask settled `dropped` | allowed |
| a design PR in a repository whose reviews go to a bot, `crossModelReview` off | the PR is reviewed and merged as today; the plan stays open until a checker worker on another model reports a pass and the human signs |
| the same, one usable model | a checker on another session of that model counts |
| the last live step removed with `replacedBy` pointing at a todo that is not a step of the plan | refused |
| the last live step removed by a cascading removal or a "Remove these" answer | refused |
| a todo that existed before the upgrade, including an open design PR todo | reads legacy; old rule only |
| a sign-off card whose plan's check already passes | stays open until answered |
| a step added after the plan is done | no new check or sign-off; the ask settles |
| a todo that is not a plan | unchanged |
