# ADR 0004 — Revision history and retired framing (reference only)

Extracted from the ADR body 2026-08-25 so the ADR carries only executable guidance. Nothing here is normative; where it conflicts with the ADR, the ADR wins.

## Status chronology (as previously recorded)

Revised 2026-08-20 after owner review: scope widened from decision cores to pure
pipelines generally — decisions, multi-step transforms (rendering/projection), and
staged async flows (decide → effect → re-snapshot). The boundaries in
"Where superpipe must not be used" still hold; "free-form effect executor"
replaces the earlier blanket "effect executor".Revised 2026-08-21 after issue #2670 (stagedRun RFC): staged run pipelines are
sanctioned — `stagedRun` composes snapshot/decide/effect/resnapshot stages, with
effect stages permitted inside pipelines under atomicity-delegation conditions.
Answers the RFC's five open questions; see "Staged run pipelines". The prior
boundary is retained in substance: a pipeline still never owns atomicity.Revised 2026-08-25 after owner review: the combinator-centric organization is
retired as a gate. Direct superpipe composition — one cohesive, business-named
pipeline per business path, mixing decision, transform, and effect stages — is
the default form for new work in daemon and web. `decisionRun` and `stagedRun`
remain for their existing call sites and may be used where they fit, but no
flow must be pre-classified into a category, and no combinator is designed
ahead of the direct uses that would justify it. See "One pipeline per business
path" and Decision item 3.

## Validation chronology

Validated further by pilot 3 (2026-08-21): `processRunTick` rewritten as a staged
interpreter over three extracted cores plus a `decisionRun` admission pipeline —
see "Pilot 3" below for boundary caveats.Validated further by pilot 5 (2026-08-21): the eight task-mutation MCP tools in
`space-agent-tools.ts` interpreted as staged pipelines over extracted
admission/routing cores — see "Pilot 5" below for the recorded asymmetries and
the group roadmap.Validated further by pilot 4 (2026-08-21): the agent message-delivery chain —
inject admission and turn-end flush as `decisionRun` pipelines, turn-outcome
and reconcile as point decisions — with the closing PRs fixing the two live
incident bugs the decision-table pins surfaced; see "Pilot 4" below for the two
design lessons it added to the record.Validated further by pilot 6 / chain S (2026-08-23): the verified-stop ladder
(`stopSessionVerified`) applied as a `stagedRun` interpreter over extracted
gates — the combinator's first composed-then-swapped production flow. See
"Pilot 6" below for the boundary caveats, the compensation deferral, and the
closing sweep.Validated further by pilot 7 (2026-08-23, Chain P): the workflow-node spawn
seam applied as a staged interpreter over extracted cores and the
lazy-activation path as an inline interpreter over its pure routing core —
and the first production consumer of
`casExecutionStatus` and the spawn reservation, whose superseded outcomes
replace previously tolerated racy writes (the other Phase 0 primitives had
already gained consumers just before the chain: transition-table enforcement
#2682, `casStatus` #2684). See "Pilot 7" below for the pinned behavior deltas,
the Pilot 3 spawn-seam race closure, and the boundary caveats.Validated further by pilot 9 / chain C (2026-08-23): the message-search FTS
admission gates as a `decisionRun` core and the delivery-status family as a
routing table under `src/storage/` — the first pilot whose cores live in the
repository layer — with the second production FTS admission implementation
(`SessionRepository.rebuildMessageSearchRows`) aligned to the extracted
vocabulary and parity-pinned. See "Pilot 9" below for the lazy-fact caveats
and the deliberate rebuild residual.Validated further by pilot 10 / chain A (2026-08-23): the `sdk_messages`
read-projection layer of `SDKMessageRepository` extracted as pure transforms
into `sdk-message-projections.ts` — the widened scope's P1 pure-transform form
applied below the runtime, at the persistence boundary. See "Pilot 10" below
for the policy-parameterization discipline the chain settled on and its
closing sweep. (Pilot 8 is reserved for chain I, the pending-queue drain +
injection shell, by Pilot 7's closing note; pilot 9 is chain C's.)Validated further by pilot 11 / chain B (2026-08-23): the `sdk_messages`
write side — save admission as a pure core over a normalized input, badge
maintenance as an instruction set, and the delivery-status flip as a
plan/interpret whose per-instruction CAS guards apply inside one
transaction (a Phase 4 relative at the storage layer: guarded effects
inside the transaction, not after commit). See "Pilot 11" below for
the coupled TS/SQL badge predicate, the per-variant admission placement
divergence, and the closing sweep.Validated further by pilot 8 / chain I (2026-08-23): the pending-queue
drain — admission gates and envelope transforms as pure cores, the drain
admission as a `decisionRun`, two flush sites as its gather → decide →
interpret consumers — and the injection shell around the Pilot 4 inject
decision, which stays single-sourced in `decideInjectDelivery` while its
delivery-row steps and v1/v2 branch moved to a steps module. See
"Pilot 8" below for the boundary caveats, the envelope-detector
retirement, and the remaining mini-pilot shelf for
`task-agent-manager.ts`.Validated further by pilot 12 (2026-08-23, first web-side pilot — the UI
chain's own "pilot 6", renumbered here to keep the ADR sequence unambiguous):
the four hand-rolled LiveQuery subscription hook lifecycles pinned then
migrated onto one pure machine, `live-query-lifecycle.ts` — composition stayed
a plain function under the earn-the-layer rule, so the pilot validates the
reduceRun shape (reducer + effects-executing facade) without yet promoting the
combinator; see "Pilot 12" below for the rule-of-three count and the recorded
config drift.

## Retired: stagedRun full design record (2026-08-21, demoted to guidance 2026-08-25)

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

## Retired: Consequences as previously recorded

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
