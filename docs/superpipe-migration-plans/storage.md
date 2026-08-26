# Storage migration plan

## Scope and combinator fit

This plan covers the four complete message-write/delivery business paths in the
storage layer:

- `packages/daemon/src/storage/repositories/sdk-message-repository.ts:saveSDKMessage`
- `packages/daemon/src/storage/repositories/sdk-message-repository.ts:saveUserMessage`
- `packages/daemon/src/storage/repositories/sdk-message-repository.ts:saveHyperNeoActionMessage`
- `packages/daemon/src/lib/agent/message-delivery-outbox.ts:persistAndEnqueueDelivery`

`decideMessageAdmission` in
`packages/daemon/src/storage/repositories/sdk-message-admission.ts` is a **pure,
synchronous, side-effect-free leaf**: it takes a `NormalizedMessageAdmissionInput`
plus `MessageAdmissionOptions` and returns a `MessageAdmissionRecord`. It is **not**
the migration target. It remains a plain exported helper consumed by the `admit`
stage of each save pipeline and directly by
`sdk-message-badge.ts:planAdmissionBadgeUpdate`.

Each save path becomes a **mixed transform/effect superpipe pipeline** named for
the business operation:

- The `admit` stage is a pure transform (P1: `pipe -> end`, no early exit).
- The `atomic` stage is a single in-transaction effect stage wrapping the existing
  `db.transaction(...)` body (insert, sequence allocation, replacement-edge writes,
  badge update, and — for `persistAndEnqueueDelivery` — the queue `enqueue`).
- The post-commit stages run after the transaction commits and keep their existing
  per-method error policy. `saveSDKMessage` uses one shared `try/catch` for its
  notification and superseded-index-deletion operations: it calls `notifySession`
  only when `badgeUpdate.kind === 'delta'`, then calls `deleteSupersededIndex`.
  A notification failure skips deletion as it does today.

Per ADR 0004 (`docs/adr/0004-superpipe-pipelines.md`, current revision 2026-08-25),
the `admit` stage is the **P1 pure sync transform** pattern (`pipe -> end`, no
early exit). Each complete path is a **mixed transform/effect superpipe
pipeline** — a business-named `superpipe(...)('...')` with `.pipe` and `.end`,
where `!dep` may halt for early-exit guards (none apply here). No `decisionRun`,
no `stagedRun`, and no new `transformRun` combinator.

The storage survey (`docs/reports/sdk-message-repository-superpipe-survey.md`)
already extracted the admission record in Chain B2 and explicitly warned against
`decisionRun` for the admission derivation because the derivations are independent,
not a precedence chain. Converting the surrounding save operations to direct
superpipe pipelines is the natural next ADR-0004 step: it makes the mixed
transform/effect stage order declarative and unit-testable without adding a
mismatched combinator.

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


## Per-site detailed plan

### Save business paths

The migration targets are the four complete save/delivery operations in
`packages/daemon/src/storage/repositories/sdk-message-repository.ts` and
`packages/daemon/src/lib/agent/message-delivery-outbox.ts`.
`packages/daemon/src/storage/repositories/sdk-message-admission.ts:decideMessageAdmission`
remains a plain exported helper consumed by the `admit` stage of each save
pipeline.

#### Admission leaf

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

#### Pipeline shape

None. Use raw `superpipe` directly:

```ts
import superpipe, { type PipelineAPI } from 'superpipe';
```

No `decisionRun`, no `stagedRun`, and no new `transformRun` combinator.

Review correction (PR #2978): the named pipelines are the THREE COMPLETE
REPOSITORY SAVE OPERATIONS — `saveSDKMessage`, `saveUserMessage`, and
`saveHyperNeoActionMessage` — plus the outbox's `persistAndEnqueueDelivery`,
which is another complete user-message save/delivery business path. Each
repository pipeline's `atomic` stage delegates to a transaction-owning
repository primitive (`saveSDKMessageWithAdmission`, `saveUserMessageWithAdmission`,
`saveHyperNeoActionMessageWithAdmission`); the `admit` stage's precomputed
`admission` is passed to that primitive. `saveUserMessageCoreWithAdmission` is
an in-transaction helper shared by the two user paths.
`saveSDKMessageWithAdmission`, `saveUserMessageWithAdmission`, and
`saveHyperNeoActionMessageWithAdmission` are transaction-owning repository
primitives; `persistAndEnqueueAdmittedUserMessage` is the transaction-owning
outbox primitive; each `atomic` stage delegates to its primitive. The public
`saveUserMessageCore` stays a compatibility wrapper that calls
`decideMessageAdmission` and then `saveUserMessageCoreWithAdmission`.
`decideMessageAdmission` also stays a PLAIN EXPORTED HELPER (a leaf consumed by
each save pipeline's admission stage, and directly by
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

#### Save-pipeline design

Keep the existing pure helpers as implementation primitives. The `admit` stage
of each save pipeline is a **single** `superpipe` stage that calls the plain
`decideMessageAdmission` leaf and stores its `MessageAdmissionRecord` on the
context. The leaf's internal derivations are listed below for reference only;
they are **not** separately-run superpipe stages.

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
  .pipe(admitMessage, 'ctx', 'ctx')               // single stage: calls the plain decideMessageAdmission leaf
  .pipe(atomicWrite, 'ctx', 'ctx')                // existing db.transaction(...) body: insert, allocate consumed_seq for terminal results, replacement edges, search index, badge
  .pipe(publishAdmissions, 'ctx', 'result');      // one post-commit stage: notifySession only when badgeUpdate.kind === 'delta', then deleteSupersededIndex, shared try/catch
```

Each save pipeline is a synchronous `.end` run executed AROUND the method's
existing `db.transaction(...)` boundary (review correction PR #2978): the
atomic write block — insert, sequence allocation, replacement-edge writes,
badge update, and — for `persistAndEnqueueDelivery` — the queue `enqueue`,
whatever the method currently performs inside its transaction — is ONE
in-transaction stage, and the session notifications / superseded-index
deletion / post-save side effects are POST-COMMIT stages that keep the
method's existing error policy. `saveSDKMessage` uses one shared `try/catch`
post-commit stage that conditionally runs `notifySession` when
`badgeUpdate.kind === 'delta'`, then runs `deleteSupersededIndex`;
`persistAndEnqueueDelivery` uses one shared `try/catch` for
`runPostSaveSideEffects`; `saveUserMessage` and `saveHyperNeoActionMessage`
run their post-commit work uncaught.
Today's `saveSDKMessage` COMMITS before notifying the session and deleting
superseded-index entries, and failures there are only logged — moving them
into the transaction would roll back or retry an otherwise successful insert.
The transaction semantics are unchanged because the transaction body moves as
a unit into one stage.

#### Shell/effect wiring

Review correction (PR #2978): each save/delivery method's COMPLETE operation
becomes one named pipeline — preflight (validation/arbitration for the outbox),
admission, a single effect `atomic` stage that delegates to a repository/outbox
primitive, and post-commit publications/side effects are its stages, so no save
path keeps an imperative shell interpreting a derivation helper. The runner
SURROUNDS the transaction-owning primitive's call and runs post-commit stages
AFTER the transaction commits. Post-commit error handling is per-operation, not a
blanket best-effort catch:

- `saveSDKMessage` → `save-sdk-message`: the method body keeps its existing
  outer `try { snapshot → run } catch { log; return false }` boundary, so any
  failure in `admit` or `atomic` still returns `false` (matching the current
  `saveSDKMessage` contract at `:581-586` and the existing repository test). The
  `admit` stage calls the plain `decideMessageAdmission` leaf; the `atomic`
  stage calls a new transaction-owning repository primitive
  `saveSDKMessageWithAdmission` that wraps the existing `:540-572`
  `db.transaction(...)` body with `withBusyRetry` (`:572`) and returns the
  inserted row id and `badgeUpdate`. The transaction body inserts and, if
  `isTerminal`, allocates and writes `consumed_seq`, then writes replacement
  edges, schedules the search index, and applies the badge update, all inside the
  transaction; post-commit is one shared `try/catch` stage that conditionally
  runs `notifySession` when `badgeUpdate.kind === 'delta'` and then
  `deleteSupersededIndex`, caught/logged at
  `:573-579`.
- `saveUserMessage` → `save-user-message`: snapshot → `admit` → `atomic`
  (a new transaction-owning repository primitive `saveUserMessageWithAdmission`
  that wraps `withBusyRetry(() => db.transaction(() =>
  saveUserMessageCoreWithAdmission(...)))` and returns `{ id, countsTowardsBadge }`;
  `saveUserMessageCoreWithAdmission` is the in-transaction helper that performs
  the INSERT, replacement edges, search-index scheduling, and badge update using
  the precomputed `admission` on the context). The public `saveUserMessageCore`
  method remains a compatibility wrapper that calls `decideMessageAdmission` and
  then `saveUserMessageCoreWithAdmission`, so existing direct callers and tests
  continue to work. → `runPostSaveSideEffects` (`:963`, post-commit, NOT caught).
- `persistAndEnqueueDelivery` → `persist-and-enqueue-delivery`: snapshot →
  `validateMessageUuid` (the missing-UUID guard at `:40-42`) →
  `arbitrateDeliveryRole` (`planDeliveryRoleArbitration` and `basePayload`
  construction at `:43-58`) → `admit` → `atomic` (a new transaction-owning outbox
  primitive `persistAndEnqueueAdmittedUserMessage` that wraps the existing
  `:60-81` `db.transaction(...)` body, calling the accessible
  `saveUserMessageCoreWithAdmission` in-transaction helper and then
  `jobQueue.enqueue` with the UNIQUE-conflict fallback) → `runPostSaveSideEffects`
  (`:84`, post-commit, ignored by the existing empty `catch {}` at `:83-89`).
- `saveHyperNeoActionMessage` → `save-hyperneo-action-message`: snapshot →
  `admit` (variant `hyperneo_action`, `sendStatus: null`) → `atomic` (a new
  transaction-owning repository primitive `saveHyperNeoActionMessageWithAdmission`
  that wraps the existing `:1707-1710` `db.transaction(...)` body and returns
  the inserted row id and `badgeUpdate`; it inserts and applies the badge
  update inside the transaction) → one post-commit stage that conditionally
  runs `notifySessionsChanged` when `badgeUpdate.kind === 'delta'` and then
  `scheduleMessageSearchIndex` (`:1711-1712`, NOT caught).

The method bodies reduce to snapshot → run (with `saveSDKMessage` keeping an
outer `try/catch` boundary that returns `false` on failure). `decideMessageAdmission`
remains the plain admission leaf. `saveUserMessageCoreWithAdmission` is the
in-transaction helper shared by both user save paths; `saveSDKMessageWithAdmission`,
`saveUserMessageWithAdmission`, and `saveHyperNeoActionMessageWithAdmission` are
transaction-owning repository primitives that each `atomic` stage delegates to.

`planAdmissionBadgeUpdate` continues to receive the record and return a
`BadgeUpdateInstruction`. `SendStatus` must remain exported from
`sdk-message-admission.ts` because `sdk-message-status-plan.ts` and
`delivery-status-routing.ts` import it.

With the complete-save-path correction (PR #2978), the DB writes,
`nextConsumedSeq` allocation, and notifications move into the pipeline through
transaction-owning repository primitives — post-commit stages keep their
existing per-operation error policy, per the boundary rules above — and they
keep their exact current semantics: the admission record stays decoupled from
`consumed_seq` allocation (see the storage survey B2/B4 notes; the allocation and
UPDATE for terminal SDK messages stay inside the single `atomic` stage, not in a
separate pipeline stage), and `isTerminal` remains only an admission flag feeding
that stage's existing decision.

#### Step-by-step migration

1. **Pin behavior first.** Add or confirm characterization tests in
   `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-admission.test.ts`
   covering the full admission-flag matrix, and in
   `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-repository.test.ts`
   add explicit post-commit failure-contract cases for `saveUserMessage` and
   `saveHyperNeoActionMessage` (force `runPostSaveSideEffects` /
   `notifySessionsChanged` to throw and assert the row is committed and the
   error propagates).
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
   business operation. The `admit` stage is a single `superpipe` stage that
   calls the plain `decideMessageAdmission` leaf and stores the
   `MessageAdmissionRecord` on the context. The `atomic` stage is a single
   effect stage that delegates to a transaction-owning repository/outbox
   primitive — it never owns the transaction itself:
   - `saveSDKMessage` → `saveSDKMessageWithAdmission` (wraps the existing
     `db.transaction(...)` body with `withBusyRetry` and returns the inserted
     row id and `badgeUpdate`).
   - `saveUserMessage` → `saveUserMessageWithAdmission` (wraps
     `withBusyRetry(() => db.transaction(() => saveUserMessageCoreWithAdmission(...)))`
     and returns `{ id, countsTowardsBadge }`).
   - `persistAndEnqueueDelivery` → its `atomic` stage calls a new
     transaction-owning outbox primitive `persistAndEnqueueAdmittedUserMessage`
     that wraps the existing `db.transaction(...)` body calling
     `saveUserMessageCoreWithAdmission` then `jobQueue.enqueue`.
   - `saveHyperNeoActionMessage` → `saveHyperNeoActionMessageWithAdmission`
     (wraps the existing `db.transaction(...)` body and returns the inserted
     row id).
   `saveUserMessageCoreWithAdmission` is the in-transaction helper shared by
   the two user paths; the public `saveUserMessageCore` stays a compatibility
   wrapper that calls `decideMessageAdmission` and then the helper. The
   post-commit stages run AFTER the transaction commits. `saveSDKMessage` keeps
   its existing outer `try/catch` boundary so the runner exception still returns
   `false`; do not invoke the full runner inside the transaction, which would
   move notification / index side effects before commit and could roll back the
   insert when they fail. `saveSDKMessage`'s post-commit `publish` stage keeps
   the shared `try/catch`: it calls `notifySession` only when
   `badgeUpdate.kind === 'delta'`, then `deleteSupersededIndex`, preserving the
   current all-or-nothing catch boundary. `decideMessageAdmission`
   keeps its current plain body
   and public signature; export each pipeline's runner (`runSaveSdkMessage` et
   al.) for stage-level assertions if the suites want them.

5. **Run targeted tests.**
   - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-admission.test.ts`
   - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-save-admission-drift.test.ts`
   - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-repository.test.ts`
     (must now include the post-commit failure-contract cases for
     `saveUserMessage` and `saveHyperNeoActionMessage`, and the
     `false`-on-insert-failure contract for `saveSDKMessage`).
   - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-repository-live-query.test.ts`
   - `packages/daemon/tests/unit/4-space-storage/storage/message-delivery-outbox.test.ts`
   - `packages/daemon/tests/unit/4-space-storage/storage/sqlite-busy-retry.test.ts`
     (preserves the `withBusyRetry` contracts for `saveSDKMessage` and
     `saveUserMessage`)

6. **Optional microbenchmark.** Add or extend
   `packages/daemon/scripts/benchmark/decision-pipeline.ts` to measure the
   **complete save-pipeline overhead** (not an admission-only pipeline) on a
   representative message set AND a representative SQLite INSERT against the
   same database setup, so any overhead ratio is grounded in a measured
   denominator (review correction PR #2978: without the insert measurement the
   ~3% claim cannot be established — if the insert cannot be measured faithfully
   in the script, report ONLY the isolated per-run pipeline overhead and drop
   the percentage claim).

7. **Lint/type check.** Run `bun run check` (or `bun run typecheck`) from the
   repo root. The file lives under `packages/daemon`, so it is covered by the
   daemon type/lint pass.

#### Tests

- **Unit: `sdk-message-admission.test.ts`**
  - Keep all existing `decideMessageAdmission` assertions as the parity oracle
    for the admission leaf; do **not** introduce an admission-only pipeline.
  - If individual pipeline runners are exported, add `describe('saveSdkMessage')`
    / `describe('saveUserMessage')` / `describe('persistAndEnqueueDelivery')` /
    `describe('saveHyperNeoActionMessage')` blocks that call the complete
    business-path pipelines and assert each stage contributes the expected
    fields.
  - If stages are not exported, test through the public wrapper and assert the
    full record/side-effect shape.

- **Drift: `sdk-message-save-admission-drift.test.ts`**
  - This is the highest-value regression suite for the four save/delivery paths
    (`saveSDKMessage`, `saveUserMessage`, `persistAndEnqueueDelivery`,
    `saveHyperNeoActionMessage`).
  - It already pins the status/anchor/badge/replacement/consumed_seq
    divergences; the pipeline must not change any of these outcomes.

- **Integration: `sdk-message-repository.test.ts` and live-query test**
  - Confirms that the real repo still writes correct `is_renderable`,
    `is_terminal`, `conversation_turn_index`, `sdk_uuid`, and
    `replacement_metadata_normalized` values.
  - Add explicit post-commit failure-contract cases for `saveUserMessage` and
    `saveHyperNeoActionMessage`: mock the post-commit effect to throw and
    assert the database row is present and the error reaches the caller.
  - For `saveSDKMessage` and the outbox, assert post-commit failures are
    swallowed/logged and do not roll back the insert.
  - Confirm `saveSDKMessage` still returns `false` on an insert/transaction
    failure (preserved by the outer `try/catch` boundary).

- **Busy retry: `sqlite-busy-retry.test.ts`**
  - Verifies that `saveSDKMessage` and `saveUserMessage` keep their
    `withBusyRetry` wrappers around the transaction-owning repository primitive.

- **Direct core: `task-id-resolution-cache.test.ts`**
  - `saveUserMessageCore` (the public wrapper) and the new
    `saveUserMessageCoreWithAdmission` helper must still satisfy the
    `saveUserMessageCore / runPostSaveSideEffects composition contract` block
    (no direct notifications, transaction-free for caller rollback, post-commit
    publication only, proxied notification behavior).

- **Outbox: `message-delivery-outbox.test.ts`**
  - Covers the preflight stages (`extractSdkUuid` / missing-UUID guard and
    `planDeliveryRoleArbitration`), the transactional persist/enqueue,
    UNIQUE-conflict-to-steer fallback, and the post-commit exception contract.

- **Benchmark: optional `scripts/benchmark/decision-pipeline.ts` extension**
  - Measures the complete save-pipeline overhead, not an admission-only
    pipeline. Verifies the overhead is in the expected ADR range before/after
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

- **Do not introduce a new combinator.** Resist `transformRun` and any
  admission-only pipeline; the four save/delivery paths are mixed
  transform/effect business operations.

- **The `atomic` stage delegates to a repository/outbox primitive; it does not
  own the transaction.** ADR 0004 requires persistent effect stages to write
  through transaction-owning primitives. `saveSDKMessageWithAdmission`,
  `saveUserMessageWithAdmission`, `saveHyperNeoActionMessageWithAdmission`, and
  `persistAndEnqueueDelivery`'s `persistAndEnqueueAdmittedUserMessage` each own
  their transaction; the pipeline `atomic` stage is just a call to the primitive.

- **Keep `withBusyRetry` around the transaction-owning primitive.**
  `saveSDKMessage` and `saveUserMessage` currently retry on `SQLITE_BUSY`
  (`sdk-message-repository.ts:572` and `:960-962`); the `sqlite-busy-retry.test.ts`
  suite pins these contracts. The new transaction-owning primitives must preserve
  the retry wrappers.

- **`consumed_seq` must stay inside the atomic stage.** The record's
  `isTerminal` field is not a signal to allocate a consumed sequence, but for
  terminal SDK messages the allocation and UPDATE must happen inside the same
  transaction as the INSERT (`saveSDKMessage`, `sdk-message-repository.ts:560-567`).
  `saveUserMessageCore` leaves `consumed_seq` NULL at insert and allocates it only
  on the later `consumed` status flip. The pipeline must preserve this by keeping
  all current transaction work in the single `atomic` stage.

- **Benchmark caveats.** The ADR numbers were produced by
  `packages/daemon/scripts/benchmark/decision-pipeline.ts` for a `decisionRun`
  with six early-exit gates. The save pipelines are mixed transform/effect
  business paths, so the benchmark must be re-run on the complete
  save/delivery pipelines rather than on an admission-only transform.

## Suggested migration order

1. **The four save/delivery pipelines (`sdk-message-repository.ts` and
   `message-delivery-outbox.ts`, with admission via the `sdk-message-admission.ts`
   leaf)** — the complete persist/enqueue business paths; they set the pattern
   for future storage mixed-transform/effect work.
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
into five slices: one pin dimension family, one complete save/delivery
pipeline per business operation (`saveSDKMessage`, the paired `saveUserMessage`
/ `persistAndEnqueueDelivery` user paths, and `saveHyperNeoActionMessage`), and
a trailing benchmark (review correction PR #2978: the former
identity/extraction pin slice was removed — the existing wrapper suite already
characterizes those dimensions).

### PR 1 — `test(storage): pin admission flags and post-commit failure contracts`

📌 pins — prod Δ = 0, test Δ ≲350

- **Scope**:
  - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-admission.test.ts`
    (steps 1–2, flag dimension family). Add or confirm characterization
    coverage for the admission-flag dimensions of `decideMessageAdmission`:
    `sdk` / `user` / `hyperneo_action` variants; all five `SendStatus` values
    for `user`; `sendStatus: null` for `sdk` and `hyperneo_action`; renderable
    vs non-renderable user content (tool result); terminal `result` messages;
    hidden subtypes (`task_started`, `thinking_tokens`, etc.); and the
    resulting `isRenderable` / `isTerminal` / `isConversationAnchor` /
    `countsTowardsBadge` values. Pin the module-private `isVisibleBadgeRow`
    null `sendStatus` default at WRAPPER level via `countsTowardsBadge`
    decision-table rows (the helper has no isolated tests and stays unexported
    — review correction PR #2978).
  - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-repository.test.ts`
    (review correction PR #2978): add explicit post-commit failure-contract
    cases for `saveUserMessage` and `saveHyperNeoActionMessage` (force
    `runPostSaveSideEffects` / `notifySessionsChanged` to throw and assert the
    row is committed and the error propagates).
- **Lands**: The admission derivations and the uncaught post-commit failure
  contracts are pinned before any production refactor.
- **Excludes**: Any edit to `sdk-message-admission.ts` itself, the pipeline
  stages, and the benchmark extension. (The identity/replacement-edge
  dimensions are already characterized by the existing wrapper suite — no
  pin slice needed for them; review correction PR #2978.)
- **Tests**: `sdk-message-admission.test.ts` and `sdk-message-repository.test.ts`
  only (this slice is test-only).
- **Depends on**: none.

### PR 2 — `refactor(storage): compose the complete save-sdk-message pipeline`

🔧 apply — prod Δ ≲100, test Δ ≲150

- **Scope**: `packages/daemon/src/storage/repositories/sdk-message-repository.ts`
  (`saveSDKMessage`, call site `:521`) only (steps 3–4 for this method).
  Compose the `save-sdk-message` pipeline — snapshot → `admit` stage calling
  the unchanged plain `decideMessageAdmission` leaf → `atomic` stage calling
  a new transaction-owning repository primitive `saveSDKMessageWithAdmission`
  that wraps the existing `db.transaction(...)` body with `withBusyRetry`
  (this includes the INSERT, the `consumed_seq` UPDATE for terminal results, the
  replacement edges, the search index, and the badge update, all in the same
  transaction) → one post-commit `publish` stage that conditionally runs
  `notifySession` when `badgeUpdate.kind === 'delta'` and then
  `deleteSupersededIndex`, all under the existing shared `try/catch`
  catch+log (review correction PR #2978: the current method COMMITS
  before those operations and only logs their failures; running them
  in-transaction would roll back successful inserts); the method body keeps an
  outer `try/catch` boundary around `snapshot → run` so a write failure still
  returns `false` (preserving the existing repository test for the
  `false`-on-insert-failure contract).
- **Lands**: `saveSDKMessage` runs as one complete named pipeline;
  `decideMessageAdmission` keeps its plain body, two-argument signature, and
  every caller (`:974`, `:1678`, `sdk-message-badge.ts`); `bun run check`
  passes.
- **Excludes**: The other save paths (PRs 3–4); folding
  `normalizeMessageAdmissionInput` in (open question 1); any
  `transformRun`-style combinator; the benchmark extension (PR 5); later
  "Suggested migration order" items.
- **Tests**:
  - `sdk-message-save-admission-drift.test.ts`
  - `sdk-message-repository.test.ts` (must confirm the existing
    `false`-on-insert-failure contract and the post-commit swallowed-exception
    contract still pass)
  - `sdk-message-repository-live-query.test.ts`
  - `sqlite-busy-retry.test.ts` (must confirm `withBusyRetry` is preserved around
    `saveSDKMessageWithAdmission`)
- **Depends on**: PR 1.

### PR 3 — `refactor(storage): compose the complete user-message save pipelines`

🔧 apply — prod Δ ≲100, test Δ ≲150

- **Scope**: `packages/daemon/src/storage/repositories/sdk-message-repository.ts`
  (`saveUserMessage`, call site `:954` / `:960-962`, plus the shared
  `saveUserMessageCore` leaf at `:967`) AND
  `packages/daemon/src/lib/agent/message-delivery-outbox.ts:37-91`.
  Review correction (PR #2978): there are TWO complete user-message
  business-operation pipelines. `saveUserMessage` is the direct repository
  method used by `query-mode-handler.ts:152`, `message-persistence.ts:204,232`,
  and other callers; its runner surrounds the existing
  `this.db.transaction(() => this.saveUserMessageCore(...))()` block
  (`:960-962`) and the uncaught `runPostSaveSideEffects` call (`:963`).
  `persistAndEnqueueDelivery` is the outbox's complete
  persist/enqueue/post-commit flow at `:37-91`; its pipeline begins with
  preflight stages (`validateMessageUuid` at `:40-42`, `arbitrateDeliveryRole`
  at `:43-58`), then `admit`, then an `atomic` stage: `saveUserMessage` calls
  a new transaction-owning repository primitive `saveUserMessageWithAdmission`
  (wrapping `withBusyRetry(() => db.transaction(() =>
  saveUserMessageCoreWithAdmission(...)))`); `persistAndEnqueueDelivery` calls
  a new transaction-owning outbox primitive `persistAndEnqueueAdmittedUserMessage`
  that wraps the existing `db.transaction(...)` body, calling
  `saveUserMessageCoreWithAdmission` and then `jobQueue.enqueue` with the
  UNIQUE-conflict fallback. The helper is exposed as a public or package-internal
  method so `message-delivery-outbox.ts` can call it; the public
  `saveUserMessageCore` stays a compatibility wrapper that calls
  `decideMessageAdmission` and then the helper, so existing tests and callers
  continue to work.
- **Lands**: Both user-message save/delivery paths run as complete named
  pipelines; `saveUserMessageCore` (public wrapper) and `decideMessageAdmission`
  remain plain helpers; `bun run check` passes.
- **Excludes**: `saveSDKMessage` (PR 2) and `saveHyperNeoActionMessage` (PR 4);
  the benchmark (PR 5).
- **Tests**:
  - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-save-admission-drift.test.ts`
  - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-repository.test.ts`
    (must include the post-commit failure-contract case for `saveUserMessage`).
  - `packages/daemon/tests/unit/4-space-storage/storage/sdk-message-repository-live-query.test.ts`
  - `packages/daemon/tests/unit/4-space-storage/storage/message-delivery-outbox.test.ts`
    (must cover `validateMessageUuid`, `planDeliveryRoleArbitration`, the
    transactional enqueue/rollback, UNIQUE-conflict-to-steer fallback, and
    post-commit exception contract).
  - `packages/daemon/tests/unit/4-space-storage/storage/sqlite-busy-retry.test.ts`
    (must confirm `withBusyRetry` is preserved around `saveUserMessageWithAdmission`).
  - `packages/daemon/tests/unit/4-space-storage/storage/task-id-resolution-cache.test.ts`
    (must confirm the `saveUserMessageCore / runPostSaveSideEffects composition
    contract` still holds for the public wrapper and the new helper).
- **Depends on**: PR 2 (same file; sequenced for same-file churn, not
  correctness).

### PR 4 — `refactor(storage): compose the complete save-hyperneo-action-message pipeline`

🔧 apply — prod Δ ≲100, test Δ ≲150

- **Scope**: `packages/daemon/src/storage/repositories/sdk-message-repository.ts`
  (`saveHyperNeoActionMessage`, call site `:1675`) only. Same composition as
  PR 2, but the `atomic` stage calls a new transaction-owning repository
  primitive `saveHyperNeoActionMessageWithAdmission` that wraps the existing
  `db.transaction(...)` body and returns the inserted row id and `badgeUpdate`.
  The post-commit stage conditionally runs `notifySessionsChanged` when
  `badgeUpdate.kind === 'delta'` and then `scheduleMessageSearchIndex` at
  `:1711-1712`; it is NOT caught, so a
  failure propagates to the caller while the insert remains committed
  (preserving the current `saveHyperNeoActionMessage` contract).
- **Lands**: All repository save business paths and the outbox
  `persistAndEnqueueDelivery` path run as complete named pipelines;
  `decideMessageAdmission` and `saveUserMessageCore` remain the plain shared
  leaves.
- **Excludes**: PRs 2–3; the benchmark (PR 5).
- **Tests**:
  - `sdk-message-save-admission-drift.test.ts`
  - `sdk-message-repository.test.ts` (must include the post-commit
    failure-contract case for `saveHyperNeoActionMessage`)
  - `sdk-message-repository-live-query.test.ts`
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
