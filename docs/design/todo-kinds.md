# A plan todo cannot end without its steps

Status: proposal, 2026-11-17. Design only. Paths without a prefix are under
`packages/daemon/src/lib/neo/`.

## Why

A design or plan is finished only when the work it describes is filed and done. Today:

- A todo counts as producing more work only if Neo sets `producesFollowUp` on
  `neo.todo.add` (`todo-operations.ts`). If Neo forgets, nothing checks, and a design with
  four planned steps can end after step 1.
- The follow-up guard (`todo-follow-up.ts`) runs only when the ask settles and looks only
  at the ask's last todo, so a later unrelated todo or a removed follow-up passes it.
- Review requirements are per repository (`neo_pack_preferences`). Turning cross-model
  review off for small fixes also turns it off for designs.

## The design

**One kind, `plan`, with three requirements.** A todo is a plan when Neo marks it so (the
existing `producesFollowUp`, renamed `plan` in the tool text and kept in the same column)
or when a pack marks it from its own facts. A plan:

1. **has steps:** at least one live todo that depends on it (`after`);
2. **was checked:** a passing check, recorded on the plan, by a session that is not its
   doer and runs another model, listing exactly the current steps;
3. **was signed:** a sign-off card on it, naming those steps, answered by the human.

**The check is one field.** `neo.todo.edit` gains `checked: { ref, stepIds }`, written by
Neo when a checker passes the plan, into one new nullable column `neo_todos.checked_json`
with the checker's confirmed model read from its work status at write time.
A check stops counting when the steps change.

**One pure function decides.** `neoPlanRefusal(facts)` in `todo-follow-up.ts` takes the
plan, its live steps, its check and its answered cards, and returns the first unmet
requirement or null. A fact step reads those; the function is the only rule. It replaces
`neoTodoFollowUpRefusal` and is called from:

| Where | Refuses |
|---|---|
| `planNeoQuestion` (a card on a plan) | a card that does not name the plan's steps, or a plan with no steps or no current check |
| `planNeoTodoDone` | a plan missing any of the three |
| the `neo.ask.settle` superpipe | an ask with a plan missing any of the three |
| `planNeoTodoRemove` | removing a plan's last live step without `replacedBy` |

Steps wait without new code: they depend on the plan, so they start when it is done
(`neoTodoReady` in `todo-dependencies.ts`).

**Coding marks and checks.**

- A todo whose PR changes `docs/design/**` is a plan, read from the PR facts the pack
  already has.
- The review brief (`packs/coding/assign-operation.ts`) lists the plan's steps and asks the
  reviewer to compare them with the design's change plan; a missing, extra or misordered
  step is a finding. A passing `neo.coding.result` on a plan writes `checked` with those
  step ids.
- For a plan, the review stage runs whatever the repository's `crossModelReview` says
  (`packs/coding/daemon-merge-gates.ts`).

Other packs mark plans the same way when they need to.

## Change plan

Each slice is one PR from `dev`, failing tests first.

1. **Core.** `neoPlanRefusal` and its fact step, the four call sites, `checked` on
   `neo.todo.edit`, tool text.
2. **Coding.** Mark design PRs as plans, the review brief, `checked` from
   `neo.coding.result`, review regardless of `crossModelReview` for plans.

Acceptance, one integration case per row:

| Case | Expected |
|---|---|
| a plan with no steps asks for sign-off | refused: steps missing |
| steps filed, no check, sign-off asked | refused: check missing |
| check recorded, then a step removed | refused until checked again |
| check by the plan's own session or same model | not accepted |
| plan done | its steps start in order |
| the last live step removed without `replacedBy` | refused |
| a repository with cross-model review off, a design PR | still reviewed and checked |
| a todo that is not a plan | unchanged |
