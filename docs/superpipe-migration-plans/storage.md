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

Review correction (PR #2978): the named pipelines are the THREE COMPLETE
REPOSITORY SAVE OPERATIONS — `saveSDKMessage`, `saveUserMessage`, and
`saveHyperNeoActionMessage` — plus the outbox's `persistAndEnqueueDelivery`,
which is another complete user-message save/delivery business path. Both user
paths share `saveUserMessageCore` as a PLAIN IN-TRANSACTION HELPER (a leaf
consumed by their `atomic` stages, and still called directly by `saveUserMessage`
itself). `decideMessageAdmission` also stays a PLAIN EXPORTED HELPER (a leaf
consumed by each save pipeline's admission stage, and directly by
`sdk-message-badge.ts:planAdmissionBadgeUpdate` and the drift suite). A
standalone admission-only pipeline invoked by imperative save shells would be
exactly the decision/effect split the composition rule forbids: the save
method is the business path, so the pipeline owns it.

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

**Internal contexts** — review correction (PR #2978): the INITIAL input type
and the progressively enriched stage contexts are DISTINCT; the pipeline input
contains only what the snapshot provides, and a derived field is ABSENT (not
`null`-filled) until its producing stage has run, so a missing or reordered
stage dependency fails the typecheck instead of being hidden behind a
`PipelineAPI` cast:

```ts
interface SaveSdkMessageInput {          // pipeline input: snapshot only
  sessionId: string;                     // every persist/publication stage needs it
  message: SDKMessage;
  variant: MessageAdmissionVariant;
  sendStatus: SendStatus | null;
  origin?: MessageOrigin;                // carried; consumed by the persist stage
}
type AdmittedSdkMessage = SaveSdkMessageInput & {
  admission: MessageAdmissionRecord;     // + the admission stage's output
};
// ...each later stage's context adds exactly the fields it produces
// (allocated sequence, inserted row id, publication flags) until the final
// `.end(...)` result.
```

`MessageAdmissionRecord` remains the admission stage's output, produced by
calling the plain `decideMessageAdmission` leaf. `origin` rides the input
because the persist stages consume it; it never enters the record.
`sessionId` rides every save input (review correction PR #2978): the
INSERT, task/turn resolution, replacement edges, badge updates, and
notifications all need it — capturing it in a closure or bypassing the
declared input would undermine the reusable typed runner. Each method's
input names the fields ITS stages consume.

#### Pure core design

Keep the existing pure helpers as implementation primitives. The six named
steps below document `decideMessageAdmission`'s internal structure (and the
admission stage each save pipeline runs by CALLING that plain leaf — review
correction: the leaf is not itself converted into a separately-run pipeline):

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

Save-pipeline sketch (one per save method; `saveSDKMessage` shown):

```ts
const saveSdkMessage = superpipe(deps)('save-sdk-message')
  .pipe(snapshotMessage, 'message', 'ctx')        // + variant/sendStatus/origin
  .pipe(admitMessage, 'ctx', 'ctx')               // calls the plain decideMessageAdmission leaf
  .pipe(persistMessage, 'ctx', 'ctx')             // existing insert effects, in-transaction
  .pipe(allocateConsumedSeq, 'ctx', 'ctx')        // existing sequence rules, unchanged
  .pipe(publishAdmissions, 'ctx', 'result');      // existing notifications/publications
```

Each save pipeline is a synchronous `.end` run executed AROUND the method's
existing `db.transaction(...)` boundary (review correction PR #2978): the
atomic write block — insert, sequence allocation, replacement-edge writes,
whatever the method currently performs inside its transaction — is ONE
in-transaction stage, and the session notifications / superseded-index
deletion / post-save side effects are POST-COMMIT stages that keep the
method's existing error policy (caught-and-logged for `saveSDKMessage` and the
outbox, uncaught for `saveUserMessage` and `saveHyperNeoActionMessage`).
Today's `saveSDKMessage` COMMITS before notifying the session and deleting
superseded-index entries, and failures there are only logged — moving them
into the transaction would roll back or retry an otherwise successful insert.
The transaction semantics are unchanged because the transaction body moves as
a unit into one stage.

#### Shell/effect wiring

Review correction (PR #2978): each save/delivery method's COMPLETE operation
becomes one named pipeline — admission, persist, sequence allocation, and
notifications/publications are its stages, so no save path keeps an imperative
shell interpreting a derivation helper. The runner SURROUNDS the method's
existing `db.transaction(...)` block (that block is ONE in-transaction stage)
and runs post-commit stages AFTER the transaction commits. Post-commit error
handling is per-operation, not a blanket best-effort catch:

- `saveSDKMessage` → `save-sdk-message`: the `atomic` stage runs the existing
  `db.transaction(...)` body (`packages/daemon/src/storage/repositories/sdk-message-repository.ts:540-572`)
  unchanged; session notification and superseded-index deletion are post-commit
  best-effort stages (local catch + log — a publication failure must NOT fail
  the committed insert, matching the current `saveSDKMessage` contract at
  `:573-579`).
- `saveUserMessage` → `save-user-message`: the `atomic` stage is the existing
  `this.db.transaction(() => this.saveUserMessageCore(...))()` call
  (`:960-962`); the shared `saveUserMessageCore` leaf performs the INSERT,
  replacement edges, search-index scheduling, and badge update. `runPostSaveSideEffects`
  (`:963`) is the post-commit stage and is NOT caught, so if it throws the
  caller receives the error even though the insert is committed (matching the
  current `saveUserMessage` contract).
- `persistAndEnqueueDelivery` → `persist-and-enqueue-delivery`:
  the `atomic` stage is the existing `db.transaction(...)` at
  `packages/daemon/src/lib/agent/message-delivery-outbox.ts:60-81`, containing
  `saveUserMessageCore` followed by `jobQueue.enqueue` and the UNIQUE-conflict
  fallback. `runPostSaveSideEffects` (`:84`) is the post-commit stage and is
  wrapped by the existing empty `catch {}` at `:83-89`, so a publication failure
  is ignored (matching the current outbox contract).
- `saveHyperNeoActionMessage` → `save-hyperneo-action-message`: the `atomic`
  stage runs the existing `db.transaction(...)` body (`:1707-1710`);
  `notifySessionsChanged` and `scheduleMessageSearchIndex` at `:1711-1712` are
  post-commit stages that are NOT caught, so a failure there propagates to the
  caller while the insert remains committed (matching the current
  `saveHyperNeoActionMessage` contract).

The method bodies reduce to snapshot → run; `decideMessageAdmission` and
`saveUserMessageCore` remain the plain exported leaves the stages call.

`planAdmissionBadgeUpdate` continues to receive the record and return a
`BadgeUpdateInstruction`. `SendStatus` must remain exported from
`sdk-message-admission.ts` because `sdk-message-status-plan.ts` and
`delivery-status-routing.ts` import it.

With the complete-save-path correction (PR #2978), the DB writes,
`nextConsumedSeq` allocation, and notifications MOVE INTO each save pipeline
as stages — post-commit stages keep their existing per-operation error policy,
per the boundary rules above — and they keep their exact current semantics: the
admission record stays decoupled from `consumed_seq` allocation (see the
storage survey B2/B4 notes; allocation is its own stage, unchanged), and
`isTerminal` remains only an admission flag feeding that stage's existing
decision.

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

2. **Distinguish existing helper coverage from wrapper coverage.**
   Review correction (PR #2978): `computeIsRenderable`, `computeIsTerminal`,
   `extractParentToolUseId`, `extractSdkUuid`, and `extractReplacementEdges`
   are exported with direct helper-level tests already in
   `sdk-message-repository-helpers.test.ts` (including the retraction gates)
   — those stay green, untouched. `isVisibleBadgeRow` is module-private with
   no isolated tests, so its null-`sendStatus` default is pinned at WRAPPER
   level via `countsTowardsBadge` decision-table rows in the admission suite;
   do not export it just for testing.

3. **Define context types.** Add the per-save input types
   (`SaveSdkMessageInput` et al.) and their progressively enriched stage
   contexts in `sdk-message-repository.ts` (review correction: the pipeline
   input holds only snapshot fields; derived fields join the context only
   after their producing stage — no `PipelineAPI` cast). Do not change
   exported public types (`MessageAdmissionRecord`, `SendStatus`,
   `MessageAdmissionVariant`, `MessageAdmissionOptions`,
   `NormalizedMessageAdmissionInput`).

4. **Implement the save pipelines.** Compose one named pipeline per
   business operation (admission stage calling the unchanged `decideMessageAdmission`
   leaf, followed by the method's existing persist/sequence/publication
   effects as stages). The runner SURROUNDS the existing `db.transaction(...)`
   block: reduce each method body to snapshot → run, with the transaction body
   as ONE in-transaction stage and post-commit stages running AFTER the
   transaction commits. Do not invoke the full runner inside the transaction;
   doing so would move notification / index side effects before commit and
   could roll back the insert when they fail. `decideMessageAdmission` keeps
   its current plain body and public signature; export each pipeline's runner
   (`runSaveSdkMessage` et al.) for stage-level assertions if the suites want
   them.

5. **Run targeted tests.**
   - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-admission.test.ts`
   - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-save-admission-drift.test.ts`
   - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-repository.test.ts`
   - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-repository-live-query.test.ts`
   - `packages/daemon/tests/unit/4-space-storage/storage/message-delivery-outbox.test.ts`

6. **Optional microbenchmark.** Add or extend
   `packages/daemon/scripts/benchmark/decision-pipeline.ts` to measure BOTH
   the save-pipeline overhead on a representative message set AND a
   representative SQLite INSERT against the same database setup, so any
   overhead ratio is grounded in a measured denominator (review correction
   PR #2978: without the insert measurement the ~3% claim cannot be
   established — if the insert cannot be measured faithfully in the script,
   report ONLY the isolated per-run pipeline overhead and drop the percentage
   claim).

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

1. **The three save-path pipelines (`sdk-message-repository.ts`, admission
   via the `sdk-message-admission.ts` leaf)** — the complete persist business
   paths; they set the pattern for future storage P1 work.
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
lands, and no slice folds in unrelated fixes. This plan decomposes
into five slices: one pin dimension family, one complete save-path pipeline
per business operation (`saveSDKMessage`, the paired `saveUserMessage` /
`persistAndEnqueueDelivery` user paths, and `saveHyperNeoActionMessage`), and
a trailing benchmark (review correction PR #2978: the former
identity/extraction pin slice was removed — the existing wrapper suite already
characterizes those dimensions).

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
  values. Pin the module-private `isVisibleBadgeRow` null `sendStatus`
  default at WRAPPER level via `countsTowardsBadge` decision-table rows (the
  helper has no isolated tests and stays unexported — review correction PR
  #2978).
- **Lands**: The flag derivations of the current hand-rolled
  `decideMessageAdmission` are pinned by a decision-table parity oracle before
  any refactor touches production code.
- **Excludes**: Any edit to `sdk-message-admission.ts` itself, the pipeline
  stages, and the benchmark extension. (The identity/replacement-edge
  dimensions are already characterized by the existing wrapper suite — no
  pin slice needed for them; review correction PR #2978.)
- **Tests**: `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-admission.test.ts`
  (this slice is test-only).
- **Depends on**: none.

### PR 2 — `refactor(storage): compose the complete save-sdk-message pipeline`

🔧 apply — prod Δ ≲100, test Δ ≲150

- **Scope**: `packages/daemon/src/storage/repositories/sdk-message-repository.ts`
  (`saveSDKMessage`, call site `:521`) only (steps 3–4 for this method).
  Compose the `save-sdk-message` pipeline — snapshot → admission stage calling
  the unchanged plain `decideMessageAdmission` leaf → ONE `atomic-write` stage
  running the method's existing `db.transaction(...)` body unchanged →
  post-commit notification / superseded-index-deletion stages with local
  catch+log (review correction PR #2978: the current method COMMITS before
  those operations and only logs their failures; running them in-transaction
  would roll back successful inserts); the method body reduces to snapshot →
  run. Review correction (PR #2978): converting
  only `decideMessageAdmission` while the save methods stay imperative shells
  would wire a derivation helper pipeline under the forbidden decision/effect
  split; the save operation is the business path, so the pipeline owns it.
- **Lands**: `saveSDKMessage` runs as one complete named pipeline;
  `decideMessageAdmission` keeps its plain body, two-argument signature, and
  every caller (`:974`, `:1678`, `sdk-message-badge.ts`); `bun run check`
  passes.
- **Excludes**: The other save paths (PRs 3–4); folding
  `normalizeMessageAdmissionInput` in (open question 1); any
  `transformRun`-style combinator; the benchmark extension (PR 5); later
  "Suggested migration order" items.
- **Tests**: `sdk-message-save-admission-drift.test.ts`,
  `sdk-message-repository.test.ts`, and
  `sdk-message-repository-live-query.test.ts` re-run unchanged (pre-existing
  gates for this save path).
- **Depends on**: PR 1.

### PR 3 — `refactor(storage): compose the complete user-message save pipelines`

🔧 apply — prod Δ ≲100, test Δ ≲150

- **Scope**: `packages/daemon/src/storage/repositories/sdk-message-repository.ts`
  (`saveUserMessage`, call site `:954` / `:960-962`, plus the shared
  `saveUserMessageCore` leaf at `:967`) AND
  `packages/daemon/src/lib/agent/message-delivery-outbox.ts:37-91`.
  Review correction (PR #2978): there are TWO complete user-message
  business-operation pipelines, both sharing `saveUserMessageCore` as an
  in-transaction plain stage/helper (not a separately-run pipeline). `saveUserMessage`
  is the direct repository method used by `query-mode-handler.ts:152`,
  `message-persistence.ts:204,232`, and other callers; its runner surrounds the
  existing `this.db.transaction(() => this.saveUserMessageCore(...))()` block
  (`:960-962`) and the uncaught `runPostSaveSideEffects` call (`:963`).
  `persistAndEnqueueDelivery` is the outbox's complete persist/enqueue/post-commit
  flow at `:60-91`; its runner surrounds the existing `db.transaction(...)` block
  that already calls `saveUserMessageCore` and `jobQueue.enqueue` with the
  UNIQUE-conflict fallback, and the existing empty `catch {}` around
  `runPostSaveSideEffects` at `:83-89`. The outbox caller is rewired in this same
  slice.
- **Lands**: Both user-message save/delivery paths run as complete named
  pipelines; `saveUserMessageCore` and `decideMessageAdmission` remain plain
  helpers; `bun run check` passes.
- **Excludes**: `saveSDKMessage` (PR 2) and `saveHyperNeoActionMessage` (PR 4);
  the benchmark (PR 5).
- **Tests**:
  - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-save-admission-drift.test.ts`
  - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-repository.test.ts`
  - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-repository-live-query.test.ts`
  - `packages/daemon/tests/unit/4-space-storage/storage/message-delivery-outbox.test.ts`
    (review correction PR #2978: this suite pins the transactional
    enqueue/rollback, UNIQUE-conflict-to-steer fallback, and post-commit
    exception contract).
- **Depends on**: PR 2 (same file; sequenced for same-file churn, not
  correctness).

### PR 4 — `refactor(storage): compose the complete save-hyperneo-action-message pipeline`

🔧 apply — prod Δ ≲100, test Δ ≲150

- **Scope**: `packages/daemon/src/storage/repositories/sdk-message-repository.ts`
  (`saveHyperNeoActionMessage`, call site `:1675`) only. Same composition as
  PR 2, but the post-commit stages are `notifySessionsChanged` and
  `scheduleMessageSearchIndex` at `:1711-1712`; they are NOT caught, so a
  failure propagates to the caller while the insert remains committed
  (preserving the current `saveHyperNeoActionMessage` contract).
- **Lands**: All repository save business paths and the outbox
  `persistAndEnqueueDelivery` path run as complete named pipelines;
  `decideMessageAdmission` and `saveUserMessageCore` remain the plain shared
  leaves.
- **Excludes**: PRs 2–3; the benchmark (PR 5).
- **Tests**: The same three repository suites re-run unchanged.
- **Depends on**: PR 3 (same file; sequenced).

### PR 5 — `test(storage): benchmark save-pipeline overhead against a measured insert`

**cleanup** (trailing measurement slice) — prod Δ = 0, benchmark-script Δ ≲150

- **Scope**: `packages/daemon/scripts/benchmark/decision-pipeline.ts` only
  (step 6, optional per the plan). Extend the benchmark to measure the
  save-pipeline per-run overhead AND a representative SQLite INSERT against
  the same database setup, so the ratio's denominator is measured, not assumed
  (review correction PR #2978).
- **Lands**: Grounded numbers — isolated save-pipeline overhead plus the
  insert it neighbors — or, if a faithful insert measurement is not feasible
  in the script, ONLY the isolated overhead with no percentage claim.
- **Excludes**: Any production-code change and any CI wiring for the benchmark.
- **Tests**: `packages/daemon/scripts/benchmark/decision-pipeline.ts` itself,
  run manually; no unit-test files change in this slice.
- **Depends on**: PR 2 (any one save pipeline suffices to measure).

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

4. **Should the save pipelines be exported for direct testing?** Options:
   - Keep each pipeline private and test only through its save method.
   - Export the pipeline runners (`runSaveSdkMessage` et al.) for direct
     stage-level tests.
   Recommendation: export the runners only if the suites need stage-level
   assertions; the drift and repository suites already pin behavior through
   the public methods, so start private.

5. **Is `superpipe({})` valid with an empty dependency object?** The superpipe
   docs and existing combinators always pass non-empty dependency objects.
   Verify during implementation that `superpipe({})` or
   `superpipe<Record<string, never>>({})` builds a pipeline with no injected
   dependencies. If the runtime or types reject an empty object, add a no-op
   `admissionReady` predicate or fall back to a single `identity` dependency.
