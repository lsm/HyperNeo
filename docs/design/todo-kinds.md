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
`producesFollowUp`, called `plan` in the tool text, same column), or, in coding, when its
PR changes `docs/design/**`. A plan cannot be marked done, and its ask cannot settle
`done`, until it:

1. **has steps:** at least one live todo that depends on it (`after`). A removed step is
   not live; a done step is;
2. **was checked:** a passing check, recorded on the plan, by a session other than its
   doer, listing exactly the current steps. The checker runs another model when one is
   usable; when the doer's model is the only usable one, another session on that model
   counts. A check stops counting when the steps change;
3. **was signed:** an answered sign-off card naming those steps.

Each item is needed: (1) is the bug; (2) is what catches steps that do not match the
design; (3) is the human's approval of the step list, which no existing record holds.

**Sign-off card.** `neo.question.ask` gains `signoff: true`: valid only on a plan, as a
one-option choice whose `todos` are exactly the plan's live steps; only choosing that
option signs. It meets the existing link rule in `planNeoQuestion` (a todo card needs
`retireWhen` or a todo `check`): it retires when answered or when the steps change. For
a design PR this card is the sign-off; the PR still merges the way the repository's
`humanSignoff` says (`packs/coding/human-signoff.ts`), and no merge gate is added.

**Check.** It is written by the daemon, never by Neo, into one new column
`neo_todos.checked_json`:

- In coding, a passing `neo.coding.result` from the review stage on a plan writes it,
  with the step ids from the review brief and the reviewer's confirmed model. The review
  brief (`packs/coding/assign-operation.ts`) lists the steps and asks the reviewer to
  compare them with the design's change plan; a missing or extra step is a finding.
- Elsewhere, the checker is a worker Neo started with `work.start` and the plan's
  `todoId` (recorded in `work_delivery_inputs`); it reports with `message.send` to Neo
  carrying `check: { verdict, stepIds }`. The daemon records a pass only from a session
  that got a delivery for this plan and is not its doer.
- Either way the record holds whether another model was usable: `chooseLine`
  (`pack-selection.ts`) over the configured lines without the doer's model.

For plans the coding review stage runs whatever `crossModelReview` says, and
`codingReviewerPolicy` (`packs/coding/stage-facts.ts`, which refuses a same-model reviewer
today) takes that availability fact, so the single-model case is allowed.

**Old todos.** The migration adds `checked_json TEXT DEFAULT '{"legacy":true}'`, so every
existing row reads legacy with no rewrite; the todo insert
(`packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts`) writes NULL for new
rows. A legacy todo keeps the old rule: one live dependent if it was marked
`producesFollowUp`, nothing otherwise.

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
| `planNeoTodoRemove`, and an `after` change in `planNeoTodoEdit` | removing a plan's last live step without `replacedBy`, or taking the plan out of its last live step's `after` |

Steps wait without new code: they depend on the plan, so they become ready when it is
done (`neoTodoReady` in `todo-dependencies.ts`).

`bun run system-map impact` on `todo-follow-up.ts`, `todo-operations.ts`,
`question-operations.ts`, `todo-runner.ts` and `packs/coding/stage-facts.ts`: `neo.todo.done`
and `neo.todo.remove` are also called by the web todo controls
(`packages/web/src/neo/todo-controls.ts`) and the daemon's cards (`daemon-cards.ts`)
through `todo-mutation-operation.ts`, so the same rule covers them and the web shows the
refusal. `stage-facts.ts` has 12 importers in the coding pack; only `codingReviewerPolicy`'s
inputs change.

## Change plan

Two PRs from `dev`, failing tests first.

1. **Core.** `neoPlanRefusal` and its fact step, the call sites above, `signoff` cards,
   the `check` report and its recording, the column, tool text.
2. **Coding.** Design PRs are plans, the review brief, `checked_json` from
   `neo.coding.result`, the review stage for plans regardless of `crossModelReview`, the
   availability fact in `codingReviewerPolicy`.

## Acceptance

One integration case per row. "One usable model" means a fixture whose configured model
lines resolve to a single model.

| Case | Expected |
|---|---|
| a plan with no steps asks for sign-off | refused: steps missing |
| steps filed, no check, sign-off asked | refused: check missing |
| checked and signed, then a step removed | refused until checked and signed again |
| re-signed after the step change | the card names the new steps; the plan can be done |
| check from the plan's own session, or from a session with no delivery for it | not recorded |
| check on the doer's model while another model is usable | not accepted |
| check on the doer's model, one usable model | accepted |
| a reply, or a card without `signoff`, on a plan | does not sign it |
| plan signed and done | its steps become ready |
| all steps done | the plan still has its steps; the ask settles |
| the last live step removed without `replacedBy`, or edited off the plan's `after` | refused |
| an abandoned plan's ask settled `dropped` | allowed |
| a repository with `crossModelReview` off, a design PR | a review stage runs and its pass writes `checked_json` with a reviewer model other than the author's |
| the same, one usable model | the review runs on another session of that model and counts |
| a todo that existed before the upgrade | reads legacy; old rule only |
| a todo that is not a plan | unchanged |
