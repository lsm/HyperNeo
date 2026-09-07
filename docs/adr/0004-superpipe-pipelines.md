# ADR 0004: Superpipe Pipelines

## Status

Accepted — 2026-08-20. Revised 2026-08-25: direct superpipe composition, one
pipeline per business path, no combinator pre-categorization. Revised
2026-09-07 (current): canonical `result:`-arm gate shape with named
dependencies, the decide-owning hybrid, `decisionRun`/`stagedRun` deprecated.
Revision history and retired framing: `docs/adr/history/0004-revisions.md`.
Pilot/validation records: `docs/adr/history/0004-pilots.md`. Those files are
reference only; this ADR is the normative document.

## Context

Runtime and domain classes accumulated long imperative cascades that interleave
reads, decisions, and effects — gate order lived only in control flow, invisible
to unit tests without the whole runtime. [superpipe](https://github.com/lsm/superpipe)
(pinned exact `0.18.0` in `packages/daemon` and `packages/web`) is the composition
engine: dependency-injected named stages, ctx threading, `!dep`/`?dep` control-flow
prefixes, per-stage error handlers, output picking/merging, sync (`.end`) and async
(`.endAsync`) executors,
`withSignal` cancellation. It has been used for years on complex codebases; this
ADR adopts it directly, without an intermediate abstraction layer.

## Decision

**One cohesive pipeline per business path.** A business logic path — spawn,
delivery, stop, recovery, ingestion — composes as ONE superpipe pipeline named
for the operation (`deliverMessage`, `spawnWorkflowNodeAgent`), whose stages
freely mix pure decisions, transforms, and effects. Do not pre-classify a flow
as decision vs staged vs transform; do not split one path across pipelines.

Most business logic decomposes this way, and that is the argument for the
style, not a nice-to-have: each stage is a named unit with declared inputs and
outputs, per-stage and per-gate unit tests replace monolithic scenario
pinning, and reasoning about the whole path reduces to reading one composition
site where every `.pipe` line shows the dataflow. PR #3804's admission gates
went from two hand-copied gate clusters to one named pipeline with
table-driven gate tests.

1. **Compose directly.** Superpipe may be imported anywhere a pipeline fits;
   there is no import boundary. `decisionRun`
   (`lib/space/runtime/decision-pipeline.ts`) and `stagedRun`
   (`lib/space/runtime/staged-run.ts`) are **deprecated** (2026-09-07): both
   pre-classify flows into decision-vs-staged categories the direct-pipe style
   does not need — the wrong abstraction. New work composes direct pipelines
   only; do not add combinator call sites. Existing call sites stay put and
   migrate slice-by-slice in the slices that touch them.
2. **Stages.** A stage is a function in the named pipeline. Pure decision and
   transform stages are preferred wherever no await or write is needed; effect
   stages are normal where the path needs them. `!dep` halts the run
   (data-dependent early exit); `?dep` skips only its own optional stage when
   the dependency is undefined. `.end` for fully sync paths, `.endAsync` when a
   stage awaits.
3. **Effects delegate atomicity.** For persistent daemon writes, every effect
   stage writes through repository primitives — CAS (`casStatus`,
   `casRunStatus`, `casExecutionStatus`), the task-transition table, the spawn
   reservation — and is idempotent or compensable. Blind read-modify-write
   inside a stage is banned. A pipeline never owns atomicity; a failed CAS is a
   `superseded` outcome, not an error, with no in-flow retry loops. Where no
   repository primitive exists (web store/DOM effects, publishes, network
   calls), the same discipline applies through the equivalent mechanism —
   generation guards so stale results cannot apply, idempotent application, or
   compensation — chosen per effect, not assumed away.
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
   pre-existing scenario suites passing unchanged as the parity proof. A gate
   pipeline additionally gets table-driven per-gate tests: each gate is a
   named pure function over declared inputs, so its decision table tests
   without the runtime, the shell, or the other gates.
8. **Hot paths stay inline.** Pipeline overhead is ~2-2.6 µs/decision vs ~75 ns
   for an if-cascade (benchmark: `packages/daemon/scripts/benchmark/decision-pipeline.ts`).
   Awaited boundaries are fine; tight per-token/per-event loops are not.

### Canonical gate shape: one shared `result:` output (superpipe ≥ 0.18.0)

Superpipe 0.18.0 adds opt-in `result:<name>` outputs: a stage returns exactly
one own arm — `{ value }` binds `<name>` and the run continues; `{ reason }`
binds `<name>` and resolves the run without starting the remaining stages. For
a typed business early exit, the `reason` arm is the preferred idiom over
hand-rolled halt flags or ctx-threaded boolean predicates; `!dep` remains
valid for data-dependent dependency halts.

The canonical rejection cascade — reference implementation
`decideReplayAdmission` in
`packages/daemon/src/lib/mailbox/deferred-replay-scheduler.ts` (PR #3804):

- **Gates share one `result:<name>` output.** Each gate is a named, exported,
  pure function taking the admitted value and returning
  `{ value: X } | { reason: Literal }`. The reason-literal union is the skip
  taxonomy, owned by the module. The first `reason` arm resolves the run;
  gate order is precedence, visible in the composition.
- **Named dependencies and inputs, not a ctx object.** Each
  `.pipe(gate, 'in', 'result:admission')` line shows what flows in and out at
  the composition site; the dataflow is auditable without reading stage
  bodies. A threaded ctx object hides it and is discouraged for new pipelines.
- **All-sync stages yield a sync callable.** A pipeline whose stages never
  await ends with `.end(...)` and is invoked synchronously — no `await` at the
  call site, no microtask boundary (Decision 4).

```ts
export type ReplaySkipReason =
  | 'no_cached_session'
  | 'manual_mode'
  | 'session_unavailable';

export function gateSessionPresent(
  session: AgentSession | null
): { value: AgentSession } | { reason: ReplaySkipReason } {
  if (session == null) return { reason: 'no_cached_session' };
  return { value: session };
}

export const decideReplayAdmission = (
  superpipe({})('mailbox-deferred-replay-admission') as PipelineAPI
)
  .input(['session'])
  .pipe(gateSessionPresent, 'session', 'result:admission')
  .pipe(gateQueryMode, 'admission', 'result:admission')
  .pipe(gateLifecycleStatus, 'admission', 'result:admission')
  .end('admission') as (
  session: AgentSession | null
) => AgentSession | ReplaySkipReason;
```

### The decide-owning hybrid

The exclusions below bar a pipeline from **owning** the loop, the state, or
the resources — never from the decision points a loop consults. The recurring
composition is the **decide-owning hybrid**: gates as a `result:` pipeline
(above), loop and resources in the owning shell. The shell owns the iteration,
the waiters, the timers, the retry/backoff state, and the tracking sets; at
each decision point it calls the pipeline synchronously and routes on
`value | reason`. PR #3804's scheduler is the shape: an imperative
resource-owning shell (`createMailboxDeferredReplayScheduler`) whose
busy-wait/park/retry loop consults `decideReplayAdmission` at admission and
again immediately before publish.

**Extraction trigger.** A gate cluster repeated at two or more decision points
in a shell is a pipeline candidate even inside an otherwise-excluded module.
The duplication is the signal — and the copies have usually already drifted by
the time you notice them. One extracted pipeline replaces the copies with one
name, one precedence order, and one table-driven test.

### Where superpipe must not be used

These exclusions are about **ownership, not module membership**: a module that
owns a loop, state, or resources still consults pipelines at its decision
points — the decide-owning hybrid above. What is barred is the pipeline being
the owner.

- **As a state machine, unbounded fold, or the loop.** State lives in the
  runtime/DB; a pipeline decides one step. A pipeline may be a per-event
  reducer body or a shell's admission gate, never the loop itself.
- **As an owner of atomicity.** See Decision 3.
- **As an owner of resources or lifecycle.** See Decision 5. The owning shell
  keeps timers, waiters, subscriptions, and handles; the pipeline receives
  values and declares outcomes.
- **On hot inner loops.** See Decision 8.

### Effect-stage disciplines (optional, not gates)

For race-prone effect stages, the retired `stagedRun`'s disciplines remain
good practice: declare the state keys a stage reads and writes, re-gather
between write and read, treat correlated multi-row transitions as one
primitive or a compensation chain, and unwind compensations in reverse on
failure. In a direct pipeline the declaration is the named-dependency list
itself — every `.pipe(fn, 'in', 'out')` line is declared dataflow, which is
why ctx-object threading is discouraged for new pipelines. The full design
record is `docs/adr/history/0004-revisions.md`.

## Pattern taxonomy (vocabulary, not categories to choose between)

| Pattern | Shape |
| --- | --- |
| P1 pure sync transform | `pipe → end`, early exit via `!dep` |
| P2 awaitable flow | async stages, `endAsync` |
| P3 guard/validation gate | boolean `!dep` halts, or the canonical `result:` cascade |
| P4 optional stages | `?dep` skips when undefined |
| P6 per-event reducer | pipeline as reducer body, never the loop |
| P7 functional sandwich | read → plan → apply |
| P8 decide-owning hybrid | `result:`-arm gate pipeline consulted by a resource-owning shell at its decision points |
| Mixed business path | decisions + transforms + effects in one pipeline (the default) |

## Roadmap (open items)

- Migrate existing `decisionRun`/`stagedRun` call sites onto direct pipelines,
  slice-by-slice in the slices that touch them (deprecation recorded
  2026-09-07); no new combinator call sites in the meantime.
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

- Reference implementation (canonical gate shape, decide-owning hybrid):
  `decideReplayAdmission` in
  `packages/daemon/src/lib/mailbox/deferred-replay-scheduler.ts` (PR #3804)
- Combinator modules (deprecated): `packages/daemon/src/lib/space/runtime/{decision-pipeline,staged-run}.ts`
- Benchmark: `packages/daemon/scripts/benchmark/decision-pipeline.ts`
- History: `docs/adr/history/0004-revisions.md` (revisions, retired framing),
  `docs/adr/history/0004-pilots.md` (pilot records, completion log)
- Surveys/proposals: `docs/agent-layer-superpipe-pilot-proposal.md`,
  `docs/research/external-event-ingestion-filters-survey.md`,
  `docs/reports/*.md`
