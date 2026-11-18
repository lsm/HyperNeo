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

1. **has steps:** at least one live todo that depends on it (`after`);
2. **was checked:** a passing check, recorded on the plan, by a session that is not its
   doer, listing exactly the current steps. The checker runs another model when the human
   has one available; when only the doer's model is usable, another session on the same
   model counts;
3. **was signed:** a sign-off card on it, naming those steps, that the human approved.

**The sign-off card.** `neo.question.ask` gains `signoff: true`. It is valid only on a
plan, only as a one-option choice (the option approves; Reply stays for anything else),
and its `todos` must be exactly the plan's live steps. Only an answer choosing that option
signs the plan. Other cards on a plan, such as an early blocking question, are unchanged.

**The check is one field.** In any pack, Neo checks a plan by starting another worker
session (`work.start` with the plan's `todoId`) and giving it the plan and its steps; when
that session reports a pass, Neo records it. `neo.todo.edit` gains
`checked: { ref, stepIds }`, accepted only when `ref` is a session the daemon started and
not the plan's doer, written into one new nullable column `neo_todos.checked_json`
with the checker's confirmed model read from its work status at write time, and whether
another model was available then: `chooseLine` (`pack-selection.ts`) over the configured
lines without the doer's model returns a usable line.
A check stops counting when the steps change.

**Plans already done.** The migration that adds `checked_json` writes `{"legacy": true}`
on every todo that is already a plan and already done. `neoPlanRefusal` holds a legacy plan
only to the old rule (one live dependent). Plans not yet done get no marker and follow the
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
| the `neo.ask.settle` superpipe (`ask-record-operations.ts`) | an ask with a plan missing any of the three |
| the automatic settle sweep (`service.ts`, which feeds `neo.ask.turned-settle`) and the follow-up wake (`neo-todo-session-repository.ts`) | the same: such an ask is not settled, and Neo is woken |
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
- A plan is always reviewed, even when the repository's `crossModelReview` is off, and
  the daemon does not merge a plan's PR until `neoPlanRefusal` passes: steps, check and
  sign-off come before the merge (`packs/coding/daemon-merge-gates.ts`).

Other packs mark plans the same way when they need to.

## Change plan

Each slice is one PR from `dev`, failing tests first.

1. **Core.** `neoPlanRefusal` and its fact step, the call sites above, `checked` on
   `neo.todo.edit`, tool text.
2. **Coding.** Mark design PRs as plans, the review brief, `checked` from
   `neo.coding.result`, review regardless of `crossModelReview` for plans.

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
