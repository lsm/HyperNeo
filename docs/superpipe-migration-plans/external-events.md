# External events migration plan

This plan describes how to migrate the hand-rolled external-event ingestion and
digestion paths in `packages/daemon/src/lib/external-events` to direct superpipe
compositions, per ADR 0004 (`docs/adr/0004-superpipe-pipelines.md`).

The target is **planning only**: no source code is changed by this document.

## Scope and combinator fit

| Site | Proposed combinator | Rationale |
| --- | --- | --- |
| `github/github-normalizer.ts` normalizer family | One raw superpipe ingest pipeline for the webhook business path (`ingest-github-webhook`) with inline self-guarding dispatch stages; `normalizeGitHubPollingRow` stays a plain function | Dispatch and per-kind processing are stages of the single webhook pipeline; projection (`project-external-event`) stays a separate per-space transform at the publish boundary. The polling-row normalizer runs once per endpoint row (pages up to 100 — `github-event-extension.ts:2491-2499`), so a per-row pipeline invocation is the hot-inner-loop pattern ADR 0004 Decision 8 excludes. |
| `event-essence.ts:formatExternalEventEssence` | Raw superpipe transform | Pure event-object to JSON-string formatting. Conditional field copies become guarded pipeline stages. |
| `deferred-event-digest.ts:buildExternalEventDigestMessage` | Raw superpipe transform | Pure list-of-essences to digest string. Sort, group, render, header/footer are discrete stages. |
| `deferred-event-digest.ts:renderDigestGroup` | Ordinary pure helper (kind switch) called as a stage of the digest pipeline — review correction: not a separately-run `decisionRun` | One composition boundary per business path; the kind switch stays a private helper (or direct stages) inside `build-external-event-digest-message`. |
| `deferred-event-digest.ts:parseDeferredExternalEventText` | None — stays a plain function (review correction PR #2979: it runs once per row inside the `partitionDeferredExternalEventRows`/`planDeferredExternalEventOverflow` loops; per-row pipeline invocation is the hot-inner-loop pattern ADR 0004 excludes) | Precedence (JSON event → JSON digest → rate-limit forms → `null`) pinned by decision-table tests instead. |
| `event-tiers.ts:classifyExternalEventDirectSteer` | Ordinary pure helper (review correction: called once per essence from `partitionDirectSteerEssences`, already a stage of `external-event-steer-admission` — converting to `decisionRun` adds a nested runner invocation per buffered event) | A short precedence chain over topic suffixes/state/conclusion/actor. First match wins; fall-through returns `null`. |
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

- Review correction: `normalizeGitHubWebhook` becomes ONE raw superpipe ingest
  pipeline (`ingest-github-webhook`); dispatch and per-kind processing are
  STAGES of that pipeline (dispatch stage selects the kind; the per-kind stage
  template follows), NOT separately-run `decisionRun` dispatchers plus
  per-kind pipelines.
- Review correction: `normalizeGitHubPollingRow` STAYS A PLAIN FUNCTION — it
  runs once per endpoint row inside the polling loops
  (`github-event-extension.ts:2491-2499`, pages up to 100 rows), so a pipeline
  invocation per row is exactly the hot-inner-loop pattern ADR 0004 Decision 8
  excludes; keeping it synchronous does not avoid that overhead. Its
  endpoint-keyed dispatch is pinned by decision-table tests instead. If a
  pipeline is ever wanted here, compose ONE pipeline around the batch polling
  operation, never per row.
- The per-kind stage template is the boxed-outcome transform described below
  (`(params) => NormalizedGitHubEvent | null` at the export boundary).
- `toExternalEvent` becomes its own **raw superpipe transform**
  (`project-external-event`), called per space at the publish boundary.
- `mapEventType` stays a lookup-table helper inside `toExternalEvent`.

#### Input/output snapshot design

Unified ingest context (review correction: the dispatch selection and the
boxed outcome live on ONE context — a separate `decision` union would not
type-check against the inline per-kind stages, which read top-level
`ctx.kind`/`ctx.input`/`ctx.outcome`, nor against the shell, which seeds
`outcome`):

```ts
type NormalizedOutcome =
  | { status: 'running' }
  | { status: 'rejected' }
  | { status: 'done'; value: NormalizedGitHubEvent };

interface GitHubWebhookDispatchCtx {
  eventType: string;
  deliveryId: string;
  payload: unknown;
  base: WebhookBase | null; // shared repo/sender/deliveryId/rawPayload after a snapshot stage
  kind: GitHubEventKind | null;
  input: unknown;
  outcome: NormalizedOutcome;
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

Per-kind transform context: the SAME unified context — after the dispatch
stage sets `kind`/`input`, each per-kind stage group treats it as
`{ input: TInput; outcome: NormalizedOutcome }` (with `TInput` narrowed per
kind); no second context type exists.

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
  now: () => number;
  newId: () => string;
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

2. **`normalizeGitHubWebhook` dispatch stages** (review correction — NOT a
   separately-run `decisionRun` with its own decision context; that would
   retain the second composition boundary): self-guarding dispatch stages run
   INLINE as the head of `ingest-github-webhook`, each setting `kind`/`input`
   on the shared ctx when it matches and no-op-ing once `kind` is set (first
   match wins):

   - `stageCheckRun`
   - `stageCheckSuite`
   - `stageBranchProtectionRule`
   - `stageMergeGroup`
   - `stageIssueComment` (guard that the issue is a PR)
   - `stagePullRequestReview`
   - `stagePullRequestReviewComment`
   - `stagePullRequestReviewThread`
   - `stagePullRequest`
   - `stageIgnoreUnknown` (leaves `kind` unset — the shell returns `null`)

   The pipeline also runs an initial `snapshotBase` stage that extracts
   `WebhookBase` so per-kind stages do not re-parse repo/sender.

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

4. **`normalizeGitHubPollingRow`** — stays a plain function (review
   correction: it runs once per endpoint row in the polling loops at
   `github-event-extension.ts:2491-2499` with pages up to 100 rows; a per-row
   pipeline invocation is the hot-inner-loop pattern ADR 0004 Decision 8
   excludes). Its endpoint-keyed dispatch (`issue_comments`,
   `review_comments`, `pulls`) is pinned by decision-table tests; if a pipeline
   is ever wanted here, compose ONE around the batch polling operation, never
   per row.

5. **`toExternalEvent` stays a separate per-space projection pipeline at the
   publish boundary** (review correction: for a webhook watched by multiple
   spaces, normalization runs ONCE before the loop over matching
   repositories, while `toExternalEvent(spaceId, normalized)` runs separately
   inside `publishEvent` for EACH space — the ingest pipeline has no
   `spaceId`, so appending `assembleExternalEvent` to it either cannot
   construct the event or constructs one event reused with the wrong space
   scope/UUID across all targets). The webhook ingest pipeline
   (`ingest-github-webhook`) ends at `NormalizedGitHubEvent`; the projection
   stages form their own small raw transform (`project-external-event`)
   covering:
   - `canonicalizeRepo`
   - `selectTopicParts` (uses `mapEventType`)
   - `buildPayload` (spreads `event.payload` into the record)
   - `assembleExternalEvent` (reads the id from the ctx's injected `newId` and
     `ingestedAt` from the ctx's injected `now` in the final stage — one fresh
     id per space, one ingestion timestamp; the exported shell wires the real
     `crypto.randomUUID`/`Date.now`, tests inject fakes — review correction:
     without these seams the projection's two nondeterminisms cannot be
     pinned)

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
    kind: null,
    input: null,
    outcome: { status: 'running' },
  });
  return outcome.status === 'done' ? outcome.value : null;
}

export function toExternalEvent(
  spaceId: string,
  event: NormalizedGitHubEvent
): ExternalEvent {
  return runToExternalEvent({
    spaceId,
    event,
    now: Date.now,
    newId: () => crypto.randomUUID(),
    result: null,
  }).result!;
}
```

Dispatch and per-kind transforms are stages of the single
`ingest-github-webhook` pipeline (dispatch stage selects the kind; the shared
per-kind stage template follows; the pipeline ENDS at `NormalizedGitHubEvent`
— review correction: projection stages never append to the ingest pipeline,
not even for the extension's publish path, because `handleWebhook` normalizes
once before iterating `validForRepo` while `publishEvent` runs the distinct
per-space `project-external-event` transform inside each iteration; an
appended projection either lacks a `spaceId` or reuses one scoped event/UUID
across every watched space). The `id` generation (`crypto.randomUUID()`)
and the `ingestedAt` timestamp (`Date.now()` — persisted and consumed
downstream) are the projection's non-determinism (review correction PR
#2979: NOT just the UUID); BOTH live in the projection's final assembly
stage and must never be replaced by `occurredAt`.
The normalizer family has no DB/network writes.

#### Step-by-step migration

1. Add parity/characterization tests for the existing normalizers if coverage
   gaps exist (especially `deployment_status`, `branch_protection_rule`,
   `merge_group`, `reaction`, `merge_conflict`). Include explicit rejection
   rows (e.g. `check_run` with `action !== 'completed'` must return `null`)
   so the boxed-outcome halt is pinned.
2. Extract the `WebhookBase` snapshot helper and unit-test it.
3. Convert `normalizeGitHubWebhook` to the single `ingest-github-webhook`
   pipeline: dispatch decision stage first, then convert one per-kind
   transform block at a time into inline stages, keeping the old export as a
   thin wrapper over the pipeline.
4. Leave `normalizeGitHubPollingRow` a plain function (review correction: it
   is invoked once per endpoint row at `github-event-extension.ts:2491-2499`,
   pages up to 100 rows — a per-row pipeline invocation is the hot-inner-loop
   pattern ADR 0004 Decision 8 excludes; pin its endpoint dispatch with
   decision-table rows instead).
5. Convert `toExternalEvent` to its own `project-external-event` transform
   and keep the `publishEvent` per-space call site unchanged (projection
   stays at the publish boundary; it never joins the normalize-once ingest
   pipeline).
6. Review correction (supersedes the former consumer-rewiring cleanup slices):
   NO consumer-rewiring phase exists. The wiring slice swaps only
   `normalizeGitHubWebhook`'s body for the pipeline shell, and the extension's
   raw call site (`github-event-extension.ts:716`) already calls that export,
   so it picks the pipeline up unchanged. The per-kind webhook exports stay
   callable as thin wrappers over their stage groups. The enriched consumers
   — `normalizeGitHubDeployment`/`normalizeGitHubDeploymentStatus`
   (`github-event-extension.ts:825-834`), `normalizeGitHubStatus` (~line 925),
   and the check-run (~line 2713), merge-conflict (~line 2855), review
   (~line 2978), and reaction (~line 3098) calls from the polling loops —
   supply derived inputs the raw runner never sees; they keep the per-kind
   exports with their CURRENT signatures and plain bodies. The old
   `normalizeGitHubWebhook` body is replaced by the shell in the wiring slice
   itself and the per-kind bodies are consumed as they are inlined, so no
   legacy-body deletion slice remains either.
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

Raw superpipe transform. The event-type branch is an ORDINARY PURE HELPER
(`decideFieldSet`) or guarded `copyXFields` stages — review correction round
20: never a `decisionRun`; it is an internal stage of this formatting
operation.

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
  .pipe(decideFieldSet, 'ctx', 'ctx') // ordinary pure helper
  .pipe(copyCommonFields, 'ctx', 'ctx')
  .pipe(copyEventTypeFields, 'ctx', 'ctx')
  .pipe(omitUndefinedAndStringify, 'ctx', 'ctx')
  .end('ctx');
```

- `buildBaseEssence` extracts `type: 'external_event'` (review correction:
  the type discriminator is MANDATORY — `parseDeferredExternalEventText`
  rejects any record whose `type !== 'external_event'`, so omitting it makes
  every formatted envelope unparseable and silently breaks deferred folding,
  cap enforcement, and direct-steer buffering), plus `eventId`, `topic`,
  `eventType`, `action`, `actor`, `repo`, `prNumber`, `prUrl`, `externalUrl`,
  `occurredAt`, `body`. Pin it in the round-trip test.
- `decideFieldSet` is an ORDINARY PURE HELPER returning the list of extra
  keys to copy for the current `eventType` (review correction: not an
  embedded `decisionRun` — field selection is only an internal stage of
  this formatting operation; do not invoke another runner from the stage).
- `copyEventTypeFields` applies that list and any topic-suffix special cases
  (`check_failed`, `suite_failed`).
- `omitUndefinedAndStringify` runs `omitUndefinedExternalEventFields` and
  `JSON.stringify(..., null, 2)`.

#### Shell/effect wiring

```ts
export function formatExternalEventEssence(event: ExternalEventPublishedPayload): string {
  return runFormatEssence({
    event,
    payload: event.payload ?? {},
    essence: {},
    result: null,
  }).result!;
}
```

Review correction (PR #2979): the run MUST be seeded with `event.payload` —
the current function derives every essence field from it
(`event-essence.ts:4-18`: eventType, action, repoOwner, repoName, actor,
prNumber, prUrl, and the per-kind fields). Seeding `{}` (or omitting a payload
snapshot stage before the copy stages) would silently drop review handles,
check conclusions, deployment state, and all payload-derived detail.

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

Raw superpipe transform. The kind switch stays an ordinary pure helper
(`renderDigestGroup`) called from the `renderGroups` stage — review
correction: NOT a separate `decisionRun`; that would recreate a second
composition boundary inside this business path.

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
  .pipe(renderGroups, 'ctx', 'ctx')    // renders groups via the pure kind-switch helper
  .pipe(assembleMessage, 'ctx', 'ctx')
  .end('ctx');
```

- `guardEmpty`: set `result = ''` if `events.length === 0`.
- `sortEvents`: stable sort by `orderTime` with index tie-break.
- `decideIncludeDate`: true when more than one UTC date is present.
- `groupEvents`: `digestGroupKind` + `digestGroupKey`, collect into a `Map`.
- `renderGroups`: iterate `DIGEST_GROUP_ORDER`, render each matching group
  via the kind switch — kept as an ORDINARY PURE HELPER or direct stages,
  not a separately-run `renderDigestGroup` `decisionRun` (review correction:
  that would recreate a second composition boundary for a private helper
  inside the one `build-external-event-digest-message` business path) — and
  append to `lines`.
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

1. Keep `renderDigestGroup` as a private pure helper (review correction: it
   is private with no other callers — converting it to a separately-run
   `decisionRun` would add a second composition boundary inside this one
   business path).
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

Ordinary pure helper with a `switch (group.kind)` (review correction — not
a separately-run `decisionRun`: this is a private helper inside the one
`build-external-event-digest-message` business path; a second composition
boundary is exactly what the one-pipeline-per-business-path rule removes).
Each kind is a case returning the rendered string; `other` is the
catch-all.

#### Input/output snapshot design

```ts
interface RenderOpts {
  includeDate: boolean;
  snippetMaxChars: number;
  renderAllReviewBodies: boolean;
}
```

#### Pure core design

```ts
function renderDigestGroup(group: DigestGroup, opts: RenderOpts): string {
  switch (group.kind) {
    case 'check': return renderCheck(group, opts);
    case 'review': return renderReview(group, opts);
    case 'pr_comment': return renderPrComment(group, opts);
    case 'state': return renderState(group, opts);
    case 'reaction': return renderReaction(group, opts);
    default: return renderOther(group, opts);
  }
}
```

#### Shell/effect wiring

`renderGroups` inside `buildExternalEventDigestMessage` calls
`renderDigestGroup(group, opts)` directly — no runner, no wrapper (review
correction: the previous steps directing implementers to create
`RenderDigestGroupCtx`, assemble a separate `decisionRun`, and invoke its
runner from `buildExternalEventDigestMessage` recreated the nested
composition boundary the proposed-combinator section rejects).

#### Step-by-step migration

1. Move each `case` body into an exported `buildXGroupLine` pure helper.
2. Keep `renderDigestGroup` as the private exhaustive `switch` over
   `group.kind` calling those helpers; the enclosing
   `build-external-event-digest-message` pipeline calls it from its
   `renderGroups` stage.

#### Tests

- `tests/unit/4-space-storage/storage/deferred-event-digest.test.ts` — add a
  `describe('renderDigestGroup')` block covering each `DigestGroupKind` and the
  `renderAllReviewBodies`/`snippetMaxChars` options.
- Test that every `DigestGroupKind` renders via the helper (exhaustive
  switch; `other` catch-all).

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

None (review correction PR #2979). `parseDeferredExternalEventText` runs once
per deferred row inside `parseDeferredDeliveryRow`, which the partition and
overflow-planning loops call per row — a pipeline invocation per row is
exactly the hot-inner-loop pattern the ADR excludes, and making the parser
synchronous does not avoid that overhead. Keep it a plain function; pin its
precedence with decision-table tests. If a pipeline is ever wanted here,
compose ONE pipeline around the batch operation, never per row.

#### Pure core design — the plain function's ordered attempts

- `tryJsonParse`: sets `json` or `jsonError`.
- `populateRecord` (review correction): converts an object-valued `json`
  into `record` (`json !== null && typeof json === 'object' ? json : null`);
  without this stage the envelope guards always see `record === null` and
  valid `external_event`/`external_event_digest` payloads fall through to
  the rate-limit text parser and return `null`.
- `guardExternalEventJson`: if `record.type === 'external_event'`, call
  `parseEssenceEntry` and set `entry`.
- `guardDigestJson`: if `record.type === 'external_event_digest'`, validate the
  events array, set `entry` with `droppedCount`.
- `tryRateLimitText`: run `parseRateLimitDigestText` and, if it matches, set
  `entry`.

`parseEssenceEntry`, `parseRateLimitDigestText`, `parseRateLimitIdEntries`, and
`scopeFromTopic` remain private pure helpers.

#### Shell/effect wiring

None — the plain function keeps its current body and callers
(`parseDeferredDeliveryRow` calls
`parseDeferredExternalEventText(rowText(row))` unchanged). The ordered
attempts above may be extracted as private helper functions inside the module
for unit clarity, but no pipeline is created and no wrapper changes.

#### Step-by-step migration

1. Pin the precedence decision table (see Tests) — no production change.
2. Optionally extract the five attempts as private named helpers inside the
   plain function's module (behavior-identical, unit-tested directly).

#### Tests

- `tests/unit/4-space-storage/storage/deferred-event-digest.test.ts` — already
  covers JSON event, JSON digest, rate-limit annotated/legacy/structured forms.
  Add decision-table rows:
  - invalid JSON enters the rate-limit attempt.
  - `record.type === 'external_event'` never reaches the rate-limit attempt.
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

Ordinary pure helper (review correction): one ordered branch per class with
a fall-through to `null`. It is invoked once per essence from
`partitionDirectSteerEssences`, which is itself a stage of
`external-event-steer-admission`; making this a `decisionRun` would split
the admission operation across pipeline boundaries with a nested runner
invocation per buffered event.

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

export function classifyExternalEventDirectSteer(
  input: DirectSteerClassificationInput
): DirectSteerEventClass | null {
  if (suffix === 'review_submitted' && (state === 'APPROVED' || state === 'CHANGES_REQUESTED')) return 'review';
  if (suffix === 'review_comment_polled' && actorIsBot) return 'review';
  if (suffix === 'check_failed' && !isNonFailureConclusion(conclusion)) return 'check';
  if (suffix === 'merge_conflict') return 'merge_conflict';
  return null;
}
```

- Branch order mirrors the current precedence: `review_submitted` →
  `review_comment_polled` → `check_failed` → `merge_conflict` → `null`. (Plain
  ordered classifier — review correction: no `classifyDirectSteerRun`
  `decisionRun`; classification runs per essence inside
  `external-event-steer-admission`, so a runner would nest per buffered
  event.)

#### Shell/effect wiring

None: the export keeps its exact signature; `partitionDirectSteerEssences`
continues calling it as a plain function.

#### Step-by-step migration

1. Replace the hand-rolled body with the ordered classifier above (behavior
   identical); no runner, no wrapper changes.

#### Tests

- `tests/unit/5-space/runtime/task-agent-manager-direct-steer.test.ts` already
  has a `classifyExternalEventDirectSteer` block. Keep it as parity.
- Add precedence rows (first matching branch wins, fall-through returns
  `null`).

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

## Focused PR breakdown

The slices below decompose this plan into a sequence of small, focused,
independently shippable PRs that a future implementer can open directly.
Two-tier review budget per slice: production Δ ≲100 lines (hard cap ~150 only
for types-dominated additive cores) and test Δ ≲350, counted SEPARATELY from
production code — if a slice would exceed either tier, split it further before
opening it; never grow a PR past budget mid-review. Pin slices split by
dimension family, never by truncating a family's rows.

Phase convention (stated on the first line of each slice): 📌 pins — prod
Δ = 0; characterization/decision-table tests of CURRENT behavior. ➕ additive
core — pure module/pipeline landed UNWIRED from production. 🔧 apply — wire
call sites; ONE arm/route/site per slice.
Tiny slices may combine 📌+🔧. Every slice leaves the repo compiling with
tests green when it lands, keeps its diff surgical (no drive-by import-block
or formatting churn in files it touches), and folds in no unrelated fixes.
Slice ordering follows the "Suggested migration order" phases above: pins land
before extraction and plain helpers before the pipelines that consume them.
Per-kind normalizer exports stay callable throughout — the webhook ones as
thin wrappers over their stage groups, the enriched/polling ones unchanged —
and no cleanup slice rewires consumers (the wiring slice swaps only the raw
dispatch export's body). Parallel-safe leaves are noted explicitly and may
proceed concurrently.

Every site in "Per-site detailed plans" is covered:

- `event-tiers.ts:classifyExternalEventDirectSteer` — PR 1
- `deferred-event-digest.ts:renderDigestGroup` — PR 2
- `deferred-event-digest.ts:buildExternalEventDigestMessage` — PRs 3-4
- `deferred-event-digest.ts:parseDeferredExternalEventText` — PR 5
- `event-essence.ts:formatExternalEventEssence` — PRs 6-8
- `github-subscription-pattern.ts:composeGitHubSubscriptionPattern` — PR 9
- `github/github-event-extension.ts:validateRemoteHook` — PRs 10-11
- `github/github-normalizer.ts` normalizer family — PRs 12-22

### PR 1 — `test(external-events): pin direct-steer classification precedence`

📌 pins — prod Δ = 0, test Δ ≲120 (review correction PR #2979: the current
`classifyExternalEventDirectSteer` is ALREADY the exact ordered plain helper
this slice used to prescribe — suffix computed once, then `review_submitted`
→ `review_comment_polled` → `check_failed` → `merge_conflict` → `null` — so
there is NO production refactor to land; manufacturing a behavior-identical
rewrite is forbidden)

- **Scope**:
  `packages/daemon/tests/unit/5-space/runtime/task-agent-manager-direct-steer.test.ts`
  only — pin the precedence table (first matching branch wins; fall-through
  returns `null`) of the EXISTING helper. `event-tiers.ts` is untouched.
- **Lands**: classification precedence is pinned as a plain leaf helper of
  `external-event-steer-admission` — no `decisionRun`, no nested runner
  invocation per buffered event, no source change.
- **Excludes**: any edit to
  `packages/daemon/src/lib/space/runtime/external-event-steer-admission-pipeline.ts`;
  the batch/benchmark contingency from the site's risks.
- **Tests**: the precedence table above.
- **Depends on**: none. Parallel-safe leaf.

---

### PR 2 — `refactor(external-events): extract digest group renderers as pure helpers`

📌 pins + 🔧 apply — prod Δ ≲120 (move-only churn), test Δ ≲300

- **Scope**: `packages/daemon/src/lib/external-events/deferred-event-digest.ts`
  — move each `switch (group.kind)` case body of `renderDigestGroup` into an
  exported `buildXGroupLine` pure helper (`check`, `review`, `pr_comment`,
  `state`, `reaction`, `other`); `renderDigestGroup` stays the private
  exhaustive switch calling those helpers; `digestGroupKind`, `digestGroupKey`,
  `digestTimestamp`, `digestSnippet`, `digestLinkSuffix`, `digestDetailSuffix`,
  `digestActionLabel`, `digestStateMarkers`, and `essenceScopeLabel` remain
  pure helpers.
- **Lands**: behavior-identical helper extraction; the kind switch is a plain
  leaf ready to be called from the `renderGroups` stage in PR 3.
- **Excludes**: the `build-external-event-digest-message` pipeline and
  `BuildDigestMessageCtx` (PR 3); `parseDeferredExternalEventText` (PR 5).
- **Tests**:
  `packages/daemon/tests/unit/4-space-storage/storage/deferred-event-digest.test.ts`
  — add a `describe('renderDigestGroup')` block covering every
  `DigestGroupKind` plus `renderAllReviewBodies`/`snippetMaxChars`.
- **Depends on**: none. Parallel-safe outside the digest file.

---

### PR 3 — `refactor(external-events): add digest-message superpipe core unwired`

➕ additive core — prod Δ ≲150 (types-dominated), test Δ ≲350

- **Scope**: `packages/daemon/src/lib/external-events/deferred-event-digest.ts`
  — add `BuildDigestMessageCtx`, the `isDone` helper, and the
  `build-external-event-digest-message` raw transform: `guardEmpty` (sets
  `result = ''`, halts via `!isDone`), `computeOptions`, `sortEvents` (stable,
  `orderTime` with index tie-break), `decideIncludeDate`, `groupEvents`
  (`digestGroupKind`/`digestGroupKey` into a `Map`), `renderGroups` (iterates
  `DIGEST_GROUP_ORDER`, calls the PR-2 `renderDigestGroup` helper directly —
  no nested runner), `assembleMessage` (header + lines + footer). The export
  still runs its old body; the pipeline is UNWIRED.
- **Lands**: the digest pipeline exists with stage-level tests; production
  behavior unchanged.
- **Excludes**: wiring `buildExternalEventDigestMessage` (PR 4); envelope text
  or line-break format changes.
- **Tests**:
  `packages/daemon/tests/unit/4-space-storage/storage/deferred-event-digest.test.ts`
  — stage tests: empty input returns `''` before sort/group; multi-date input
  sets `includeDate = true`; groups render in `DIGEST_GROUP_ORDER`;
  `renderAllReviewBodies` propagates into `renderDigestGroup`; stable-sort
  tie-break.
- **Depends on**: PR 2.

---

### PR 4 — `refactor(external-events): route digest message through the pipeline`

🔧 apply — prod Δ ≲20, test Δ ≲0 (PR 2-3 pins stay green)

- **Scope**: same file — the body of `buildExternalEventDigestMessage` becomes
  the shell that seeds the ctx and unwraps `result!`.
- **Lands**: digest building runs as one raw superpipe transform for this
  business path; the parity suite is green unchanged.
- **Excludes**: `parseDeferredExternalEventText` (PR 5-6); further changes to
  the `buildXGroupLine` helpers.
- **Tests**: `deferred-event-digest.test.ts` parity suite, unchanged.
- **Depends on**: PR 3.

---

### PR 5 — `test(external-events): pin deferred-text parse precedence`

📌 pins — prod Δ = 0, test Δ ≲200

- **Scope**:
  `packages/daemon/tests/unit/4-space-storage/storage/deferred-event-digest.test.ts`
  only. Pin the CURRENT precedence of the PLAIN function (JSON event → JSON
  digest → rate-limit annotated/legacy/structured → `null`) plus the
  malformed-`external_event_digest`-with-empty-events row. Review correction
  (PR #2979): `parseDeferredExternalEventText` STAYS a plain function — it
  runs once per row inside the partition/overflow loops, and a per-row
  pipeline invocation is the hot-inner-loop pattern ADR 0004 excludes; there
  is deliberately no parse pipeline to add or wire (the former PR 5/PR 6 pair
  is replaced by this pins-only slice).
- **Lands**: the parser's precedence contract is pinned before any later
  digest work touches its neighbors.
- **Excludes**: any production change; restructuring
  `RATE_LIMIT_DIGEST_PATTERN`; essence formatting (next PRs).
- **Tests**: the decision table above.
- **Depends on**: PR 4 (same-file sequencing within the digest pass).

---

### PR 6 — `test(external-events): pin essence formatting per eventType and topic suffix`

📌 pins — prod Δ = 0, test Δ ≲350

- **Scope**: expand
  `packages/daemon/tests/unit/2-handlers/github/external-event-essence-contract.test.ts`
  into a decision table of the CURRENT formatted output: every `eventType`
  branch's field set, the mandatory `type: 'external_event'` discriminator and
  base fields, the `.check_failed`/`.suite_failed` topic-suffix overrides
  (reading `event.topic`), and round trips through
  `parseDeferredExternalEventText`.
- **Lands**: current essence output is fully pinned before any extraction.
- **Excludes**: any production change.
- **Tests**: the contract test file only.
- **Depends on**: PR 5 (parse precedence pinned first so round-trip rows are
  stable; review correction PR #2979 — the previous PR 6 self-reference was
  unschedulable). Parallel-safe with everything outside `event-essence.ts`.
- **Size guard**: if the table would exceed test Δ ≲350, split by dimension
  family (eventType field-selection table vs topic-suffix + round-trip) before
  opening — never truncate rows.

---

### PR 7 — `refactor(external-events): add essence formatting pipeline unwired`

➕ additive core — prod Δ ≲150 (types-dominated), test Δ ≲350

- **Scope**: `packages/daemon/src/lib/external-events/event-essence.ts` — add
  `FormatExternalEventEssenceCtx` and the `format-external-event-essence`
  transform: `buildBaseEssence` (the mandatory `type: 'external_event'`
  discriminator plus `eventId`, `topic`, `eventType`, `action`, `actor`,
  `repo`, `prNumber`, `prUrl`, `externalUrl`, `occurredAt`, `body`),
  `decideFieldSet` (ordinary pure helper — never a `decisionRun`),
  `copyCommonFields`, `copyEventTypeFields` (also reads `event.topic` for the
  `.check_failed`/`.suite_failed` suffixes), `omitUndefinedAndStringify`
  (`omitUndefinedExternalEventFields` + `JSON.stringify(..., null, 2)`).
  UNWIRED: the export keeps its old body.
- **Lands**: the formatting pipeline exists with per-stage tests; production
  behavior unchanged.
- **Excludes**: wiring (PR 8); key renames or `undefined`-omission changes
  that would break the round trip.
- **Tests**: add
  `packages/daemon/tests/unit/1-core/external-events/event-essence-pipeline.test.ts`
  with per-stage tests for `buildBaseEssence`, `decideFieldSet`, and
  `omitUndefinedAndStringify`.
- **Depends on**: PR 6.

---

### PR 8 — `refactor(external-events): route essence formatting through the pipeline`

🔧 apply — prod Δ ≲15, test Δ ≲0 (PR 6 pins stay green)

- **Scope**: same file — the body of `formatExternalEventEssence` becomes the
  shell unwrapping `result!`; callers in `space-runtime.ts` and
  `task-agent-manager.ts` are untouched.
- **Lands**: essence formatting runs as one synchronous transform; the
  contract pins are green unchanged.
- **Excludes**: any edit under `packages/daemon/src/lib/space/`.
- **Tests**: the expanded contract test, unchanged.
- **Depends on**: PR 7.

---

### PR 9 — `refactor(external-events): compose subscription pattern via decisionRun`

🔧 apply — prod Δ ≲110, test Δ ≲150 (the existing exhaustive suite is the pin)

- **Scope**:
  `packages/daemon/src/lib/external-events/github-subscription-pattern.ts` —
  replace the body of `composeGitHubSubscriptionPattern` with the
  `compose-github-subscription-pattern` `decisionRun`:
  `gateSlashSeparatedAction`, `guardTooManySegments`, `guardFullyQualified`,
  `guardOwnerRepoResourceAction`, `guardSourcePrefixedThreeSegments`,
  `guardOwnerRepoThreeSegments`, `guardTwoSegments`, `guardOneSegment`, and
  the always-`ok` `buildFallbackPattern` (catch-all `github/*/*/${topic}`);
  the shell keeps the throw-on-error contract with identical messages;
  `splitDottedGitHubResource`, `isGitHubEventResource`,
  `thirdIsOwnerRepoResourceShape`, `ensureGitHubEntityAction`, and
  `ensureGitHubEventResource` stay pure helpers. Single-function rewire — no
  separate additive slice needed.
- **Lands**: every invalid shape becomes an `invalid` decision that halts the
  run; `long-horizon-subscription-pattern.ts` keeps catching the same thrown
  errors.
- **Excludes**: exposing a decision-shaped result to callers (open question 4
  stays open); edits to `long-horizon-subscription-pattern.ts`.
- **Tests**:
  `packages/daemon/tests/unit/5-space/runtime/github-subscription-pattern.test.ts`
  — keep as parity; add "first invalid gate halts" rows, a fallback-pattern
  test, and stage-level tests for `guardFullyQualified` and the repo-resource
  special cases (including an owner literally named `repo`).
- **Depends on**: none. Parallel-safe leaf.

---

### PR 10 — `test(external-events): pin remote-hook validation failure modes`

📌 pins — prod Δ = 0, test Δ ≲350

- **Scope**: add
  `packages/daemon/tests/unit/2-handlers/github/validate-remote-hook.test.ts`
  characterizing the CURRENT behavior of the private `validateRemoteHook`
  through its callers: `hook.active === false`, URL mismatch, content type not
  `json`, missing required events, wildcard `events: ['*']`, and the valid
  case; add `webhookLastError` string assertions per failure mode in
  `github-event-extension.test.ts`.
- **Lands**: the validation contract (including exact error strings) is pinned
  before the rewrite.
- **Excludes**: any production change.
- **Depends on**: none. Parallel-safe leaf.
- **Size guard**: if both files exceed test Δ ≲350 together, keep the unit
  characterization file in this slice and move the `webhookLastError`
  integration rows into PR 11 rather than truncating either.

---

### PR 11 — `refactor(external-events): validate remote hook via decisionRun`

🔧 apply — prod Δ ≲110, test Δ ≲0 (PR 10 pins stay green)

- **Scope**:
  `packages/daemon/src/lib/external-events/github/github-event-extension.ts` —
  convert the private `validateRemoteHook` to the
  `validate-github-remote-hook` `decisionRun` with `gateHookActive`,
  `gateWebhookUrlMatch`, `gateContentType`, `gateRequiredEvents`, and
  `gateValid`; `missingRequiredEvents` and `isOnlyMissingEvents` remain pure
  helpers (`isOnlyMissingEvents` unaltered); the shell preserves the
  `string | null` contract used by `checkWebhook` (~lines 1874/1908) and
  `reconcileSharedHook` (~line 2056); gates are exported for tests while
  `validateRemoteHook` stays module-private. Single-function rewire.
- **Lands**: hook validation is a precedence-ordered gate chain; stored
  `webhookLastError` strings are preserved.
- **Excludes**: normalizer work in the same file (PR 12-25); any
  decision-shape contract change.
- **Tests**: the PR 10 suite, green unchanged.
- **Depends on**: PR 10.

---

### PR 12 — `test(external-events): pin webhook check/status normalization family`

📌 pins — prod Δ = 0, test Δ ≲350

- **Scope**: grow
  `packages/daemon/tests/unit/2-handlers/github/github-normalizer.test.ts`
  with characterization rows for the CI/status family of CURRENT normalizers:
  `normalizeGitHubCheckRun` (including the rejection row: `action !==
  'completed'` must return `null`), `normalizeGitHubCheckSuite`, and
  `normalizeGitHubStatus`.
- **Lands**: the check/status family — including rejection halts — is pinned
  before any ingest pipeline exists.
- **Excludes**: any production change; other kind families (PR 13-15).
- **Tests**: `github-normalizer.test.ts` only.
- **Depends on**: none. Sequenced before PR 13-15: all four pin slices extend
  the SAME test file, so they land in family order 12 → 13 → 14 → 15 (PR 16
  after all four); parallel-safe with PR 1-11.

---

### PR 13 — `test(external-events): pin webhook review/comment/PR normalization family`

📌 pins — prod Δ = 0, test Δ ≲350

- **Scope**: same test file — characterization rows for the review/comment/PR
  family: `normalizeGitHubReview`, issue-comment-on-PR vs plain-issue
  dispatch, review comment, review thread, `pull_request`, and `merge_group`
  (a doc-named gap kind).
- **Lands**: the review/comment/PR dispatch and output shapes are pinned.
- **Excludes**: production changes; other families.
- **Tests**: `github-normalizer.test.ts` only.
- **Depends on**: PR 12 (review correction PR #2979: PRs 12-15 all extend
  the SAME test file, so they are SEQUENCED, not parallel — concurrent
  edits would collide; land in family order 12 → 13 → 14 → 15, and PR 16
  lands after all four).

---

### PR 14 — `test(external-events): pin webhook deployment/config normalization family`

📌 pins — prod Δ = 0, test Δ ≲350

- **Scope**: same test file — characterization rows for the
  deployment/repo-config family: `normalizeGitHubDeployment`,
  `normalizeGitHubDeploymentStatus` (a doc-named gap kind), and
  `normalizeGitHubBranchProtectionRule` (including the branch-aware
  `repo/<branch>.<action>` resource shape; a doc-named gap kind).
- **Lands**: the deployment/config family — consumed directly by
  `github-event-extension.ts` — is pinned.
- **Excludes**: production changes; other families.
- **Tests**: `github-normalizer.test.ts` only.
- **Depends on**: PR 13 — PRs 12-15 extend the same test file and land in
  family order 12 → 13 → 14 → 15.

---

### PR 15 — `test(external-events): pin polling-row normalization family`

📌 pins — prod Δ = 0, test Δ ≲350

- **Scope**: same test file — characterization rows for polling rows:
  `normalizeGitHubPollingRow` per `endpointKey` (`issue_comments`,
  `review_comments`, `pulls`), plus the polled kinds `normalizeGitHubReaction`
  and `normalizeGitHubMergeConflict` (both doc-named gap kinds).
- **Lands**: endpoint dispatch and polled-kind outputs are pinned.
  `normalizeGitHubPollingRow` itself stays a plain function (review
  correction: it runs once per endpoint row at
  `github-event-extension.ts:2491-2499`, pages up to 100 rows — no per-row
  pipeline).
- **Excludes**: production changes; webhook families (PR 12-14).
- **Tests**: `github-normalizer.test.ts` only.
- **Depends on**: PR 14 — PRs 12-15 extend the same test file and land in
  family order 12 → 13 → 14 → 15.

---

### PR 16 — `refactor(external-events): add normalizer outcome types and base snapshots`

➕ additive core — prod Δ ≲150 (types-dominated), test Δ ≲350

- **Scope**:
  `packages/daemon/src/lib/external-events/github/github-normalizer.ts` — add
  the `NormalizedOutcome` terminal, the unified `GitHubWebhookDispatchCtx`
  (dispatch selection `kind`/`input` AND the boxed `outcome` on ONE context)
  and `WebhookBase` types, and extract the `WebhookBase` snapshot helper
  (shared
  repo/sender/`deliveryId`/`rawPayload` extraction ONLY — review correction PR #2979: no shared `occurredAt` exists; each kind selects different nested timestamps (check completion/update fields, comment timestamps, review submission timestamps, PR timestamps) so timestamp selection stays in each per-kind stage or digest chronology breaks) as pure
  functions. UNWIRED: no pipeline consumes them yet; no behavior change.
- **Lands**: the shared scaffolding exists with snapshot-helper unit tests,
  ready for the webhook ingest pipeline.
- **Excludes**: the ingest pipelines (PR 17+); edits to callers.
- **Tests**: `github-normalizer.test.ts` — snapshot-helper unit tests.
- **Depends on**: PR 12-15 (pins before extraction).

---

### PR 17 — `refactor(external-events): add github webhook ingest skeleton with dispatch stages`

➕ additive core — prod Δ ≲150 (types-dominated), test Δ ≲350

- **Scope**: same file — add the `ingest-github-webhook` raw superpipe
  skeleton: the initial `snapshotBase` stage filling `WebhookBase`, then the
  inline self-guarding dispatch stages (`stageCheckRun`, `stageCheckSuite`,
  `stageBranchProtectionRule`, `stageMergeGroup`, `stageIssueComment` with the
  issue-is-a-PR guard, `stagePullRequestReview`,
  `stagePullRequestReviewComment`, `stagePullRequestReviewThread`,
  `stagePullRequest`, `stageIgnoreUnknown` — first match wins, no separate
  `decisionRun` dispatcher). Per-kind transforms initially delegate to the
  existing per-kind exports WHERE SUCH EXPORTS EXIST (`check_run`,
  `check_suite`, `branch_protection_rule`, `merge_group`); the five kinds
  implemented only as inline branches of the current `normalizeGitHubWebhook`
  body (`issue_comment`, `pull_request_review`,
  `pull_request_review_comment`, `pull_request_review_thread`,
  `pull_request` — `github-normalizer.ts:207-332`) are DISPATCH-ONLY
  placeholders whose transform stages arrive with PR 19 (review correction:
  no per-kind export exists for them to delegate to). UNWIRED:
  `normalizeGitHubWebhook` keeps its old body.
- **Lands**: dispatch precedence is independently testable while production
  behavior is unchanged.
- **Excludes**: inline per-kind conversion (PR 18-20); wiring (PR 21).
- **Tests**: add
  `packages/daemon/tests/unit/2-handlers/github/github-normalizer-pipeline.test.ts`
  — dispatch-order rows (e.g. `issue_comment` dispatches only when the issue
  is a PR; unknown events leave `kind` unset so the shell returns `null`).
- **Depends on**: PR 16.

---

### PR 18 — `refactor(external-events): inline check transforms in webhook ingest`

➕ additive core — prod Δ ≲120 (move-heavy), test Δ ≲350

- **Scope**: same file — convert the check family (`check_run`, `check_suite`)
  from delegated exports into inline boxed-outcome stages inside
  `ingest-github-webhook` (`guardRequiredShape` → `!isDone` →
  `extractPrimaryFields` → `!isDone` → `extractPayload` →
  `assembleNormalizedEvent`); guards that reject set
  `outcome = { status: 'rejected' }`; the per-kind exports stay callable as
  thin wrappers over their stage groups. Stages stay synchronous (no
  `endAsync`) and never mutate `payload`. Review correction (PR #2979):
  `status` has NO raw webhook-event arm at all — `handleWebhook` routes
  `status` deliveries to `handleStatusWebhook` before
  `normalizeGitHubWebhook` is ever called
  (`github-event-extension.ts:703-705`), and neither the current dispatch nor
  this plan's stage list has a status arm — so there is no `status` stage to
  inline; the enriched handler-side `normalizeGitHubStatus`
  (`github-event-extension.ts:925`, fed derived inputs) stays plain logic
  with its CURRENT signature. Still UNWIRED.
- **Lands**: the CI kinds run as pipeline stages with first-class rejection
  halts, verified against the PR 12 pins.
- **Excludes**: other families (PR 19-20); wiring (PR 21).
- **Tests**: `github-normalizer-pipeline.test.ts` — stage-order rows (e.g.
  the `check_run` guard halts before payload parsing when
  `action !== 'completed'`).
- **Depends on**: PR 17, PR 12.
- **Size guard**: prod Δ is move-heavy; if two kinds exceed the tier, split by
  kind before opening.

---

### PR 19 — `refactor(external-events): inline review/comment/PR transforms in webhook ingest`

➕ additive core — prod Δ ≲120 (move-heavy), test Δ ≲350

- **Scope**: same file — inline the review/comment/PR family
  (`pull_request_review`, review comment, review thread, issue-comment-on-PR,
  `pull_request`, `merge_group`) into `ingest-github-webhook` using the same
  boxed-outcome template; per-kind exports stay callable wrappers (this
  family's transforms are inline in the current `normalizeGitHubWebhook` body
  except `normalizeGitHubMergeGroup`; the POLLED `normalizeGitHubReview` —
  `github-event-extension.ts:2978` — is an enriched consumer, stays plain
  with its CURRENT signature, and is NOT inlined here). Still UNWIRED.
- **Lands**: the review/comment/PR kinds run as stages, verified against the
  PR 13 pins.
- **Excludes**: other families; wiring (PR 21).
- **Tests**: `github-normalizer-pipeline.test.ts` — stage rows for this
  family.
- **Depends on**: PR 17, PR 13.
- **Size guard**: move-heavy; split by kind before opening if over tier.

---

### PR 20 — `refactor(external-events): inline branch-protection transform in webhook ingest`

➕ additive core — prod Δ ≲120 (move-heavy), test Δ ≲350

- **Scope**: same file — inline `branch_protection_rule` (with its
  branch-aware `repo/<branch>.<action>` resource) into
  `ingest-github-webhook`; the per-kind export stays a callable wrapper.
  Review correction (PR #2979): `deployment`/`deployment_status` have NO raw
  webhook-event arms — `handleWebhook` routes those deliveries to
  `handleDeploymentWebhook` before `normalizeGitHubWebhook` is ever called
  (`github-event-extension.ts:707-714`) — so there are no deployment stages
  to inline; the enriched handler-side
  `normalizeGitHubDeployment`/`normalizeGitHubDeploymentStatus`
  (`github-event-extension.ts:825-834`, fed derived inputs) stay plain logic
  with their CURRENT signatures. Still UNWIRED.
- **Lands**: the branch-protection webhook-event kind runs as a stage,
  verified against the PR 14 pins; every raw webhook-event kind is now
  inline.
- **Excludes**: wiring (PR 21).
- **Tests**: `github-normalizer-pipeline.test.ts` — stage rows for this
  family, including the branch-protection resource shape.
- **Depends on**: PR 17, PR 14.
- **Size guard**: move-heavy; split by kind before opening if over tier.

---

### PR 21 — `refactor(external-events): route webhook normalization through ingest pipeline`

🔧 apply — prod Δ ≲30, test Δ ≲0 (PR 12-20 pins stay green)

- **Scope**: same file — the body of `normalizeGitHubWebhook` becomes the
  thin shell seeding the ctx and unwrapping
  `outcome.status === 'done' ? value : null`. ONE site wired;
  `handleWebhook`, `handleStatusWebhook`, and `handleDeploymentWebhook` are
  untouched, and every per-kind export remains callable as a wrapper over its
  stage group.
- **Lands**: webhook normalization (dispatch + per-kind transforms as stages
  of one pipeline) is live; the full parity suite is green unchanged.
- **Excludes**: `normalizeGitHubPollingRow` (stays plain — hot per-row loop);
  `toExternalEvent` (PR 22); any edit to `github-event-extension.ts` (the raw
  call site at line 716 already calls this export and picks the pipeline up
  unchanged; re-run the `github/index.ts` export-surface check unchanged).
- **Tests**: `github-normalizer.test.ts` and
  `github-normalizer-pipeline.test.ts`, unchanged and green.
- **Depends on**: PR 18, PR 19, PR 20.

---

### PR 22 — `refactor(external-events): project external events per space via superpipe transform`

🔧 apply — prod Δ ≲110 (types-dominated transform + one-line shell), test Δ ≲60

- **Scope**: same file — add the `project-external-event` raw transform
  covering `canonicalizeRepo`, `selectTopicParts` (`mapEventType` stays a
  lookup-table helper), `buildPayload`, and `assembleExternalEvent`
  (`newId()` AND `now()` from the ctx's INJECTED seams only in the final
  stage — one fresh id per space, one ingestion timestamp; review correction
  PR #2979: `ToExternalEventCtx` carries `now`/`newId` and the exported
  shell wires the real `Date.now`/`crypto.randomUUID`, so the migration can
  neither omit `ingestedAt` nor substitute `occurredAt` unnoticed — the pins
  below fail if it does),
  and wire the exported `toExternalEvent(spaceId, event)` to wrap it. ONE
  site wired; the `publishEvent` per-space call site is unchanged; the ingest
  pipeline still ends at `NormalizedGitHubEvent` — projection stages never
  append to it. The transform is small enough to land wired rather than as
  a separate additive slice.
- **Lands**: the normalize-once / project-per-space boundary is explicit; each
  watched space gets its own event id.
- **Excludes**: `publishEvent` logic; global `crypto`/`Date` mocking (the ctx
  seam replaces it — open question 6 is resolved by this slice).
- **Tests**:
  `packages/daemon/tests/unit/2-handlers/github/external-event-essence-contract.test.ts`
  — end-to-end `toExternalEvent` round trips, green, PLUS pin rows for the
  projection's nondeterminism (review correction PR #2979: the existing
  round-trip rows only copy `event.id`/`event.ingestedAt` into fixtures or
  persist whatever was produced — they never detect a reused id or an
  `occurredAt` substitution): inject a fixed `now` and assert `ingestedAt`
  equals it while differing from `occurredAt`; inject a deterministic
  `newId` and assert each per-space projection carries its own fresh id.
- **Depends on**: PR 21 (`NormalizedGitHubEvent` stable; same-file
  sequencing).

---

## Open questions

1. **Optional stage prefix `?dep` in raw superpipe**: The ADR mentions `?dep`
   for skipping optional stages, but the repo currently does not use it in a raw
   superpipe. Should the normalizer/essence pipelines rely on `?dep` for
   event-type branches, or is it safer to have each stage inspect `ctx.eventType`
   internally and return `ctx` unchanged when not applicable?

2. ~~**Normalizer dispatch granularity**~~ Resolved by review: the entire
   pipeline (dispatch + kind processing) is a single raw superpipe ingest
   pipeline per business path, with dispatch as a stage — NOT a separately-run
   `decisionRun` dispatcher plus per-kind pipelines (that splits one
   ingestion business path across composition boundaries). `stagedRun` never
   applies here: normalization is synchronous and effect-free. The exported
   function signatures stay stable via thin wrappers over the single pipeline.

3. ~~**`classifyExternalEventDirectSteer` hot path**~~ Resolved by review: it stays an ordinary ordered classifier called per essence from `partitionDirectSteerEssences` — no `decisionRun`, nothing to benchmark.

4. **Error vs decision for `composeGitHubSubscriptionPattern` and
   `validateRemoteHook`**: These currently throw/return error strings. The plan
   wraps a `decisionRun` and preserves the old contract. Is there a longer-term
   desire to expose the decision shape (e.g., `{ ok } | { error }`) to callers,
   or should the throw/return contract remain forever?

5. **Testing private `validateRemoteHook`**: `validateRemoteHook` is a module
   private. Should the migration export a `decideValidateRemoteHook` runner for
   testing, or test it through `checkWebhook`/`reconcileSharedHook` integration
   only?

6. ~~**`toExternalEvent` UUID**~~ Resolved by review (PR #2979):
   `ToExternalEventCtx` carries injected `now`/`newId` seams; the exported
   shell wires the real `Date.now`/`crypto.randomUUID`, and tests pin
   `ingestedAt` ≠ `occurredAt` plus per-space fresh ids via the seams — no
   global `crypto` mocking needed.
