# Todo kinds carry their own requirements

Status: proposal, 2026-11-17. Design only. Builds on `neo-plan-dependencies.md` (one ask
holds all steps) and the follow-up guard (`lib/neo/todo-follow-up.ts`). Paths without a
prefix are under `packages/daemon/src/`.

## Why

A plan, research or design is finished only when the work it describes exists as todos
and gets done. Today that depends on Neo remembering:

- A todo is marked as producing more work only when Neo sets `producesFollowUp` on
  `neo.todo.add` (`lib/neo/todo-operations.ts`). If Neo does not set it, nothing checks.
  A design with four planned steps can finish after step 1 and its ask settles.
- Even when set, the guard runs only when the ask settles and only looks at the ask's last
  todo, so an unrelated later todo or a removed follow-up passes it.
- Requirements are per repository only (`neo_pack_preferences`, scope `global`, `repo` or
  `project`). Turning off cross-model review for a repository, to make small fixes faster,
  also turns it off for that repository's designs.

The steps of a plan need a model to write them, and a second actor to check them. What
must be reliable is that the steps exist before anyone signs, that a check covered exactly
those steps, and that the ask cannot end without them.

## The design

**Kinds.** Every todo has a `kind`. A kind is declared by a pack (or by core) with a label
and its requirements:

| Requirement | Meaning, enforced by core |
|---|---|
| `steps` | the todo's result is more work: it needs step todos that depend on it (`after`) before a sign-off card on it can open, and before it can be done |
| `check` | `none`, `another-session` or `another-model`: a passing check recorded by a session that is not the todo's doer (and, for `another-model`, runs another model) before sign-off and done |
| `signoff` | an answered sign-off card on the todo before it can be done |

Core declares two kinds: `core.task` (no requirements, the default) and `core.plan`
(`steps`, `check: another-model`, `signoff`). Neo picks the kind on `neo.todo.add` from
the declared list; a pack may also set it from facts it owns (see Coding). The existing
`producesFollowUp` flag is replaced: stored `producesFollowUp = 1` reads as `core.plan`.

**The human sets requirements per kind.** A kind's declared requirements are its default.
The human can change them in settings: a core preference `kindRequirements`, scope
`global`, one value per kind. A repository or project preference cannot go below its kind:
a repository with cross-model review off still checks its `core.plan` todos.

**Steps are filed before sign-off.** Neo files the steps with `neo.todo.add`
`after: [planTodoId]`; they stay unstarted because their dependency is not done
(`neoTodoReady`, `lib/neo/todo-dependencies.ts`). A sign-off card on a `steps` todo must
name those step todos (`neo.question.ask` `todos`), so the human approves the plan and its
steps together. When the plan todo is done, the steps start in order.

**The check is recorded, not described.** A new core operation `neo.todo.check` (Neo
only) records a check for a todo: the checking session, its verdict (`pass` or
`changes`), the step todo ids it compared against the plan, and the todo's version (an
opaque string the pack supplies; for coding, the PR head). Core accepts it only when:

- the checking session is a daemon-started worker and not the todo's doer;
- for `another-model`, its confirmed model differs from the doer's;
- the step ids equal the todo's current live steps exactly.

A check is current until the version or the step list changes. Then a new check is needed.

**Gates.** One pure function, `neoTodoRequirementRefusal(todo, kind, facts)`, returns the
first unmet requirement. It runs as a step in the existing superpipe pipelines of
`neo.question.ask` (sign-off on the todo), `neo.todo.done`, ask settle (replacing
`neoTodoFollowUpRefusal`), and `neo.todo.remove` (removing the last live step of a `steps`
todo needs `replacedBy` or a human answer).

### Coding

- A todo whose PR changes `docs/design/**` gets kind `coding.design` (declared like
  `core.plan`), set from the PR facts the pack already reads.
- The review brief (`lib/neo/packs/coding/assign-operation.ts`) lists the step todos and asks the
  reviewer to compare them with the design's plan; a missing, extra or misordered step is a
  finding. `neo.coding.result` for a passing review also records `neo.todo.check` with
  those step ids and the head.
- The merge gate (`lib/neo/packs/coding/daemon-merge-gates.ts`) asks core for the todo's
  requirements and holds the merge until they are met, whatever the repository's
  `crossModelReview` says.

Other packs declare their own kinds the same way, for example a contract edit checked by
another model.

## Change plan

Each slice is one PR from `dev`, failing tests first.

1. **Core kinds and gates.** Kind declarations, `neo_todos.kind`, the
   `producesFollowUp` read, `neoTodoRequirementRefusal` in the four pipelines, Neo's tool
   text for picking a kind and filing steps before sign-off.
2. **Core check.** `neo.todo.check`, its table, the current-check rule, the `check` gate.
3. **Coding.** `coding.design` from PR facts, the review brief, the check from
   `neo.coding.result`, the merge gate.
4. **Settings.** The kinds table on the settings page, with each kind's requirements
   editable by the human.

Acceptance, one integration case per row:

| Case | Expected |
|---|---|
| a design PR todo with no step todos asks for sign-off | refused: steps missing |
| steps filed, review not recorded, sign-off asked | refused: check missing |
| review recorded, then a step removed | the check is no longer current |
| the plan todo is done | its steps start in order |
| the last live step is removed without `replacedBy` | refused unless the human said so |
| a repository with cross-model review off, a design PR | still needs an another-model check |
| a `core.task` todo | no new requirement |
| the human turns `check` off for `core.plan` in settings | plans no longer need a check |
