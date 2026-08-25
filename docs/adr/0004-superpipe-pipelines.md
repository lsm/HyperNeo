# ADR 0004: Superpipe Pipelines

## Status

Accepted — 2026-08-20. Revised 2026-08-25 (current): direct superpipe
composition, one pipeline per business path, no combinator pre-categorization.
Revision history and retired framing: `docs/adr/history/0004-revisions.md`.
Pilot/validation records: `docs/adr/history/0004-pilots.md`. Those files are
reference only; this ADR is the normative document.

## Context

Runtime and domain classes accumulated long imperative cascades that interleave
reads, decisions, and effects — gate order lived only in control flow, invisible
to unit tests without the whole runtime. [superpipe](https://github.com/lsm/superpipe)
(pinned exact `0.17.0`, daemon and web) is the composition engine: dependency-injected
named stages, ctx threading, `!dep`/`?dep` control-flow prefixes, per-stage error
handlers, output picking/merging, sync (`.end`) and async (`.endAsync`) executors,
`withSignal` cancellation. It has been used for years on complex codebases; this
ADR adopts it directly, without an intermediate abstraction layer.

## Decision

**One cohesive pipeline per business path.** A business logic path — spawn,
delivery, stop, recovery, ingestion — composes as ONE superpipe pipeline named
for the operation (`deliverMessage`, `spawnWorkflowNodeAgent`), whose stages
freely mix pure decisions, transforms, and effects. Do not pre-classify a flow
as decision vs staged vs transform; do not split one path across pipelines.

1. **Compose directly.** Superpipe may be imported anywhere a pipeline fits;
   there is no import boundary. The existing `decisionRun`
   (`lib/space/runtime/decision-pipeline.ts`) and `stagedRun`
   (`lib/space/runtime/staged-run.ts`) combinators remain usable where they
   fit, including their existing call sites, but nothing routes through a
   combinator by requirement. Extract a NEW combinator only after ≈3 direct
   uses reveal a recurring shape; never design one ahead of use.
2. **Stages.** A stage is a function in the named pipeline. Pure decision and
   transform stages are preferred wherever no await or write is needed; effect
   stages are normal where the path needs them. `!dep` halts the run
   (data-dependent early exit); `?dep` skips only its own optional stage when
   the dependency is undefined. `.end` for fully sync paths, `.endAsync` when a
   stage awaits.
3. **Effects delegate atomicity.** Every effect stage writes through repository
   primitives — CAS (`casStatus`, `casRunStatus`, `casExecutionStatus`), the
   task-transition table, the spawn reservation — and is idempotent or
   compensable. Blind read-modify-write inside a stage is banned. A pipeline
   never owns atomicity; a failed CAS is a `superseded` outcome, not an error,
   with no in-flow retry loops.
4. **Sync profile where it matters.** Pipelines invoked from the run tick (or
   otherwise coupled to background timers) keep their decide-equivalent stages
   synchronous and pin the microtask profile in tests; the sync executor
   preserves event-loop interleaving exactly. Elsewhere async is fine.
5. **Resources stay in classes.** `AbortController`s, timers, subscriptions,
   query objects, handles — pipelines receive values and declare outcomes;
   the owning class executes lifecycle.
6. **Cancellation is requirement-driven.** `withSignal` is wired when a real
   cancellation requirement appears, not to exercise the feature.
7. **Testing.** Pin behavior before refactoring (parity/characterization
   tests), cover decision tables and stage precedence in unit tests, and keep
   pre-existing scenario suites passing unchanged as the parity proof.
8. **Hot paths stay inline.** Pipeline overhead is ~2-2.6 µs/decision vs ~75 ns
   for an if-cascade (benchmark: `packages/daemon/scripts/benchmark/decision-pipeline.ts`).
   Awaited boundaries are fine; tight per-token/per-event loops are not.

### Where superpipe must not be used

- **As a state machine or unbounded fold.** State lives in the runtime/DB; a
  pipeline decides one step. A pipeline may be a per-event reducer body, never
  the loop.
- **As an owner of atomicity.** See Decision 3.
- **As a resource owner.** See Decision 5.
- **On hot inner loops.** See Decision 8.

### Guidance inherited from the combinators (optional, not gates)

For race-prone effect stages, `stagedRun`'s disciplines remain good practice:
declare the state keys a stage reads and writes, re-gather between write and
read, treat correlated multi-row transitions as one primitive or a compensation
chain, and unwind compensations in reverse on failure. The full design record
is `docs/adr/history/0004-revisions.md`.

## Pattern taxonomy (vocabulary, not categories to choose between)

| Pattern | Shape |
| --- | --- |
| P1 pure sync transform | `pipe → end`, early exit via `!dep` |
| P2 awaitable flow | async stages, `endAsync` |
| P3 guard/validation gate | boolean `!dep` halts |
| P4 optional stages | `?dep` skips when undefined |
| P6 per-event reducer | pipeline as reducer body, never the loop |
| P7 functional sandwich | read → plan → apply |
| Mixed business path | decisions + transforms + effects in one pipeline (the default) |

## Roadmap (open items)

- Recovery handlers as one direct pipeline each: `repairQueuedWorkflowNodeHandoffs`
  first, then the four `handle*Executions` handlers, then top-level
  `processRunTick` composition.
- Provider-concurrency admission gate (design:
  `docs/design/provider-concurrency-admission-gate.md`).
- Web direct pipelines: generation-guarded fetch machines (SpaceForge,
  ScopeDetail, GitHubHealthPanel); store delta application.
- External-event ingestion gates (self-event suppression, type/field filters) —
  compose directly at the ingestion seam.
- Candidate idiom names (`transformRun`, `requestRun`, `transactionalRun`,
  `reduceRun`) are observations, not a build queue; propose a combinator only
  when ≈3 direct uses share a shape.

## References

- Combinator modules: `packages/daemon/src/lib/space/runtime/{decision-pipeline,staged-run}.ts`
- Benchmark: `packages/daemon/scripts/benchmark/decision-pipeline.ts`
- History: `docs/adr/history/0004-revisions.md` (revisions, retired framing),
  `docs/adr/history/0004-pilots.md` (pilot records, completion log)
- Surveys/proposals: `docs/agent-layer-superpipe-pilot-proposal.md`,
  `docs/research/external-event-ingestion-filters-survey.md`,
  `docs/reports/*.md`
