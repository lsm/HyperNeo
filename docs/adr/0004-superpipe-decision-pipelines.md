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
  side effects — network, publishes, session injects — carry condition 5's
  idempotence/compensation obligation instead.
- **`resnapshot`** — re-reads the specific keys a later stage depends on.
- **`halt`** — terminal; returns the outcome.

Branching is deliberately not a stage type: a `decide` stage's output drives
superpipe's native `!`/`?` control flow. A separate `branch` stage would duplicate
the library.

**Conditions on `effect` stages.** The prior boundary — effects at pipeline
boundaries, a pipeline never owns atomicity — was drawn because superpipe provides
no atomicity. It is retained in substance and relocated: atomicity moves into
repository primitives, which effect stages must call.

1. **Atomicity delegation.** Every effect stage writes persistent state through
   CAS, reservation, or transition-table-guarded primitives (Phase 0 below) — a
   transition-table guard qualifies only when guard and write commit as one
   conditional update or transaction, never check-then-write. Blind
   read-modify-write inside an effect stage is banned.
2. **Declared read/write sets, enforced.** The interpreter refuses to run a flow
   in which a stage reads a key that an earlier effect stage wrote unless an
   intervening `snapshot`/`resnapshot` re-gathers it — staleness prevention made
   structural, the same way `!hasDecided` made precedence structural. The
   declaration is load-bearing by construction: stages access state through the
   declared keys' accessors, not the raw context, so an undeclared read is not
   expressible.
3. **CAS failure is a decision, not an error.** A failed CAS stamps a
   `superseded` outcome; the flow re-snapshots or halts for this tick. No
   in-tick retry loops. The recovery-handler-overwrites-`stopped`-with-`blocked`
   race class becomes structurally impossible instead of tested away. Effect
   stages return their primitives' CAS outcomes and the interpreter — not the
   effect body — stamps `superseded` and halts, keeping decision-stamping out of
   the effect contract. Correlated transitions (an execution, its run, the
   canonical task) compose into one transactional primitive per set or
   compensate already-committed writes before halting — a `superseded` halt
   never leaves a half-applied set.
4. **Microtask pinning.** Decision item 5's proof obligation carries over: any
   `stagedRun` invoked from the run tick pins its microtask profile in tests.
   `decide` stages stay synchronous; `snapshot`/`effect` stages may use
   `.endAsync`.
5. **Idempotence or compensation** at every effect stage (unchanged from
   Decision item 4).

**Effect-stage errors.** A throwing effect stage fails the pass: the interpreter
catches, logs, and returns an error outcome — no in-flow retry. Recovery is the
caller's re-entry with a fresh snapshot plus condition 5's idempotence or
compensation (for the run tick, the next tick).

**The RFC's open questions, answered:**

1. **Location:** new module
   `packages/daemon/src/lib/space/runtime/staged-run.ts`; `space-runtime.ts` is
   already 8k+ lines. This makes `staged-run.ts` the second sanctioned superpipe
   import site (Decision item 3 amended above).
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

## Roadmap

- **Done (pilot):** admission gates extracted as pure functions (no superpipe
  needed there); delivery + post-activation decision pipelines; `decisionRun`
  combinator; interpreter dedup.
- **Done (pilot 3):** run-tick admission/settlement/spawn cores and the
  `processRunTick` staged interpreter — see "Pilot 3" above.
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
- **Staged rollout of `stagedRun`** (from #2670; the pilot-3 "future mini-pilots"
  sub-flows become these phases):

  | Phase | Scope | Notes |
  | --- | --- | --- |
  | 0 | Task CAS (`casStatus`), transition-table enforcement in `updateTaskAndEmit`, spawn reservation, run/execution CAS | Product behavior change, not refactor; needs characterization pins. The `update_task` tool layer delegates to the repo-layer table — one source of truth (aligns with Pilot 5). |
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
- RFC: issue #2670 (`stagedRun` rollout proposal; its open questions are answered
  by the "Staged run pipelines" section).
- Staged combinator (Phase 1+): `packages/daemon/src/lib/space/runtime/staged-run.ts`.
- superpipe 0.17.0 — library semantics map and contract tests produced during the
  pilot.
