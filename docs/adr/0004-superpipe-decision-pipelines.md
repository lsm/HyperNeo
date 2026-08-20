# ADR 0004: Superpipe Decision Pipelines for Runtime Decision Cores

## Status

Accepted — 2026-08-20. Validated by the superpipe pilot on `superpipe-pilot-1`:
dead-machinery removal + parity harness (#2578), pure admission gates (#2582),
delivery decision pipeline + interpreter (#2589), shared `decisionRun` combinator
(#2591). Upstream library pinned exact at `superpipe@0.17.0`. This ADR records the
adopted pattern, its boundaries, and the migration roadmap. It does not mandate
immediate adoption elsewhere; each phase gets its own go/no-go.

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

Adopt the functional-core sandwich for runtime decision flows. Superpipe is used
only for the decision core; the class keeps snapshot reads and effect execution.

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
4. **Decision cores stay synchronous** (`.end`, never `.endAsync`). Pilot evidence:
   the async executor's promise settlement added microtask boundaries that changed
   interleaving with background tick timers and broke a timing-sensitive test
   (transient-dispatch retry in `space-runtime-external-events.test.ts`); the sync
   executor preserves the pre-refactor event-loop profile exactly. Async snapshot
   gathering stays in the shell; the core is sync by convention until a case is
   made and proven.
5. **Testing conventions.** (a) A parity harness pins behavior against the parent
   commit before extraction — transcript-style instrumentation of store marks and
   effect calls (`space-runtime-external-event-admission-parity.test.ts`). (b) Gate
   unit tests cover the decision table, precedence ("terminal beats every
   downstream gate"), and pass-through identity. (c) The interpreter is covered by
   the pre-existing scenario suites, which must pass unchanged — that is the
   parity proof.
6. **Cancellation is requirement-driven.** `run.withSignal(signal, …)` per-run
   `AbortSignal` cancellation exists and is unused. Wire it when a real
   cancellation requirement appears, not to exercise the feature.

### Where superpipe must not be used

- **As a state machine or unbounded fold.** State lives in the runtime/DB; a
  pipeline decides one step. Stream reduction may use a pipeline as the per-event
  reducer body (Phase 3), never as the loop.
- **As an effect executor.** Decisions are data. DB writes, network, publishes,
  session injects stay in the interpreter.
- **As a resource owner.** `AbortController`s, timers, subscriptions, query
  objects stay in classes; pipelines receive values.
- **On hot paths.** Per-stage container allocation is not free. Planning flows are
  not hot; inner loops stay inline functions. (Unbenchmarked here — treat as
  guidance until a micro-benchmark exists.)

### Pattern taxonomy (from the adoption study)

| Pattern | Shape | HyperNeo fit |
| --- | --- | --- |
| P1 pure sync transform | `pipe → end` | data mapping, projections |
| P2 awaitable planning flow | async deciders, `endAsync` | **pilot used sync cores instead**; async variant unproven in-repo |
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

## Roadmap

- **Done (pilot):** admission gates extracted as pure functions (no superpipe
  needed there); delivery + post-activation decision pipelines; `decisionRun`
  combinator; interpreter dedup.
- **Phase 1 — job settlement decider** (`job-queue-processor.ts`): already a
  discriminated union (`complete | retry | dead-letter | park | ignore-stale-claim`)
  with existing tests. First test of whether an async core is ever needed, or
  "sync core, async shell" holds as a standing convention. Go/no-go for Phases
  2–5.
- **Phase 2 — workflow transition resolution** (message-delivery admission half
  done in the pilot).
- **Phase 3 — per-event stream reduction** (query-runner event folds, ACP
  translation as P6 reducer bodies).
- **Phase 4 — transaction sandwich** (schedule transactions, workflow hook
  engine): read → plan → CAS within transaction → apply effects after commit.
- **Phase 5 — web functional cores** (P1: `useTurnBlocks`, message projections,
  model-switcher projections).
- **Carried research:** hot-path micro-benchmark of `decisionRun` vs a hand-written
  cascade; async/`withSignal` validation if Phase 1 wants an async core.

## References

- Pilot files: `packages/daemon/src/lib/space/runtime/{decision-pipeline,
  external-event-delivery-pipeline, external-event-admission-gates}.ts`; delivery
  interpreter in `space-runtime.ts`
  (`deliverExternalEventToWorkflowTarget` and helpers).
- Parity harness:
  `packages/daemon/tests/unit/5-space/runtime/space-runtime-external-event-admission-parity.test.ts`
- Pilot PRs: #2578, #2582, #2589, #2591 (branch `superpipe-pilot-1`).
- superpipe 0.17.0 — library semantics map and contract tests produced during the
  pilot.
