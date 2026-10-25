# One plan, one ask, all its steps

Status: proposal for human review. Refs lsm/HyperNeo#8715. Design only.

## Core owns the plan

**Create all known steps under one ask; keep it open until every retained todo is
done.** Add discoveries there using `added_after_start`. Workers may change.

Add `neo_todos.depends_on` / `dependsOn`. Reuse Space’s `TaskDependencyNode` and
`planTaskDependencies`: same-ask prerequisites, no self-links, duplicates or cycles;
only `done` satisfies edges. Position is display order. Independent steps share
existing approvals/capacity. Resolve step keys and save atomically; keep the
twenty-step limit.

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

## Worker questions become cards

Today card creation is Neo-only; structured blockers wake Neo without changing
todo state. Reported incidents include 26 and ten blocker repeats in six hours,
one against a day-old card; silence for 7.5 hours; and three doing todos receiving
66 nudges and 171 routine reports.

Extend `message.send` kinds `question` / `blocked` with todo, short title and
options. Validate current assignment; derive `sourceSession`, never trust claimed
identity. Multi-todo workers name affected todos; ambiguous reports wake Neo once
for triage. Require these reports even when routine messaging is suppressed.

Reuse `neo_questions`, source/todo links and answer controls through an internal
`question-operations.ts` helper. Atomically create/reuse one open card per todo,
persist `state=blocked` with a needs-human hold, and enqueue one incident-keyed Neo
wake. Repeats reuse even an older open card and restore its hold without re-waking.
Enforce a short title, 2–6 options and the human’s configured language; retain
free-text reply and the original report.

Neo may answer from a cited standing rule/prior answer and retire the card, merge
duplicates preserving answer routes/holds, or leave it. Agent resolution never
counts as human approval.

Persist human answers once and deliver directly to the bound worker with a retry
key; include answers in Neo’s durable turn context. Accepted delivery clears the
hold and returns doing after dependency checks; failed delivery stays waiting.
Neo resolutions use the same path. Recompute, restart, activity and routine reports
cannot clear holds. Recheck before nudging; cancel pending reminders. Unchanged
reports remain evidence without new wakes.

## Coding pack mirrors the plan

Core works without GitHub. Coding-pack tables bind ask ↔ epic and todo ↔ sub-issue
at creation, extended for later todos. Cross-repository work keeps one epic/ask.

Use `todos.schema` for bindings, `sweep` for reconciliation, `snapshotRows` for
status, `todos.openedPrs` for PRs, `readFacts`/`judge` or `todos.check` for evidence.
Add an after-commit plan-change hook; sweep repairs missed hooks. Persist creation
markers/bindings to reconcile uncertain retries without duplicates.
`prepareExecution` holds starts until mirrors exist. Keep network calls outside
core transactions. Epic closure cannot override pending todos/Verify; retry failed
closure after core completion.

## Context and migration

Each turn rehydrates open asks, states/edges, unmet prerequisites, blockers, answers
and startable todos after compaction. Share `neo.snapshot`’s projection, removing
its ten-ask gap. Under budget pressure retain every owner’s summary and identify
omitted detail to read before acting. Pack rows add mirror status.

Default dependencies to empty. Backfill existing open asks with a conservative
position chain, preserving serial new starts; leave running work alone. Neo may
edit edges. Preserve closed asks/outcomes/timestamps/links; explicitly reconcile
fragmented unfinished work into one open ask without rewriting history.

## Small PRs, in shipping order

Target 100–200 production lines each; measure and split, never pad. Tests accompany
each slice:

1. Build report/card storage: validated attribution, one card, language/format
   limits and needs-human holds.
2. Wire reports/nudges/wakes: repeats, old cards and restart yield one card/wake;
   quiet workers still report blockers.
3. Wire answers/triage: retry-safe delivery/resume, duplicate routes and truthful
   human/agent provenance survive restart.
4. Store/validate dependencies: atomic creation rejects bad edges; migration
   preserves serial starts and history.
5. Remove split/settle bypasses: one multi-repository ask; RPC and concurrent
   additions cannot evade pending steps.
6. Gate dispatch/advance: independent branches run; joins and every start path
   wait for prerequisites.
7. Rehydrate context: compaction retains over ten asks; non-coding needs no GitHub.
8. Build pack reconciliation: partial creation and late steps recover without
   duplicate issues.
9. Wire pack hooks/holds/evidence: missing mirrors hold starts; premature issue
   closure cannot finish plans.

Verify each slice through isolated synthetic RPC/UI journeys using the repository
verify skill. No runtime fix is claimed.

## Cut from v1

- Large-plan staging: reject oversized creates; no batch activation protocol.
- Per-ask adoption mode: one migration, no parallel scheduling modes.
- Durable plan-event outbox: after-commit hook plus sweep repairs missed hooks.
- Custom graph paging protocol: compact summaries plus explicit detail reads.

## What we will not build

No successor chains, prose/silence inference, worker access to Neo-only operations,
new card system, workflow engine, mandatory goals or GitHub logic in core. No
automatic historical repairs or implementation before human design approval.
