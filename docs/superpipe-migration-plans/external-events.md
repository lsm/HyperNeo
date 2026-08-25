# External events migration plan

This plan describes how to migrate the hand-rolled external-event ingestion and
digestion paths in `packages/daemon/src/lib/external-events` to direct superpipe
compositions, per ADR 0004 (`docs/adr/0004-superpipe-pipelines.md`).

The target is **planning only**: no source code is changed by this document.

## Scope and combinator fit

| Site | Proposed combinator | Rationale |
| --- | --- | --- |
| `github/github-normalizer.ts` normalizer family | Raw superpipe transforms for per-kind normalizers; `decisionRun` for webhook/poll dispatch | Each normalizer is a pure payload-to-`NormalizedGitHubEvent \| null` transform. `normalizeGitHubWebhook` and `normalizeGitHubPollingRow` are dispatchers over known event/endpoint kinds. |
| `event-essence.ts:formatExternalEventEssence` | Raw superpipe transform | Pure event-object to JSON-string formatting. Conditional field copies become guarded pipeline stages. |
| `deferred-event-digest.ts:buildExternalEventDigestMessage` | Raw superpipe transform | Pure list-of-essences to digest string. Sort, group, render, header/footer are discrete stages. |
| `deferred-event-digest.ts:renderDigestGroup` | `decisionRun` | A single switch over `group.kind` with one branch per kind; `decisionRun` halts on the first matching renderer and returns the rendered string. |
| `deferred-event-digest.ts:parseDeferredExternalEventText` | Raw superpipe transform with `!hasEntry` early exit | Try JSON, then rate-limit text. Each parse attempt either produces an entry and halts, or falls through. |
| `event-tiers.ts:classifyExternalEventDirectSteer` | `decisionRun` | A short precedence chain over topic suffixes/state/conclusion/actor. First matching gate wins; fall-through returns `null`. |
| `github-subscription-pattern.ts:composeGitHubSubscriptionPattern` | `decisionRun` | Validation gates each produce an `invalid` decision and halt; the final gate builds the `ok` pattern. The shell preserves the current throw-on-error contract. |
| `github/github-event-extension.ts:validateRemoteHook` | `decisionRun` | Each validation rule produces an `invalid` decision and halts; success falls through to a `valid` decision. The shell preserves the `string \| null` contract. |

No new combinator should be invented. The existing `decisionRun`
(`packages/daemon/src/lib/space/runtime/decision-pipeline.ts`) and raw superpipe
patterns from `external-event-steer-admission-pipeline.ts` are sufficient.
`stagedRun` is **not** needed for any of these sites because none require
async effects or multi-stage compensation.

## Existing superpipe examples to emulate

1. `packages/daemon/src/lib/space/runtime/external-event-steer-admission-pipeline.ts`
   - Best overall template for an external-event direct superpipe.
   - Uses a `{ ..., decision: Decision \| null }` context, an `admissionSettled`
     helper, and exported per-stage functions that can be unit-tested in
     isolation.
   - Demonstrates how to mix a `decision` field with enrichment/snapshot stages.

2. `packages/daemon/src/lib/space/runtime/external-event-delivery-pipeline.ts`
   - Shows multiple `decisionRun` pipelines (`external-event-delivery`,
     `external-event-post-activation`) with typed decision unions and a
     `decided(ctx, decision)` helper.
   - Good example of turning an imperative gate cascade into a clear precedence
     order.

3. `packages/daemon/src/lib/space/runtime/spawn-admission-decision-pipeline.ts`
   - Minimal `decisionRun` with a default fall-through gate.
   - Useful for the smaller dispatchers (`classifyExternalEventDirectSteer`,
     `validateRemoteHook`, `composeGitHubSubscriptionPattern`).

4. `packages/daemon/src/lib/space/runtime/decision-pipeline.ts` and
   `packages/daemon/tests/unit/5-space/runtime/decision-pipeline.test.ts`
   - Defines the `decisionRun` contract and shows how `hasDecided`/gate order
     is tested.

5. `packages/daemon/tests/unit/5-space/runtime/external-event-steer-admission-pipeline.test.ts`
   - Exemplifies the test style we want: per-stage tests plus end-to-end
     pipeline tests, with exported stage names.

## Per-site detailed plans

### `github/github-normalizer.ts`: normalizer family

#### Current summary

The file contains ~1200 lines of hand-rolled normalizers for GitHub webhooks and
poll rows:

- `normalizeGitHubWebhook` — top-level switch over `X-GitHub-Event`, then large
  branch-specific payload extraction.
- `normalizeGitHubPollingRow` — endpoint-based dispatch and common field
  extraction.
- Per-kind normalizers: `normalizeGitHubCheckRun`, `normalizeGitHubStatus`,
  `normalizeGitHubCheckSuite`, `normalizeGitHubDeployment`,
  `normalizeGitHubDeploymentStatus`, `normalizeGitHubBranchProtectionRule`,
  `normalizeGitHubMergeGroup`, `normalizeGitHubReaction`,
  `normalizeGitHubMergeConflict`, `normalizeGitHubReview`.
- Helpers: `mapEventType`, `toExternalEvent`, `repoFromPayload`, `prUrl`,
  `userFrom`, `parseGitHubTimestamp`, `truncateBody`, `isBotActor`, etc.

Callers:
- `github/github-event-extension.ts` (`handleWebhook`, `handleStatusWebhook`,
  `handleDeploymentWebhook`, `pollEnabledSpaces` and related polling loops).
- Tests: `tests/unit/2-handlers/github/github-normalizer.test.ts`,
  `tests/unit/2-handlers/github/external-event-essence-contract.test.ts`.

#### Proposed combinator

- `normalizeGitHubWebhook` and `normalizeGitHubPollingRow` become `decisionRun`
  **dispatchers** that decide which per-kind normalizer to run.
- Each per-kind normalizer becomes a **raw superpipe transform** of shape
  `(params) => NormalizedGitHubEvent \| null`.
- `toExternalEvent` becomes a **raw superpipe transform**.
- `mapEventType` can either stay as a lookup-table helper inside
  `toExternalEvent`, or be extracted as a small raw superpipe of its own if it
  is tested independently.

#### Input/output snapshot design

Dispatcher context:

```ts
interface GitHubWebhookDispatchCtx {
  eventType: string;
  deliveryId: string;
  payload: unknown;
  base: WebhookBase | null; // shared repo/sender/occurredAt after a snapshot stage
  decision:
    | { action: 'ignore' }
    | { action: 'normalize'; kind: GitHubEventKind; input: unknown }
    | null;
}

interface WebhookBase {
  repo: GitHubPollingRepo;
  canonicalOwner: string;
  canonicalRepo: string;
  sender: { login: string; type: string };
  deliveryId: string;
  rawPayload: unknown;
}
```

Per-kind transform context (generic template):

```ts
type NormalizedOutcome =
  | { status: 'running' }
  | { status: 'rejected' }
  | { status: 'done'; value: NormalizedGitHubEvent };

interface NormalizeGitHubEventCtx<TInput> {
  input: TInput;
  outcome: NormalizedOutcome;
}
```

A plain `result: T | null` with `isDone = result !== null` cannot express
rejection: seeding with `null` and "rejecting" by assigning `null` leaves the
predicate unchanged, so `!isDone` would run extraction and assembly on an
already-rejected payload (e.g. a `check_run` webhook whose action is not
`completed`). The boxed `outcome` terminal makes rejection a first-class halt:
guards that reject set `outcome = { status: 'rejected' }` and `!isDone` halts.

`toExternalEvent` context:

```ts
interface ToExternalEventCtx {
  spaceId: string;
  event: NormalizedGitHubEvent;
  result: ExternalEvent | null;
}
```

`toExternalEvent` never rejects — it always produces an event — so a plain
`result` with `isDone = result !== null` is sound there.

#### Pure core design

1. **Shared helpers remain pure functions**: `asObject`, `getString`,
   `getNumber`, `repoFromPayload`, `prUrl`, `parseGitHubTimestamp`,
   `userFrom`, `truncateBody`, `isBotActor`, `sanitizeBranchTopicSegment`,
   `parseMergeQueuePrNumber`. They are called by pipeline stages.

2. **`normalizeGitHubWebhook` dispatcher** — `decisionRun` with a gate per known
   kind and a final `ignore` gate:

   - `gateCheckRun`
   - `gateCheckSuite`
   - `gateBranchProtectionRule`
   - `gateMergeGroup`
   - `gateIssueComment` (guard that the issue is a PR)
   - `gatePullRequestReview`
   - `gatePullRequestReviewComment`
   - `gatePullRequestReviewThread`
   - `gatePullRequest`
   - `gateIgnoreUnknown` (sets `decision: { action: 'ignore' }`)

   Each gate, when it matches, sets `decision = { action: 'normalize', kind, input }`
   and returns. The dispatcher also runs an initial `snapshotBase` stage that
   extracts `WebhookBase` so per-kind normalizers do not re-parse repo/sender.

3. **Per-kind transform stages live inside the operation pipeline, not as
   separately-run pipelines** (review correction — regroup by business path per
   CLAUDE.md/AGENTS.md: one directly named pipeline per business operation,
   mixing decision/transform stages). The stage sequence below is the per-kind
   template applied within `normalize-github-webhook` after the dispatch stage:

   ```ts
   .pipe(guardRequiredShape, 'ctx', 'ctx')   // reject -> outcome = { status: 'rejected' }
   .pipe('!isDone', 'ctx')
   .pipe(extractPrimaryFields, 'ctx', 'ctx')
   .pipe('!isDone', 'ctx')
   .pipe(extractPayload, 'ctx', 'ctx')
   .pipe(assembleNormalizedEvent, 'ctx', 'ctx') // outcome = { status: 'done', value }
   ```

   `isDone` returns `ctx.outcome.status !== 'running'`. A guard that rejects
   sets `ctx.outcome = { status: 'rejected' }`, which flips the predicate and
   makes `!isDone` halt before extraction/assembly. The pipeline ends with
   `.end('ctx')` and the shell unwraps `outcome.status === 'done' ? value : null`.

4. **`normalizeGitHubPollingRow`** — same single-pipeline shape, with the
   dispatch stage keyed on `endpointKey` (`issue_comments`, `review_comments`,
   `pulls`, etc.) followed by the endpoint-specific transform stages inline.

5. **`toExternalEvent` stays a separate per-space projection pipeline at the
   publish boundary** (review correction: for a webhook watched by multiple
   spaces, normalization runs ONCE before the loop over matching
   repositories, while `toExternalEvent(spaceId, normalized)` runs separately
   inside `publishEvent` for EACH space — the ingest pipeline has no
   `spaceId`, so appending `assembleExternalEvent` to it either cannot
   construct the event or constructs one event reused with the wrong space
   scope/UUID across all targets). The ingest pipelines
   (`ingest-github-webhook` / `ingest-github-polling-row`) end at
   `NormalizedGitHubEvent`; the projection stages form their own small raw
   transform (`project-external-event`) covering:
   - `canonicalizeRepo`
   - `selectTopicParts` (uses `mapEventType`)
   - `buildPayload` (spreads `event.payload` into the record)
   - `assembleExternalEvent` (generates `crypto.randomUUID()` in the final
     stage — one fresh UUID per space)

   The exported `toExternalEvent(spaceId, event)` wraps that transform and is
   what `publishEvent` calls per space.

#### Shell/effect wiring

```ts
export function normalizeGitHubWebhook(
  eventType: string,
  deliveryId: string,
  payload: unknown
): NormalizedGitHubEvent | null {
  const { outcome } = runIngestGitHubWebhook({
    eventType,
    deliveryId,
    payload,
    base: null,
    outcome: { status: 'running' },
  });
  return outcome.status === 'done' ? outcome.value : null;
}

export function toExternalEvent(
  spaceId: string,
  event: NormalizedGitHubEvent
): ExternalEvent {
  return runToExternalEvent({ spaceId, event, result: null }).result!;
}
```

The dispatch `decisionRun` and per-kind transforms are stages of the single
`ingest-github-webhook` pipeline (dispatch stage selects the kind; the shared
per-kind stage template follows; projection stages append when the caller is
the extension's publish path). The `id` generation (`crypto.randomUUID()`) is
the only non-determinism. It stays in the final assembly stage. The normalizer
family has no DB/network writes.

#### Step-by-step migration

1. Add parity/characterization tests for the existing normalizers if coverage
   gaps exist (especially `deployment_status`, `branch_protection_rule`,
   `merge_group`, `reaction`, `merge_conflict`). Include explicit rejection
   rows (e.g. `check_run` with `action !== 'completed'` must return `null`)
   so the boxed-outcome halt is pinned.
2. Extract `WebhookBase`/`PollingBase` snapshot helpers and unit-test them.
3. Convert `normalizeGitHubWebhook` to the single `ingest-github-webhook`
   pipeline: dispatch decision stage first, then convert one per-kind
   transform block at a time into inline stages, keeping the old export as a
   thin wrapper over the pipeline.
4. Convert `normalizeGitHubPollingRow` to the single
   `ingest-github-polling-row` pipeline the same way.
5. Convert `toExternalEvent` to its own `project-external-event` transform
   and keep the `publishEvent` per-space call site unchanged (projection
   stays at the publish boundary; it never joins the normalize-once ingest
   pipeline).
6. After all wrappers pass the existing test suites, delete the old
   implementations and rename the pipeline runners to the original export names.
7. Update `github/index.ts` if any internal exports change; public export
   surface must remain the same.

#### Tests

- `tests/unit/2-handlers/github/github-normalizer.test.ts` — keep as the parity
  suite; add per-stage unit tests for each exported gate/snapshot function.
- `tests/unit/2-handlers/github/external-event-essence-contract.test.ts` —
  end-to-end `toExternalEvent` round trips.
- Add `tests/unit/2-handlers/github/github-normalizer-pipeline.test.ts` with
  stage-order tests (e.g., "check_run guard halts before payload parsing when
  `action !== 'completed'`").

#### Risks/caveats

- **Volume**: webhooks and polls are event-rate paths. Keep normalizer stages
  synchronous and avoid `endAsync`.
- **Payload mutability**: `payload` is often a parsed JSON object. Pipeline
  stages must not mutate `payload`; always copy into a new `Record`.
- **Null returns for unparseable events**: the dispatch and per-kind transforms
  must distinguish "unparseable" (`null`) from "malformed input". The current
  behavior is to return `null`; preserve that.
- **`toExternalEvent` UUID**: the pipeline is not idempotent because of the
  random `id`. Do not retry the same normalized event through `toExternalEvent`
  expecting the same `id`.
- **Branch protection and repo resource**: the `repo` resource is unusual
  (`repo/<branch>.<action>`); the `repoFromPayload` helper and `entityId`
  generation must remain branch-aware.

---

### `event-essence.ts:formatExternalEventEssence`

#### Current summary

Builds a formatted JSON essence from an `ExternalEventPublishedPayload`.
Copies a base set of fields, then copies additional fields based on
`eventType` (and `topic.endsWith('.check_failed')`). Returns a pretty-printed
JSON string.

Callers:
- `packages/daemon/src/lib/space/runtime/space-runtime.ts` (injected as a
  synthetic user message).
- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` (direct steer
  and deferred digest text generation).
- `packages/daemon/tests/unit/4-space-storage/storage/deferred-event-digest.test.ts`
  and `task-agent-manager-direct-steer.test.ts`.

#### Proposed combinator

Raw superpipe transform. The event-type branch becomes either a `decisionRun`
stage that selects the field-set to copy, or a sequence of guarded
`copyXFields` stages.

#### Input/output snapshot design

```ts
interface FormatExternalEventEssenceCtx {
  event: ExternalEventPublishedPayload;
  payload: Record<string, unknown>;
  essence: Record<string, unknown>;
  result: string | null;
}
```

#### Pure core design

```ts
const formatEssencePipeline = superpipe<{ isDone: (ctx: FormatExternalEventEssenceCtx) => boolean }>({
  isDone: (ctx) => ctx.result !== null,
})('format-external-event-essence')
  .input(['ctx'])
  .pipe(buildBaseEssence, 'ctx', 'ctx')
  .pipe(decideFieldSet, 'ctx', 'ctx') // can be a small decisionRun
  .pipe(copyCommonFields, 'ctx', 'ctx')
  .pipe(copyEventTypeFields, 'ctx', 'ctx')
  .pipe(omitUndefinedAndStringify, 'ctx', 'ctx')
  .end('ctx');
```

- `buildBaseEssence` extracts `eventId`, `topic`, `eventType`, `action`, `actor`,
  `repo`, `prNumber`, `prUrl`, `externalUrl`, `occurredAt`, `body`.
- `decideFieldSet` (or a `decisionRun` embedded as a stage) returns the list of
  extra keys to copy for the current `eventType`.
- `copyEventTypeFields` applies that list and any topic-suffix special cases
  (`check_failed`, `suite_failed`).
- `omitUndefinedAndStringify` runs `omitUndefinedExternalEventFields` and
  `JSON.stringify(..., null, 2)`.

#### Shell/effect wiring

```ts
export function formatExternalEventEssence(event: ExternalEventPublishedPayload): string {
  return runFormatEssence({
    event,
    payload: {},
    essence: {},
    result: null,
  }).result!;
}
```

#### Step-by-step migration

1. Pin the current string output for each `eventType` with characterization
   tests.
2. Extract `buildBaseEssence`, `copyExternalEventFields`,
   `omitUndefinedExternalEventFields` as pure helpers.
3. Replace the central `if/else` with a `decideFieldSet` decision stage.
4. Wire the pipeline and run the existing `deferred-event-digest` and
   `task-agent-manager-direct-steer` suites.

#### Tests

- `tests/unit/2-handlers/github/external-event-essence-contract.test.ts` —
  expand to cover every `eventType` branch and the `check_failed`/`suite_failed`
  topic-suffix overrides.
- Add `tests/unit/1-core/external-events/event-essence-pipeline.test.ts` with
  per-stage tests for `buildBaseEssence`, `decideFieldSet`, and
  `omitUndefinedAndStringify`.

#### Risks/caveats

- **Round-trip contract with `parseDeferredExternalEventText`**: the formatted
  text must remain parseable. Any change to key names or `undefined` omission
  must be coordinated with `parseDeferredExternalEventText`.
- **Performance**: called for every injected external event. Keep the pipeline
  sync and avoid allocations beyond the essence object and the JSON string.
- **Topic-suffix edge cases**: `.check_failed` and `.suite_failed` add extra
  fields even when `eventType` is `check_run`/`check_suite`; the decision stage
  must read `event.topic` as well as `eventType`.

---

### `deferred-event-digest.ts:buildExternalEventDigestMessage`

#### Current summary

Takes a list of `ExternalEventEssenceEntry` values and builds a human-readable
multi-line digest string. It sorts by `occurredAt`, groups by
`(kind, repo/pr, key)`, renders each group, and adds a header/footer.

Callers:
- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` (direct steer
  injection).
- `packages/daemon/src/lib/external-events/deferred-event-digest.ts`
  (`foldDeferredExternalEventsAtFlush`).
- Tests: `tests/unit/4-space-storage/storage/deferred-event-digest.test.ts`.

#### Proposed combinator

Raw superpipe transform. The `switch (group.kind)` inside `renderDigestGroup`
will be split into a separate `decisionRun` that `buildExternalEventDigestMessage`
calls as a stage.

#### Input/output snapshot design

```ts
interface BuildDigestMessageCtx {
  events: ExternalEventEssenceEntry[];
  options?: {
    droppedEventCount?: number;
    title?: string;
    snippetMaxChars?: number;
    renderAllReviewBodies?: boolean;
  };
  ordered: ExternalEventEssenceEntry[];
  includeDate: boolean;
  groups: Map<string, DigestGroup>;
  lines: string[];
  result: string | null;
}
```

#### Pure core design

```ts
const buildDigestPipeline = superpipe<{ isDone: (ctx: BuildDigestMessageCtx) => boolean }>({
  isDone: (ctx) => ctx.result !== null,
})('build-external-event-digest-message')
  .input(['ctx'])
  .pipe(guardEmpty, 'ctx', 'ctx')      // if events.length === 0 -> result = ''
  .pipe('!isDone', 'ctx')
  .pipe(computeOptions, 'ctx', 'ctx')
  .pipe(sortEvents, 'ctx', 'ctx')
  .pipe(decideIncludeDate, 'ctx', 'ctx')
  .pipe(groupEvents, 'ctx', 'ctx')
  .pipe(renderGroups, 'ctx', 'ctx')    // calls renderDigestGroup decisionRun
  .pipe(assembleMessage, 'ctx', 'ctx')
  .end('ctx');
```

- `guardEmpty`: set `result = ''` if `events.length === 0`.
- `sortEvents`: stable sort by `orderTime` with index tie-break.
- `decideIncludeDate`: true when more than one UTC date is present.
- `groupEvents`: `digestGroupKind` + `digestGroupKey`, collect into a `Map`.
- `renderGroups`: iterate `DIGEST_GROUP_ORDER`, call `renderDigestGroup` for
  matching groups, append to `lines`.
- `assembleMessage`: header + lines + footer joined with `\n`.

#### Shell/effect wiring

```ts
export function buildExternalEventDigestMessage(
  events: ExternalEventEssenceEntry[],
  options?: { ... }
): string {
  return runBuildDigestMessage({
    events,
    options,
    ordered: [],
    includeDate: false,
    groups: new Map(),
    lines: [],
    result: null,
  }).result!;
}
```

#### Step-by-step migration

1. Convert `renderDigestGroup` to a `decisionRun` first (it is private and has
   no other callers).
2. Add a `BuildDigestMessageCtx` type and the `isDone` helper.
3. Replace the body of `buildExternalEventDigestMessage` with the pipeline
   stages above.
4. Keep the existing `digestGroupKind`, `digestGroupKey`, `digestTimestamp`,
   `digestSnippet`, `digestLinkSuffix`, `digestDetailSuffix`, and
   `essenceScopeLabel` as pure helpers.

#### Tests

- `tests/unit/4-space-storage/storage/deferred-event-digest.test.ts` — keep as
  parity suite; add tests for each new stage.
- Add explicit stage-order tests:
  - empty input returns `''` before any sort/group.
  - multi-date input sets `includeDate = true`.
  - groups are rendered in `DIGEST_GROUP_ORDER`.
  - `renderAllReviewBodies` option is propagated into `renderDigestGroup`.

#### Risks/caveats

- **Stable sorting**: the current sort uses `index` as a tie-break. The superpipe
  `sortEvents` stage must preserve that.
- **Map ordering**: groups are not insertion-ordered; the render stage must
  iterate `DIGEST_GROUP_ORDER` and then `groups.values()`.
- **String formatting**: the digest is later parsed by `parseDeferredExternalEventText`.
  Preserve line breaks and the JSON envelope text produced by
  `buildDeferredEventDigestEnvelopeText`.

---

### `deferred-event-digest.ts:renderDigestGroup`

#### Current summary

A private function with a `switch (group.kind)` over six kinds (`check`,
`review`, `pr_comment`, `state`, `reaction`, `other`). Returns a single formatted
string line for a group.

Callers: only `buildExternalEventDigestMessage`.

#### Proposed combinator

`decisionRun`. Each kind is a gate that, when matched, sets `ctx.decision` to
the rendered string and halts. The `other` gate is the final catch-all.

#### Input/output snapshot design

```ts
interface RenderDigestGroupCtx {
  group: DigestGroup;
  includeDate: boolean;
  snippetMaxChars: number;
  renderAllReviewBodies: boolean;
  decision: string | null;
}
```

#### Pure core design

```ts
function decided(
  ctx: RenderDigestGroupCtx,
  decision: string
): RenderDigestGroupCtx {
  return { ...ctx, decision };
}

const renderDigestGroupRun = decisionRun<RenderDigestGroupCtx>('render-digest-group', [
  gateCheck,
  gateReview,
  gatePrComment,
  gateState,
  gateReaction,
  gateOther,
]);
```

Each gate:

```ts
export function gateCheck(ctx: RenderDigestGroupCtx): RenderDigestGroupCtx {
  if (ctx.group.kind !== 'check') return ctx;
  return decided(ctx, buildCheckGroupLine(ctx.group, ctx.includeDate, ctx.snippetMaxChars));
}
```

#### Shell/effect wiring

```ts
function renderDigestGroup(
  group: DigestGroup,
  includeDate: boolean,
  options: DigestRenderOptions = {}
): string {
  const ctx = {
    group,
    includeDate,
    snippetMaxChars: options.snippetMaxChars ?? DIGEST_SNIPPET_MAX_CHARS,
    renderAllReviewBodies: options.renderAllReviewBodies ?? false,
    decision: null,
  };
  return renderDigestGroupRun(ctx).decision!;
}
```

#### Step-by-step migration

1. Move each `case` body into an exported `buildXGroupLine` pure helper.
2. Create the `RenderDigestGroupCtx` and the six `gate*` functions.
3. Assemble the `decisionRun`.
4. Replace the switch in `buildExternalEventDigestMessage` with the runner.

#### Tests

- `tests/unit/4-space-storage/storage/deferred-event-digest.test.ts` — add a
  `describe('renderDigestGroup')` block covering each `DigestGroupKind` and the
  `renderAllReviewBodies`/`snippetMaxChars` options.
- Test gate order: once a gate sets `decision`, later gates must not run.

#### Risks/caveats

- **Six-way exhaustive switch**: the `other` catch-all must always match. Do not
  return `''` for unknown kinds; the current switch is exhaustive because
  `digestGroupKind` only returns the six kinds.
- **Shared helpers**: `digestTimestamp`, `digestSnippet`, `digestDetailSuffix`,
  `digestActionLabel`, `digestStateMarkers`, and `essenceScopeLabel` must remain
  accessible to the gate functions.

---

### `deferred-event-digest.ts:parseDeferredExternalEventText`

#### Current summary

Parses a deferred external-event text back into a `DeferredExternalEventEntry`.
It tries JSON first, then falls back to a rate-limit digest regex. JSON can be
an `external_event` or `external_event_digest` envelope. Rate-limit text has
both annotated and legacy forms.

Callers:
- `parseDeferredDeliveryRow` (within the same file).
- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`
  (`enforceDeferredExternalEventCap`, `maybeBufferDirectSteer`).
- Tests: `tests/unit/4-space-storage/storage/deferred-event-digest.test.ts`.

#### Proposed combinator

Raw superpipe transform with `!hasEntry` early exit after each parse attempt.

#### Input/output snapshot design

```ts
interface ParseDeferredTextCtx {
  text: string;
  json: unknown;
  jsonError: boolean;
  record: Record<string, unknown> | null;
  entry: DeferredExternalEventEntry | null;
}
```

#### Pure core design

```ts
const parseDeferredTextPipeline = superpipe<{ hasEntry: (ctx: ParseDeferredTextCtx) => boolean }>({
  hasEntry: (ctx) => ctx.entry !== null,
})('parse-deferred-external-event-text')
  .input(['ctx'])
  .pipe(tryJsonParse, 'ctx', 'ctx')
  .pipe('!hasEntry', 'ctx')
  .pipe(guardExternalEventJson, 'ctx', 'ctx')
  .pipe('!hasEntry', 'ctx')
  .pipe(guardDigestJson, 'ctx', 'ctx')
  .pipe('!hasEntry', 'ctx')
  .pipe(tryRateLimitText, 'ctx', 'ctx')
  .end('ctx');
```

- `tryJsonParse`: sets `json` or `jsonError`.
- `guardExternalEventJson`: if `record.type === 'external_event'`, call
  `parseEssenceEntry` and set `entry`.
- `guardDigestJson`: if `record.type === 'external_event_digest'`, validate the
  events array, set `entry` with `droppedCount`.
- `tryRateLimitText`: run `parseRateLimitDigestText` and, if it matches, set
  `entry`.

`parseEssenceEntry`, `parseRateLimitDigestText`, `parseRateLimitIdEntries`, and
`scopeFromTopic` remain private pure helpers.

#### Shell/effect wiring

```ts
export function parseDeferredExternalEventText(text: string): DeferredExternalEventEntry | null {
  return runParseDeferredText({
    text,
    json: undefined,
    jsonError: false,
    record: null,
    entry: null,
  }).entry;
}
```

#### Step-by-step migration

1. Extract each parse attempt into a named stage function.
2. Add the `hasEntry` helper and `!hasEntry` halts.
3. Keep `parseDeferredDeliveryRow` unchanged; it calls
   `parseDeferredExternalEventText(rowText(row))`.

#### Tests

- `tests/unit/4-space-storage/storage/deferred-event-digest.test.ts` — already
  covers JSON event, JSON digest, rate-limit annotated/legacy/structured forms.
  Add stage-level tests:
  - invalid JSON halts after `tryJsonParse` and enters rate-limit stage.
  - `record.type === 'external_event'` never reaches rate-limit stage.
  - malformed `external_event_digest` with empty events returns `null`.

#### Risks/caveats

- **Input is untrusted text**: malformed JSON or regex edge cases must not
  throw. The current code catches `JSON.parse` and returns `null` on regex
  failure; preserve that behavior.
- **Rate-limit regex is brittle**: the `RATE_LIMIT_DIGEST_PATTERN` must not be
  split across stages in a way that makes it harder to reason about.
- **Performance**: `parseDeferredExternalEventText` is called per deferred row
  in `enforceDeferredExternalEventCap` and `maybeBufferDirectSteer`. Keep it
  synchronous and avoid `endAsync`.

---

### `event-tiers.ts:classifyExternalEventDirectSteer`

#### Current summary

A short `if/else` chain that classifies an external event essence into a direct
steer class (`review`, `check`, `merge_conflict`) or `null`.

Callers:
- `packages/daemon/src/lib/space/runtime/external-event-steer-admission-pipeline.ts`
  (`partitionDirectSteerEssences`), used once per essence.
- `packages/daemon/tests/unit/5-space/runtime/task-agent-manager-direct-steer.test.ts`.

#### Proposed combinator

`decisionRun` with one gate per class and a fall-through to `null`.

#### Input/output snapshot design

```ts
interface ClassifyDirectSteerCtx {
  input: DirectSteerClassificationInput;
  decision: DirectSteerEventClass | null;
}
```

#### Pure core design

```ts
function decided(
  ctx: ClassifyDirectSteerCtx,
  decision: DirectSteerEventClass
): ClassifyDirectSteerCtx {
  return { ...ctx, decision };
}

const classifyDirectSteerRun = decisionRun<ClassifyDirectSteerCtx>('classify-direct-steer', [
  gateReviewSubmitted,
  gateReviewCommentPolled,
  gateCheckFailed,
  gateMergeConflict,
]);
```

- `gateReviewSubmitted`: if suffix is `review_submitted` and `state` is
  `APPROVED` or `CHANGES_REQUESTED`, set `decision = 'review'`.
- `gateReviewCommentPolled`: if suffix is `review_comment_polled` and actor is
  a bot, set `decision = 'review'`.
- `gateCheckFailed`: if suffix is `check_failed` and `conclusion` is not a
  non-failure conclusion, set `decision = 'check'`.
- `gateMergeConflict`: if suffix is `merge_conflict`, set `decision = 'merge_conflict'`.

#### Shell/effect wiring

```ts
export function classifyExternalEventDirectSteer(
  input: DirectSteerClassificationInput
): DirectSteerEventClass | null {
  return classifyDirectSteerRun({ input, decision: null }).decision;
}
```

#### Step-by-step migration

1. Export each gate function.
2. Replace the function body with the `decisionRun`.
3. Update `external-event-steer-admission-pipeline.ts` to call the new runner
   (signature unchanged).

#### Tests

- `tests/unit/5-space/runtime/task-agent-manager-direct-steer.test.ts` already
  has a `classifyExternalEventDirectSteer` block. Keep it as parity.
- Add `tests/unit/1-core/external-events/event-tiers-pipeline.test.ts` with
  per-gate tests and a "first gate wins" test.

#### Risks/caveats

- **Hot path**: this function is called once per essence in
  `partitionDirectSteerEssences`. A batch can contain up to
  `DIRECT_STEER_BUFFER_MAX_ENTRIES` events. The `decisionRun` overhead
  (~2 µs/gate) is acceptable for an event-level loop, but if many events are
  processed in one tick it may be worth benchmarking against the current
  implementation. If the loop becomes a bottleneck, consider batch
  classification or keeping a compact lookup inside the steer pipeline.
- **Null fall-through**: if no gate matches, `decision` stays `null`; the caller
  treats that as "not direct".

---

### `github-subscription-pattern.ts:composeGitHubSubscriptionPattern`

#### Current summary

Normalizes a user-supplied GitHub subscription topic into a canonical wildcard
pattern. Throws descriptive errors for unsupported resources, slash-separated
actions, malformed entity segments, etc.

Callers:
- `packages/daemon/src/lib/external-events/long-horizon-subscription-pattern.ts`.
- Tests: `tests/unit/5-space/runtime/github-subscription-pattern.test.ts`.

#### Proposed combinator

`decisionRun` where each validation/building gate sets `decision` and halts.
The final shell throws for `invalid` and returns the pattern for `ok`.

#### Input/output snapshot design

```ts
interface ComposeGitHubPatternCtx {
  source: string;
  topic: string;
  segments: string[];
  isSourcePrefixed: boolean;
  resourceSegments: string[];
  decision:
    | { action: 'ok'; pattern: string }
    | { action: 'invalid'; reason: string }
    | null;
}
```

#### Pure core design

```ts
function decided(
  ctx: ComposeGitHubPatternCtx,
  decision: ComposeGitHubPatternCtx['decision']
): ComposeGitHubPatternCtx {
  return { ...ctx, decision };
}

const composePatternRun = decisionRun<ComposeGitHubPatternCtx>('compose-github-subscription-pattern', [
  gateSlashSeparatedAction,
  guardTooManySegments,
  guardFullyQualified,
  guardOwnerRepoResourceAction,
  guardSourcePrefixedThreeSegments,
  guardOwnerRepoThreeSegments,
  guardTwoSegments,
  guardOneSegment,
  buildFallbackPattern,
]);
```

The helper functions `splitDottedGitHubResource`, `isGitHubEventResource`,
`thirdIsOwnerRepoResourceShape`, `ensureGitHubEntityAction`, and
`ensureGitHubEventResource` stay as pure helpers.

#### Shell/effect wiring

```ts
export function composeGitHubSubscriptionPattern(source: string, topic: string): string {
  const result = composePatternRun({
    source,
    topic,
    segments: topic.split('/'),
    isSourcePrefixed: topic.split('/')[0] === source,
    resourceSegments: topic.split('/').slice(topic.split('/')[0] === source ? 1 : 0),
    decision: null,
  }).decision;

  if (!result || result.action === 'invalid') {
    throw new Error(result?.reason ?? `Invalid GitHub topic "${topic}"`);
  }
  return result.pattern;
}
```

#### Step-by-step migration

1. Extract the current `throw` sites into `decided(ctx, { action: 'invalid', reason })`.
2. Split the shape logic into the gates above.
3. Add a final `buildFallbackPattern` gate that always sets an `ok` decision
   (the catch-all `github/*/*/${topic}`).
4. Replace the function body with the `decisionRun` and throw wrapper.

#### Tests

- `tests/unit/5-space/runtime/github-subscription-pattern.test.ts` — already
  exhaustive; keep as parity. Add explicit "first invalid gate halts" tests
  and a "fallback pattern" test.
- Add stage-level tests for `guardFullyQualified` and the repo-resource special
  cases.

#### Risks/caveats

- **Throw contract**: `long-horizon-subscription-pattern.ts` relies on thrown
  errors to reject invalid patterns. The shell must continue to throw with the
  same messages.
- **Error message stability**: the existing tests assert exact error strings.
  Preserve them in the `invalid` decisions.
- **Ambiguous `repo` owner name**: the existing code has special handling for an
  owner literally named `repo`. The gate logic must retain the segment-count
  checks that distinguish owner-name from the `repo` resource.

---

### `github/github-event-extension.ts:validateRemoteHook`

#### Current summary

A private function that validates a remote GitHub hook against a watched repo.
Returns a human-readable error string or `null` if the hook is valid.

Callers:
- `checkWebhook` (line 1874, 1908)
- `reconcileSharedHook` (line 2056)
- `reconcileWebhookEvents` uses `isOnlyMissingEvents` and `missingRequiredEvents`.

#### Proposed combinator

`decisionRun` with one validation gate per failure mode and a final `valid`
gate.

#### Input/output snapshot design

```ts
interface ValidateRemoteHookCtx {
  watched: GitHubWatchedRepo;
  hook: GitHubHookResponse;
  decision:
    | { action: 'invalid'; reason: string }
    | { action: 'valid' }
    | null;
}
```

#### Pure core design

```ts
function decided(
  ctx: ValidateRemoteHookCtx,
  decision: ValidateRemoteHookCtx['decision']
): ValidateRemoteHookCtx {
  return { ...ctx, decision };
}

const validateRemoteHookRun = decisionRun<ValidateRemoteHookCtx>('validate-github-remote-hook', [
  gateHookActive,
  gateWebhookUrlMatch,
  gateContentType,
  gateRequiredEvents,
  gateValid,
]);
```

- `gateHookActive`: if `!hook.active`, set `invalid` reason.
- `gateWebhookUrlMatch`: if `watched.webhookUrl` is set and does not match
  `hook.config.url`, set `invalid` reason.
- `gateContentType`: if `hook.config.content_type !== 'json'`, set `invalid` reason.
- `gateRequiredEvents`: if `missingRequiredEvents(hook).length > 0`, set `invalid`
  reason.
- `gateValid`: always sets `decision = { action: 'valid' }`.

`missingRequiredEvents` and `isOnlyMissingEvents` remain pure helpers.

#### Shell/effect wiring

```ts
function validateRemoteHook(watched: GitHubWatchedRepo, hook: GitHubHookResponse): string | null {
  const result = validateRemoteHookRun({ watched, hook, decision: null }).decision;
  if (!result || result.action === 'valid') return null;
  return result.reason;
}
```

#### Step-by-step migration

1. Export each gate function.
2. Replace the imperative `if` chain with the `decisionRun`.
3. Verify `checkWebhook`, `reconcileWebhookEvents`, and `reconcileSharedHook`
   still receive the same `string | null` error values.

#### Tests

- There is currently no dedicated unit test for `validateRemoteHook`. Add
  `tests/unit/2-handlers/github/validate-remote-hook.test.ts` covering:
  - `hook.active === false`
  - URL mismatch
  - content type not `json`
  - missing required events
  - wildcard `events: ['*']`
  - valid hook
- Add an integration test in `github-event-extension.test.ts` that asserts the
  `webhookLastError` string for each failure mode.

#### Risks/caveats

- **Private function**: the gates can be exported for testing, but
  `validateRemoteHook` itself should remain private to the module. Export the
  `decisionRun` runner only inside the module or via a named helper for tests.
- **Error message stability**: `checkWebhook` and `reconcileSharedHook` store
  `error` in `webhookLastError`. Preserve messages.
- **`isOnlyMissingEvents`**: this helper is used independently of
  `validateRemoteHook` and should not be altered by the migration.

---

## Suggested migration order

1. `event-tiers.ts:classifyExternalEventDirectSteer` — small, well-tested, and
   has a direct consumer in `external-event-steer-admission-pipeline.ts` that
   already follows the desired pattern.
2. `deferred-event-digest.ts:renderDigestGroup` — isolated private function;
   unblock `buildExternalEventDigestMessage`.
3. `deferred-event-digest.ts:buildExternalEventDigestMessage` — high value,
   self-contained, and its consumer (`task-agent-manager.ts`) is already
   superpipe-heavy.
4. `deferred-event-digest.ts:parseDeferredExternalEventText` — closely related
   to (2) and (3); do them together in one digest pass.
5. `event-essence.ts:formatExternalEventEssence` — closely related to (2)-(4)
   and easy to pin with round-trip tests.
6. `github-subscription-pattern.ts:composeGitHubSubscriptionPattern` —
   independent, good first external-event "validation" `decisionRun`.
7. `github/github-event-extension.ts:validateRemoteHook` — independent from
   normalizers but part of the same validation surface.
8. `github/github-normalizer.ts` normalizer family — largest and most
   caller-heavy; do it last after the patterns are established.

## Open questions

1. **Optional stage prefix `?dep` in raw superpipe**: The ADR mentions `?dep`
   for skipping optional stages, but the repo currently does not use it in a raw
   superpipe. Should the normalizer/essence pipelines rely on `?dep` for
   event-type branches, or is it safer to have each stage inspect `ctx.eventType`
   internally and return `ctx` unchanged when not applicable?

2. **Normalizer dispatch granularity**: Should `normalizeGitHubWebhook` and
   `normalizeGitHubPollingRow` be single `decisionRun` dispatchers that call
   per-kind raw transforms, or should the entire pipeline (dispatch + kind
   processing) be a single raw superpipe with a `decide` stage? The former keeps
   signatures stable; the latter is more unified but may require `stagedRun`
   semantics.

3. **`classifyExternalEventDirectSteer` hot path**: The function is called once
   per essence. Should we benchmark the `decisionRun` overhead against the
   current `if/else` before finalizing, and if the overhead is measurable, keep
   a compact direct implementation inside `partitionDirectSteerEssences`?

4. **Error vs decision for `composeGitHubSubscriptionPattern` and
   `validateRemoteHook`**: These currently throw/return error strings. The plan
   wraps a `decisionRun` and preserves the old contract. Is there a longer-term
   desire to expose the decision shape (e.g., `{ ok } | { error }`) to callers,
   or should the throw/return contract remain forever?

5. **Testing private `validateRemoteHook`**: `validateRemoteHook` is a module
   private. Should the migration export a `decideValidateRemoteHook` runner for
   testing, or test it through `checkWebhook`/`reconcileSharedHook` integration
   only?

6. **`toExternalEvent` UUID**: The function is non-deterministic because of
   `crypto.randomUUID()`. Should the pipeline accept an optional `id` input so
   tests can avoid mocking `crypto`, or should `randomUUID` remain an internal
   stage effect?
