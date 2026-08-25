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
seam applied as a staged interpreter over extracted cores and the
lazy-activation path as an inline interpreter over its pure routing core —
and the first production consumer of
`casExecutionStatus` and the spawn reservation, whose superseded outcomes
replace previously tolerated racy writes (the other Phase 0 primitives had
already gained consumers just before the chain: transition-table enforcement
#2682, `casStatus` #2684). See "Pilot 7" below for the pinned behavior deltas,
the Pilot 3 spawn-seam race closure, and the boundary caveats.

Validated further by pilot 9 / chain C (2026-08-23): the message-search FTS
admission gates as a `decisionRun` core and the delivery-status family as a
routing table under `src/storage/` — the first pilot whose cores live in the
repository layer — with the second production FTS admission implementation
(`SessionRepository.rebuildMessageSearchRows`) aligned to the extracted
vocabulary and parity-pinned. See "Pilot 9" below for the lazy-fact caveats
and the deliberate rebuild residual.

Validated further by pilot 10 / chain A (2026-08-23): the `sdk_messages`
read-projection layer of `SDKMessageRepository` extracted as pure transforms
into `sdk-message-projections.ts` — the widened scope's P1 pure-transform form
applied below the runtime, at the persistence boundary. See "Pilot 10" below
for the policy-parameterization discipline the chain settled on and its
closing sweep. (Pilot 8 is reserved for chain I, the pending-queue drain +
injection shell, by Pilot 7's closing note; pilot 9 is chain C's.)

Validated further by pilot 11 / chain B (2026-08-23): the `sdk_messages`
write side — save admission as a pure core over a normalized input, badge
maintenance as an instruction set, and the delivery-status flip as a
plan/interpret whose per-instruction CAS guards apply inside one
transaction (a Phase 4 relative at the storage layer: guarded effects
inside the transaction, not after commit). See "Pilot 11" below for
the coupled TS/SQL badge predicate, the per-variant admission placement
divergence, and the closing sweep.

Validated further by pilot 8 / chain I (2026-08-23): the pending-queue
drain — admission gates and envelope transforms as pure cores, the drain
admission as a `decisionRun`, two flush sites as its gather → decide →
interpret consumers — and the injection shell around the Pilot 4 inject
decision, which stays single-sourced in `decideInjectDelivery` while its
delivery-row steps and v1/v2 branch moved to a steps module. See
"Pilot 8" below for the boundary caveats, the envelope-detector
retirement, and the remaining mini-pilot shelf for
`task-agent-manager.ts`.

Validated further by pilot 12 (2026-08-23, first web-side pilot — the UI
chain's own "pilot 6", renumbered here to keep the ADR sequence unambiguous):
the four hand-rolled LiveQuery subscription hook lifecycles pinned then
migrated onto one pure machine, `live-query-lifecycle.ts` — composition stayed
a plain function under the earn-the-layer rule, so the pilot validates the
reduceRun shape (reducer + effects-executing facade) without yet promoting the
combinator; see "Pilot 12" below for the rule-of-three count and the recorded
config drift.

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

Revised 2026-08-25 after owner review: the combinator-centric organization is
retired as a gate. Direct superpipe composition — one cohesive, business-named
pipeline per business path, mixing decision, transform, and effect stages — is
the default form for new work in daemon and web. `decisionRun` and `stagedRun`
remain for their existing call sites and may be used where they fit, but no
flow must be pre-classified into a category, and no combinator is designed
ahead of the direct uses that would justify it. See "One pipeline per business
path" and Decision item 3.

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

### One pipeline per business path (revised 2026-08-25)

Superpipe's surface is the composition engine itself: dependency-injected named
stages, ctx threading, `!dep`/`?dep` control-flow prefixes, per-stage error
handlers, output picking/merging, sync (`.end`) and async (`.endAsync`)
executors, and `withSignal` cancellation. The default way to use it is DIRECT:
one cohesive pipeline per business path, named for the business operation
(`deliverMessage`, `spawnWorkflowNodeAgent`), whose stages freely mix pure
decisions, transforms, and effects. Nothing requires classifying a flow — or a
stage — into a category before composing it.

The earlier framing — `decisionRun`/`stagedRun` as "blessed idioms" through
which flows were expected to route — is retired (2026-08-25, owner directive).
Pre-categorization made code more complex, not simpler: Chain P's spawn path
was one business flow split into two pipelines, one per category, and the
`stagedRun` contract taxonomy (five stage kinds, declared read/write sets) put
a type system in front of plain composition. Those combinators remain
available — they carry real disciplines their existing call sites rely on —
but they are tools, not gates. New combinators are extracted only after direct
use (≈3 real instances) reveals a recurring shape that earns a name; a
combinator is never designed ahead of its uses.

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
3. **One pipeline per business path; composition is direct (revised
   2026-08-25).** A business logic path — spawn, delivery, stop, recovery —
   composes as ONE superpipe pipeline named for the operation, mixing decision,
   transform, and effect stages; `!dep`/`?dep` handle early exits and
   `.end`/`.endAsync` follow need. Superpipe may be imported anywhere a pipeline
   fits; there is no import boundary (the 2026-08-21 wording kept a two-module
   boundary and treated direct use as the exception — that inversion bred the
   category tax this revision removes). `decisionRun`
   (`packages/daemon/src/lib/space/runtime/decision-pipeline.ts`) and
   `stagedRun` (`staged-run.ts`) remain usable where their shape fits —
   including the gate-ritual dedup `decisionRun` provides — but a flow is never
   required to choose a category or route through a combinator. Extract a NEW
   combinator only after ≈3 direct uses reveal a recurring shape; never design
   one ahead of use.
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
     decision pipeline. Effect stages mid-pipeline are ordinary (revised
     2026-08-25); the discipline they carry: idempotent or compensable, with
     atomic multi-step writes belonging to a transaction shell (P7) or a
     repository primitive. A pipeline owns no atomicity.
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

**Revision 2026-08-25:** this section records the `stagedRun` design as built
and remains in force for its existing consumers (verified-stop, spawn flow).
It is no longer a mandatory classification. New flows compose one direct
pipeline per business path (see "One pipeline per business path"); the five
stage contracts and declared read/write sets below are guidance for race-prone
effect stages, not a required taxonomy.

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
- **As a free-form effect executor (revised 2026-08-25).** Effects as pipeline
  stages are normal — a business path mixes them with decisions and
  transforms. The boundary that remains: every effect stage delegates atomicity
  to repository primitives (CAS, transition table, spawn reservation) and is
  idempotent or compensable; blind read-modify-write inside a stage is banned.
  A pipeline still never owns atomicity.
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
nothing — the bind CAS supersedes, the spawned session is cancelled
best-effort (the compensation's `cancelBySessionId` is fire-and-forget: a
rejected strict stop logs and leaves the session-manager registration and
`subSessions` entry in place; only the direct
`createSubSession` inner-bind abort deletes the never-streamed row), the
cancelled execution row is not resurrected, and no rejection goes unhandled; a
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
waiters already registered settle at the winning bind, a failed peer's
waiter re-checks the DB before rejecting, waiters remove themselves on
timeout, and `cleanupAll` settles stragglers — but registration is not
wake-up-safe: a caller paused between its `spawningExecutionIds` check
and waiter insertion watches the winner settle both calls and clear the
map, then waits out the full 30 s despite the successful binding (the pin
registers its waiter before releasing the winner, so this window is
recorded here, not pinned). A new real-repository suite (`task-agent-manager-spawn-cas.test.ts`)
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

## Pilot 9 — chain C: message-search FTS admission + delivery-status routing (2026-08-23)

Chain C carried the sandwich below `src/lib/`, into the storage layer's
message-repository cluster — the third-ranked chain of the sdk-message-repository
survey (`docs/reports/sdk-message-repository-superpipe-survey.md`). Five PRs:
C1 the characterization pins (#2755 — the delivery-transition window matrix,
the turn-end batch semantics, and the FTS flush boundary incl.
delete-then-decide ordering and both malformed-payload outcomes), C2 the
admission core (#2771), C3 the routing table (#2791), C4 the session-rebuild
alignment (#2804), and this closing sweep.

Extracted:

- `message-search-admission.ts` (160 lines) — `decideMessageSearchAdmission`,
  a real `decisionRun` over six gates (superseded → searchable-type →
  eligibility → body-nonempty → user-status → index), first-skip-wins; the FTS
  policy vocabulary (retention TTL, room-session prefixes and types, terminal
  space-task statuses, searchable message types) exported as data; and every
  retention check evaluated against an injected `now` — the survey's purity
  finding was that the old `isOlderThanMessageSearchTtl` read `Date.now()`
  internally, and the synchronous fallback path
  (`scheduleMessageSearchIndex` with no pending table) means *every* admission
  shell, not just the 2 s flush, must supply a clock.
- `delivery-status-routing.ts` (47 lines) — `DELIVERY_TRANSITION_RULES`: the
  seven delivery-transition actions' accepted from-status windows and targets
  as one table, consumed through `routeDeliveryTransition` (boolean routing)
  and `deliveryTransitionRule` (window + target, for SQL interpolation) —
  `task-transition-routing.ts`'s precedent at repository scale.

Interpreters: `upsertMessageSearchRow` keeps the delete-then-decide order and
the body-extraction-first placement the C1 pins protect (a JSON-valid but
invalid payload throws inside the flush transaction, so the pending row is
retained for retry; syntactically invalid JSON returns before the old-row
delete). The ten `markDelivery*`/`reopenDelivery*` wrappers select their
target row through `deliveryTransitionRule`'s window — `send_status IN
(acceptedFrom)` in the SELECT — and then flip it through the shared
`updateMessageStatus`, which chain B's B4 (landed beside this chain's merge)
has since rebuilt as plan/interpret whose guard splits by action family:
only consumed/failed targets build planned rows, so only the fail and
consume wrappers get the expected-status guard on their status UPDATE and
turn/seq statements, while the submit, reopen, retry, and uuid-keyed defer
wrappers target statuses that never plan and always take the unplanned
by-id update; a row that leaves the pending window between selection and
plan joins them there. The select-to-update window is closed for the planned
arm and remains, in theory, everywhere else. The dbId-keyed
`deferEnqueuedUserMessage` keeps its own guarded UPDATE
(`AND send_status = ?`) rather than going through the shared effect — its
distinct lookup, return shape, and conditional-update semantics preserved.

**The session-rebuild outcome: routed vocabulary, deliberate residual.** The
survey flagged `SessionRepository.rebuildMessageSearchRows` as a second
production FTS admission implementation drifting against the repo's. C4 routed
its *policy* through the core — the bulk WHERE interpolates the exported
vocabulary, and both retention cutoffs bind as millisecond parameters from one
injected clock (`updateSession`'s optional third parameter), ms-exact and
NULL-keeping to match `isOlderThanMessageSearchTtl`, replacing SQLite's
`'now'` — while the *shape* stays set-based, and that residual duplication is
deliberate: the rebuild remains one DELETE plus one `INSERT … SELECT` per
session flip rather than a per-row JS loop over the shared predicates; its
supersession match keeps the codebase-wide `COALESCE(sdk_uuid, id)` fallback,
which is stricter than the repo path for one row shape — a searchable row
with neither a payload UUID nor a `sdk_uuid` column value whose replacement
edge targets its database id is rejected by the rebuild's match while
`isMessageSuperseded` returns false on the absent payload UUID; edges carry
payload UUIDs (`retracted_message_uuids`), never db ids, so that shape cannot
arise in practice (dead defensive symmetry, pilot 3's rebind-guard precedent)
and the parity matrix deliberately contains no such row; and its body
assembly stays SQL `GROUP_CONCAT`, where non-string text/thinking scalars
(and non-ASCII whitespace-only bodies) can still diverge from
`extractVisibleSearchText` for malformed-content rows. Writing the parity
matrix (`session-search-rebuild-parity.test.ts`) surfaced five real
divergences, all fixed: second-truncated SQL kept rows the core rejected
(sub-second-in-second), the `COALESCE(…, 0)` task cutoff rejected
null-timestamp terminal tasks the core keeps, empty-body rows were inserted,
room-prefixed session ids typed as Space sessions were admitted, and
self-supersession edges were dropped — the same incident-shaped payoff as
pilot 4's pins.

Boundary caveats, recorded for the same reason as pilot 3's:

1. **The expensive facts are thunks — one eager in practice, one lazy.**
   `isSuperseded` and `isSearchableUserMessageStatus` enter the core as
   thunks (pilot 3's lazy-thunk pattern), but only the trailing one is
   actually skipped by earlier gates: supersession is the FIRST gate, so its
   replacement-table read is forced for every JSON-valid row that reaches
   the core — including rows later rejected for type, eligibility, or empty
   body — while the user-status thunk sits last and is the one an earlier
   skip avoids. The suite pins both positions directly: superseded consulted
   first, user-status last, the user-status fact never consulted when an
   earlier gate skips and never for non-user rows.
2. **The gates are wiring, not surface.** The six `applyXGate` functions are
   production-internal — composed intra-module into the run that
   `decideMessageSearchAdmission` executes — and directly test-consumed by
   the identity pins. The suite pins the decision table through the composed
   run's precedence ("superseded wins over every later gate") *and* the
   per-gate pass-through identity of Decision item 6(b) — the identity pin is
   the one part the composed run cannot prove: a gate returning a spread copy
   instead of the same ctx reference still composes, so only the per-gate
   `gate(ctx) === ctx` assertion catches it.
3. **The fact suppliers stay repo-private.** `isMessageSuperseded` and
   `isSearchableUserMessageStatus` remain private methods — the reads the core
   delegates. The searchable-user-status policy also survives as SQL
   (`COALESCE(send_status, 'consumed') IN ('consumed', 'failed')`) in the
   read-projection builders (survey zone 1: do-not-extract, hand-tuned SQL)
   and one line of the rebuild's WHERE — the same policy in three syntaxes,
   unified only at the gate.

**The closing sweep found no dead inline copies.** The ten wrappers'
hardcoded status windows and the old five-gate FTS cascade are gone from both
files; knip (files/dependencies/exports), oxlint, and `tsc --noEmit` are
clean. Live near-duplicates deliberately kept: the pending-selection window —
set-equal to `fail`'s acceptedFrom but a distinct predicate (rows still
pending delivery, keyed on target ∈ {consumed, failed}, driving
turn-promotion side effects) — was still inline when this chain closed, and
chain B's B4 has since lifted it into the named `PENDING_ROW_FROM_STATUSES`
in `sdk-message-status-plan.ts`, keeping it a separate concept rather than
folding it onto the delivery routing table; `deletePendingUserMessage`'s
inline `('deferred', 'enqueued')` pending set remains unconverted B-chain
mutator territory; and the searchable-user-status SQL family of caveat 3.
Every core export is production-consumed or pinned by the C suites:
the five vocabulary constants by `session-repository.ts`'s rebuild (the TTL
also by the parity suite), `decideMessageSearchAdmission` by
`upsertMessageSearchRow` and both suites, `isMessageSearchIndexEligible` and
`isOlderThanMessageSearchTtl` by the admission suite (the former also
intra-module as the eligibility gate), the six gates both — composed into
the production run and pinned by the identity describe —
`routeDeliveryTransition` by `deferEnqueuedUserMessage` and the
routing suite, `deliveryTransitionRule` by the four wrapper call sites and the
suite, `DeliveryTransitionAction` by the wrapper signatures, and the remaining
types intra-module.

**Costs:** production +167 across C2–C4 — the two cores +207 (160 + 47),
`sdk-message-repository.ts` net −78 from chain C's own PRs (1,943 lines at
the chain's close, 1,867 after dev's interleaved extractions — chain A PRs
4–5 and the rewind-operator dedup — landed beside it; chains A and B account
for the rest of the shrink from the survey's 2,199-line base),
`session-repository.ts` +38 for the vocabulary interpolation and
parameterized cutoffs. Tests +1,672:
C1's pins +585 net (window matrix, turn-end batch semantics, flush boundary),
the admission suite +305 (212 across C2 plus this closing sweep's 93
identity-pin lines, reworked twice in review), the routing suite +98, the
parity matrix +684 —
again the value is testability, and here the parity matrix paid for itself by
surfacing the five rebuild divergences on identical rows.

Pilot 9 PRs: #2755, #2771, #2791, #2804, plus this closing sweep. Chain A
landed beside this chain as pilot 10; chain B (save admission) from the same
survey remains in flight and lands its own note.


## Pilot 10 — chain A: sdk-message read projections (2026-08-23)

Chain A applied the widened scope (pure transforms, P1) to the persistence
read layer: every `sdk_messages` row → projected-message transform in
`SDKMessageRepository`
(`packages/daemon/src/storage/repositories/sdk-message-repository.ts`) moved
into the pure, SQL-free `sdk-message-projections.ts` beside it. The repository
keeps all SQL, writes, badge maintenance, and delivery transitions; the module
holds row parsing, projection, text/content shaping, and page composition.
Five PRs: A1 the characterization pin (#2730 — 794 lines pinning the
repository's read-projection behavior before any extraction, including the
per-reader malformed-row policy table and the user-content shaper split), A2
the parse/inflate layer (#2766), A3 text/content projections plus the
renderable-text predicate (#2793), A4 page composition (#2811), and A5 this
closing sweep.

Extracted surface, grouped by A2–A4 stratum:

- **Parse/inflate (A2):** `parseSdkMessageRow` plus
  `projectTopLevelMessageRow`, `projectSubagentMessageRow`,
  `projectBackgroundTaskMessageRow`, `inflatePersistedMessage`.
- **Text/content (A3):** `extractVisibleText`, `extractFirstTextBlockContent`,
  `extractToolCallNames`, `projectRenderableTextRow`, and the
  batch-size/scan-budget constants.
- **Page composition (A4):** `composeMessagePage`, `collectToolUseIds`,
  `buildRowIdHydrationBatches`, `orderHydratedMessages`.

**Policy parameterization, not normalization — the chain's recorded idiom.**
Where A1 characterized two readers or shapers as the same walk diverging only
by a policy, the extraction shares one primitive behind an *explicit* policy
parameter instead of either collapsing to a single unparameterized function or
keeping two copies. Two instances. First, `parseSdkMessageRow(raw, policy)`
carries the per-reader malformed-row policy A1 pinned (`synthesize`, `skip`,
`throw`, `null`) rather than normalizing all callers to one behavior —
`getAssistantMessagesSince` still throws on a malformed row while the page
composers synthesize, exactly as before. Second, A5 (this sweep): the two
user-content shapers — `extractVisibleText` (join-all) and
`extractFirstTextBlockContent` (first-block-only) — had grown the identical
`message.content` block walk; both now delegate to
`extractTextBlockContents(msg, 'first-block-only' | 'join-all')`. The named
shapers remain as the policy selections call sites actually want (never one
unparameterized shaper): the parameter is required, and each shaper's output
policy stays visible at its own boundary.

Boundary caveats, recorded in the same spirit as pilot 3's:

1. **The shapers differ beyond the block policy.** Join-all additionally
   appends the `result` field for `result`-type messages, joins blocks with
   blank lines, and trims the outer boundary; first-block-only returns the
   first text block verbatim, interior and outer whitespace preserved (A1/A3
   pin `' Padded first '` round-tripping and `'Alpha\n\nBeta'` from
   `' Alpha'`/`'Beta '`). The shared primitive carries only the common
   content walk; output shaping stays per-shaper, so the policy parameter is
   the *stop* decision, not the whole difference.
2. **One predicate now serves both policies.** The first-block-only shaper
   previously matched `type === 'text'` and coerced a missing `text` to `''`;
   the shared walk applies the join-all predicate
   (`type === 'text' && typeof text === 'string'`) under both policies, so a
   malformed text block without string `text` is skipped rather than returned
   as empty. The divergence is reachable only on input violating the SDK's
   content-block types (`text: string`) and is pinned by no A1 case.
3. **Three content answers coexist on purpose.** `getUserMessageContentByUuid`
   returns stored content verbatim (raw blocks or string) — a third projection
   that is neither shaper, pinned by A1 as deliberately unshaped; the shapers
   serve `getUserMessages`/`parseUserMessageRow` (first-block-only) and the
   renderable/assistant readers (join-all). Unifying them would be a behavior
   change, not a dedup.
4. **Deliberate near-duplicate not folded:** `extractVisibleSearchText`
   (`message-search.ts`) repeats the block walk but also indexes `thinking`
   blocks and `hyperneo_action` title/message/question/prompt/action fields,
   trimming per part before joining — a search-indexing shape, not a
   user-content shaper, and out of this chain's scope.

**The closing sweep found one dead copy and deleted it.** The private
`extractAssistantText` method on the repository — an A3-era one-line
delegation to `extractVisibleText` — is gone; its single caller uses the
shaper directly. No other inline copies of the extracted walks remain in the
repository. Every module export is production-consumed by the repository or
pinned by the projections/repository suites; the in-module-consumed function
exports (`parseSdkMessageRow`, `projectTopLevelMessageRow`,
`projectSubagentMessageRow`, `collectToolUseIds`, `extractTextBlockContents`)
are test-pinned directly, and the in-module type exports
(`MalformedSdkRowPolicy`, `TextBlockExtractionPolicy`) are companions of
those pinned signatures. knip (files/dependencies/exports), oxlint, and
`tsc --noEmit` are clean.

Costs: `sdk-message-repository.ts` 2,236 → 1,896 lines across A2–A5
(A2 −61, A3 −225, A4 −50, A5 −4) against a 264-line projections module;
tests net ≈ +1,457 (A1 +794 characterization pins; projections suite +204
A2, +163 A3, +246 A4, +50 A5). As in pilots 3–7, the value is testability:
the A1 pins run against pure functions, no database fixture required for the
policy tables.

## Pilot 11 — chain B: save admission, badge instruction set, status-plan interpreter (2026-08-23)

Chain B is the write-side chain of the `sdk_messages` superpipe survey (task
#1249, #2713): the three save paths' admission and badge decisions extracted
as pure cores, and the delivery-status flip extracted as a pure planner plus
a transaction-shell interpreter that owns its own SQL — the repository
keeping the surrounding reads, transactions, and notifications. Five PRs:
B1 the save-admission
drift pins (#2736), B2 the admission core (#2767), B3 the badge instruction
set (#2794), B4 the `updateMessageStatus` plan/interpret (#2815), and this
closing sweep. The chain ran interleaved with chains A (read projections)
and C (FTS admission + delivery-status routing) on the same file; changes
from those chains and their review fixes are theirs, not credited here.

Extracted:

- `sdk-message-admission.ts` (169 lines) — `decideMessageAdmission` over a
  normalized input, returning one admission record (`isRenderable`,
  `isTerminal`, `isConversationAnchor`, `countsTowardsBadge`,
  `parentToolUseId`, `sdkUuid`, `replacementEdges`), plus the per-fact
  extractors (`computeIsRenderable`, `computeIsTerminal`,
  `extractParentToolUseId`, `extractSdkUuid`, `extractReplacementEdges`) and
  the `SendStatus` type.
- `sdk-message-badge.ts` (16 lines) — the badge planners:
  `planAdmissionBadgeUpdate` (delta `+1` iff the admission record counts) and
  `planBadgeRecompute`, over the `BadgeUpdateInstruction` union.
- `sdk-message-status-plan.ts` (137 lines) — `planMessageStatusApplication`
  over the pending-row snapshot, producing the ordered instruction list
  (`touch-timestamp` / `promote-turn` / `allocate-consumed-seq`), and
  `applyMessageStatusPlan`, the transaction-shell interpreter with the
  expected-status guards. The module's halves differ in kind: the planner is
  pure, the interpreter is not — it prepares its own statements, reads the
  clock, invokes the sequence allocator, and writes — so this module is a
  planner/interpreter pair, not a third pure core.

**Shape call: pure function, not `decisionRun`.** The save gates are
independent derivations off one message — renderability, terminality,
anchorhood, badge visibility, uuid, replacement edges — with no precedence
among them; a gate list would have manufactured a first-decision-wins order
the facts do not have. The ADR's original sanction (pilot 1) already covered
plain pure-function admission gates. Chain B's addition is the *normalized
input*: `normalizeMessageAdmissionInput` folds the disjoint
`HyperNeoActionMessage` shape into a synthetic `SDKMessage`, so the three
save sites — `saveSDKMessage`, `saveUserMessageCore`,
`saveHyperNeoActionMessage` — consume one core. The deliberate divergences
split by where they live: the one the core itself owns — the anchor status
gate — becomes an explicit `variant` parameter, while `consumed_seq`
allocation stays site-local policy interpreting the shared record:

- **Anchor status gate.** `isConversationAnchor` requires `sendStatus`
  `consumed`/`failed` on the user variant only; the SDK variant takes no send
  status (the INSERT omits the column, so the schema default `'consumed'`
  applies) and bypasses only that send-status arm — renderability and
  user-type still gate the anchor, so non-user or non-renderable SDK rows
  anchor exactly as they would on the user path.
- **`consumed_seq` at insert.** The SDK variant allocates a sequence for
  terminal results inside its insert transaction; the user variant leaves the
  column NULL at insert and allocates only at the consumed flip. B1 pinned
  this as the divergence a shared `isTerminal` field must not flatten — the
  allocation decision stays at the sites (the flip side is B4's
  interpreter-owned instruction), so the record carries the fact and each
  site keeps its policy.
- **Badge visibility** rides the same record (`countsTowardsBadge`) —
  previously a repository-private predicate invoked at each site, now a core
  field whose delta/recompute split B3 unified.

**B3 — badge maintenance as an instruction set.** A save whose admission
counts emits `delta(+1)`; a non-counting save emits the union's no-op
`none` (hidden-subtype rows, tool-child rows, pending user rows); the
status flip, both rewind operators, and `deletePendingUserMessage` emit a
**recompute** instruction (authoritative `COUNT(*)` + conditional update,
which also repairs pre-existing counter drift) — never delta subtraction,
which would preserve exactly that drift. Two notification asymmetries are
pinned, not normalized: `deletePendingUserMessage` recomputes but emits no
`sessions` notification, while the rewind operators notify iff the recompute
changed the row; and `recomputeVisibleMessageCount` stays public and
notification-free for the recovery script (`scripts/recover-messages.ts:276`).
The interpreter is the four-line `applyBadgeUpdate`; the rewind pair itself
later collapsed into one `deleteMessagesFromTimestamp` (interleaved #2812,
finishing B3's unification).

**B4 — a plan/interpret flip with per-instruction CAS guards.**
`updateMessageStatus` gathers the pending-row snapshot and plans *before*
opening the transaction, then interprets inside it: the timestamp, turn,
and sequence instructions execute first, each itself a guarded conditional
update, and the final `send_status` flip is the last guarded statement in
the same transaction, with the badge recompute alongside and only the
notifications and search-index scheduling after commit. That ordering —
effects-before-status-CAS, all inside the transaction — is a *relative* of
the ADR's Phase 4 wording (read → plan → CAS within transaction → apply
effects *after commit*), not an instance of it: the effects here are DB-only
rows guarded by the same predicate, so transactionality, not commit
ordering, is what makes them safe. The snapshot-to-apply gap is exactly
why the expected-status guards below exist, and the synchronous
single-threaded connection is why it stays theoretical today; the
plan/interpret boundary must not widen it. Two disciplines carried
structurally. First, *newly allocated values never appear in the plan*:
turn promotion reads the live `MAX(conversation_turn_index)` per task (a
shared-turn base frozen once per task inside the transaction), and a fresh
`consumed_seq` comes from the atomic single-row `UPDATE … RETURNING`
allocator — both invoked by the interpreter inside the open transaction,
because pre-transaction allocation of either axis would make planning
effectful or let a concurrent writer advancing the same task invalidate the
plan. The one deliberate exception is a caller-provided sequence:
`markDeliveriesConsumedAtTurnEnd` passes the result row's existing
`consumed_seq` as `options.consumedSeq`, the planner stores it in each
`allocate-consumed-seq` instruction as `providedSeq`, and the interpreter
reuses it without spending an atomic allocation — pinned as such. Second,
*every planned transition carries an expected-status guard*
(`AND send_status IN (pending set)`): a row outside the pending set at
apply time fails its whole transition — no stale timestamp, turn, or
sequence instruction executes on it — and (the PR-review fix) the
seq-allocation arm re-probes the window before spending an atomic sequence,
so a rejected row does not burn one. The guard is membership-at-apply, not
continuous membership since the snapshot — no version or status history is
recorded — so an ABA round trip between snapshot and apply (say
`enqueued → failed → enqueued` through the live reopen route) re-admits the
row and its planned effects land. The guard's scope is the planned set
only, because the snapshot is gathered solely for `consumed`/`failed`
targets: intermediate-target updates (`enqueued`, `deferred`, `submitted` —
the re-queue paths call these live) take the unconditional arm with no
`send_status` predicate at all, as do ids outside the snapshot on terminal
targets — flipping without turn/seq/timestamp effects, the pre-existing
behavior for already-settled rows, now pinned as such. The options-carrying
callers (`sharedTurn`, `consumedSeq`) are repository-internal delivery
wrappers; the `Database` facade exposes the 2-arg form only.

**Boundary caveats.**

1. **The badge predicate lives twice.** The core's TypeScript
   `isVisibleBadgeRow` (delta path) and `recomputeVisibleMessageCount`'s SQL
   `WHERE` (authoritative path) encode the same membership — no
   `parent_tool_use_id`, hidden subtypes excluded, user rows counted only
   when consumed/failed — in two languages and two modules, and the
   hidden-subtype list is itself defined twice (`BADGE_HIDDEN_SUBTYPES` in
   the core; `EXCLUDED_FROM_PAGINATION_SQL_LIST` in the repository, whose
   name records its first job — pagination and badge exclusion share one
   list). The pair is coupled by design — recompute is what repairs delta
   drift — but a change to either predicate must be mirrored in the other,
   or recompute silently "repairs" the counter toward a different definition
   of visible.
2. **Admission placement diverges by site, preserved — and the placement is
   not itself an invariant.** The SDK variant computes its record before its
   transaction; the user variant computes it inside the composed transaction
   (the `saveUserMessage` wrapper and the delivery outbox both call
   `saveUserMessageCore` transactionally). The derivation reads only the
   in-scope message and its options — no repository, clock, or other
   mutable state — so the two placements cannot observe different inputs;
   nothing about admission freshness pins the code where it is. What the
   placement is load-bearing for is composition shape: the user core is
   itself the transactional unit its callers compose (core inside the
   transaction, `runPostSaveSideEffects` after commit), so hoisting its
   admission computation out would change that seam, not correctness.
   Recorded so the divergence is not read as a discipline.
3. **The normalized input is a type seam.** Folding `HyperNeoActionMessage`
   into a synthetic `SDKMessage` is an `as unknown as SDKMessage` cast. The
   core reads `type`, `subtype`, and `uuid` off every input, and additionally
   `message.content` (renderability), `parent_tool_use_id`, and
   `supersedes`/`retracted_message_uuids` (replacement edges) where present —
   the synthetic object omits all of those, and the omissions are
   load-bearing defaults (non-array content renders, no parent, no edges). A
   new admission fact reading deeper structure must extend the normalizer's
   synthetic shape or its omissions become silent defaults; the seam is why
   the disjoint shape crosses at all.
4. **The repository re-export block is suite-pinned.** `computeIsRenderable`,
   `computeIsTerminal`, `extractParentToolUseId`, and `extractReplacementEdges`
   re-export from `sdk-message-repository.ts` for the helpers suite, which
   pins them through the facade (`extractSdkUuid` is production-consumed by
   the delivery outbox; `SendStatus` widely) — the pilots 6/7
   pinned-export phenomenon, recorded rather than folded.

**Worker and recovery-script contracts, verified by this sweep.** The
constructor stays `(db, reactiveDb?)`: the message-search worker constructs
the repository on a read-only connection (`{readonly: true}` plus
`PRAGMA query_only`, `message-search-worker.ts:29`), while the recovery
script constructs it on a writable one whose writes include the recompute's
`UPDATE` (`scripts/recover-messages.ts:276`) — what the two share is the
absence of a reactive database, against which every notification is a `?.`
no-op, and `recomputeVisibleMessageCount` is the script's public entry. The
module tops stay worker-safe across the repository and every module it
imports: module-scope initialization exists — constant `Set`s,
`message-search-admission.ts` composing its `decisionRun` pipeline at
import, and the shared logger's `globalConfig` reading
`NODE_ENV`/`LOG_LEVEL`/`LOG_FILTER` — but none of it touches database or
reactive state, which is the requirement the worker's import graph
actually imposes; the logging env read is the accepted exception, harmless
on the worker's read-only connection. The facade
(`storage/index.ts`) and the reactive proxy's `METHOD_TABLE_MAP` were not
touched by any chain B PR. The proxy dispatches with `.apply(target, args)`,
but the proxied facade method is itself 2-arg — `Database.updateMessageStatus`
forwards `(messageIds, newStatus)` and would discard a third — so the
options-bearing callers work because they are repository-internal wrappers
calling `this.updateMessageStatus` directly, bypassing the facade; that
narrowing is the recorded shape, not transparent passthrough. The
interleaved `willEmitTableChange` addition (#2814) was that PR's own
incident fix, not chain B's.

**The closing sweep found no dead inline admission derivations.** B2
deleted the inline copies as it landed — `isVisibleBadgeRow`, the per-site
`isRenderable`/`isTerminal`/`isConversationAnchor`/`countsTowardsBadge`
derivations at all three save sites — and B3 the bare
`bumpVisibleMessageCount(…, 1)` calls; every save site now reads
`admission.*` only, and knip (files/dependencies/exports), oxlint, and
`tsc --noEmit` are clean, verified in this sweep. Live near-duplicates
deliberately kept: the badge SQL mirror of caveat 1; `message-queue.ts`'s
local `extractParentToolUseId` — a different function on a different input
shape (queued content blocks, not an `SDKMessage`), never a core consumer
despite the name; and the per-variant admission placement of caveat 2.

**Costs:** production +418/−203 across B2–B4, chain-B-attributable only —
three extracted modules +322 (169 + 16 + 137: two pure cores plus the
planner/interpreter pair), the repository itself +96/−203
(net −107; the survey's 2,199-line file was simultaneously shrinking under
chains A and C). Tests +1,321: B1's drift matrix and task-id-resolution
reactive harness +618, the admission suite +202, the badge suite +193, the
status-plan suite +308. B1's matrix is the chain's parity proof (its save
cells are one fixed-status `saveSDKMessage` row plus five send-status
`saveUserMessageCore` rows — the SDK save API takes no status, so no
pair × status grid exists — alongside the fixed-shape hyperneo-action
table and the core/side-effects composition contract); B4's suite pins
the CAS guards, including the probe's allocator skip.

Pilot 11 PRs: #2736, #2767, #2794, #2815, plus this closing sweep. Numbering
ledger for the survey's chains: pilot 7 is chain P; 8 stays reserved for chain I
per pilot 7's note; 9 is chain C per its in-flight closing sweep; 10 is chain A
(#2819); 11 is chain B.

## Pilot 8 — chain I: pending-queue drain + injection shell (2026-08-23)

Chain I is the chain Pilot 7's close unblocked: the durable pending-message
queue's drain paths and the injection shell that delivers into sub-sessions —
the code that shares `injectMessageIntoSession` call sites with the spawn seam.
Six PRs: I1 the characterization pins (#2799 — 1,143 lines pinning drain
admission, envelope formatting, per-row outcomes, the space-agent flush, the
terminal guard, and pending-drain-through-the-v2-shell, plus 82
reset-context-per-turn pins), I2 the drain/envelope cores (#2809), I3 the
injection-shell delivery steps (#2817), I4 the drain admission composed as a
`decisionRun` (#2829), I5 the space-agent flush as the pipeline's second
consumer (#2840), and this closing sweep.

Extracted:

- `pending-drain-gates.ts` — `derivePendingQueueTargetNames` (the bare +
  node-prefixed target-name pair) and `selectDrainablePendingRows`
  (targetKind filter, executionless-safety filter, id dedup, createdAt
  ordering).
- `pending-envelope.ts` — `pendingSourceLevel`, `hasAgentMessageEnvelope`,
  `isHumanPendingSource`, and the two row formatters
  (`formatPendingRowForNodeAgent`, `formatPendingRowForSpaceAgent`) that pass
  through already-enveloped bodies or re-envelope bare ones.
- `injection-delivery-steps.ts` — the recurring delivery-row transitions
  (`reopenFailedDeliveryRow`, `flipDeliveryRowToDeferred`,
  `failDeliveryRowInBackground`, `settleDeliveryRowStatus`) plus
  `deliverInjectedMessage` (the v1/v2 delivery branch).
- `pending-drain-decision-pipeline.ts` — the `decisionRun` composition
  (empty-listings short-circuit → drainable-rows admission → terminal skip),
  exposed as `decidePendingDrainAdmission`.

**The injection shell composes on the Pilot 4 core — no second decision core.**
The chain's standing constraint was that the inject decision stays
single-sourced in `decideInjectDelivery`. What I3 extracted from
`injectMessageIntoSession` is everything *around* that call: the row-status
transitions its interpreter performs per decision arm, and the terminal v1/v2
delivery cascade. The shell is now gather → `decideInjectDelivery` →
interpret, with the interpreter's shared effects in the steps module and the
decision inputs (parent-task rate/usage status, slot reset, active delivery
job, unconsumed work) still gathered shell-side. The two flush sites —
`flushPendingMessagesForTarget` (node agents) and, since I5,
`flushPendingMessagesForSpaceAgent` — are the drain pipeline's two gather →
decide → interpret consumers; the per-row delivery loop stays shell-owned at
both (the ADR Q3 never-the-loop rule), as do the injection lock and the double
terminal guard in `injectSubSessionMessageWithOrigin` (checked before and
after lock acquisition).

Boundary caveats, recorded for the same reason as pilot 3's:

1. **Maintenance effects run ahead of the core.** Both flush sites call
   `enforceRetention` and `expireStale` before the admission decision —
   mutate, then gather listings, then decide. A skip decision is therefore
   not a no-op: expired rows are already gone. The ordering is maintain →
   gather → decide → interpret here, recorded rather than normalized
   (retention belongs to the queue, not to the drain decision).
2. **The dual-name gather carries a defensive dedup and a tiebreak seam.**
   The two target names are disjoint selectors (`target_agent_name = ?`), so
   the core's `seenIds` dedup can never fire in production — dead defensive
   symmetry, pilot 3's rebind-guard precedent. Ordering is split across two
   syntaxes: each SQL listing orders `created_at ASC, rowid ASC`, and the core
   re-sorts the merged set by `createdAt` only, so a same-millisecond tie
   between rows from the two listings resolves by listing order (bare name
   first), not rowid.
3. **The space-agent site pins its admission inputs.** I5 hardcodes
   `executionPresent: true`: the injector-presence check ahead of the core is
   the real gate, and the pre-pipeline behavior admitted every `space_agent`
   row regardless of `workflowNodeId`, so the executionless-safety filter
   must not apply (pinned: node-scoped space_agent rows still drain). Pilot
   3's defused-gate phenomenon — the gate list is not the complete drain
   policy.
4. **The injection interpreter re-derives a gated input with no await
   between.** `hasActiveDeliveryJob` feeds the core (it gates the
   `delivery_job_active` refusal) and is re-checked at the
   `clear_before_deliver` branch — with nothing awaited on that path between
   decision and re-check, so the second read can only diverge through
   synchronous mutation. A pre-existing double-check carried verbatim (pilot
   5's re-derived-predicate caveat in its weakest form); recorded rather than
   removed.
5. **The typed skip reasons collapse at both shells.** The pipeline
   distinguishes `no_pending_rows` from `no_drainable_rows`; both production
   consumers map any skip to the same early return, so the distinction is
   carried by the decision value and pinned by the suite only — the
   shadowed-arms phenomenon in its mildest form.
6. **The v1/v2 branch rides an env boolean through the step.**
   `deliverInjectedMessage` takes `deliveryV2Enabled` as an input and keeps
   the V1 memory-queue path inside the extracted step — pilot 4's deliberate
   non-goal (the V1 env-gated legacy path untouched) carried into the module.

**The envelope detector is retired from production paths.** Pre-I2,
`hasAgentMessageEnvelopeForTest` was the envelope detector *misnamed as
test-only* and exported from `task-agent-manager.ts` — while both production
flush paths called it directly. I2 folded it into `pending-envelope.ts` as the
production-named `hasAgentMessageEnvelope`, consumed only through the two row
formatters; the `ForTest` export and its dedicated describe block are gone,
and no reference to the old name remains anywhere (verified in this sweep).
Recorded with it, I3's one review-driven behavior fix: the original step
voided the async fail step from the `onEnqueueFailure`/`terminalizeOnTimeout`
callbacks, turning a synchronous `markDeliveryFailedByUuid` throw into a
detached rejection the fatal process logger treats as exit-worthy;
`failDeliveryRowInBackground` keeps the mark synchronous (throws propagate
through `awaitDeliveryConsumption` as before) and leaves only the status
publish fire-and-forget with its own swallow.

**The closing sweep found no dead inline copies.** Each conversion PR deleted
its inline copy as it landed — the envelope-format ternaries (I2), the
delivery-row transitions and the v1/v2 cascade (I3), the bare
`selectDrainablePendingRows` call (I4), and the space-agent inline
targetKind filter + empty check (I5). knip (files/dependencies/exports),
oxlint, and `tsc --noEmit` are clean, verified in this sweep. Live
near-duplicates deliberately kept: the defer arm's direct
`markDeliveryDeferredByUuid` — the mark-without-publish variant, since
`settleDeliveryRowStatus` publishes 'deferred' immediately after and routing
through `flipDeliveryRowToDeferred` would double-publish — and, one file over,
`repairQueuedWorkflowNodeHandoffs`'s own inline `targetKind === 'node_agent'`
filter, which belongs to Pilot 3's recorded phase-1 mini-pilot, not this
chain. Every core export is production-consumed or pinned by the suites
(Decision item 6); the three pipeline gates are production-internal wiring
composed into the run and directly test-consumed by the identity pins —
pilot 9's caveat-2 shape.

**Costs:** production +330 lines of new modules (38 + 84 + 159 + 49) against
`task-agent-manager.ts` +103/−188 (net −85); tests +2,064/−41 across I1–I5 —
I1's pin suites (1,143 + 82) and the four module suites
(149 + 228 + 330 + 203), plus I5's space-agent admission pin. As in the
earlier pilots, the value is testability: the drain admission and envelope
tables now run against pure functions with no runtime fixture.

Pilot 8 PRs: #2799, #2809, #2817, #2829, #2840, plus this closing sweep.

**Remaining mini-pilot shelf for `task-agent-manager.ts`**, recorded as
future candidates (each pinned by a decision-table test before extraction,
per the pilot-3 non-goal discipline):

- **The MCP-factory task-tool handlers onto the Pilot 5 routing cores.** The
  bound node-agent MCP callbacks (`onCreateStandaloneTask`, `onPublishTask`,
  `onArchiveTask`, exposed through `node-agent-tools.ts`'s task handlers)
  still re-implement gates inline: `onArchiveTask` repeats the
  archive-active-run gate with its own message variant, and `onPublishTask`
  enforces no draft-only gate at all — it calls a bare `publishTask`
  (`setTaskStatus(taskId, 'open')`), so the node-agent publish path can
  publish a non-draft task that both the MCP tool (`routePublishTask`) and
  the RPC handler reject. Pilot 5's sweep recorded this surface as
  never-converted; folding it onto `task-transition-routing.ts` is the
  candidate.
- **The `rehydrateSubSession` failure-cleanup asymmetry.** The catch around
  `startStreamingQuery`/`replayPendingMessagesAfterRuntimeProvisioning`
  unwinds the registration set (bookkeeping, index, conditional
  session-manager unregister), but the guarded window covers only that final
  stage: a throw between registration and the try — the tool-continuation
  listing or transcript sanitization — leaves the session fully registered
  with no unwind. The inverse set and the registration set are not aligned;
  pin first, then narrow the window or move registration inside it.
- **The rehydrate admission gates.** `performSubSessionRehydrate`'s
  early-return ladder (already-indexed → no execution → no parent task →
  parent cancelled/archived/stopped → space missing → run cancelled →
  restore-null) is a decision table living in control flow; the
  `rehydrateSubSession` wrapper's dedup + restore-lock is shell, but the
  ladder is extraction material once pinned.

## Pilot 12 — web live-query subscription lifecycle (2026-08-23)

Pilot 12 (the UI-side pilot 6) carried the pattern out of the daemon into
`packages/web`: the four hand-rolled LiveQuery subscription lifecycles —
`useSpaceTaskMessages`, `useActorMessageProjections`, `useTaskMilestones`,
`useGroupMessages` — each a drifted copy of the same
subscribe/snapshot/delta/error/reconnect machinery, were characterized with pin
files written green against the pre-migration hooks, then migrated one PR at a
time onto a single pure machine, `packages/web/src/lib/live-query-lifecycle.ts`
(224 lines): five statuses (`subscribing`/`awaiting-snapshot`/`live`/
`error-retry`/`disposed`), six events, and a pure
`(state, event) → { state, effects[] }` transition that only declares effects
(`re-snapshot`, `retry-with-backoff`, `emit-to-store`, `schedule-cleanup`),
never executes them. Events whose `generation` does not match the current
machine state are dropped structurally (this guards the dispatch origin,
promise completion, and retry timers that captured their generation; incoming
LiveQuery snapshot/delta payloads have no embedded generation, so the listeners
stamp them with `lifecycle.generation` at receipt time and that stamped value
is what the guard tests). Snapshot-retry delay/budget/enabled are config so
that drifted copies adopt the
machine without forks (`snapshotRetryEnabled: false` arrived as an optional
flag for exactly that). The hooks keep the shell role — subscription handles,
timers, row stores, and effect execution; the sandwich is the same, the
"class" is a Preact effect.

**Composition status: plain function, no superpipe.** The machine is a single
switch decider with no staged effects, so a pipeline layer would not earn its
place (Decision item on blessed idioms; the call was made in PR 3 of the chain
and held). Consequence, reconciled by the closing sweep: the web `superpipe`
dependency added for the pilot "functional cores" is unused and was removed
(only daemon modules import it, and daemon declares its own) — re-add it when a
superpipe-based combinator actually lands in web. The pilot therefore validates
the *shape* `reduceRun` is meant to own — a per-event reducer plus a
facade/executor that interprets its effects — without promoting the combinator.

**Rule-of-three count for `reduceRun`.** The executor half of the shape
(dispatch → transition → interpret effects, plus timer cleanup) is hand-rolled
four times today, once per facade, ~30–40 structurally identical lines each:
4 real uses, at the promotion threshold. The next consumer is already scouted,
not speculative: the pilot-12 closing report's store assessment finds
`app-mcp-store`, `space-mcp-store`, and `skills-store` fit the machine
(single fixed subscription, snapshot/delta listeners, reconnect resubscribe;
needs `snapshotRetryEnabled: false`, an async bridge for awaited-and-throwing
subscribes, a fresh machine per actual subscription lifecycle since
`disposed` is terminal — `skills-store`'s ref-counted `subscribe()` must key
machine creation to the 0→1 transition, not to each acquisition — and a
delta-gating adapter or explicit behavior-change decision, since these stores
apply matching deltas unconditionally while the machine emits them only from
`live`), with
`space-store` (four near-identical blocks, highest payoff) and
`global-store` (dynamic params) behind small decisions. What blocks promotion
is not the count but drift: the four executors differ in config and policy —
snapshot watchdog on/off, subscribe-rejection retry ladder, error surfacing,
reconnect mechanism — consolidated in the closing report's drift table with
proposed (not applied) unification PRs. Unify first and the combinator falls
out with structural differences; promote now and the drift calcifies inside it.

**Costs:** production +385 web lines — the machine (+224) against four facades
914 → 1,075 (+161 of interpretation wiring; no hook shrank, and none was
expected: the pilots deduplicate *decisions*, and the per-hook row stores,
sorters, and side channels remain hook-owned by design). Tests +2,118: the
machine contract suite (496 lines, including a full status×event
transition-table pin) plus four `.lifecycle.test.ts` characterization files
(584 + 352 + 272 + 414). Pins-first discipline held: every pre-existing suite
passed unchanged except one pinned expectation that moved 12 → 14 subscribe
calls — the old inline code let a superseded generation's subscribe resolution
consume retry budget where the machine's generation guard drops it, restoring
the full budget on reconnect.

**The closing sweep found the migrations clean.** Diffed against their
pre-migration bodies, the hooks retain no retired inline lifecycle remnants —
STM's watchdog consts, GRP's old `subscribeWithRetry`/`MAX_RETRIES` closure,
and the inline generation counters are all gone; GRP's subscribe-rejection
ladder survives by design as an executor concern (the machine has no
request-failure event) and is U3's extraction target in the closing report; knip
(files/dependencies/exports), oxlint, and `tsc --noEmit` are clean on web. The
one find was the unused `superpipe` dependency above. Recorded, not removed:
the `'full'` query variant of `useSpaceTaskMessages` has no production caller
in web (daemon still registers the named query); `LiveQueryEmission`/
`LiveQueryLifecycleTransition` are exported contract types with no external
importer. Full drift table, store-variant assessment, and unification
proposals U1–U6 (watchdog everywhere, one reconnect mechanism, shared
executor, store adoptions, milestones error listener, `'full'` retirement —
each with risk): `docs/reports/ui-pilot-6-live-query-lifecycle-drift.md`,
owner decides.

**Follow-on candidates this unblocks.**

- **`requestRun` is already at threshold on the same evidence.** The
  version-guarded fetch idiom (`requestVersion` ref, guard every apply) recurs
  in ≥6 web production sites: `SpaceForge.tsx` alone hosts five guarded fetch
  closures (~27 guard checks), plus `ScopeDetailPanel`, `GitHubHealthPanel`
  (refresh generation), `SpaceTaskPane`, and `space-store`. A stale response
  structurally cannot apply is a sibling discipline: the lifecycle machine guards
  its own dispatch generation and captured timers; `requestRun` would guard the
  apply stage against a stale fetch return — the combinator would give it to
  fetches.
- **The `components/space` bucket is the next web surface.** 32.4k non-test
  source lines across 85 files at pilot close, unchanged from pilot start
  (32.2k) — 21.5k at the top level, `visual-editor/` 7.3k, `thread/` 3.4k; the
  ~27k plan figure undercounts it. Its subscriptions ride the six stores
  assessed above; its panels hold the `requestRun` sites. The Phase 5 line
  ("web functional cores — P1: `useTurnBlocks`, message projections,
  model-switcher projections") should be executed in the machine+facade shape
  this pilot established.

UI pilot 6 PRs (the pilot-12 record): #2714, #2716, #2718, #2724, #2756,
#2788, plus this closing PR (drift report + dead-code sweep + this note).

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
- **Done (chain C / pilot 9):** the message-search FTS admission gates
  (`decisionRun`) and the delivery-status routing table under
  `src/storage/repositories/`, with the session-rebuild parity alignment —
  see "Pilot 9" above for the lazy-fact caveats and the deliberate rebuild
  residual. Chain B (save admission) from the same survey remains in flight.
- **Done (chain A / pilot 10):** the `sdk_messages` read-projection layer of
  `SDKMessageRepository` extracted as the pure `sdk-message-projections.ts`
  (parse/inflate, text/content shapers over an explicit first-block-only /
  join-all policy parameter, renderable-text projection, page composition) —
  see "Pilot 10" above for the policy-parameterization idiom and the closing
  sweep. The repository's read projections are done; the write/admission side
  is chain B's (pilot 11), not revisited here.
- **Done (chain B / pilot 11):** the save-admission core, badge instruction
  set, and `updateMessageStatus` plan interpreter under
  `src/storage/repositories/` — see "Pilot 11" above for the
  variant-parameterized divergences, the badge predicate's coupled TS/SQL
  pair, and the worker/recovery-script contract. Chain C from the same
  survey lands its own note.
- **Done (chain I / pilot 8):** the pending-queue drain (admission gates,
  envelope transforms, the `decisionRun` composition) with both flush sites
  as gather → decide → interpret consumers, and the injection-shell delivery
  steps around the Pilot 4 inject core, which stays single-sourced in
  `decideInjectDelivery` — see "Pilot 8" above for the boundary caveats, the
  envelope-detector retirement, and the mini-pilot shelf (the MCP-factory
  task-tool handlers onto the Pilot 5 routing cores, the
  `rehydrateSubSession` failure-cleanup asymmetry, the rehydrate admission
  gates).
- **Done (pilot 12, web):** the four LiveQuery hook lifecycles onto the pure
  `live-query-lifecycle` machine, plain-function composition (no superpipe —
  earn-the-layer held); the `reduceRun` executor shape is at 4 real uses with
  three store consumers scouted — see "Pilot 12" above and the closing drift
  report for the unification path.
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
  | 0 | Task CAS (`casStatus`), transition-table enforcement in `updateTaskAndEmit`, spawn reservation, run/execution CAS, durable intent/outbox + compensation-record repositories | Product behavior change, not refactor; needs characterization pins. The `update_task` tool layer delegates to the repo-layer table — one source of truth (aligns with Pilot 5). Consumption so far: transition-table enforcement (#2682); `casStatus` (#2684 recovery blocked-write; Pilot 7 added the trailing promotion); `casExecutionStatus` across the spawn seam and the spawn reservation (Pilot 7 — its consumers carry the before/after pins). Implemented but unconsumed: the run CAS (`casRunStatus`). Not yet implemented at all: the durable intent/outbox and compensation-record repositories for Space flows (only the unrelated message-delivery outbox exists), so those rows name future primitives, not dormant code. |
  | 1 | `repairQueuedWorkflowNodeHandoffs` as one direct pipeline (revised 2026-08-25 — no longer "a staged sub-pipeline") | First flow built under the one-pipeline-per-path revision; proves the pattern on one opaque effect. |
  | 2 | `handleAliveStuckExecutions` + crash reset | First recovery handler; the `withSignal` candidate lands here only if a test demonstrates the race. |
  | 3 | `handleWaitingRebindExecutions` | |
  | 4 | `handleNonTerminalIdleExecutions` | |
  | 5 | `handleTerminalErrorIdleExecutions` | |
  | 6 | Compose `processRunTick` as one top-level direct pipeline (revised 2026-08-25 — no longer "one top-level `stagedRun`") | Sequenced strictly after the pilot-3 apply PR merges — same lines. |
  | 7 | Same pattern beyond the tick: runtime nags, checkpoint/restore, message dispatch, startup handoff repair | |

- **Candidate idiom names (observed, not designed — revised 2026-08-25):** these
  are labels for shapes that direct use may or may not eventually consolidate,
  not a build queue. `transformRun` (P1 pure transforms with data-dependent
  early exit: github-normalizer, store delta application, message-shape
  normalization); `requestRun` (web: generation-guarded request/apply — a stale
  response structurally cannot apply — SpaceForge/ScopeDetail fetches,
  GitHubHealthPanel refresh, every version-guarded panel fetch);
  `transactionalRun` (P7/Phase 4 — effects run only after commit); `reduceRun`
  (P6/Phase 3 — per-event reducer bodies; pilot 12's subscription-lifecycle
  machine is the first instance and its executor half already recurs 4×). A
  combinator is proposed only when ≈3 direct uses share the shape; until then,
  compose directly. See "One pipeline per business path."
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
- Pilot 9 (chain C) files:
  `packages/daemon/src/storage/repositories/{message-search-admission,delivery-status-routing}.ts`;
  interpreters in `sdk-message-repository.ts` (`upsertMessageSearchRow`, the
  ten delivery wrappers, `deferEnqueuedUserMessage`) and
  `session-repository.ts` (`rebuildMessageSearchRows`); survey and C4 outcome
  in `docs/reports/sdk-message-repository-superpipe-survey.md`. Pilot 9 PRs:
  #2755, #2771, #2791, #2804, plus this closing sweep.
- Pilot 10 (chain A) files:
  `packages/daemon/src/storage/repositories/sdk-message-projections.ts`;
  consumer in `sdk-message-repository.ts`. Characterization pins in
  `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-repository.test.ts`
  (A1), module suite in `sdk-message-projections.test.ts`. Pilot 10 PRs:
  #2730, #2766, #2793, #2811, plus this closing sweep.
- Pilot 11 (chain B) files:
  `packages/daemon/src/storage/repositories/{sdk-message-admission,sdk-message-badge,sdk-message-status-plan}.ts`;
  interpreters in `sdk-message-repository.ts` (`saveSDKMessage`,
  `saveUserMessageCore`, `saveHyperNeoActionMessage`, `updateMessageStatus`,
  `applyBadgeUpdate`); pins in
  `packages/daemon/tests/unit/4-space-storage/storage/{sdk-message-save-admission-drift,sdk-message-admission,sdk-message-badge,sdk-message-status-plan,task-id-resolution-cache}.test.ts`;
  survey and chain plan in
  `docs/reports/sdk-message-repository-superpipe-survey.md`. Pilot 11 PRs:
  #2736, #2767, #2794, #2815, plus this closing sweep.
- Pilot 8 (chain I) files:
  `packages/daemon/src/lib/space/runtime/{pending-drain-gates,pending-envelope,pending-drain-decision-pipeline,injection-delivery-steps}.ts`;
  interpreters in `task-agent-manager.ts` (`injectMessageIntoSession`,
  `flushPendingMessagesForTarget`, `flushPendingMessagesForSpaceAgent`); pins
  in
  `packages/daemon/tests/unit/5-space/runtime/{task-agent-manager-pending-drain,reset-context-per-turn,pending-drain-gates,pending-envelope,pending-drain-decision-pipeline,injection-delivery-steps}.test.ts`.
  Pilot 8 PRs: #2799, #2809, #2817, #2829, #2840, plus this closing sweep.
- Pilot 12 (UI pilot 6) files: `packages/web/src/lib/live-query-lifecycle.ts`
  (machine, with its contract suite alongside); facades in
  `packages/web/src/hooks/{useSpaceTaskMessages,useActorMessageProjections,
  useTaskMilestones,useGroupMessages}.ts`, pins in
  `hooks/__tests__/*.lifecycle.test.ts`. Closing drift report (config-drift
  table, store-variant assessment, unification proposals U1–U6):
  `docs/reports/ui-pilot-6-live-query-lifecycle-drift.md`. UI pilot 6 PRs:
  #2714, #2716, #2718, #2724, #2756, #2788, plus the closing PR.
- superpipe 0.17.0 — library semantics map and contract tests produced during the
  pilot.
