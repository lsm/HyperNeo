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

Validated further by pilot 4 (2026-08-21): the agent message-delivery chain —
inject admission and turn-end flush as `decisionRun` pipelines, turn-outcome
and reconcile as point decisions — with the closing PRs fixing the two live
incident bugs the decision-table pins surfaced; see "Pilot 4" below for the two
design lessons it added to the record.

Validated further by pilot 6 / chain S (2026-08-23): the verified-stop ladder
(`stopSessionVerified`) applied as a `stagedRun` interpreter over extracted
gates — the combinator's first composed-then-swapped production flow. See
"Pilot 6" below for the boundary caveats, the compensation deferral, and the
closing sweep.

Validated further by pilot 7 (2026-08-23, Chain P): the workflow-node spawn
seam and the lazy-activation path as staged interpreters over extracted
admission/routing cores — and the first production consumer of
`casExecutionStatus` and the spawn reservation, whose superseded outcomes
replace previously tolerated racy writes (the other Phase 0 primitives had
already gained consumers just before the chain: transition-table enforcement
#2682, `casStatus` #2684). See "Pilot 7" below for the pinned behavior deltas,
the Pilot 3 spawn-seam race closure, and the boundary caveats.

Revised 2026-08-20 after owner review: scope widened from decision cores to pure
pipelines generally — decisions, multi-step transforms (rendering/projection), and
staged async flows (decide → effect → re-snapshot). The boundaries in
"Where superpipe must not be used" still hold; "free-form effect executor"
replaces the earlier blanket "effect executor".

Revised 2026-08-21 after issue #2670 (stagedRun RFC): staged run pipelines are
sanctioned — `stagedRun` composes snapshot/decide/effect/resnapshot stages, with
effect stages permitted inside pipelines under atomicity-delegation conditions.
Answers the RFC's five open questions; see "Staged run pipelines". The prior
boundary is retained in substance: a pipeline still never owns atomicity.

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

### Library surface vs. blessed idioms

Superpipe's full surface is larger than anything blessed in this ADR: async
pipelines, dependency-injected named inputs/outputs, per-stage error handlers,
`!dep`/`?dep` control-flow prefixes, output picking/merging, and `withSignal`
cancellation. The combinators below (`decisionRun`, `stagedRun`) are **blessed
idioms** — recurring shapes with the wiring ceremony deduplicated and one
discipline made structural — not a statement about what the library can do. A
flow that fits no blessed idiom may use superpipe directly; when a raw shape
recurs (≈3 uses), promote it into a named combinator so the codebase converges
on vocabulary instead of calcifying. A combinator must earn its layer by making
a discipline structural — dedup alone is convenience, not a layer. Phases bound
adoption; nothing here bounds the library.

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
   hand-write the gate ritual when `decisionRun` fits. Superpipe imports outside
   `decision-pipeline.ts` and `staged-run.ts` are permitted for flows that fit no
   blessed idiom (revised 2026-08-21 — this was earlier a monopoly, and it bred
   false ceilings about the library); when a raw shape recurs ≈3 times, promote
   it into a named combinator.
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

### Staged run pipelines (`stagedRun`) — added 2026-08-21 (#2670)

`decisionRun` answers "what happens next" in one synchronous step. The run tick's
remaining body is a different shape: long flows interleaving snapshots, decisions,
and guarded effects — admission, four recovery handlers, queued-handoff repair,
completion settlement, spawn. Per issue #2670, a second combinator is sanctioned:
`stagedRun(name, stages)`. Only the top-level composition is necessarily
superpipe — the interpreter makes stage ordering, halts, and error wiring
structural. Each stage is a callable obeying one of five stage contracts; the
body may be a plain function or a composed sub-pipeline, which are
interchangeable (after composition, a pipeline is just a function — the
interpreter never distinguishes them). The five contracts:

- **`snapshot`** — read-only; gathers declared state keys into ctx (async
  allowed); keys that must be mutually coherent are gathered in one repository
  read, not stitched from separate queries.
- **`decide`** — pure and synchronous; a `decisionRun` core; stamps a decision
  union member.
- **`effect`** — mutating; declares `reads`/`writes` state keys; persistent
  writes go through atomic repository primitives (condition 1), while external
  side effects — network, publishes, session injects — are gated by a durable
  intent row whose conditional write validates the stage's declared read
  preconditions (the Phase 0 reservation mechanism, which also dedups replay)
  and carry condition 5's idempotence/compensation obligation.
- **`resnapshot`** — re-reads the specific keys a later stage depends on.
- **`halt`** — terminal; returns the outcome.

Branching is deliberately not a stage type: a `decide` stage's output drives
superpipe's native `!`/`?` control flow. A separate `branch` stage would duplicate
the library. Action routing rides the same machinery: a decision member's payload
enters ctx, action-specific stages declare it as an optional dependency (`?dep`
skips the stage when the decision is not that member) or end the flow with a halt
(`!dep`) — the P3/P4 idioms, no per-action dispatcher.

**Conditions on `effect` stages.** The prior boundary — effects at pipeline
boundaries, a pipeline never owns atomicity — was drawn because superpipe provides
no atomicity. It is retained in substance and relocated: atomicity moves into
repository primitives, which effect stages must call.

1. **Atomicity delegation.** Every effect stage writes persistent state through
   CAS, reservation, or transition-table-guarded primitives (Phase 0 below) — a
   transition-table guard qualifies only when guard and write commit as one
   conditional update or transaction, never check-then-write. The conditional
   update carries the stage's declared read preconditions as well (the spawn
   reservation validates the task's status while reserving the execution), so a
   concurrent external change to a declared read key — a mid-tick park — fails
   the same CAS into `superseded`, not just a change to the written row. Blind
   read-modify-write inside an effect stage is banned.
2. **Declared read/write sets, enforced.** The interpreter refuses to run a flow
   in which a stage reads a key that an earlier effect stage wrote unless an
   intervening `snapshot`/`resnapshot` re-gathers it — staleness prevention made
   structural, the same way `!hasDecided` made precedence structural.
   Re-gathers are guard-aware (review rounds 1–2 of the combinator PR): an
   *unconditional* re-gather clears the write for every reader; a `when`-guarded
   re-gather re-enables reads only for stages sharing its guard, because the
   guarded pair always fires together (branch presence is monotone within a
   run). Symmetrically, a key introduced only by a guarded gather is readable
   only under that guard until an unconditional gather provides it. The
   declaration is load-bearing by construction: stages access state through the
   declared keys' accessors, not the raw context, so an undeclared read is not
   expressible.
3. **CAS failure is a decision, not an error.** A failed CAS stamps a
   `superseded` outcome; the flow re-snapshots or halts for this tick. No
   in-tick retry loops. The recovery-handler-overwrites-`stopped`-with-`blocked`
   race class becomes structurally impossible instead of tested away. Effect
   stages return their primitives' CAS outcomes and the interpreter — not the
   effect body — stamps `superseded`, keeping decision-stamping out of the
   effect contract; whether the flow then re-snapshots or halts for this tick
   is the outcome's routing, never the effect's choice. Correlated transitions
   (an execution, its run, the canonical task) compose into one transactional
   primitive per set or compensate already-committed writes before either
   route — halt or re-snapshot — so a `superseded` outcome never continues
   from a half-applied set.
4. **Microtask pinning.** Decision item 5's proof obligation carries over: any
   `stagedRun` invoked from the run tick pins its microtask profile in tests.
   `decide` stages stay synchronous; `snapshot`/`effect` stages may use
   `.endAsync`.
5. **Idempotence or compensation** at every effect stage (unchanged from
   Decision item 4).

**Stage failures.** Any failing stage — a throwing `snapshot`/`resnapshot` read
or a throwing `effect` — fails the pass: the interpreter catches, logs, and
returns an error outcome; no in-flow retry. Before returning, it unwinds the
compensations of every effect stage it *started*, in reverse order — including
the failing stage's own partial work (a compensation is registered when the
stage starts, not when it completes). Persistent compensations are conditional
inverse operations — CAS-guarded or durable saga steps: a compensation that
finds newer state records an incomplete unwind instead of clobbering it. Each
compensation failure is itself caught, logged, and durably recorded while
unwinding continues, so a failed pass leaves no compensable-but-uncompensated
effect behind and an incomplete unwind is discoverable. Recovery is the caller's re-entry with a fresh snapshot
plus condition 5 (for the run tick, the next tick). In-memory compensation
covers only the live process: correlated persistent-transition sets commit as
one database transaction or carry a durable saga record completed or reversed
during recovery, and replay that crosses a process crash needs condition 5's
durable arm — a persistent idempotency key or outbox record. **Deferral
(2026-08-22, landed with the combinator):** the durable saga/outbox arm is
deliberately deferred — no flow's compensation must currently survive a process
crash (daemon-crash recovery is reconcile/rehydrate plus caller re-entry), so
the landed interpreter registers compensations in memory only. The deferral is
recorded in the module as `DEFERRED_DURABLE_COMPENSATION_ARMS` and pinned by
the contract suite; revisiting it is its own evidence-backed change when a flow
grows that requirement — the caveats narrow, never expand.

**The RFC's open questions, answered:**

1. **Location:** new module
   `packages/daemon/src/lib/space/runtime/staged-run.ts`; `space-runtime.ts` is
   already 8k+ lines. This makes `staged-run.ts` the second blessed combinator
   location alongside `decision-pipeline.ts` (Decision item 3 amended above) —
   not a second import boundary; raw imports elsewhere follow the rule of three.
2. **Stage file layout:** grouped by sub-flow — one module per recovery handler
   or sub-pipeline, stages co-located with their types and tests, mirroring the
   pilot-3 extraction modules (`run-tick-admission-gates.ts` & co). Not one file
   per stage.
3. **Spawn loop:** stays sequential — the shell owns the loop and invokes
   per-execution effect stages, one bounded pass per execution; never
   `Promise.all`, and never recursive re-entry that would make the pipeline
   itself the loop (the "never the loop" boundary above). The current loop is
   ordered and that ordering is behavior; tests pin spawn order. Spawn steps
   are await-heavy, not
   compute-hot, so per-stage overhead is negligible against spawn latency (the
   hot-path rule targets tight loops, not awaited boundaries). Parallelism would
   be its own evidence-backed change.
4. **Cancellation:** `withSignal` stays requirement-driven (item 7). The named
   candidate requirement: aborting in-flight stage awaits (e.g. a run-status
   transition) when a newer tick generation supersedes this one. The signal is
   owned by the runtime class (resource-ownership rule), introduced no earlier
   than Phase 2, and only where a test demonstrates the race. The spawn
   reservation, not cancellation, is the correctness mechanism. An effect that
   commits synchronously before its first await cannot be aborted at all — the
   condition 1 guard is its mechanism; the signal only narrows await windows.
5. **`decisionRun` vs `stagedRun`:** both stay. `decisionRun` remains the proven
   sync point-decision combinator; no existing call sites migrate. `stagedRun`
   composes `decide` stages that wrap `decisionRun` cores internally. Two
   combinators, two jobs.

### Where superpipe must not be used

- **As a state machine or unbounded fold.** State lives in the runtime/DB; a
  pipeline decides one step. Stream reduction may use a pipeline as the per-event
  reducer body (Phase 3), never as the loop.
- **As a free-form effect executor.** Effects happen at pipeline boundaries, or
  as declared `effect` stages inside `stagedRun` under the five conditions in
  "Staged run pipelines" (revised 2026-08-21). DB writes, network, publishes,
  session injects never appear as ad-hoc mid-pipeline steps; a pipeline still
  never owns atomicity — effect stages delegate it to repository primitives.
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
| P2 awaitable planning flow | async deciders, `endAsync` | **pilot used sync cores instead**; async variant unproven in-repo; staged effect boundaries (Decision item 4) are the sanctioned async form meanwhile — P8 (2026-08-21) supersedes for staged flows |
| P3 guard/validation gate | boolean `!dep` halts | eligibility, preflight decline |
| P4 optional stages | `?dep` skips when undefined | conditional normalization |
| P5 callback continuation | `next` keeps run open | avoided — abort abandons retained `next` |
| P6 per-event reducer | pipeline as reducer body | stream folds (Phase 3) |
| P7 functional sandwich | read → plan → apply | the adopted macro; pilot + Phases 1–4 |
| P8 staged orchestration | `stagedRun`: snapshot/decide/effect/resnapshot/halt | run-tick recovery handlers, handoff repair, settlement, spawn (rollout below) |

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

**2026-08-21 addendum:** `stagedRun` adds a second combinator to learn, and its
Phase 0 changes product behavior — racy writes that were silently tolerated
become `superseded` outcomes — so Phase 0 carries its own characterization pins.
Per #2670's acceptance criteria, the caveats this ADR records must narrow as
phases land, never expand.

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

## Pilot 4 — agent message-delivery cores (2026-08-21)

Pilot 4 carried the pattern below the Space runtime, into the agent layer's
message-delivery chain (`packages/daemon/src/lib/agent/`). Four cores were
extracted over PRs 2–5 from decision-table pins written in PR 1, wired into
the four production call sites in PR 6, and the two live incident bugs the
pins surfaced were fixed in PRs 7–8:

- `message-ownership-gates.ts` — `resolveMessageOwnership` (the typed
  ownership answer: durable job queue / in-memory queue / unowned), flush
  planning (`planFlushDelivery`), role resolution (`resolveDeliveryRole`), and
  defer admission (`decideDeferAdmission`).
- `context-reset-planner.ts` — `planInjectContextReset` and
  `planTurnEndFlushContextReset`: whether a delivery clears conversation
  context first, and — as a typed reason — why not.
- `turn-outcome-classification.ts` — `classifyTurnCompletion` (the
  completed / terminal-error / recoverable-error taxonomy with detail
  fallbacks), `shouldRearmSpuriousTurnEnd`, and the reconcile pair
  (`decideReconcileAdmission`, `selectStrandedDeliveries`).
- `message-delivery-pipeline.ts` — the two `decisionRun` compositions:
  `decideInjectDelivery` (consumed → failed-reopen → defer admission →
  context reset → deliver) and `decideTurnEndFlush` (empty → ownership →
  context reset → final), each stamped as a typed plan the shell interprets.

The two main pipelines are interpreted at `injectMessageIntoSession`
(`runtime/task-agent-manager.ts`) and the turn-end flush
(`query-mode-handler.ts`: `handleQueryTrigger` and
`sendEnqueuedMessagesOnTurnEnd`'s V2 paths); the point decisions at
`driveDeliveryTurn`'s tail and `reconcileStrandedDeliveries`
(`agent-session.ts`), where the throws, reopens, and re-enqueues stay inline
as effects. `deliverMessage`'s role resolution stayed inline deliberately —
rewiring it to `resolveDeliveryRole` would have added churn without clarity —
so that core function ships as a pinned decision table without a production
caller, the pilot-4 instance of pilot 3's shadowed-arms phenomenon.

**Lesson (a): OWNERSHIP MUST HAVE ONE TYPED ANSWER.** The duplicate-delivery
bug after a model switch (#2598, Space task #1101, fixed just before the
pilot) was two partial ownership sources — the durable job queue and the
in-memory `MessageQueue` — each consulted by different code paths with no
unified resolution, so turn-end replay and stranded-delivery reconciliation
could each re-enqueue a message the other still owned. The pilot's answer is
the `MessageOwnership` union: reconcile routes both sources through
`selectStrandedDeliveries` (the durable set plus the in-flight predicate),
while the flush planner runs `resolveMessageOwnership` per message — its
interpreter still resolves memory-queue ownership caller-side, pre-filtering
on `hasPendingOrInFlight` and feeding the planner an empty in-memory set, so
the typed `memory_queue` arm fires only in the pinned decision tables — and a
message's owner is a typed value, not whichever set the surrounding code
happened to check.

**Lesson (b): ORDERING CONSTRAINTS BELONG IN THE PLANNER, NOT THE CALLERS.**
The wiped-handoff incident (#1085, fixed in PRs 7–8) was clear-vs-batch
ordering implicit in call order across two modules: the turn-end flush
delivered a task's handoff and a later idle clear wiped it, because nothing
anywhere stated "the clear precedes the batch". `planTurnEndFlushContextReset`
now decides `clear_then_flush` as data — and refuses to clear over
unconsumed delivered work (`unconsumed_work_pending` on the inject side) —
while the interpreter emits the confirmed clear at the front of the flush
batch, with PR 7 making `clearConversationContext` resolve only on the SDK
result event so "confirmed" is real. An ordering a caller must maintain by
statement placement is a decision the planner owes a field for.

**The pattern was already half-landed.** `message-delivery.ts` entered the
pilot with typed outcome unions (`DriveTurnOutcome`, `FeedSteerOutcome`) and
pure classifiers (`isTerminalTurnError`, `isRetryableErrorResultSubtype`,
`classifyReclaimTermination`); the pilot finished the file's own trajectory
rather than importing a foreign style — decisions as pinned tables, effects in
the shells, and the cores import those classifiers instead of re-deriving
them.

Deliberate non-goals: `driveDeliveryTurn`'s lock/admission/batch-narrowing/
stall-watchdog mechanics remain as-is (loop mechanics, locking, and the stall
watchdog are the shell's job), and the V1 env-gated legacy path
(`HYPERNEO_MESSAGE_DELIVERY_V2=0` → memory-queue delivery) is untouched, so
`deliverRowsViaMemoryQueue` keeps its own guards.

The closing sweep found no dead copies at the call sites — PR 6 had already
deleted the inline active-set filter (`deliverEachUnderV2`) it replaced with
the flush plan's skip list, and the role-resolution and taxonomy candidates
were the deliberate-inline cases above. One production-dead duplicate
remained elsewhere: the standalone `reconcileStrandedDeliveries` export in
`message-delivery.ts` (carried through PR 6 for its pinned outbox tests)
duplicated the stranded-selection loop; it now composes
`selectStrandedDeliveries` like the live `agent-session` method. Every core
export is production-consumed or pinned by the decision-table suites; knip
(files/dependencies/exports), oxlint, and `tsc --noEmit` are clean.

Costs: 490 lines of new pure modules (126 + 64 + 104 + 196). The four sites
were not shrunk — `injectMessageIntoSession` 125 → 223 lines, the
`query-mode-handler` flush cluster 134 → 286 across its methods,
`driveDeliveryTurn` 337 → 368, `reconcileStrandedDeliveries` 43 → 54 — but
most of the growth is the PR 7–8 fix interpretation, not refactor overhead;
the behavior-neutral wiring PR netted +32 daemon src lines. Daemon totals
across PRs 1–8: src +1,512/−330, tests +4,714/−101. As in pilot 3, the value
is testability, and here it was incident-shaped: writing the pins surfaced
two live bugs (the pre-pilot #2598 ownership race and #1085's wiped handoff)
that the old inline cascades kept invisible.

Pilot 4 PRs: #2618 (decision-table pins), #2622, #2636, #2639, #2648
(extraction), #2662 (call-site interpretation), #2694 + #2728 (incident
fixes), plus this closing sweep.

## Pilot 5 — MCP tool-handler staged pipelines (2026-08-21)

Pilot 5 carried the pattern from the runtime into the Space MCP tool surface. All
eight task-mutation tools in `packages/daemon/src/lib/space/tools/space-agent-tools.ts`
(`create_standalone_task`, `update_task`, `retry_task`, `cancel_task`,
`publish_task`, `archive_task`, `reassign_task`, `approve_task`) are now staged
interpreters over extracted routing cores — `update_task` alone runs the full
three-core pipeline, the other seven call `task-transition-routing.ts` routers
directly, and only `approve_task` additionally consumes the autonomy-admission
core:

- `tool-admission-gates.ts` — the shared autonomy-admission core:
  `resolveEffectiveAutonomyLevel`, `decideAutonomyAdmission`, and
  `TOOL_AUTONOMY_REQUIREMENTS`, now the single place *fixed session-write*
  gating policy lives (previously a hardcoded `SESSION_WRITE_AUTONOMY_LEVEL = 4`
  const inside the handler factory plus prose deny strings assembled at each
  throw site). Workflow-derived requirements are deliberately outside the table:
  `approve_task`'s threshold is gathered by the caller — `space-agent-tools.ts`
  derives the workflow's `completionAutonomyLevel` (default 5) and passes it in
  as `required` — while `routeApproveTask` only compares its inputs. The
  threshold default has further owners: the bound node-agent approval path
  (`end-node-handlers.ts`) independently derives
  `workflow?.completionAutonomyLevel ?? 5` and enforces its own denial wording,
  `task-agent-manager.ts` repeats the same default when advertising
  `approve_task` availability in end-node prompts, and the `?? 5` fallback also
  lives in the shared auto-close helper
  (`packages/shared/src/space/workflow-autonomy.ts`) and the web autonomy
  summary's displayed required
  level — so a threshold or default change must touch every owner until the
  derivation is centralized, or backend approval behavior diverges from the
  UI's auto-close count and displayed level. Distinct from that runtime
  missing-value fallback, creation and storage default the level to **3**: the
  visual editor's state init and serialization (`?? 3`), import handling
  (`space-export-import-handlers.ts`), the `completion_autonomy_level`
  column backfill (DEFAULT 3, with per-template overrides), and the workflow
  repository, which defaults omitted values to 3 when creating workflows and
  when mapping *summary* rows — but the full-workflow mapper (`rowToWorkflow`)
  assigns the nullable column through unchanged, so a legacy-null row resolves
  to 3 through summary loads, while full-workflow loads pass the null through:
  `?? 5` consumers coerce it back to 5, but the primary `approve_task` caller's
  `!== undefined` guard admits the null, the threshold becomes null, and
  `level < null` is false — so approval **bypasses the threshold entirely** for
  legacy-null full-workflow loads. The defaults disagree and the null leaks;
  both are part of the same centralization question. The
  router owns only the denial routing — reason, message, and
  precedence against the target check (see the second recorded asymmetry
  below).
- `task-transition-routing.ts` — pure routing tables: `routeTaskUpdate` (the
  old seven-branch inline cascade as a typed precedence table), the shared
  `routeTaskTarget`, and one router per remaining tool.
- `space-tool-pipeline.ts` — the `decisionRun` composition for `update_task`
  (autonomy → arg-changes → target → routing arbiter), exposed as
  `decideUpdateTask`.

**MCP TOOL HANDLER = STAGED PIPELINE.** The sanctioned handler shape,
generalizing the pilot-1 sandwich to tool calls: admission (autonomy) →
arg validation → target/scope resolution → action routing (pure table) →
effects (manager/runtime calls) → result folding (a JSON result always; audit
logging and task-updated emission are optional stages). Everything up to and
including action routing is pure and
unit-pinned; the shell gathers snapshot inputs (task row, run-active flag,
workflow completion level, effective autonomy) and interprets the routed
action. The stage order is the precedence contract and is the *implemented*
order in `update_task`'s `decisionRun` (autonomy → arg-changes → target →
routing arbiter), which preserves the pre-pilot precedence: a no-fields call
fails with the argument error even for a missing or cross-space task id. A new
handler following this shape inherits that arg-before-target ordering. The
gather layer itself sits *ahead* of that contract: `update_task`'s shell awaits
`getSpaceAutonomyLevel` before computing `hasChanges` or reading the task, even
though `update_task` has no entry in `TOOL_AUTONOMY_REQUIREMENTS` and its
autonomy gate is consequently a structural no-op — so a failing level lookup
surfaces before the documented argument/target errors, and the read adds an
async window the pre-pilot handler did not have (the gather was introduced by
the pilot). The pure gate order is the precedence contract of the core, not
the complete observable precedence of the tool call; gathering autonomy only
when the tool has a requirement is the code-level follow-up. Audit
and emission coverage is as-implemented, not uniform: every handler that
reaches its try block folds to
a JSON result, `update_task`/`publish_task`/`archive_task`/`approve_task` both
audit and emit, `create_standalone_task` audits without emitting, `cancel_task`
emits without auditing, and `retry_task`'s standalone branch and
`reassign_task` do neither — `taskManager.retryTask` publishes nothing, so that
mutation reaches no `space.task.updated` subscriber (the workflow-backed retry
branch does, via the runtime's recovery emit). `reassign_task` is moreover a
no-op beyond validation: `SpaceTaskManager.reassignTask` ignores its agent
parameters, checks existence and an allowed-status list, and returns the task
unchanged — nothing is mutated to audit or emit, a review question in its own
right (deliberate deprecation or lost implementation?), not merely an emission
asymmetry. Pre-try gathers bound the always-JSON claim as a rule: any read
taken before a handler's try block — `approve_task`'s awaited autonomy snapshot
(`getSpace`/`getSpaceAutonomyLevel`), `publish_task`/`archive_task`'s
`taskRepo.getTask`, `create_standalone_task`'s workflow resolution — rejects
the MCP call on error rather than folding into JSON, while `update_task`
performs the same autonomy gather inside its try and folds. That
spread is another facet of the emission-ownership question below. `update_task` is the fullest instance: its `TaskUpdateRouting` union —
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
2. **Autonomy deny messages have three provenances.** Session-write denies are
   composed by `decideAutonomyAdmission` ("…Request human approval."),
   `approve_task` denies inside `routeApproveTask` with submit-for-approval
   advisory text, and the bound node-agent path (`end-node-handlers.ts`) with
   its own findings/QA-aware advisory; the shared core parameterizes the tool
   name but not the remediation wording, so unifying any two producers still
   leaves the third divergent.

**Boundary caveats.** `cancel_task` routes *after* its primary effect —
`taskManager.cancelTaskCascade` runs first and `routeCancelTask` then decides
only whether to also cancel the workflow run: an action router over
post-effect state, not an admission gate (target errors surface from the
manager throwing, as before). `reassign_task` keeps no target gate, and its worker validation precedes target
resolution — `routeReassignTask` runs first, so an invalid `custom_agent_id`
wins over an unknown `task_id`, with target errors surfacing only later from
the manager throwing (pre-pilot parity; inserting `routeTaskTarget` in the
documented position would change observable error precedence), and
`approve_task` gathers `spaceLevel` preferring
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
target checks in `get_task_detail`, the node-agent `get_task`, the RPC
`spaceTask.get`, `send_message_to_task`, `list_task_members`,
`approve_pending_completion`, `attach_forge_task_evidence`, the task branch
of `resolve_forge_scope`, and the RPC message handlers
`space.task.sendMessage`/`space.task.activateNodeAgent`
(`rpc-handlers/space-task-message-handlers.ts`), whose space-mismatch case
collapses into the not-found error rather than a distinct message; the bound
task-agent surface (`runtime/task-agent-manager.ts`), whose `onArchiveTask`
re-implements the archive-active-run gate with its own message variant and
whose `onPublishTask` enforces no draft-only gate at all — `publishTask` is a
bare `setTaskStatus(taskId, 'open')`, so the node-agent publish path can
publish a non-draft task that both the MCP tool (`routePublishTask`) and the
RPC handler (inline check) would reject;
and the largest ones: the UI-side RPC surface
in `rpc-handlers/space-task-handlers.ts`, which re-implements the update
routing by hand with UI-flavored messages, whose `spaceTask.publish` repeats
the publish target resolution and draft-only gate, and whose
`spaceTask.approvePendingCompletion` repeats the scoped lookup,
pending-checkpoint/review gates, approval effects, and `space.task.updated`
emission of the MCP `approve_pending_completion` handler — each with its own
wording. These are follow-up mini-pilot
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

## Pilot 6 — chain S: verified-stop staged interpreter (2026-08-23)

Chain S took `stagedRun` to production on the smallest staged flow first, as a
deliberate choice: `TaskAgentManager`'s verified-stop ladder (interrupt →
verify → retry → escalate → report), ~90 inline lines driving one session,
with the S1 parity harness already pinning its behavior — including the
process-exit settle race and the `cancellingSessions` interplay. Six PRs:
S1 the parity pin (#2709), S2 the `staged-run.ts` combinator plus contract
suite (#2717, shared with chain P), S3 the `stop-verification-gates.ts` pure
core (#2729), S4 the composed `verified-stop-flow.ts` running beside the
inline ladder (#2763), S5 the swap — ladder deleted, `stopSessionVerified`
now a 17-line interpreter plus a 34-line deps builder (#2787) — and this
closing sweep. One merge-order fact, so "deliberately first" is not read as
merge order: chain P's spawn flow (#2761) landed hours before S4, so
verified-stop was the second merged production consumer of the combinator.

The interpreter: `stopSessionsVerified` keeps the `Promise.all` fan-out (the
pipeline is per-session, never the loop) and the `cancellingSessions` guard;
`stopSessionVerified` itself claims nothing — the flow's first snapshot stage
claims the session out of the manager's index, so a missing session is a
structural branch with its own unregister effect and halt, never an input to
the gates. The interrupt effect binds `stopSessionPreserveDb` (strict); the
ladder position is structural — each decide site calls `decideStopVerification`
with the counters pinned (`interruptAttemptsSoFar` 1, then 2;
`escalationDone` false, then true; `sessionPresent: true` always). Callers
(`parkStoppedWorkflowTask`, `stopActiveWork`) consume `VerifiedSessionStop[]`
unchanged and still warn on unconfirmed sessions.

Boundary caveats, recorded for the same reason as pilot 3's:

1. **The composed flow shadows most of the gate's decision table.** With the
   counters pinned per site, the arms encoding other ladder positions are
   unreachable in production: `sessionPresent: false` (the missing case is
   decided structurally before any gate), `retry_interrupt` at
   `interruptAttemptsSoFar ≥ 2`, `escalate_terminate` below 2 attempts
   (1 < `VERIFIED_STOP_MAX_INTERRUPT_ATTEMPTS` always retries), `report_leak`
   before escalation, and both mid-flow decide stages' bare `{ decision }`
   fallthroughs. Those arms live in the gate suite — the gate remains the
   complete decision table, the flow the ladder; the same dual phenomenon
   pilot 3 recorded, with the same defense (the gate suite pins the table,
   the flow suites pin which cells production occupies).
2. **The gather short-circuit duplicates the gate's first two arms.**
   `gatherSessionLiveness` pre-checks `isStopDownProcessingStatus` and
   `isInterruptInProgress` to skip the process-exit settle await and the pid
   reads, returning synthesized `interruptInProgress: false, livePids: []`.
   The synthesis is coherent only because `inspectSessionLiveness` checks
   status, then interrupt, then pids — a cheap-path guard written with
   knowledge of the gate's precedence (pilot 3's lazy-thunk caveat in another
   shape: the read is skipped, not deferred).
3. **`notes` rides a closure, not declared state.** The flow's `notes` array
   is captured from the enclosing invocation by effect and halt bodies; it is
   not a declared state key, so the declared read/write-set discipline does
   not see it. Append-only within a sequential run and re-created per
   invocation, so there is no staleness hazard — but it is an escape hatch
   from "an undeclared read is not expressible", recorded rather than closed.
4. **The type seam is deliberately loose at the payloads.** State keys are
   typed (`StageView` is a `Pick` of the state interface), but branch payloads
   ride the `when` key as `unknown` and `decision` is `unknown`, so the flow
   casts at read sites (`view.session!`, `view.retryInterrupt as { reason:
   string }`, `view.decision as StopVerificationDecision`). The declared-key
   discipline is enforced by the composition-time contract and its suite, not
   by these payload types; tightening them is combinator work, not flow work.
5. **`superseded` is structurally unreachable here.** Every effect declares
   `writes: []` — no CAS primitives exist to lose — so the shell's superseded
   branch is defensive, and if it ever fired it would surface through the
   fan-out's catch as `stopped: false, detail: 'verified stop crashed: …'`,
   the same channel as a genuine crash. `superseded` becomes real only with
   the run-tick phases and their Phase 0 CAS machinery.

**Compensation: none registered, and the durable arm stays deferred.** Every
effect is idempotent or escalating — a repeated interrupt is harmless,
unregister is idempotent, terminate is the escalation itself — so the flow
registers no compensations at all. What a daemon crash mid-flow actually
leaves (corrected after review of this sweep): the unregister/detach effects
are in-memory-only — cache removal and pid preservation, no DB rows — so the
persistent residue is a possibly-live orphaned SDK process (the interrupt or
escalation that never ran) and, for the park caller, stale `in_progress`
node-execution rows, because `parkInFlightExecutionsForTask` runs after the
verified stop and never ran. Nothing re-runs the ladder for that residue:
`rehydrate()` iterates `listActive()`, which excludes `stopped`;
`parkStoppedWorkflowTask` throws on the invalid `stopped → stopped`
transition before reaching `stopSessionsVerified`; and the space-shutdown
caller finds no in-memory sessions, so its verified stop runs with an empty
list. The residue is reconciled forward, not by unwinding: a later space stop
runs `parkInFlightExecutionsForSpace`, a DB-level sweep that resets stale
execution rows regardless of in-memory state, and a task resume
(`stopped → in_progress` is a valid transition) re-admits the run to the
tick; orphaned processes have no startup sweep and end by their own exit or
manual kill. That is the actual reason the durable arm stays deferred: no
consumer exists for a compensation record — nothing at startup looks for
incomplete unwinds, the in-memory targets of the inverse operations are gone
with the process, and the durable harms are repaired by forward DB sweeps
rather than inverse effects. `DEFERRED_DURABLE_COMPENSATION_ARMS` in the S2
contract suite pins the deferral; a flow whose effects carry durable inverse
obligations would reopen it.

**The closing sweep found no dead inline copies.** The S5 swap deleted the
whole ladder — the inline loop, `gatherStopVerificationSnapshot`,
`readLivePidsAfterSettle`, and the S4-era `stopSessionVerifiedViaFlow` twin —
and no reference to any of them remains. knip (files/dependencies/exports),
oxlint, and `tsc --noEmit` are clean. Every core export is
production-consumed or pinned directly by the gate suites (Decision item 6):
`decideStopVerification`, `isStopDownProcessingStatus`,
`assembleVerifiedStopResult`, and the `SessionLivenessSnapshot` /
`StopVerificationDecision` types are consumed by `verified-stop-flow.ts`;
`inspectSessionLiveness`, `VERIFIED_STOP_MAX_INTERRUPT_ATTEMPTS`, and the
remaining snapshot/assembly types are pinned by
`stop-verification-gates.test.ts` alone — the flow pins the attempt bound
and ladder position as literals and reaches the liveness inspection only
through `decideStopVerification`, which wraps the inspector (caveats 1–2);
`runVerifiedStopFlow` /
`VerifiedStopFlowDeps` by `task-agent-manager.ts` and both flow suites; the
combinator's `stagedRun` / `StagedRunOutcome` by both production flows
(`verified-stop-flow.ts`, chain P's `spawn-flow.ts`);
`DEFERRED_DURABLE_COMPENSATION_ARMS` by the S2 contract suite. Live
near-duplicates deliberately kept: `stopSessionPreserveDb` itself — the
unverified one-shot interrupt+cleanup still called directly by
`respawnRateLimitedExecution`, `cancelBySessionId`, `restartStuckSubSession`,
`shutdownTask`, and `cleanup`, none of which verify liveness afterward (the
verified flow binds it as an effect dep rather than converting its callers);
the gather guards of caveat 2; `post-approval-router.ts`'s
`SessionLivenessProbe` — a boolean session-presence check, a different
concept from the processing-state/pid liveness ladder and never a gates
consumer despite the name; `SessionManager.preserveRootPids` — the pid
bookkeeping under `unregisterSession` (its host
`interruptInMemorySession`, interrupt and cleanup without a verification
ladder, is production-unreferenced — its only callers are its own unit
tests, so it is recorded here after review as pre-existing dead machinery
outside chain S's conversion, a removal candidate for a code-change PR
rather than something this docs-only sweep deletes); and the `app.ts`
process-watchdog callback, which folds `getTrackedAgentRootPidsSplit`
from both managers into `cleanupSuspiciousProcesses` — the split
determines the daemon-owned descendant set and therefore which
long-running owned processes (`bun test` past 15 minutes, `make dev`
past 24 hours) are SIGTERMed with their process groups. That last one is
an operational decision surface, not status reporting (corrected after
review): a third consumer of the same pid split whose ownership question
differs from the ladder's liveness question, and any later consolidation
must respect both.

**Costs:** production +315 across the chain — gates +92, flow +268,
`task-agent-manager.ts` net −45 (S3 +62/−44, S4 +54, S5 +1/−118) — on top of
the shared combinator landed at S2 (+738). Tests net +1,861 (S1 +654/−7
including the settle-window upper bound, gates suite +367, two flow suites
+419 each, S5 +25/−16) on top of the shared 1,975-line S2 contract suite.

## Pilot 7 — spawn/activation seam + the Phase 0 consumption record (Chain P, 2026-08-23)

Pilot 7 (sub-pilot 7, "Chain P") converted the workflow-node spawn seam:
`TaskAgentManager.spawnWorkflowNodeAgentForExecution` became a staged
interpreter over extracted cores, and the `activateTargetSessionsForMessage`
lazy-activation path gained a pure routing core it interprets inline around
its shell effects (no `stagedRun` — see the boundary caveats). The chain
made the seam the first production
consumer of `casExecutionStatus` (#2678) and the spawn reservation (#2680)
— `casStatus` (#2677) and transition-table enforcement had already gained
theirs in the recovery paths just before the chain (#2684, #2682). The
chain ran pin → extract → compose → apply: PR 1 (#2712)
pinned the admission table and the tolerated non-CAS execution-status
writes as the Phase 0 BEFORE picture; PRs 2–3 (#2725, #2735) extracted the
pure cores with inline interpretation (no behavior change, pins green);
PR 4 (#2761) composed the spawn flow over `decisionRun` + `stagedRun`
additively; PR 5 (#2770) applied it — the method became the flow
interpreter, every execution-status write at the seam moved onto
`casExecutionStatus`, and the spawn pass reserves the task. This PR is the
closing sweep.

Extracted:

- `spawn-admission-gates.ts` — the admission decision (`reuse_live |
  wait_concurrent | proceed_fresh | reject_permanent | reject_transient`)
  over plain inputs, mirroring `validateTaskAllowsSpawn` semantics.
- `spawn-admission-decision-pipeline.ts` — the same gates as a
  `decisionRun` gate list (`decideSpawnExecutionAdmissionViaPipeline`),
  parity-pinned against the pure function across the full input matrix.
- `spawn-slot-resolution.ts` — slot lookup, `buildSlotOverrides`,
  base-session-id/availability, workspace resolution, session-init
  assembly.
- `spawn-flow.ts` — the `stagedRun` composition: snapshot → decide
  (branch routing via `?dep` guards on the decision member, no per-action
  dispatcher) → reserve/spawn → bind → attach/register → kickoff → flush →
  halt, with reservation release as the registered reverse-unwind
  compensation, joined by the spawned-session cancel once session creation
  has resolved — if `createSubSession` throws after registering the
  session but before returning (e.g. a `startStreamingQuery` rejection),
  the attempt box never records the id and the compensation releases the
  reservations without cancelling the partially created session.
- `activation-routing.ts` — `decideActivationRouting` (reuse_existing /
  reset_pending_and_continue / reject_undeclared / spawn_with_timeout /
  return_empty) plus the `selectWorkflowNodeForAgent` target-node selector.

**Phase 0 consumption.** `casExecutionStatus` — extended for the seam
to carry the bind payload atomically (`agentSessionId`/`startedAt`/
`completedAt`), an `expectAgentSessionId` NULL-safe identity guard, and
`updated_at` + reactive notification on a win — is the write path at six
sites: the flow's live-session rebind and post-create bind,
`createSubSession`'s reuse-target and fresh-create binds and its stale
co-owner idle flip, and the activation path's dead-session reset. The
spawn pass reserves the task through
`reserveSpawnForTick`/`releaseSpawnReservation`
(`spawn_reservation_token`; won only when the status is reservable —
draft/open/in_progress/review/approved/blocked — and no token is held),
released immediately after the bind is confirmed (release-once closure, so
a stalled attach/kickoff cannot starve sibling executions) and compensated
on unwind; `clearAllSpawnReservations` runs at first-tick rehydration so a
crash cannot strand a token. The tick's trailing `open → in_progress`
promotion goes through `casStatus(['open'], 'in_progress')`, with
auxiliary fields and emission written only on a win. Pilot 7 is the first
consumer of `casExecutionStatus` and the spawn reservation; `casStatus`'s
first consumer predates the chain (#2684 routed the alive-stuck recovery
handler's blocked write through it), as does transition-table enforcement
(#2682, asserted at the top of `updateTaskAndEmit`).

**Superseded-outcome behavior deltas, pinned both ways.** The BEFORE pins
(#2712) recorded unconditional writes: a live-session rebind whose
`in_progress` write clobbered a concurrent DB flip; a post-create bind
with no status precondition, whose readback mismatch was misflagged as
corruption; a dead-session activation reset as an unconditional
status-only write. The AFTER pins (#2770) record the superseded outcomes —
a losing CAS means the guarded precondition no longer matched (the row
moved concurrently, the observed status was not bindable, or the identity
guard found an unexpected existing binding), not proof of which writer won,
and the call skips instead of clobbering or misflagging. Concretely: a
parked (`stopped`)
task on the fresh-spawn arm is admitted by the gates (the passes pin) and
stopped by the reservation — no spawn, no execution write; the `reuse_live`
arm deliberately precedes every task-status gate (the archived-task-rebind
pin), so a parked task whose execution still has a live indexed session
rebinds through the guarded CAS without acquiring the reservation; a park
landing mid-spawn-pass
fails the next execution's reservation, so the remainder does not spawn
onto the parked task, and the trailing promotion CAS-loses instead of
resurrecting it (pinned in the tick-loop suite); a mid-spawn cancel loses
nothing — the bind CAS supersedes, the spawned session is compensated
(cancelled and unregistered under preserve-DB semantics: only the direct
`createSubSession` inner-bind abort deletes the never-streamed row), the
cancelled row is not resurrected, and no rejection goes unhandled; a
superseded spawn is skipped — not classified — by the tick spawn loop,
queued-handoff repair, and the activation path, while the post-approval
router maps it to a benign skipped route that persists
`postApprovalBlockedReason` as durable diagnostic state rather than
silently clearing the dispatch — display-only today (`mapPostApprovalDispatchWarning`
feeds the detail surfaces; no reader schedules a retry, an `approved` task
is already-resolved for settlement, so only a fresh human approval
re-dispatches). Review rounds added
the finer pins: the bind guards on the admission-observed status (a
mid-spawn quiesce to `idle` is not laundered by an inner pre-bind), the
identity guard on the post-create bind (it predicates on the
admission-observed binding, so a foreign binding cannot be overwritten
there; the live-session rebind guards on status only — a pointer-only
change by another path while the observed status holds can still be
overwritten by the stale rebind), and the
`freshSessionOnly` descope (a reused session is never transferred). The
50 ms DB-polling concurrent-spawn waiter became an explicit promise
handoff with the same three outcome classes (resolved/failed/timeout):
waiters settle at the winning bind, re-check the DB before rejecting on
peer failure, remove themselves on timeout, and are settled by
`cleanupAll`. A new real-repository suite (`task-agent-manager-spawn-cas.test.ts`)
drives `spawnWorkflowNodeAgentForExecution` directly against real task and
execution repositories — session creation and attachment stubbed — to pin
the mid-spawn-loop park and cancel races at the flow level; the tick-loop
suite covers the loop half with a superseded-throwing spawn stub. No single
test runs the real tick loop over the real reservation and interpreter; the
two halves are pinned separately.

**Pilot 3 race note — closed at the TaskAgentManager seam.** The Pilot 3
caveat's spawn-seam portion — a park landing while the spawn loop awaits
the first of several spawns still spawns the remainder with the stale
task, and the trailing unvalidated update writes the parked task back to
`in_progress` — is closed by the reservation and the CAS'd trailing
promotion, both pinned (#2770); likewise the observation that
`validateTaskAllowsSpawn` passes a parked task (it rejects only
archived/cancelled/rate-usage-limited statuses) — the reservation, not the
validator, now stops the parked task. Pilot 3's closing requirement —
atomic coordination *plus* the
equivalent guards around every task-status write in the tick — is hereby
half-landed: the spawn-seam half. The remaining guards (handoff repair,
`attemptBlockedRunRecovery`, the admission interpreter's blocking branches,
the four recovery handlers, the spawn-failure `blockRun*` calls) stay
exactly as recorded in Pilot 3 and belong to the later staged-rollout
phases; this chain touched none of them.

**Boundary caveats.** First, nothing aborts an in-flight spawn: the bind
re-checks the execution's guarded status and binding, never the task row,
so an execution that already holds the reservation when the park lands
still spawns and binds onto the parked task — the real-repository suite
pins exactly this (the first gated spawn resolves and goes `in_progress`
after the task is stopped; only the remainder is rejected). Released at
the confirmed bind, attach/kickoff/flush run unreserved. The guarantees
are therefore scoped to *subsequent* executions — they no longer spawn —
plus the trailing promotion CAS-loss; no in-flight execution or post-bind
stage is aborted.
Second, the flow never transfers a session: the `reuse_live` arm only
rebinds an execution whose own indexed live session exists
(`freshSessionOnly`), and cross-execution session reuse survives only in
`createSubSession`'s direct path — the deliberate final-round descope that
collapsed the transfer-rollback, per-agent exclusivity, and double-flush
findings. Third, the parked-task asymmetry is policy, not accident:
admission does not reject `stopped`; on the fresh-spawn arm the
reservation does (and `reuse_live` precedes task status entirely) — the
admission decision table alone is not the complete spawn policy. Fourth,
admission
reasons are computed twice: booleans in the core, the precise message
re-derived in the shell (`raiseSpawnRejection` re-runs
`validateTaskAllowsSpawn`/`assertExecutionValidAgainstWorkflow`), because
the core's reason enum is coarser than the validators' messages. Fifth,
the activation path interprets its core inline — three
`decideActivationRouting` calls across two fact-gathering stages — with
the spawn call and the 30 s timeout race as shell effects: core-only
extraction, no `stagedRun` composition, deliberately. Sixth, the waiter
map and the flow compensations are in-memory only, consistent with
`DEFERRED_DURABLE_COMPENSATION_ARMS`: a daemon crash mid-spawn is covered
only for reservation liveness — first-tick `clearAllSpawnReservations`
releases the token so another spawn can proceed — while a session row
persisted before the outer bind stays orphaned (rehydration keys on
`execution.agentSessionId`, so nothing picks it up); that session cleanup
remains a deferred durable-compensation gap, not recovered state.

**The closing sweep found no dead inline copies.** Each conversion PR
removed its inline copy as it landed — the admission cascade, the
slot/session assembly, the activation routing cascade, the polling waiter,
the readback corruption check, and the P4-era `spawnWorkflowNodeAgentForExecutionViaFlow`
intermediate. knip (files/dependencies/exports), oxlint, `tsc --noEmit`,
format, and the no-comments guard are clean, with no knip special-casing
for any Chain P module. Every core export is production-consumed or pinned
by the gate suites (Decision item 6): the one production-unreferenced
export, the pure `decideSpawnExecutionAdmission`, is the parity oracle for
the pipeline suite. Live near-duplicates remain, deliberately:
`createSubSession`'s own execution-binding updates (reuse-target bind,
fresh-create bind, co-owner sweep) stay shell effects — the flow calls it
with `deferFreshExecutionBind` + `freshSessionOnly`, so the flow's guarded
outer bind is authoritative, while direct callers keep the guarded inner
binds — and `spawnPostApprovalSubSession` remains an inline near-copy of
the flow's stages (init → MCP assembly → create → attach → kickoff),
unconverted; both are future mini-pilot material, not cleanup fodder. The
bindability guard idiom (`SPAWN_BINDABLE_EXECUTION_STATUSES.includes(s) ?
[s] : []`) repeats at the four bind sites. Non-CAS execution-status
writes adjacent to but outside the converted seam survive unchanged —
`respawnRateLimitedExecution`'s reset, the completion/error handlers, the
co-owner sweep's pointer-only preserve arm, and the tick's recovery
writes — later phases' scope, tolerance unchanged.

**Costs:** production +1,547/−545 across PRs 2–5 (five new modules — four
pure cores plus the `spawn-flow.ts` staged composition — 697 lines;
`task-agent-manager.ts` at 4,461 lines — the spawn body became
the `buildSpawnExecutionFlowDeps` adapter plus a thin interpreter); tests
+4,584/−146 across PRs 1–5 — nine new suites (admission gates/table,
decision-pipeline parity, slot resolution, the flow contract, activation
routing ×2, manager flow, the real-repo CAS suite) plus extensions to the
post-approval, tick-loop, and repository CAS-fake suites.

Pilot 7 PRs: #2712, #2725, #2735, #2761, #2770, plus this closing sweep.
Chain P's close unblocks Chain I (sub-pilot 8: the pending-queue drain +
injection shell, tasks #1243+), which shares `injectMessageIntoSession`
call sites with the spawn seam and was sequenced behind the P5 apply.

## Roadmap

- **Done (pilot):** admission gates extracted as pure functions (no superpipe
  needed there); delivery + post-activation decision pipelines; `decisionRun`
  combinator; interpreter dedup.
- **Done (pilot 3):** run-tick admission/settlement/spawn cores and the
  `processRunTick` staged interpreter — see "Pilot 3" above.
- **Done (pilot 4):** the agent message-delivery cores — inject admission and
  turn-end flush `decisionRun` pipelines plus the turn-outcome/reconcile point
  decisions, with both incident bugs fixed — see "Pilot 4" above.
- **Done (pilot 5):** the eight task-mutation MCP tools as staged pipelines
  over `tool-admission-gates` / `task-transition-routing` /
  `space-tool-pipeline` — see "Pilot 5" above, which also records the group
  follow-ups (session tools, agent CRUD, forge/goals, messaging, the RPC task
  cascade) as mini-pilot candidates.
- **Done (chain S / pilot 6):** the verified-stop ladder as a `stagedRun`
  interpreter over `stop-verification-gates.ts`, composed in
  `verified-stop-flow.ts` and applied in `stopSessionVerified` — see "Pilot 6"
  above for the boundary caveats, the compensation deferral, and the closing
  sweep. The stop flow is done; later chains do not revisit it.
- **Done (pilot 7, Chain P):** the spawn/activation seam staged over the
  Phase 0 primitives — see "Pilot 7" above, which records the Phase 0
  consumption ledger, the superseded-outcome pins, and the Pilot 3
  spawn-seam race closure, and whose close unblocks Chain I (pending-drain +
  injection shell).
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
- **Done (combinator, 2026-08-22):** `staged-run.ts` landed — the `stagedRun`
  interpreter plus its contract suite (composition-time stage-contract
  validation, declared-key views, interpreter-stamped `superseded`, reverse
  compensation unwind, microtask-profile pins; branching rides superpipe's
  native `!dep`/`?dep`). Production consumers have since landed: chain S's
  verified-stop flow (PRs 4–5, see "Pilot 6") and chain P's spawn flow. Every
  later phase below composes **on this landed module** — it is never re-landed
  or duplicated.
- **Staged rollout of `stagedRun`** (from #2670; the pilot-3 "future mini-pilots"
  sub-flows become these phases). Every phase composes on the landed
  `staged-run.ts` from S2 (#2717) as a direct import: the run-tick phases —
  `repairQueuedWorkflowNodeHandoffs` (phase 1), the four
  `handle*Executions` recovery handlers (phases 2–5), and the top-level tick
  composition (phase 6) — depend on that module and must never re-land or
  duplicate it:

  | Phase | Scope | Notes |
  | --- | --- | --- |
  | 0 | Task CAS (`casStatus`), transition-table enforcement in `updateTaskAndEmit`, spawn reservation, run/execution CAS, durable intent/outbox + compensation-record repositories | Product behavior change, not refactor; needs characterization pins. The `update_task` tool layer delegates to the repo-layer table — one source of truth (aligns with Pilot 5). Consumption so far: transition-table enforcement (#2682); `casStatus` (#2684 recovery blocked-write; Pilot 7 added the trailing promotion); `casExecutionStatus` across the spawn seam and the spawn reservation (Pilot 7 — its consumers carry the before/after pins). Still unconsumed: the run CAS (`casRunStatus`) and durable intent/outbox + compensation-record repositories. |
  | 1 | `repairQueuedWorkflowNodeHandoffs` as a staged sub-pipeline | Proves the pattern on one opaque effect. |
  | 2 | `handleAliveStuckExecutions` + crash reset | First recovery handler; the `withSignal` candidate lands here only if a test demonstrates the race. |
  | 3 | `handleWaitingRebindExecutions` | |
  | 4 | `handleNonTerminalIdleExecutions` | |
  | 5 | `handleTerminalErrorIdleExecutions` | |
  | 6 | Compose `processRunTick` as one top-level `stagedRun` | Sequenced strictly after the pilot-3 apply PR merges — same lines. |
  | 7 | Same pattern beyond the tick: runtime nags, checkpoint/restore, message dispatch, startup handoff repair | |

- **Candidate idioms (rule of three — extract on the ≈3rd real use, not before):**
  `transformRun` (P1 pure transforms with data-dependent early exit:
  github-normalizer, store delta application, message-shape normalization);
  `requestRun` (web: generation-guarded request/apply — a stale response
  structurally cannot apply — SpaceForge/ScopeDetail fetches, GitHubHealthPanel
  refresh, every version-guarded panel fetch); `transactionalRun` (P7/Phase 4 —
  effects run only after commit); `reduceRun` (P6/Phase 3 — per-event reducer
  bodies; the web subscription-lifecycle machines decompose into this shape plus
  a facade). See "Library surface vs. blessed idioms" for the promotion rule.
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
- Pilot 4 files: `packages/daemon/src/lib/agent/{message-ownership-gates,
  context-reset-planner,turn-outcome-classification,message-delivery-pipeline}.ts`;
  interpreters in `runtime/task-agent-manager.ts` (`injectMessageIntoSession`),
  `query-mode-handler.ts` (turn-end flush), and `agent-session.ts`
  (`driveDeliveryTurn` tail, `reconcileStrandedDeliveries`). Pilot 4 PRs:
  #2618, #2622, #2636, #2639, #2648, #2662, #2694, #2728.
- Pilot 5 files: `packages/daemon/src/lib/space/tools/{tool-admission-gates,
  task-transition-routing,space-tool-pipeline}.ts`; interpreters in
  `space-agent-tools.ts` (the eight task-mutation handlers). Pilot 5 PRs:
  #2663, #2668, #2669, #2673, #2676.
- Pilot 7 files: `packages/daemon/src/lib/space/runtime/{spawn-admission-gates,
  spawn-admission-decision-pipeline,spawn-slot-resolution,spawn-flow,
  activation-routing}.ts`; interpreters in `task-agent-manager.ts`
  (`spawnWorkflowNodeAgentForExecution`, `activateTargetSessionsForMessage`).
  Phase 0 primitives in `storage/repositories/{node-execution-repository,
  space-task-repository}.ts` (#2677, #2678, #2680). BEFORE/AFTER pins:
  `tests/unit/5-space/agent/task-agent-manager-{spawn-admission,spawn-cas,
  spawn-flow}.test.ts`; real-repo race pins in the spawn-cas suite; tick-loop
  pins in `tests/unit/5-space/runtime/space-runtime-tick-loop.test.ts`.
  Pilot 7 PRs: #2712, #2725, #2735, #2761, #2770.
- RFC: issue #2670 (`stagedRun` rollout proposal; its open questions are answered
  by the "Staged run pipelines" section).
- Staged combinator (landed 2026-08-22):
  `packages/daemon/src/lib/space/runtime/staged-run.ts`, contract suite in
  `packages/daemon/tests/unit/5-space/runtime/staged-run.test.ts`. The run-tick
  phases below and every later pilot depend on this module — never re-land it.
- Pilot 6 (chain S) files:
  `packages/daemon/src/lib/space/runtime/{stop-verification-gates,verified-stop-flow}.ts`;
  interpreter in `task-agent-manager.ts` (`stopSessionsVerified` /
  `stopSessionVerified` and the deps builder). Pilot 6 PRs: #2709, #2717,
  #2729, #2763, #2787, plus this closing sweep.
- superpipe 0.17.0 — library semantics map and contract tests produced during the
  pilot.
