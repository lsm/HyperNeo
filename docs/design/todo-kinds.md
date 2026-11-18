# A plan todo cannot end without its steps

Status: proposal, 2026-11-17. Design only. Paths without a prefix are under
`packages/daemon/src/lib/neo/`.

## Why

A design or plan is finished only when the work it describes is filed and done. Today:

- A todo counts as producing more work only if Neo sets `producesFollowUp` on
  `neo.todo.add` (`todo-operations.ts`). If Neo forgets, nothing checks, and a design with
  four planned steps can end after step 1.
- The follow-up guard (`todo-follow-up.ts`) needs only one live dependent todo, however
  many steps the design described, and nothing checks that the filed steps match it.
- Review requirements are per repository (`neo_pack_preferences`). Turning cross-model
  review off for small fixes also turns it off for designs.

## The design

**One kind, `plan`, with three requirements.** A todo is a plan when Neo marks it so (the
existing `producesFollowUp`, renamed `plan` in the tool text and kept in the same column)
or when a pack marks it from its own facts. A plan:

1. **has steps:** at least one live todo that depends on it (`after`). Live means not
   removed; a done step is live, so a plan whose steps are all done still has them;
2. **was checked:** a passing check, recorded on the plan, by a session that is not its
   doer, listing exactly the current steps. The checker runs another model when the human
   has one available; when only the doer's model is usable, another session on the same
   model counts;
3. **was signed:** a sign-off card on it, naming those steps, that the human approved.

**The sign-off card.** `neo.question.ask` gains `signoff: true`. It is valid only on a
plan, only as a one-option choice (the option approves; Reply stays for anything else),
and its `todos` must be exactly the plan's live steps. Only an answer choosing that option
signs the plan. A `signoff` card satisfies the existing link rule in `planNeoQuestion`
(a todo card needs `retireWhen` or a todo `check`): it retires when answered, or when the
plan's steps change, which asks for a new one. Other cards on a plan, such as an early
blocking question, are unchanged.

**The check is recorded by the daemon from the checker's report.** In any pack, Neo
checks a plan by starting another worker session with `work.start` and the plan's
`todoId`, giving it the plan and its steps. The daemon already records that delivery with
the todo id and the session it reached (`work_delivery_inputs`). The checker reports
through the existing worker report (`message.send` to Neo) with an optional
`check: { verdict, stepIds }`. The daemon writes a pass into one new nullable column
`neo_todos.checked_json` only when the sender is a session that received a delivery for
this plan's todo and is not its doer. It records the checker's confirmed model from its
work status, and whether another model was available then: `chooseLine`
(`pack-selection.ts`) over the configured lines without the doer's model returns a usable
line. Neo cannot write the check. For coding, a passing `neo.coding.result` on a plan
writes the same column, anchored by the pack's own stage assignment.
A check stops counting when the steps change.

**Todos already done.** The migration that adds `checked_json` writes `{"legacy": true}`
on every todo that is already done, plan or not, in plain SQL. `neoPlanRefusal` holds a
legacy todo only to the old rule (one live dependent when it was marked
`producesFollowUp`, nothing otherwise), so no pack facts are needed at migration time. Plans not yet done get no marker and follow the
new rule; Neo checks and signs them as above.

**One pure function decides.** `neoPlanRefusal(facts)` in `todo-follow-up.ts` takes the
plan, its live steps, its check and its answered cards, and returns the first unmet
requirement or null. A fact step reads those; the function is the only rule. It replaces
`neoTodoFollowUpRefusal` and `neoTodoWithoutFollowUp` at their call sites:

| Where | Refuses |
|---|---|
| `planNeoQuestion` (a `signoff` card) | a card that does not name exactly the plan's live steps, or a plan with no steps or no current check |
| `planNeoTodoDone` and the `done` input of `planNeoTodoEdit` | a plan missing any of the three |
| the runner's automatic done (`planNeoTodoCheck` and the pack judge in `todo-runner.ts`) | it does not mark such a plan done; the plan stays open with the unmet requirement as its reason, and Neo is woken |
| the `neo.ask.settle` superpipe (`ask-record-operations.ts`) | settling `done` an ask with a plan missing any of the three; settling `dropped` stays allowed, as today |
| the automatic settle sweep (`service.ts`, which feeds `neo.ask.turned-settle`) and the follow-up wake (`packages/daemon/src/storage/repositories/neo-todo-session-repository.ts`) | the same: such an ask is not settled `done`, and Neo is woken |
| `planNeoTodoRemove` | removing a plan's last live step without `replacedBy` |

Steps wait without new code: they depend on the plan, so they start when it is done
(`neoTodoReady` in `todo-dependencies.ts`).

**Coding marks and checks.**

- A todo whose PR changes `docs/design/**` is a plan, read from the PR facts the pack
  already has.
- The review brief (`packs/coding/assign-operation.ts`) lists the plan's steps and asks the
  reviewer to compare them with the design's change plan; a missing, extra or misordered
  step is a finding. A passing `neo.coding.result` on a plan writes `checked_json` with those
  step ids, the reviewer's confirmed model and the same `chooseLine` availability fact, so
  `neoPlanRefusal` judges coding checks by the same rule.
- For a plan, the reviewer may run the author's model when no other model is usable: the
  same availability fact is passed to `codingReviewerPolicy` and the review assignment
  (`assign-operation.ts`), which today refuse a same-model reviewer outright.
- A plan is always reviewed, even when the repository's `crossModelReview` is off, and
  the daemon does not merge a plan's PR until `neoPlanRefusal` passes: steps, check and
  sign-off come before the merge (`packs/coding/daemon-merge-gates.ts`).

Other packs mark plans the same way when they need to.

## Change plan

Each slice is one PR from `dev`, failing tests first.

1. **Core.** `neoPlanRefusal` and its fact step, the call sites above, the `check` field
   on the worker report and its recording, the legacy migration, tool text.
2. **Coding.** Mark design PRs as plans, the review brief, `checked_json` from
   `neo.coding.result`, review regardless of `crossModelReview` for plans.

`bun run system-map impact` on `todo-follow-up.ts`, `todo-operations.ts`,
`question-operations.ts`, `todo-runner.ts` and `packs/coding/stage-facts.ts`: `neo.todo.done`
and `neo.todo.remove` are also called by the human's todo controls on the web
(`packages/web/src/neo/todo-controls.ts`) and by the daemon's own cards
(`daemon-cards.ts`), all through `todo-mutation-operation.ts`, so the same rule covers them:
the web shows the refusal text, and a human-step card on a plan's step is unaffected.
`stage-facts.ts` has 12 importers in the coding pack; slice 2 changes only
`codingReviewerPolicy`'s inputs.

Acceptance, one integration case per row:

| Case | Expected |
|---|---|
| a plan with no steps asks for sign-off | refused: steps missing |
| steps filed, no check, sign-off asked | refused: check missing |
| check recorded, then a step removed | refused until checked again |
| check by the plan's own session | not accepted |
| check on the doer's model while another model is usable | not accepted |
| check on the doer's model when it is the only usable model | accepted |
| plan done | its steps start in order |
| a design PR whose checks pass, before steps, check or sign-off | not merged, and the plan is not marked done |
| the last live step removed without `replacedBy` | refused |
| a repository with cross-model review off, a design PR | still reviewed and checked |
| a todo that is not a plan | unchanged |
| a plan already done before the upgrade, its ask still open | held to the old rule (one live dependent); the new rule applies to plans not yet done |
| a `no`-style reply or a non-signoff card on a plan | does not sign it |
| a design PR todo already done before the upgrade, its ask still open | marked legacy; the old rule applies |
| all of a plan's steps done | the plan still has its steps; the ask settles |
| a `check` reported by a session that got no delivery for the plan | not recorded |
| an abandoned plan's ask settled `dropped` | allowed |
| a design PR where the author's model is the only usable one | reviewed by another session on that model, checked, merged after sign-off |
