# ADR 0004: Superpipe Decision Pipelines for Runtime Decision Cores

## Status

Accepted — 2026-08-20. Validated by the superpipe pilot on `superpipe-pilot-1`:
dead-machinery removal + parity harness (#2578), pure admission gates (#2582),
delivery decision pipeline + interpreter (#2589), shared `decisionRun` combinator
(#2591). Upstream library pinned exact at `superpipe@0.17.0`. This ADR records the
adopted pattern, its boundaries, and the migration roadmap. It does not mandate
immediate adoption elsewhere; each phase gets its own go/no-go.

Validated further by pilot 3 (2026-08-21): `processRunTick` rewritten as a staged
interpreter over three extracted cores plus a `decisionRun` admission pipeline —
see "Pilot 3" below for boundary caveats.

Validated further by pilot 5 (2026-08-21): the eight task-mutation MCP tools in
`space-agent-tools.ts` interpreted as staged pipelines over extracted
admission/routing cores — see "Pilot 5" below for the recorded asymmetries and
the group roadmap.

Revised 2026-08-20 after owner review: scope widened from decision cores to pure
pipelines generally — decisions, multi-step transforms (rendering/projection), and
staged async flows (decide → effect → re-snapshot). The boundaries in
"Where superpipe must not be used" still hold; "free-form effect executor"
replaces the earlier blanket "effect executor".

## Context

HyperNeo's Space runtime classes accumulate cascades that interleave three concerns:
snapshot reads (repos, stores, in-flight maps), decisions (deliver / defer / fail /
skip), and effects (DB marks, session injects, retries, activation). Before the
pilot, `deliverExternalEventToWorkflowTarget` was a single 193-line cascade whose
gate order lived only in control flow — unreachable to unit tests without the whole
runtime, and expensive to reason about.

The pilot question: can the functional-core style — decisions as pure
functions/pipelines, classes as snapshot-readers and effect-interpreters — be
adopted with zero behavior change and without growing the codebase?

[superpipe](https://github.com/lsm/superpipe) 0.17.0 provides the pipeline
primitive: dependency-injected named stages, ctx threading, boolean `!dep`
flow-control halts, and a choice of sync (`.end`) or async (`.endAsync`) executors.
It was hardened for this pilot upstream (tsconfig build fix, raw-boolean-dep
support, catchable `OutputKeyError`).

## Decision

Adopt the functional-core sandwich for runtime logic — decision flows and
multi-step transforms alike. Superpipe carries the pure core (a decision, an
evolved value, or a staged plan); the class keeps snapshot reads and effect
execution at staged boundaries.

```
shell (class): read snapshot into a plain input object
core (superpipe): ordered pure gates → first decision wins → decision union
shell (class): flat interpreter, one branch per decision action
```

1. **Gates are `(ctx) => ctx`.** A gate either attaches a member of the decision
   union (via a `decided(ctx, decision)` spread) or returns the ctx unchanged.
   Passing through must be identity (`gate(ctx) === ctx`).
2. **Precedence is stage order, enforced structurally.** Every gate is followed by
   a `!hasDecided` halt guard, so the first deciding gate wins. There is no
   separate precedence document; the gate list is it.
3. **All wiring ceremony lives in `decisionRun(name, gates)`**
   (`packages/daemon/src/lib/space/runtime/decision-pipeline.ts`): factory + cast,
   `.input(['ctx'])`, the per-gate halt guards, and `decision: null` injection.
   A new decision pipeline is a name plus a gate array (~6 lines). Do not
   hand-write the superpipe ritual; do not import superpipe outside
   `decision-pipeline.ts` without an ADR-level reason.
4. **Pipelines are the composition primitive for sequential logic, not just
   decisions.** Two additional sanctioned forms beyond decide-once cores:
   - **Transform pipelines.** A pipeline may compose an evolving value across
     many steps — rendering/projection pipelines, message-shape normalization,
     UI state changes — using the same halt machinery for data-dependent early
     exit (`!dep` guards, `?dep` optional stages): a 10-step render that stops
     after step 3 when the data says so is a pipeline, not a decision. Steps
     stay pure `(value) => value`; applying the result (DOM, DB, publish)
     remains outside.
   - **Staged async flows: decide → effect → re-snapshot → decide.** A pipeline
     run may end in an effect, and the shell may re-enter a pipeline on the
     result. The pilot already ships this shape: `deliverViaActivation` runs
     the async activation, then feeds the outcome through the post-activation
     decision pipeline. What is *not* sanctioned is free-form effectful stages
     mid-pipeline: each effect boundary must be idempotent or compensable, and
     atomic multi-step writes belong to a transaction shell (P7), never to the
     pipeline. A pipeline owns no atomicity.
5. **Decision cores stay synchronous** (`.end`, never `.endAsync`). Pilot evidence:
   the async executor's promise settlement added microtask boundaries that changed
   interleaving with background tick timers and broke a timing-sensitive test
   (transient-dispatch retry in `space-runtime-external-events.test.ts`); the sync
   executor preserves the pre-refactor event-loop profile exactly. Async snapshot
   gathering stays in the shell; the core is sync by convention until a case is
   made and proven. Any async pipeline coupled to the run-tick must pin its
   microtask profile in tests.
6. **Testing conventions.** (a) A parity harness pins behavior against the parent
   commit before extraction — transcript-style instrumentation of store marks and
   effect calls (`space-runtime-external-event-admission-parity.test.ts`). (b) Gate
   unit tests cover the decision table, precedence ("terminal beats every
   downstream gate"), and pass-through identity. (c) The interpreter is covered by
   the pre-existing scenario suites, which must pass unchanged — that is the
   parity proof.
7. **Cancellation is requirement-driven.** `run.withSignal(signal, …)` per-run
   `AbortSignal` cancellation exists and is unused. Wire it when a real
   cancellation requirement appears, not to exercise the feature.

### Where superpipe must not be used

- **As a state machine or unbounded fold.** State lives in the runtime/DB; a
  pipeline decides one step. Stream reduction may use a pipeline as the per-event
  reducer body (Phase 3), never as the loop.
- **As a free-form effect executor.** Effects happen at pipeline boundaries
  (decide → effect → re-snapshot), not as arbitrary mid-pipeline steps. DB writes,
  network, publishes, session injects stay in the interpreter or in an explicitly
  staged effect boundary; a pipeline never owns atomicity.
- **As a resource owner.** `AbortController`s, timers, subscriptions, query
  objects stay in classes; pipelines receive values.
- **On hot paths.** Per-stage container allocation is not free. A six-gate,
  router-shaped benchmark (100k iterations; median of five fresh Bun processes on
  an Intel i9-10910) measured `decisionRun` at 2,557 ns/op cold and 1,999 ns/op warm,
  versus 194 ns/op cold and 75 ns/op warm for an if-cascade. `AgentMessageRouter`
  runs once per `send_message` tool call, not per streaming token, and its awaited
  repository reads and session injection are millisecond-scale. Both pipeline
  measurements are below the 10 µs/decision threshold, so this is a **GO** for the
  router; genuinely hot inner loops should stay inline.

### Pattern taxonomy (from the adoption study)

| Pattern | Shape | HyperNeo fit |
| --- | --- | --- |
| P1 pure sync transform | `pipe → end` | data mapping, projections, rendering pipelines with data-dependent early exit (Phase 5) |
| P2 awaitable planning flow | async deciders, `endAsync` | **pilot used sync cores instead**; async variant unproven in-repo; staged effect boundaries (Decision item 4) are the sanctioned async form meanwhile |
| P3 guard/validation gate | boolean `!dep` halts | eligibility, preflight decline |
| P4 optional stages | `?dep` skips when undefined | conditional normalization |
| P5 callback continuation | `next` keeps run open | avoided — abort abandons retained `next` |
| P6 per-event reducer | pipeline as reducer body | stream folds (Phase 3) |
| P7 functional sandwich | read → plan → apply | the adopted macro; pilot + Phases 1–4 |

## Consequences

**Positive:** decisions are unit-testable without the runtime (23 delivery + 27
admission + 3 combinator tests); precedence is structural and readable in one
place; the 193-line cascade became gather → decide → interpret; the marginal cost
of a new pipeline is ~6 lines; the timing-sensitive 162-test suite passed
unchanged across all pilot PRs.

**Costs:** production LOC is roughly neutral (the cleanup pass netted +3: −23
pipeline wiring, +7 helper extraction, +19 combinator module); one new daemon
dependency (pinned exact 0.17.0); a convention to learn; the sync-core rule means
async deciders carry a proof obligation (microtask-profile sensitivity).

## Pilot 3 — run-tick staged interpreter (2026-08-21)

Pilot 3 applied the pattern to `processRunTick`, the 5-second run supervisor in
`space-runtime.ts` (~535 lines at `:5933–6468` before the pilot) — the staged-async
form (Decision item 4) at its largest so far: snapshot → decide → effect →
re-snapshot, repeated across the tick.

Extracted:

- `run-tick-admission-gates.ts` — the tick admission decision (missing/finished/
  waiting run, executor meta, run tasks, canonical task, workflow validity,
  rate-limit, task-stopped, executions-present, blocked-executions) plus pure
  timed-out-execution selection.
- `run-tick-decision-pipeline.ts` — the admission gates composed as a
  `decisionRun` pipeline.
- `run-completion-settlement.ts` — completion-summary resolution,
  already-resolved and final-status mapping, spawned post-approval session
  resolution, quiesce source selection, and sibling-quiesce selection.
- `run-spawn-decisions.ts` — spawn admission, promotable-pending selection,
  spawn-failure classification, and the driveable-execution check.

The shell keeps every execution-mutating effect and re-snapshots
`nodeExecutionRepo.listByWorkflowRun` after each such stage (crash reset, the
execution-mutating recovery handlers, handoff repair, promotion) before the
next decision that consumes executions. The qualifier is load-bearing:
`handleAliveStuckExecutions` can inject a runtime nag and return `none`, after
which the tick proceeds to the next handler without a re-list — the invariant
is about execution-mutating stages that continue, not about every effect.

Four boundary caveats, recorded so the section is not read as a cleaner
validation of the sandwich than it is. First, slot availability is modeled by a
pipeline gate but defused at the production call site
(`availableTaskSlots: Number.MAX_SAFE_INTEGER`): `space` — and with it
`getAvailableTaskSlots` — only loads after admission, and the authoritative
check stays in the shell, after the timeout-notification stage; the gate list
does not encode slot precedence. Second, six admission gates (missing/finished/
waiting run, executor meta, run tasks, canonical task) are shadowed by shell
short-circuits ahead of the admission call: the interpreter returns for each of
those conditions first and then hardcodes the corresponding inputs (an active
`runStatus`, `hasExecutorMeta: true`, a positive task count,
`hasCanonicalTask: true`), so those gates are unreachable in production. The
authoritative ordering of the tick is therefore shell short-circuits first,
then the pipeline gates; the gate list alone is the precedence document of the
core, not of the production tick. Third, four admission inputs
(`executionCount`, `runIsComplete`, `hasBlockedExecution`, `firstBlockedResult`)
are lazy thunks forced inside the gates, so their repository/detector reads
happen within the core run rather than pre-gathered by the shell — a deliberate
exception so cheap skip paths never pay for the executions snapshot. The reads
are read-only and memoized (one shared `loadNodeExecutions` snapshot), and no
effects run inside the core. Fourth, spawn-failure classification has shadowed
outcomes: the interpreter handles permanent and transient errors inline
(cancelling the execution, deferring with a log) before calling
`classifySpawnFailure`, so the production call always supplies
`isPermanent: false` and `isTransient: false` and the core's `cancel_permanent`
and `defer_transient` arms are unreachable outside unit tests — in production
the core only chooses between preserve-stale-terminal and reset-retry.

Deliberate non-goals: the four `handle*Executions` recovery sub-flows
(alive-stuck, waiting-rebind, non-terminal-idle, terminal-error-idle) and
`repairQueuedWorkflowNodeHandoffs` remain opaque effects behind the interpreter —
candidates for future mini-pilots, each to be pinned by a decision-table test
before extraction.

Terminal-set nuance: settlement terminal (`isSettlementTerminal` —
done/cancelled/blocked/approved) and spawn terminal
(`isCanonicalTaskTerminalForSpawn` — done/cancelled/archived/stopped)
intentionally differ: 'blocked' settles a finished attempt, while 'stopped'
(user-parked) skips the post-admission tick body — via `applyTaskStoppedGate`
→ skip for an active run (no crash recovery, handoff repair, settlement, or
spawn runs for a task parked before the tick), though pre-admission
reconciliation still runs first: duplicate run tasks are archived (cancelling
their agents' sessions where applicable) even for a parked task. The
`workflowRunId` rebind guard beside it never fires in production —
`listByWorkflowRun` selects rows whose `workflow_run_id` already equals the
run, so the mismatch condition is always false; it stays as defensive
self-heal. Non-active
runs exit even earlier in the shell: a finished run returns after clearing stuck state, and a blocked run
diverts into `attemptBlockedRunRecovery`, which returns on its own stopped-task
check — so the admission gates, validity included, are never reached there.
Within admission, workflow validity is gated before the stopped gate, so a
parked task on an active run whose workflow lacks `endNodeId` is transitioned
to `blocked` instead (pre-existing precedence, preserved by the pilot; parking
is authoritative only for active runs with valid workflows). Mid-tick parking
is only partially guarded, and the guards are snapshots, not locks: the
canonical task is re-read before spawn admission, so the ordinary spawn path
is suppressed only for parks visible at that re-read — a park landing after
it, in particular while the spawn loop awaits
`spawnWorkflowNodeAgentForExecution` for the first of several pending
executions, still spawns the remainder with the stale task, and the loop's
trailing status update — guarded only by the stale `open` snapshot — then
writes the parked task back to `in_progress` through the same unvalidated
update. Earlier stages run
on the admission-era task entirely, and every blocking write in the tick,
wherever it fires, can overwrite a concurrent park rather than merely act
stale: the admission interpreter's `blockInvalidWorkflow` and
`blockOnBlockedExecutions` branches, the four recovery handlers, the shared
`blockRun*` helpers — including the spawn-failure calls to
`blockRunForPermanentSpawnFailure` and `blockRunForAgentCrash` after awaited
spawns fail — and `attemptBlockedRunRecovery` all test a task snapshot taken
before one or more awaited effects and then write through `updateTaskAndEmit`,
which does not enforce the task-transition table — so a park completing inside
any of those windows is flipped `stopped` → `blocked` (or back to
`in_progress` on the resume paths: `attemptBlockedRunRecovery` — the pre-admission path
for blocked runs, where a park landing after its
stopped-task check is undone, because the helper resets blocked executions to
pending, flips the run back to `in_progress`, and writes the stale-snapshot
task to `in_progress` through the same unvalidated update — and the successful
`handleWaitingRebindExecutions` recovery, which resets the execution to
pending, transitions the run, and then writes the stale `blocked`/`open`
snapshot back to `in_progress`. Queued-handoff
repair's terminal check
(done/cancelled/archived) excludes 'stopped' and can still spawn, and the
completion branch, gated on the admission-time-cached `runIsComplete`, runs
before the re-read and can still transition the run to `done` and write task
result/summary — though not status: `buildTaskOutcomeUpdates` never sets
`status`, and `dispatchPostApproval` re-reads the task and returns `skipped`
because `stopped → approved` is not a valid transition, so a mid-tick
'stopped' survives settlement. One status-dependent settlement effect does
fire: when the admission-era status was already settlement-terminal (e.g.
`blocked`), `finalTaskStatus` stays stale-terminal and the sibling-quiesce
loop still idles sibling executions and interrupts their sessions after the
park. Per-effect validation of the freshly-read task status — including `stopped` —
narrows these gaps to a check-then-act window but does not close them: a
concurrent park can still land after the read and before the effect, and the
re-read alone buys nothing because `spawnWorkflowNodeAgentForExecution`
already re-reads the task while `validateTaskAllowsSpawn` rejects only
archived/cancelled and rate/usage-limited statuses, so a parked task passes
and the spawn proceeds. Truly closing the races requires atomic coordination
— a lock, a CAS on the task row, or a spawn reservation — plus the equivalent
guards around every task-status write in the tick — handoff repair,
`attemptBlockedRunRecovery`, the admission interpreter's blocking branches,
the recovery handlers, and the spawn-failure `blockRun*` calls; that work is
deliberately not slipped into this
closing sweep and belongs with the `repairQueuedWorkflowNodeHandoffs`
mini-pilot. The terminal-handoff-cleanup check in the interpreter is a third,
narrower set (done/cancelled/archived). These are distinct decisions, not
duplicate predicates to unify.

Costs: production net +374 lines across the pilot — 368 lines of new pure
modules, `space-runtime.ts` net +6 (`processRunTick` 535 → 533 lines; the value
is testability of the decisions, not method shrinkage); tests +1,918 lines
(decision-table pins and core unit suites).

Pilot PRs: #2601 (decision-table pin), #2604, #2620, #2624, #2629, #2641, plus
the closing cleanup/dead-code sweep. The sweep confirmed no dead inline copies
remained: every leftover near-duplicate (pre-admission finished/waiting
fast-path, post-snapshot slot check, the post-approval session ternary that
narrows the `PostApprovalRouteResult` union) is live adapter code, deliberately
kept. The dual phenomenon — core decision arms that production never reaches —
is recorded in the boundary caveats above (shadowed admission gates, the slot
gate, spawn-failure outcomes). The review round also surfaced pre-existing
production-unreachable defensive code outside the sweep's PR-6 scope — the
`workflowRunId` rebind guard — recorded above rather than removed.

## Pilot 5 — MCP tool-handler staged pipelines (2026-08-21)

Pilot 5 carried the pattern from the runtime into the Space MCP tool surface. All
eight task-mutation tools in `packages/daemon/src/lib/space/tools/space-agent-tools.ts`
(`create_standalone_task`, `update_task`, `retry_task`, `cancel_task`,
`publish_task`, `archive_task`, `reassign_task`, `approve_task`) are now staged
interpreters over three extracted cores:

- `tool-admission-gates.ts` — the shared autonomy-admission core:
  `resolveEffectiveAutonomyLevel`, `decideAutonomyAdmission`, and
  `TOOL_AUTONOMY_REQUIREMENTS`, now the single place *fixed session-write*
  gating policy lives (previously a hardcoded `SESSION_WRITE_AUTONOMY_LEVEL = 4`
  const inside the handler factory plus prose deny strings assembled at each
  throw site). Workflow-derived requirements are deliberately outside the table:
  `approve_task` enforces the workflow's `completionAutonomyLevel` inside
  `routeApproveTask`, so changing an approval requirement means changing that
  router, not the map (see the second recorded asymmetry below).
- `task-transition-routing.ts` — pure routing tables: `routeTaskUpdate` (the
  old seven-branch inline cascade as a typed precedence table), the shared
  `routeTaskTarget`, and one router per remaining tool.
- `space-tool-pipeline.ts` — the `decisionRun` composition for `update_task`
  (autonomy → arg-changes → target → routing arbiter), exposed as
  `decideUpdateTask`.

**MCP TOOL HANDLER = STAGED PIPELINE.** The sanctioned handler shape,
generalizing the pilot-1 sandwich to tool calls: admission (autonomy) →
arg validation → target/scope resolution → action routing (pure table) →
effects (manager/runtime calls) → result folding (audit + task-updated emit +
JSON result). Everything up to and including action routing is pure and
unit-pinned; the shell gathers snapshot inputs (task row, run-active flag,
workflow completion level, effective autonomy) and interprets the routed
action. The stage order is the precedence contract and is the *implemented*
order in `update_task`'s `decisionRun` (autonomy → arg-changes → target →
routing arbiter), which preserves the pre-pilot precedence: a no-fields call
fails with the argument error even for a missing or cross-space task id. A new
handler following this shape inherits that arg-before-target ordering. `update_task` is the fullest instance: its `TaskUpdateRouting` union —
reject `no_updatable_fields` → target reject → `review_direct` →
`approved_direct` → `park_stopped` → `review_to_done` → `archive_active_run` →
`recover_transition` → `stop_for_status` → `set_status`, else `fields_only` —
declares each arm's audit shape (`auditParamsShape`: `'transition' |
'fields_only'`) and task-updated emission obligation (`emitTaskUpdated`:
`'never' | 'only_with_field_updates' | 'always'`) as union fields. These are
recorded contract, not consumed directives: the interpreter hardcodes auditing
and emission per switch arm, and the parity suites pin the arm-by-arm
correspondence. Whether the interpreter should instead branch on the fields —
making the table the operative emission policy — is part of the
emission-ownership review question below.

**Recorded asymmetries — open review questions, not silently preserved
behavior.** Both predate the pilot and were carried verbatim for parity; the
table now renders them as data, which is the point of recording them:

1. **Task-updated emission ownership is split by arm.** The handler's
   `emitTaskUpdated` and the runtime's `safeOnTaskUpdated` publish the same
   `space.task.updated` bus event (the runtime hook additionally drives
   `goalService.handleTaskTerminal`). For `stop_for_status` the runtime owns
   emission — `stopWorkflowBackedTaskForStatus` emits once and the handler arm
   emits nothing, so `emitTaskUpdated: 'never'` really means "never
   double-emit". For `park_stopped` and `recover_transition` the runtime emits
   the transition row and the handler emits again only when field updates
   accompany it — a park or recover *with* field updates publishes two events,
   the first immediately stale, while a status-only park/recover publishes one.
   For `set_status` and `fields_only` the task manager emits nothing (verified:
   no bus publish in `space-task-manager.ts`) and the handler owns emission.
   Review questions for the team: should ownership be unified (runtime always
   emits, handlers never) instead of split by arm, and should the with-fields
   double event be collapsed to the final row?
2. **Autonomy deny messages have two provenances.** Session-write denies are
   composed by `decideAutonomyAdmission` ("…Request human approval."), while
   `approve_task` denies are composed inside `routeApproveTask` with
   submit-for-approval advisory text; the shared core parameterizes the tool
   name but not the remediation wording.

**Boundary caveats.** `cancel_task` routes *after* its primary effect —
`taskManager.cancelTaskCascade` runs first and `routeCancelTask` then decides
only whether to also cancel the workflow run: an action router over
post-effect state, not an admission gate (target errors surface from the
manager throwing, as before). `reassign_task` keeps no target gate (the manager
throws for unknown ids), and `approve_task` gathers `spaceLevel` preferring
`space.autonomyLevel` over the `getSpaceAutonomyLevel` path that
`requireSessionWriteAutonomy` uses — both pre-existing divergences, preserved.
`approve_task` also inverts the shape's admission-first order: `routeApproveTask`
checks the target before the autonomy level, so a below-threshold caller
supplying a missing or cross-space task id receives the target error rather
than the autonomy denial — the reverse of `update_task`'s autonomy-first gate
order, and pre-existing parity (the inline handler checked target first too).
The gather layer also re-derives predicate inputs (`statusDiffers`,
`isRecoveryTransition`) from the same snapshots the table consumes — the price
of keeping reads out of the core.

**The closing sweep found no dead duplicates.** The conversion PRs removed
every inline copy as they landed: the status cascades, the local transition
predicates (`fromActivePaused`/`toStopped`/`toBlockedFromPaused`,
`retryableStatuses`), and the old gate internals — the factory-local async
closure `resolveEffectiveAutonomy` (succeeded by the pure
`resolveEffectiveAutonomyLevel` export), the inline `isAgentCeilingBinding`
predicate (succeeded by the exported type guard), and the
`SESSION_WRITE_AUTONOMY_LEVEL` const (folded into
`TOOL_AUTONOMY_REQUIREMENTS`) — no longer appear in
`space-agent-tools.ts`; knip (files/dependencies/exports),
oxlint, and `tsc --noEmit` are clean; every core export is production-consumed
or pinned directly by the gate/routing suites per Decision item 6. Live
near-duplicates remain only in never-converted surfaces — the hand-rolled
target checks in `get_task_detail`, `send_message_to_task`, `list_task_members`,
`approve_pending_completion`, `attach_forge_task_evidence`, and the task branch
of `resolve_forge_scope`, and the largest one: the UI-side RPC cascade
in `rpc-handlers/space-task-handlers.ts`, which re-implements the update
routing by hand with UI-flavored messages. These are follow-up mini-pilot
material (below), deliberately not folded into a cleanup PR.

**Costs:** production net +458 daemon lines across the pilot — +556 in the
three new pure modules (82 + 414 + 60) against −98 in `space-agent-tools.ts`
(5,143 at pilot start, 5,029 now; 16 of that difference came from unrelated
interleaved PRs). The eight handlers shrank 521 → 420 lines (−19%:
create 89→61, update 179→134, retry 36→29, cancel 30→33, publish 30→24,
archive 33→29, reassign 27→28, approve 97→82 — the two that grew host their
routing call plus plan interpretation). Tests +1,519 (three new core suites —
268 + 827 + 407 — plus parity additions).

**Group roadmap.** The same skeleton — admission gates + routing tables, with
`decisionRun` composition where gate order itself is the contract — is the
template for follow-up mini-pilots, each pinned by a decision-table test before
extraction: session tools (`send_session_message`, `update_session_state`,
`interrupt_session` — already gated by the shared autonomy core; their
target/arg validation remains inline), agent CRUD (long-horizon agent
create/update validation), forge/goals (automation-policy validation,
evolution-scope merging), messaging (`send_message_to_task` target resolution),
and the RPC-side `space-task-handlers.ts` update cascade, whose folding onto
`routeTaskUpdate` would unify agent-side and UI-side transition policy in one
table.

Pilot 5 PRs: #2663, #2668, #2669, #2673, #2676, plus this closing sweep.

## Roadmap

- **Done (pilot):** admission gates extracted as pure functions (no superpipe
  needed there); delivery + post-activation decision pipelines; `decisionRun`
  combinator; interpreter dedup.
- **Done (pilot 3):** run-tick admission/settlement/spawn cores and the
  `processRunTick` staged interpreter — see "Pilot 3" above.
- **Done (pilot 5):** the eight task-mutation MCP tools as staged pipelines
  over `tool-admission-gates` / `task-transition-routing` /
  `space-tool-pipeline` — see "Pilot 5" above, which also records the group
  follow-ups (session tools, agent CRUD, forge/goals, messaging, the RPC task
  cascade) as mini-pilot candidates.
- **Phase 1 — job settlement decider** (`job-queue-processor.ts`): already a
  discriminated union (`complete | retry | dead-letter | park | ignore-stale-claim`)
  with existing tests. First test of whether an async core is ever needed, or
  "sync core, async shell" holds as a standing convention. Go/no-go for Phases
  2–5.
- **Phase 2 — workflow transition resolution** (message-delivery admission half
  done in the pilot). The message-admission pipeline — sequenced behind the
  in-flight delivery-ordering fixes in the turn lifecycle — is also the landing
  spot for a **provider-concurrency admission gate**: when a provider (e.g. GLM)
  is at its concurrency limit, the admission decision queues the message before
  it is persisted to the session, instead of letting concurrent calls pile up at
  the provider.
- **Phase 3 — per-event stream reduction** (query-runner event folds, ACP
  translation as P6 reducer bodies).
- **Phase 4 — transaction sandwich** (schedule transactions, workflow hook
  engine): read → plan → CAS within transaction → apply effects after commit.
- **Phase 5 — web functional cores** (P1: `useTurnBlocks`, message projections,
  model-switcher projections).
- **Carried research:** async/`withSignal` validation if Phase 1 wants an async core.

## References

- Pilot files: `packages/daemon/src/lib/space/runtime/{decision-pipeline,
  external-event-delivery-pipeline, external-event-admission-gates}.ts`; delivery
  interpreter in `space-runtime.ts`
  (`deliverExternalEventToWorkflowTarget` and helpers).
- Parity harness:
  `packages/daemon/tests/unit/5-space/runtime/space-runtime-external-event-admission-parity.test.ts`
- Benchmark: `packages/daemon/scripts/benchmark/decision-pipeline.ts` (`bun run
  packages/daemon/scripts/benchmark/decision-pipeline.ts` from the repository root).
- Pilot PRs: #2578, #2582, #2589, #2591 (branch `superpipe-pilot-1`).
- Pilot 3 files: `packages/daemon/src/lib/space/runtime/{run-tick-admission-gates,
  run-tick-decision-pipeline, run-completion-settlement, run-spawn-decisions}.ts`;
  interpreter in `space-runtime.ts` (`processRunTick`). Pilot 3 PRs: #2601,
  #2604, #2620, #2624, #2629, #2641.
- Pilot 5 files: `packages/daemon/src/lib/space/tools/{tool-admission-gates,
  task-transition-routing,space-tool-pipeline}.ts`; interpreters in
  `space-agent-tools.ts` (the eight task-mutation handlers). Pilot 5 PRs:
  #2663, #2668, #2669, #2673, #2676.
- superpipe 0.17.0 — library semantics map and contract tests produced during the
  pilot.
