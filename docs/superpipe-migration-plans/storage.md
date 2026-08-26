# Storage migration plan

## Scope and combinator fit

This plan covers a single storage admission seam:

- `packages/daemon/src/storage/repositories/sdk-message-admission.ts:decideMessageAdmission`

`decideMessageAdmission` is a **pure, synchronous, side-effect-free transform**: it takes a
`NormalizedMessageAdmissionInput` plus `MessageAdmissionOptions` and returns a
`MessageAdmissionRecord`. It has no early-exit guards, no `decision` field, no
asynchronous work, and no external effects.

Per ADR 0004 (`docs/adr/0004-superpipe-pipelines.md`, current revision 2026-08-25),
this is the **P1 pure sync transform** pattern:

> `pipe -> end`, early exit via `!dep`

In this case the "early exit" clause does not apply, so the pipeline is simply a
straight chain of named transform stages. It must **not** be forced into
`decisionRun` (which requires a `decision` field and a `hasDecided` halting guard)
and it must **not** use `stagedRun` (which is for async, multi-snapshot, effectful
flows). It should be a **raw `superpipe` pipeline** named for the business
operation.

The storage survey (`docs/reports/sdk-message-repository-superpipe-survey.md`)
already extracted this admission record in Chain B2 and explicitly warned against
`decisionRun` for this site because the derivations are independent, not a
precedence chain. Converting it to a direct P1 superpipe pipeline is the natural
next ADR-0004 step: it makes the stage order declarative and unit-testable
without adding a mismatched combinator.

## Existing superpipe examples to emulate

### `packages/daemon/src/lib/space/runtime/decision-pipeline.ts`

The `decisionRun` combinator. It demonstrates the monadic context pattern that
this transform should reuse:

- `.input(['ctx'])` — one positional context object.
- `.pipe(fn, 'ctx', 'ctx')` — each stage receives the full context and returns
the next full context.
- `.end('ctx')` — return the final value stored under the named key.

This transform drops the `hasDecided` guard and the `decision` key but keeps the
same `ctx -> ctx` threading style.

### `packages/daemon/src/lib/space/runtime/external-event-steer-admission-pipeline.ts`

A direct `superpipe` pipeline (not a combinator). It is the closest in-repo
example of a business-named pipeline built with `superpipe(...)('name')`,
`.input(...)`, named exported stages, and `!dep` halts. It is a **guard chain**,
so the `!admissionSettled` halts do not apply here, but the mechanical style
(import, `PipelineAPI`, `superpipe(...)(...)`, stage registration) is the model
to copy.

### `packages/daemon/src/storage/repositories/message-search-admission.ts`

A `decisionRun` consumer with a clear first-skip-wins precedence
(superseded -> type -> eligibility -> body -> user-status -> index). Cite this as
a **contrast**: `decisionRun` is correct for message-search admission because it
has a `decision` and ordered gates; `decideMessageAdmission` has neither and
should not be shoehorned into the same shape.

### `packages/daemon/src/lib/space/runtime/staged-run.ts`

The `stagedRun` combinator. This is an explicit **non-example** for this site:
it is designed for async flows with snapshots, effect stages, and compensation
unwinding. `decideMessageAdmission` does not await and does not write, so
`stagedRun` is inappropriate.

### Pure transform example

There is currently **no P1 direct superpipe pipeline in the daemon**. This
migration will be the first one. A generic `transformRun` combinator must **not**
be introduced: ADR 0004 requires ~3 direct uses before extracting a combinator,
and the roadmap explicitly lists `transformRun` as an observation, not a build
queue item.

## Per-site detailed plan

### `packages/daemon/src/storage/repositories/sdk-message-admission.ts:decideMessageAdmission`

#### Current summary

A 27-line hand-rolled function:

```ts
export function decideMessageAdmission(
  input: NormalizedMessageAdmissionInput,
  options: MessageAdmissionOptions
): MessageAdmissionRecord {
  const { message } = input;
  const { variant, sendStatus } = options;
  const messageType = message.type;
  const messageSubtype = 'subtype' in message ? (message.subtype as string) : null;
  const isRenderable = computeIsRenderable(message);
  const anchorStatusAllowed =
    variant !== 'user' || sendStatus === 'consumed' || sendStatus === 'failed';
  const parentToolUseId = extractParentToolUseId(message);
  return {
    isRenderable,
    isTerminal: computeIsTerminal(message),
    isConversationAnchor: isRenderable === 1 && messageType === 'user' && anchorStatusAllowed,
    countsTowardsBadge: isVisibleBadgeRow({
      parentToolUseId,
      messageType,
      messageSubtype,
      sendStatus,
    }),
    parentToolUseId,
    sdkUuid: extractSdkUuid(message),
    replacementEdges: extractReplacementEdges(message),
  };
}
```

It delegates to the already-pure helpers:

- `computeIsRenderable`
- `computeIsTerminal`
- `extractParentToolUseId`
- `extractSdkUuid`
- `extractReplacementEdges`
- `isVisibleBadgeRow`

Consumers:

- `packages/daemon/src/storage/repositories/sdk-message-repository.ts:521`
- `packages/daemon/src/storage/repositories/sdk-message-repository.ts:974`
- `packages/daemon/src/storage/repositories/sdk-message-repository.ts:1678`
- `packages/daemon/src/storage/repositories/sdk-message-badge.ts:planAdmissionBadgeUpdate`
- `packages/daemon/src/storage/repositories/sdk-message-status-plan.ts` (imports `SendStatus` only)
- `packages/daemon/src/storage/repositories/delivery-status-routing.ts` (imports `SendStatus` only)

All call sites consume the record synchronously and immediately use its fields
for SQL INSERT values, badge planning, or replacement-edge writes.

#### Proposed combinator

None. Use raw `superpipe` directly:

```ts
import superpipe, { type PipelineAPI } from 'superpipe';
```

No `decisionRun`, no `stagedRun`, and no new `transformRun` combinator.

#### Input/output snapshot design

**Public input** (unchanged at the wrapper):

```ts
{
  message: SDKMessage;          // from NormalizedMessageAdmissionInput
  variant: MessageAdmissionVariant;
  sendStatus: SendStatus | null;
  origin?: MessageOrigin;       // carried but not used in the record
}
```

**Internal context** (`MessageAdmissionCtx`) — the working object threaded
through each stage:

```ts
interface MessageAdmissionCtx extends MessageAdmissionOptions {
  message: SDKMessage;
  messageType: string;
  messageSubtype: string | null;
  parentToolUseId: string | null;
  sdkUuid: string | null;
  replacementEdges: SDKMessageReplacementEdge[];
  isRenderable: 0 | 1;
  isTerminal: 0 | 1;
  isConversationAnchor: boolean;
  countsTowardsBadge: boolean;
}
```

**Output**: `MessageAdmissionRecord`, returned from `.end('record')`.

The wrapper coerces the two-argument public signature into the single context
object that superpipe expects:

```ts
export function decideMessageAdmission(
  input: NormalizedMessageAdmissionInput,
  options: MessageAdmissionOptions
): MessageAdmissionRecord {
  return messageAdmissionPipeline({ ...input, ...options });
}
```

`origin` is preserved in the context because callers pass it, but no stage
consumes it; this keeps the options contract intact without adding noise to the
record.

#### Pure core design

Keep the existing pure helpers as implementation primitives. Reorganize the
function body into explicit, named, testable stages:

1. `extractMessageIdentity(ctx)`
   - Populate `messageType`, `messageSubtype`, `parentToolUseId`, `sdkUuid`,
     `replacementEdges`.
   - Reuses `extractParentToolUseId`, `extractSdkUuid`, `extractReplacementEdges`.

2. `computeRenderability(ctx)`
   - Set `isRenderable`.
   - Reuses `computeIsRenderable(ctx.message)`.

3. `computeTerminal(ctx)`
   - Set `isTerminal`.
   - Reuses `computeIsTerminal(ctx.message)`.

4. `computeConversationAnchor(ctx)`
   - Set `isConversationAnchor` from `isRenderable`, `messageType`, `variant`,
     `sendStatus`.
   - Encode the existing rule:
     `isRenderable === 1 && messageType === 'user' && (variant !== 'user' || sendStatus === 'consumed' || sendStatus === 'failed')`.

5. `computeBadgeVisibility(ctx)`
   - Set `countsTowardsBadge` from `isVisibleBadgeRow`.

6. `buildRecord(ctx)`
   - Return `MessageAdmissionRecord`.

Each of stages 1–5 returns the full updated context (`MessageAdmissionCtx`).
Stage 6 returns the record. The pipeline ends with `.end('record')`.

Pipeline sketch:

```ts
const messageAdmissionPipeline = (
  superpipe({})('sdk-message-admission') as PipelineAPI
)
  .input(['ctx'])
  .pipe(extractMessageIdentity, 'ctx', 'ctx')
  .pipe(computeRenderability, 'ctx', 'ctx')
  .pipe(computeTerminal, 'ctx', 'ctx')
  .pipe(computeConversationAnchor, 'ctx', 'ctx')
  .pipe(computeBadgeVisibility, 'ctx', 'ctx')
  .pipe(buildRecord, 'ctx', 'record')
  .end('record');
```

`superpipe({})` is used with an empty dependency object because no external
predicates are required. If the type checker rejects an empty generic, prefer
`superpipe<Record<string, never>>({})` or an equivalent empty `Dependencies`
subtype; verify at implementation time.

#### Shell/effect wiring

No effects. The three `SDKMessageRepository` save methods remain the shell:

- `saveSDKMessage` computes admission **before** its `db.transaction(...)`.
- `saveUserMessageCore` computes admission **inside** the transaction that
  `message-delivery-outbox.ts` composes (`packages/daemon/src/lib/agent/message-delivery-outbox.ts:60-81`).
- `saveHyperNeoActionMessage` computes admission before its local transaction.

`planAdmissionBadgeUpdate` continues to receive the record and return a
`BadgeUpdateInstruction`. `SendStatus` must remain exported from
`sdk-message-admission.ts` because `sdk-message-status-plan.ts` and
`delivery-status-routing.ts` import it.

Do **not** move any DB write, `nextConsumedSeq`, or notification logic into the
pipeline. The record is intentionally decoupled from `consumed_seq` allocation
(see the storage survey B2/B4 notes). The `isTerminal` field is only an
admission flag; the repo still decides when to allocate a consumed sequence.

#### Step-by-step migration

1. **Pin behavior first.** Add or confirm characterization tests in
   `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-admission.test.ts`
   covering the full matrix:
   - `sdk` / `user` / `hyperneo_action` variants.
   - All five `SendStatus` values for `user`.
   - `sendStatus: null` for `sdk` and `hyperneo_action`.
   - Renderable vs non-renderable user content (tool result).
   - Assistant with `parent_tool_use_id`.
   - Terminal `result` messages.
   - Hidden subtypes (`task_started`, `thinking_tokens`, etc.).
   - Superseded and retracted replacement edges, including the
     `model_refusal_fallback` subtype gate.
   - `HyperNeoActionMessage` normalization.

2. **Extract the pure helpers if not already tested.** The helpers
   `computeIsRenderable`, `computeIsTerminal`, `extractParentToolUseId`,
   `extractSdkUuid`, `extractReplacementEdges`, and `isVisibleBadgeRow` are
   already exported and should keep their own isolated tests. Any gaps
   (e.g. `extractReplacementEdges` retraction gate, `isVisibleBadgeRow` null
   sendStatus default) should be covered before the pipeline refactor.

3. **Define context types.** Add `MessageAdmissionCtx` and the `MessageAdmissionInput`
   union inside `sdk-message-admission.ts`. Do not change exported public types
   (`MessageAdmissionRecord`, `SendStatus`, `MessageAdmissionVariant`,
   `MessageAdmissionOptions`, `NormalizedMessageAdmissionInput`).

4. **Implement the named stages and pipeline.** Replace the body of
   `decideMessageAdmission` with the six stages and the `messageAdmissionPipeline`
   builder. Keep `decideMessageAdmission` itself as the public wrapper so callers
   do not change. Optionally export `runMessageAdmission` or keep the pipeline
   private depending on whether the test file wants stage-level assertions.

5. **Run targeted tests.**
   - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-admission.test.ts`
   - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-save-admission-drift.test.ts`
   - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-repository.test.ts`
   - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-repository-live-query.test.ts`

6. **Optional microbenchmark.** Add or extend
   `packages/daemon/scripts/benchmark/decision-pipeline.ts` to compare the
   current hand-rolled function against the new raw superpipe pipeline on a
   representative message set. The ADR benchmark expects ~2–3 µs per pipeline
   run vs ~75–194 ns for an if-cascade. For this site the neighbor cost is a
   SQLite INSERT, so the overhead should be well under 3%.

7. **Lint/type check.** Run `bun run check` (or `bun run typecheck`) from the
   repo root. The file lives under `packages/daemon`, so it is covered by the
   daemon type/lint pass.

#### Tests

- **Unit: `sdk-message-admission.test.ts`**
  - Keep all existing `decideMessageAdmission` assertions as the primary parity
    oracle.
  - Optionally add a `describe('messageAdmissionPipeline')` block that calls the
    pipeline directly and asserts each stage contributes the expected field.
  - If stages are not exported, test through the wrapper and assert the full
    record shape.

- **Drift: `sdk-message-save-admission-drift.test.ts`**
  - This is the highest-value regression suite for the three save paths
    (`saveSDKMessage`, `saveUserMessageCore`, `saveHyperNeoActionMessage`).
  - It already pins the status/anchor/badge/replacement/consumed_seq
    divergences; the pipeline must not change any of these outcomes.

- **Integration: `sdk-message-repository.test.ts` and live-query test**
  - Confirms that the real repo still writes correct `is_renderable`,
    `is_terminal`, `conversation_turn_index`, `sdk_uuid`, and
    `replacement_metadata_normalized` values.

- **Benchmark: optional `scripts/benchmark/decision-pipeline.ts` extension**
  - Verifies the pipeline overhead is in the expected ADR range before/after
    merge.

#### Risks/caveats

- **Hot path: per-message admission.** `decideMessageAdmission` runs once for
  every persisted message (SDK, user, action). The superpipe overhead is
  expected to be ~2–3 µs, while the surrounding SQL work is ~100 µs to ms.
  This is acceptable per ADR hot-path guidance, but it should not be used
  inside tight read-projection row loops (it is not; it is only on the write
  path).

- **No early exit needed.** The current function has no guard cascade, so the
  pipeline must not add `!dep` or `?dep` stages for "halting." Adding a
  `hasDecided`-style guard would be a false category and could tempt later
  changes to model admission as a skip decision.

- **Projections nearby are unaffected.** `getLastSDKMessage`,
  `getRenderableTextMessages`, `_getSDKMessagesImpl`, etc. do not call this
  function. The ADR's "no pipelines in read-projection row loops" rule is not
  violated.

- **Type casts must be preserved.** `computeIsRenderable`,
  `extractParentToolUseId`, `extractReplacementEdges`, and the normalizer rely
  on `as` casts to read loosely-typed SDK fields. The migration should not
  attempt to tighten these types; doing so is a behavior change, not a refactor.

- **`origin` is a passenger.** `MessageAdmissionOptions.origin` is passed by
  `saveSDKMessage` but not used in record computation. It must remain part of
  the options contract but can be ignored by the pipeline.

- **Do not introduce a new combinator.** Resist `transformRun`. This site is the
  first pure transform; there are not yet three direct uses to justify a
  generic combinator.

- **`consumed_seq` must stay out.** The record's `isTerminal` field is not a
  signal to allocate a consumed sequence. `saveSDKMessage` allocates
  `consumed_seq` for terminal results after the INSERT; `saveUserMessageCore`
  leaves `consumed_seq` NULL at insert and allocates it only on the `consumed`
  status flip. The pipeline must preserve this.

- **Benchmark caveats.** The ADR numbers were produced by
  `packages/daemon/scripts/benchmark/decision-pipeline.ts` for a `decisionRun`
  with six early-exit gates. A pure transform with six `ctx -> ctx` stages may
  have slightly different absolute numbers; the benchmark must be re-run on
  this pipeline.

## Suggested migration order

1. **This P1 pipeline (`sdk-message-admission.ts`)** — it is the smallest,
   purest storage transform and sets the pattern for future P1 work.
2. **Message-search admission (`message-search-admission.ts`)** — already uses
   `decisionRun`; consider whether it should stay a combinator or be inlined to
   a direct superpipe guard chain. Not in this plan.
3. **Delivery-status routing (`delivery-status-routing.ts`)** — pure data table,
   not a pipeline candidate; leave as-is.
4. **`updateMessageStatus` planner (`sdk-message-status-plan.ts`)** — P7
   functional sandwich (read -> plan -> apply); a candidate for a later
   separate plan.
5. **Read projections** — the storage survey already recommends keeping read
   projection row loops as plain function calls. Do not apply superpipe there.

## Focused PR breakdown

Budget rule (owner's PR-sizing decomposition playbook): production Δ ≲100 lines
per slice — hard cap ~150 only for types-dominated additive cores — with test
Δ ≲350 counted separately from production code. Pin slices split by dimension
family, never by truncation. Every slice carries a phase label as its first
line: 📌 pins (characterization of current behavior, prod Δ = 0) → ➕ additive
core (pure module landed unwired) → 🔧 apply (wire call sites) → cleanup (small
trailing slice); tiny phases may combine. Decompose at authoring time and split
a slice further before opening it rather than growing a PR past budget
mid-review; every slice leaves the repo compiling with tests green when it
lands, and no slice folds in unrelated fixes. This single-site plan decomposes
into four slices: two pin dimension families, the combined additive-plus-apply
pipeline slice, and a trailing benchmark.

### PR 1 — `test(storage): pin admission-flag matrix for decideMessageAdmission`

📌 pins — prod Δ = 0, test Δ ≲350

- **Scope**: `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-admission.test.ts`
  only (steps 1–2, flag dimension family). Add or confirm characterization
  coverage for the admission-flag dimensions of `decideMessageAdmission`:
  `sdk` / `user` / `hyperneo_action` variants; all five `SendStatus` values for
  `user`; `sendStatus: null` for `sdk` and `hyperneo_action`; renderable vs
  non-renderable user content (tool result); terminal `result` messages; hidden
  subtypes (`task_started`, `thinking_tokens`, etc.); and the resulting
  `isRenderable` / `isTerminal` / `isConversationAnchor` / `countsTowardsBadge`
  values. Close the `isVisibleBadgeRow` null `sendStatus` default helper gap
  (step 2) within the same dimension family.
- **Lands**: The flag derivations of the current hand-rolled
  `decideMessageAdmission` are pinned by a decision-table parity oracle before
  any refactor touches production code.
- **Excludes**: Identity/replacement-edge/normalization dimensions (PR 2), any
  edit to `sdk-message-admission.ts` itself, the pipeline stages, and the
  benchmark extension.
- **Tests**: `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-admission.test.ts`
  (this slice is test-only).
- **Depends on**: none.

### PR 2 — `test(storage): pin identity and replacement-edge admission extraction`

📌 pins — prod Δ = 0, test Δ ≲350

- **Scope**: `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-admission.test.ts`
  only (steps 1–2, identity dimension family). Characterize the extraction
  dimensions of `decideMessageAdmission`: assistant messages with
  `parent_tool_use_id` (`parentToolUseId`), `sdkUuid` extraction, superseded and
  retracted replacement edges including the `model_refusal_fallback` subtype
  gate, and `HyperNeoActionMessage` normalization. Close the
  `extractReplacementEdges` retraction-gate helper gap (step 2) and keep the
  isolated helper tests for `computeIsRenderable`, `computeIsTerminal`,
  `extractParentToolUseId`, `extractSdkUuid`, `extractReplacementEdges`, and
  `isVisibleBadgeRow` green.
- **Lands**: The extraction and normalization half of the admission record is
  pinned alongside PR 1's flag family, completing the parity oracle with
  production code still untouched.
- **Excludes**: Flag-dimension cases (PR 1), any edit to
  `sdk-message-admission.ts`, the pipeline stages, and the benchmark extension.
- **Tests**: `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-admission.test.ts`
  (test-only).
- **Depends on**: none (PR 1 touches the same file; land sequentially to avoid
  same-file churn, not for correctness).

### PR 3 — `refactor(storage): convert decideMessageAdmission to a raw superpipe pipeline`

➕ additive core + 🔧 apply — prod Δ ≲100, test Δ ≲100

- **Scope**: `packages/daemon/src/storage/repositories/sdk-message-admission.ts`
  only (steps 3–4, verified by steps 5 and 7). Add the internal
  `MessageAdmissionCtx` and the `MessageAdmissionInput` union without changing
  exported public types; implement the six named stages
  `extractMessageIdentity`, `computeRenderability`, `computeTerminal`,
  `computeConversationAnchor`, `computeBadgeVisibility`, and `buildRecord`, each
  reusing the existing pure helpers; register them on
  `superpipe({})('sdk-message-admission')` with `.input(['ctx'])`,
  `.pipe(fn, 'ctx', 'ctx')` threading, and `.end('record')`; and reduce
  `decideMessageAdmission` to the two-argument wrapper
  `messageAdmissionPipeline({ ...input, ...options })`, exporting
  `runMessageAdmission` for stage-level tests per the open-questions
  recommendation. The additive core and apply phases combine here because the
  wrapper delegation is the only wiring — no external call site changes — and
  the production delta stays within the types-dominated budget. Verify the
  empty dependency object at implementation time (fallback:
  `superpipe<Record<string, never>>({})` or a no-op dependency).
- **Lands**: `decideMessageAdmission` returns the identical
  `MessageAdmissionRecord` through the daemon's first raw P1 superpipe
  pipeline; every caller keeps its signature and call site
  (`sdk-message-repository.ts:521`, `:974`, `:1678`, plus
  `sdk-message-badge.ts:planAdmissionBadgeUpdate`), `SendStatus` stays exported
  for `sdk-message-status-plan.ts` and `delivery-status-routing.ts`, and
  `bun run check` passes.
- **Excludes**: Folding `normalizeMessageAdmissionInput` into the pipeline (open
  question 1 keeps them separate); any `transformRun`-style combinator; changing
  the two-argument public signature; tightening the `as` casts; moving
  `consumed_seq`, `nextConsumedSeq`, or notification logic into the pipeline;
  the benchmark extension (PR 4); and all later items in "Suggested migration
  order" (message-search admission, `sdk-message-status-plan.ts`,
  delivery-status routing, read projections).
- **Tests**: `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-admission.test.ts`
  (PR 1 + PR 2 parity oracle, plus the optional
  `describe('messageAdmissionPipeline')` stage-level block as this slice's only
  test delta),
  `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-save-admission-drift.test.ts`,
  `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-repository.test.ts`,
  and
  `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-repository-live-query.test.ts` —
  the latter three are pre-existing gates, re-run unchanged.
- **Depends on**: PR 1, PR 2.

### PR 4 — `test(storage): benchmark messageAdmissionPipeline overhead`

**cleanup** (trailing measurement slice) — prod Δ = 0, benchmark-script Δ ≲150

- **Scope**: `packages/daemon/scripts/benchmark/decision-pipeline.ts` only
  (step 6, optional per the plan). Extend the benchmark to run the six-stage
  `ctx -> ctx` pipeline over a representative message set against the
  hand-rolled baseline, re-measuring this pipeline instead of reusing the ADR's
  `decisionRun` numbers.
- **Lands**: Measured per-run overhead for `messageAdmissionPipeline`,
  confirming the expected ~2–3 µs range stays well under 3% of the neighboring
  SQLite INSERT before the P1 pattern is copied to other sites.
- **Excludes**: Any production-code change and any CI wiring for the benchmark.
- **Tests**: `packages/daemon/scripts/benchmark/decision-pipeline.ts` itself,
  run manually; no unit-test files change in this slice.
- **Depends on**: PR 3.

## Open questions

1. **Should `normalizeMessageAdmissionInput` be folded into the pipeline?**
   Callers currently call `normalizeMessageAdmissionInput(...)` and then
   `decideMessageAdmission(...)`. The pipeline could include a `prepareInput`
   stage that accepts `SDKMessage | HyperNeoActionMessage` directly. Keeping
   them separate is simpler and matches the existing call sites; folding is a
   follow-up only if desired.

2. **Should `decideMessageAdmission` keep its two-argument signature or become a
   single `MessageAdmissionRequest` argument?** The two-argument signature is
   already used in three call sites and `sdk-message-admission.test.ts`. Keep
   it to avoid churn.

3. **Should any stage be further split?** `computeIsRenderable` handles both
   `user` and `assistant` content shapes. Splitting into
   `computeUserRenderability` and `computeAssistantRenderability` could improve
   unit-test clarity but is optional.

4. **Should the pipeline be exported for direct testing?** Options:
   - Keep the pipeline private and test only the public wrapper.
   - Export `runMessageAdmission` (the pipeline executor) for direct
     stage-level tests.
   - Export the individual stage functions for unit testing.
   Recommendation: export `runMessageAdmission` and the stage functions from
   the module, but keep them as non-public (`_` prefix or `internal` comments
   not allowed; rely on naming and test-only use). This gives test coverage
   without changing the public API.

5. **Is `superpipe({})` valid with an empty dependency object?** The superpipe
   docs and existing combinators always pass non-empty dependency objects.
   Verify during implementation that `superpipe({})` or
   `superpipe<Record<string, never>>({})` builds a pipeline with no injected
   dependencies. If the runtime or types reject an empty object, add a no-op
   `admissionReady` predicate or fall back to a single `identity` dependency.
