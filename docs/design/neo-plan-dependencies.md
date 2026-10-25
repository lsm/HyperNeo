# One plan, one ask, all its steps

Status: proposal for human review. Refs lsm/HyperNeo#8715. Design only.

## Core owns the plan

**Create all known steps under one ask; keep it open until every retained todo is
done.** Add discoveries there using `added_after_start`. Workers may change.

Add `neo_todos.depends_on` / `dependsOn`. Reuse Space’s `TaskDependencyNode` and
`planTaskDependencies`: same-ask prerequisites, no self-links, duplicates or cycles;
only `done` satisfies an edge. Position is display order. Independent steps may
run together within existing approvals/capacity. Resolve request-local step keys
and save the graph atomically; retain the twenty-step create limit.

Close three existing loopholes:

- `ask-record-operations.ts` and `todo-repo.ts`: stop multi-repository splitting,
  parent auto-settlement and later card relocation. Keep repository on each todo.
- `neo.ask.settle`: remove the local-RPC completion bypass. Serialize additions
  with settlement. Scope removal requires a recorded human decision and edge
  repair; cancellation remains `dropped`, not success.
- `todo-state.ts`: replace positional auto-advance with dependency-ready candidates.
  Recheck prerequisites when claiming every start, retry, continue or automatic
  advance. Reject new unmet prerequisites on running todos until explicitly stopped.

The ask is the owner. Preserve historical `parent_id`; `goal_id` / `neo_goals`
remain optional standing-outcome grouping. No successor-at-settle field.

## Blockers reach the human

A reported incident left three todos doing: a worker wrote a plain-text blocker,
received 66 nudges over 7.5 hours, and produced 171 turn reports without a human card.

Use #8663’s structured `blocked` kind, correlated with current assignment and
explicit affected-todo references added to the reporting contract. Ambiguous
reports wake Neo once for triage; never guess across a worker’s todos.
Persist `state=blocked`, reason, next action and a needs-human marker. Recompute,
restart, worker activity and routine reports cannot clear it.

Recheck the hold before nudging; cancel pending reminders. Commit one deduplicated
Neo wake per blocker incident with the transition. Neo creates the human card;
replays and “Ending without messaging” reports cannot wake again. Human answer
plus explicit resume clears the hold and rechecks dependencies.

## Coding pack mirrors the plan

Core stores plans/dependencies/blockers without GitHub. Coding-pack tables bind
ask ↔ epic and todo ↔ sub-issue, created with the plan and extended for later
todos. Cross-repository work keeps one epic and ask.

Use existing seams: `todos.schema` (bindings), `sweep` (reconciliation),
`snapshotRows` (status), `todos.openedPrs` (PR links), `readFacts`/`judge` or
`todos.check` (evidence). Add an after-commit plan-change hook; sweep repairs missed
hooks. Persist creation markers/bindings; reconcile uncertain retries before
creating duplicates. `prepareExecution` holds starts until mirrors exist. Surface
failures; keep network calls outside core transactions. Epic/issue closure cannot
override unfinished todos or Verify. Retry epic closure after core completion.

## Context and migration

Each turn, including after compaction, rehydrates open asks, todo states/edges,
unmet prerequisites, human blockers and next startable todos. Share the projection
with `neo.snapshot`, removing its ten-ask gap. Retain every owner’s summary under
budget pressure; identify omitted graph detail to read before acting. Pack rows
append mirror status.

Default new dependency arrays to empty. For existing open asks, backfill a
conservative position chain among retained steps to preserve serial behavior for
new starts; leave running work alone. Neo can edit these explicit edges. Preserve
closed asks, outcomes, timestamps and historical links. Reconcile fragmented
unfinished work explicitly into one open ask; never reopen or rewrite history.

## Small PRs, in shipping order

Target 100–200 production lines each; measure and split, never pad. Tests accompany
each slice:

1. Persist blocked reports: named todos block; ambiguous assignments request triage.
2. Wire holds/nudges/wakes: replay, restart and routine reports yield one human
   card without reminder loops.
3. Store/validate dependencies: atomic creation rejects bad edges; migration
   preserves serial starts and history.
4. Remove split/settle bypasses: one multi-repository ask; RPC and concurrent
   additions cannot evade pending steps.
5. Gate dispatch/advance: independent branches run; joins and every start path
   wait for prerequisites.
6. Rehydrate context: compaction retains more than ten asks; non-coding plans
   work without GitHub.
7. Build pack reconciliation: partial creation and late steps recover without
   duplicate issues.
8. Wire pack hooks/holds/evidence: missing mirrors hold starts; premature issue
   closure cannot finish plans.

Follow the repository verify skill with isolated synthetic RPC/UI journeys for
these proofs. This document claims no runtime fix.

## Cut from v1

- Large-plan staging: reject oversized creates; no batch activation protocol.
- Per-ask adoption mode: one migration, no parallel scheduling modes.
- Durable plan-event outbox: after-commit hook plus sweep repairs missed hooks.
- Custom graph paging protocol: compact summaries plus explicit detail reads.

## What we will not build

No successor chains, prose blocker parser, new workflow engine, mandatory goals,
GitHub logic in core, or automatic historical repairs. No implementation before
human design approval.
