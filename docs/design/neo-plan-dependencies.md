# One plan, one ask, all its steps

Status: proposal for human review. Refs lsm/HyperNeo#8715. Design only; no runtime
change. Source base: `b3b1b5df72d2ef9907156ce85b1cf0af450deb2b`.

## The problem

An approved plan can finish its first slice, say the rest is “tracked separately”,
and disappear. Each small ask completed its own cards; nothing owned the whole
outcome. Creating all known steps before starting makes unfinished work durable.
Dependencies say which steps may run next. A new worker does not mean a new ask.

**One approved plan stays in one open ask until every retained todo is done.**
Core owns this invariant without GitHub. The coding pack mirrors coding work into
an epic and sub-issues; those are evidence and collaboration surfaces for the same
plan, not a second plan owner.

## What exists today

| Source | Behavior that matters |
| --- | --- |
| `neo/ask-record-operations.ts` | `neo.ask.open` accepts todos, but splits multiple repositories into child asks and directly settles the empty parent. `neo.ask.settle` checks only its own todos; local human RPC bypasses that check. Removed todos with a reason count as finished. |
| `neo/todo-repo.ts` | `neoTodoHome` and `neoMoveTodo` can create repository children or move cards between asks. This must stop for plans, including when repository evidence arrives later. Keep repository identity on each todo. |
| `neo/todo-runner.ts`, `neo/todo-state.ts` | Start admission checks state, not prerequisites. Completion selects the next unfinished card by position. `blockedBy` is a reason kind, not a dependency edge. |
| `tasks/dependency-plan.ts`, `tasks/dependency-graph.ts`, `tasks/task-manager.ts` | Space tasks persist `depends_on`, validate an acyclic graph in one owner scope, and require every prerequisite's status to be `done`. The graph helpers are storage independent. |
| `storage/repositories/session-goal-repository.ts`, `goals/session-goal-operations.ts` | `neo_goals` already owns session goals, journal and wake schedules, but completion currently does not prove every linked ask finished. Goals are useful for standing outcomes, not required for a finite plan. |
| `neo/operations.ts`, `neo/snapshot-compact.ts`, `neo/session-config.ts` | Neo's prompt is configured separately from the on-demand snapshot. MCP snapshots select only ten asks before a 40 KB budget can trim more. A conversation summary or an optional snapshot read cannot guarantee awareness of every open plan. |

Paths in this table are relative to `packages/daemon/src/lib/`, except `storage/`,
which is relative to `packages/daemon/src/`.

## Core: store the entire plan

Reuse `neo_asks` as the finite plan owner and `neo_todos` as its steps. Add a
`depends_on` JSON array of todo IDs, exposed as `dependsOn`; keep `position` for
display only. Retain `goal_id` for asks contributing to an existing standing goal.
Do not turn `parent_id` into another ownership hierarchy: its current repository
split behavior is the mechanism we are replacing. Preserve old links for reading.

When an approved plan has N steps, record all N todos and their edges together
before dispatching any of them. The create request uses unique request-local step
keys so edges can refer to siblings before IDs exist; resolve keys and validate
the complete graph in the same transaction. A stable request key makes retry
return the same rows. No partial plan starts. Keep the current bounded create
size explicit; larger plans are staged in batches under the same ask, with dispatch
held until the complete graph is committed and activated.

Use `TaskDependencyNode` and `planTaskDependencies` with Neo state mapped to its
generic status input; reuse the graph and self/duplicate/missing/cycle checks.
Validate only against todos in this ask. Map `removed` to an ended prerequisite;
`failed` remains unmet and retryable. Reuse the all-prerequisites-done rule, not
Space's task manager or its workflow/session ownership machinery.

For example, seven todos may have edges “2 needs 1; 3 needs 1; 4 needs 2 and 3;
5 needs 4; 6 needs 4; 7 needs 5 and 6”. After 1 finishes, 2 and 3 can both be
startable. No edge means independent; list order does not imply a dependency.

Every dispatch path—explicit start, add-with-start, retry, continue and automatic
advance—uses the same dependency gate, rechecked at the dispatch claim. All
prerequisites must still exist in the same ask and be `done`. Failed, removed,
missing or blocked prerequisites never unlock a dependent. Existing human start
questions, pack holds and execution limits still apply. Replace positional
auto-advance with the set of graph-ready candidates, and claim each at most once.
An empty candidate set with unfinished work means waiting or blocked, never done.

Add later discoveries through `neo.todo.add` to the same ask, preserving
`added_after_start`, with explicit dependencies. Dependency edits replace the whole
list, atomically validate the resulting graph and invalidate readiness. Unlike
Space's stop-on-edit path, initially reject adding an unmet prerequisite to a
running todo: stop it explicitly before editing. Do not claim an already running
step obeyed a newly added prerequisite. Removing a prerequisite with dependents
requires an explicit scope decision and edge repair; it never satisfies them.

Keep the existing all-todos-finished settle gate, remove its local-RPC completion
bypass, and prevent the split/move shortcuts from settling or fragmenting plans.
A worker's handoff stays on its todo. “Tracked separately” is not completion.
An approved scope removal may retain the existing removed-with-reason exception,
but records the human decision and repairs affected edges; a generic removal
reason cannot discard unfinished plan steps. Explicit cancellation uses `dropped`
with its reason and remains visibly different from success. Adding a todo and
settling the ask must serialize so an unfinished step cannot race past closure.

There is no successor-at-settle field: the remaining steps already exist in this
ask. Likewise an epic closing cannot override unfinished core todos. A standing
goal may group these asks through `goal_id`; it does not replace their completion
gate or automatically complete when one slice finishes.

## Coding pack: mirror the plan into GitHub

Core stores asks, todos, dependency edges and revisioned changes, with no GitHub
fields or network calls. Coding-pack tables add ask ↔ epic and todo ↔ issue
bindings, canonical repository/issue references, sync revision and evidence
freshness/error. A coding plan has one epic and one sub-issue for each todo;
later todos get another sub-issue under that epic. For multiple repositories,
choose the epic's repository explicitly and retain each todo's repository; use
cross-repository sub-issues where supported, surfacing unsupported links rather
than splitting the ask.

Use the existing seams in `neo/pack-contract.ts`:

- `todos.schema` owns coding bindings; `todos.repository` resolves todo repos.
- `sweep` reconciles pending mirrors and issue/PR changes after restart;
  `snapshotRows` exposes bindings, freshness and sync failures.
- `todos.openedPrs` associates worker PRs; `readFacts`/`judge` and `todos.check`
  return completion evidence or a block through the existing recompute path.
  Issue closure alone does not prove merge, Verify or deployment requirements.
- `todos.refuse` handles synchronous draft validation and `prepareExecution`
  holds coding dispatch while required epic/sub-issue bindings are incomplete.
  Neither is used for remote effects inside the core transaction.

There is no existing plan-created callback. Add one small generic, revisioned
plan-change notification for create/add/edit/settle, committed durably with the
core change. Enabled packs consume it after commit; `sweep` reconciles missed
notifications against current revisions. Core provides ask/todo facts, not GitHub
instructions. Creating the plan queues its mirror immediately; remote creation
cannot be atomic with SQLite. Persist each returned binding, reconcile a stable
plan/todo marker before retrying an uncertain GitHub create, and show “tracking
pending” until all bindings exist. Do not duplicate issues or start partially
mirrored coding work. With no coding pack, core runs the same plan normally.

Bring external changes back as pack evidence, never as an automatic instruction
to create a successor ask. Close the epic after all mirrored steps and the plan's
acceptance checks pass. An early manual epic closure is a visible discrepancy;
pack checks cannot declare unfinished todos done. A failed epic close remains
visible as pack sync work even after core completion, rather than losing the retry
when an ask leaves the open list.

## What Neo sees every turn

Before each Neo turn, rebuild a core context section from durable open asks,
including after compaction or restart: ask identity/title, each todo's state and
prerequisite IDs, unmet prerequisites, next dependency-ready todos and blockers.
Include open asks with no running cards or no ready step. Paused/approval waits
remain visible; readiness is not permission to start.

Use the same projection for this injection and `neo.snapshot`. Do not apply the
current ten-ask selection or ordinary text trimming to silently omit owners.
Reserve a compact index of every open ask with ready/blocked counts; if full graphs
exceed budget, include explicit omitted counts and revision-bound paged detail
references, prioritizing changed/stalled plans. Neo must load that ask's graph
before acting on it. Pack rows append epic/issue links and sync status when enabled;
core does not fetch GitHub while assembling a turn. Context is rehydration, not a
new special Neo delivery or scheduling runtime.

## Migration and proof

Add the dependency column with an empty-array default. Preserve all settled asks,
outcomes, timestamps and existing `parent_id`/`goal_id` links. Do not infer edges
from prose or position. Before activating graph scheduling for an existing open
ask, review its remaining steps and explicitly record edges; retain legacy
positional scheduling until that ask is adopted, so an empty default does not
unexpectedly parallelize old work.

For an already fragmented plan, explicitly adopt remaining work into one open ask
with new todos and references to the historical rows. Retire superseded active
tracking only through recorded decisions; do not rewrite closed asks or silently
move their cards. Coding-pack reconciliation binds existing matching issues first
and reports ambiguous matches for review before creating anything. Rollout enables
storage/read projections first, then gates and per-ask adoption, then pack mirrors;
unadopted plans remain clearly labelled rather than falsely covered.

Implementation slices must follow `.claude/skills/verify/SKILL.md` with synthetic
data and isolated RPC/UI journeys. Prove seven-step creation before first dispatch,
parallel branches and joins, dependency refusal on every start path, cycle and
cross-ask rejection, failed/removed prerequisites, late additions, edit/start and
add/settle races, restart and compaction with more than ten open asks, no-GitHub
life-admin execution, multi-repository cards staying in one ask, partial mirror
recovery without duplicates, external issue closure without false completion,
and closure held by unfinished steps. This document supplies no runtime proof.

## What we will not build

No successor-ask chains, successor text parser, new goal/epic concept in core,
GitHub requirement for non-coding plans, general workflow engine, inferred
dependencies, rewritten history, or automatic conversion of closed asks into
new active work. No implementation before human design approval.
