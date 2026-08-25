# Web migration plan

Deep-dive plan for migrating hand-rolled imperative cascades in `packages/web`
to direct superpipe pipelines (ADR 0004, revised 2026-08-25). Thirteen sites,
one plan. No source changes yet — this document is the implementation blueprint.

Core invariants for every site below:

- The exported function signature stays EXACTLY as-is. Callers do not change.
- Every pipeline/combinator instance is built once at module scope. Never
  rebuild per call (superpipe assembly cost dwarfs run cost).
- Stages never read Preact signals. The shell (wrapper or hook) snapshots
  signal values (`.value`) into a plain input object at the call boundary, and
  interprets outputs back into signal writes / toasts / DOM inside `batch()`
  where the caller already does so.
- Characterization tests are written/pinned BEFORE each refactor (ADR 0004
  Decision 7). Nearly all sites already have Vitest suites; gaps are called
  out per site.
- Zero comments in `.ts` sources (`bun run check:no-comments`), Biome single
  quotes / semicolons / width 100, no explicit `any` (use the daemon
  `as PipelineAPI` / `as unknown as T` cast idioms where the builder's generics
  degrade).

## Scope and combinator fit

Inventory (verified by reading every file and grepping all call sites):

| Site | Combinator | Call frequency | Risk |
| --- | --- | --- | --- |
| `hooks/useSendMessage.ts:sendMessage` | direct mixed pipeline (was suggested stagedRun — see rationale) | per user submit | medium |
| `lib/app-routing.ts:deriveAppExpectedPath` | decisionRun | per routing-signal change (signal effect) | low |
| `lib/status-actions.ts:getCurrentAction` | decisionRun (+ purity shims) | per streaming tick (`useMemo` in `useChatComposerController`) | medium |
| `lib/parse-group-message.ts:parseGroupMessage` | decisionRun | per message inside `useTurnBlocks` map (reducer body, not the loop) | low |
| `hooks/useModelSwitcher.ts:inferProviderFromModelId` | decisionRun | per model on fetch (module-internal) | low |
| `hooks/useModelSwitcher.ts:mapRawModelsToModelInfos` | raw P1 transform pipeline (per-model family via decisionRun) | per `models.list` fetch | low |
| `lib/node-click-resolver.ts:resolveNodeClick` | steer-style direct pipeline (transforms + final decide) | per node click | low |
| `lib/task-banner.ts:resolveActiveTaskBanner` | decisionRun | per `SpaceTaskPane` render | low |
| `lib/router.ts:getSpaceIdFromPath` (+ optional `classifySpaceRoute`) | decisionRun | popstate / init only | low |
| `lib/session-load-error.ts:classifySessionLoadError` | decisionRun | per failed session load (catch path) | low |
| `lib/user-error.ts:sanitizeUserError` | decisionRun | error paths + outbound-queue flush loop | low |
| `lib/session-utils.ts:getModelLabel` | decisionRun | test-only today (SessionsPage has local copy) | low |
| `lib/provider-brand.ts:shortenModelName` | raw P1 transform pipeline | render body + per dropdown item | low-medium |

Caller facts that drive the fits (from the call-site sweep):

- `deriveAppExpectedPath` — `App.tsx:106` inside a signal `effect`; runs per
  navigation/state change, not per keystroke. Cold enough for any combinator.
- `getCurrentAction` — `useChatComposerController.ts:124` inside
  `useMemo(..., [agentState, messages])`. Per streaming message batch, not per
  list item. A module-scope decisionRun (~2–2.6 µs/run, benchmarked in ADR 0004)
  is acceptable at batch cadence; do NOT introduce it into tighter loops.
- `parseGroupMessage` — `useTurnBlocks.ts:139` `.map(parseGroupMessage)` inside
  a `useMemo`. The map is the loop (stays imperative); the function is a
  per-event reducer body, which ADR 0004 explicitly allows as a pipeline.
- `resolveNodeClick` — `SpaceTaskPane.tsx:784` in an async click handler. Cold.
- `resolveActiveTaskBanner` — `SpaceTaskPane.tsx:591` render body, per
  task/message/status update. Module-scope pipeline + per-render run is fine.
- Router parsers — `applyPathToSignals` is module-private, called from
  `handlePopState` and `initializeRouter` only. `getSpaceIdFromPath` has no
  production callers outside `router.ts` itself (tests only). Cold.
- `sanitizeUserError` — `useSendMessage.ts:143` catch, plus
  `outbound-queue.ts:90` inside the flush loop over queued actions. Error-path
  cadence only.
- `mapRawModelsToModelInfos` — `ModelsSettings.tsx:495` and
  `WorkflowModelSelect.tsx:100`, both async fetch handlers. Cold.
- `shortenModelName` — render bodies and per-item JSX loops in
  `NewChatModelPicker.tsx:107/204` and `SessionStatusBar.tsx:301/441`. Per
  dropdown item per render; see that site's memoization caveat.
- `resolveTargetSessionId` — `useMemo([selectedTarget, activityMembers])` plus
  a `for (const target of targets)` effect loop at
  `useTargetSessionContext.ts:284`. Moderate cadence, fine.
- `getModelLabel` (lib) — zero production importers; `SessionsPage.tsx:115`
  hand-rolls a divergent local copy. See open questions.

## Existing superpipe examples to emulate

### `decisionRun` patterns

- `packages/daemon/src/lib/space/runtime/run-tick-decision-pipeline.ts` — the
  canonical gate-cascade: pure exported gate functions `(ctx) => ctx`, each
  either returning ctx untouched or `{ ...ctx, decision }`; composed once at
  module scope via `decisionRun('name', [gateA, gateB, ...])`; a thin wrapper
  (`decideRunTickAdmissionViaPipeline`) seeds `decision: null` and reads
  `ctx.decision ?? fallback`. Gate order IS the precedence order and is pinned
  by unit tests.
- `packages/daemon/src/lib/agent/query-retry-routing.ts` — the "keep the pure
  classifier, pipeline the composition" variant: a pre-existing pure function
  (`classifyQueryRetryRoute`) stays intact; two gates (`applyClassifierGate`,
  `applyArmMappingGate`) stamp its result into a decision ctx. This is the
  template for sites where a pure core already exists and is heavily tested
  (`classifySessionLoadError`, `classifyByMessage`, `inferProviderFromModelId`).

### Raw `superpipe` patterns (direct composition — the ADR default)

- `packages/daemon/src/lib/space/runtime/external-event-steer-admission-pipeline.ts`
  — the closest template for `resolveNodeClick` and `resolveTargetSessionId`:
  one ctx object threaded through mixed transform stages
  (`enrichDirectEssences`, `partitionDirectSteer`) and gate stages, each
  `.pipe(stage, 'ctx', 'ctx')` followed by `.pipe('!settled', 'ctx')`, ending
  `.end('ctx')` with a wrapper that seeds `decision: null` and casts the
  runner. Transforms enrich ctx; gates stamp decisions; the finalize stage
  produces the terminal shape.
- Daemon `staged-run.ts` internals (`buildGatherAdapter`, the
  `.pipe(fn, '{a,b}', '{...}')` multi-key syntax) show how to declare
  per-stage input/output views when a site does not want the single-cctx
  shape. Only needed if a web pipeline outgrows ctx threading.

### `stagedRun` patterns — NOT ported to web

`staged-run.ts` (738 lines: compensation stacks, CAS outcomes, contract
validation) exists to discipline persistent daemon writes. No scoped web site
has compensable multi-stage state writes; the only suggested candidate
(`sendMessage`) is an admission cascade plus idempotent UI effects, which the
ADR's default mixed direct pipeline covers without compensation machinery.
Porting `stagedRun` into `packages/web` would be dead weight. If a web flow
with genuinely compensable stages appears later (e.g. multi-step store deltas),
revisit extraction to a shared home at that point.

## Prerequisite: combinator availability in web

`packages/web/package.json` has no `superpipe` entry today. ADR 0004
anticipates this: "packages/web adds the dependency when its first direct
pipeline lands."

### Step 0 — dependency spike (blocking, do first)

1. Add `"superpipe": "0.17.0"` (exact pin, matching daemon) to
   `packages/web` `dependencies`. Run `bun install`.
2. Verify resolution under all three consumers of web code:
   `cd packages/web && bunx vitest run src/lib/__tests__/user-error.test.ts`
   (vitest/vite), `make build` (rollup production build), and the dev server
   (`make dev PORT=8484 DB_PATH=/tmp/hyperneo-web-spike.db`). Confirm bundle
   size delta is negligible and no CJS/ESM interop errors surface.
3. If the spike fails on bundling grounds, fall back to direct-only
   composition in web and drop decisionRun-dependent plans below to raw
   steer-style pipelines (all designs have that fallback shape).

### Step 0b — where `decisionRun` lives for web

Options considered (this is the prompt's open prerequisite; recommendation is
(a)):

- **(a) Web-local module `packages/web/src/lib/pipelines/decision-run.ts`** —
  a copy of the 19-line combinator from
  `packages/daemon/src/lib/space/runtime/decision-pipeline.ts`, unchanged
  semantics (`superpipe` `!hasDecided` halts, `decision: null` seeding,
  `Undecided<Ctx>` input type). Pros: no cross-package coupling, daemon
  untouched, shared stays dependency-free. Cons: 19 duplicated lines until a
  third consumer appears. Add a parity unit test
  (`src/lib/pipelines/__tests__/decision-run.test.ts`) pinning first-gate-wins,
  wrapper-fallback, and null-seeding against hand-rolled expectations.
- **(b) Extract to `@hyperneo/shared/src/lib/decision-run.ts`** with daemon
  re-exporting from its current path for compatibility. Pros: one canonical
  implementation. Cons: shared currently has zero runtime dependencies; adding
  an engine to the types/protocol package is a policy change that touches the
  daemon and CLI at once. Defer until cli/desktop also wants it.
- **(c) No combinator — direct composition only.** Always available as the
  fallback; more verbose for the ~9 pure precedence cascades scoped here, and
  the gates would each hand-write `!settled` plumbing that decisionRun
  centralizes.

`stagedRun` remains daemon-side (see above). No new combinators are proposed
anywhere in this plan.

### Conventions established by the first landed site

- `src/lib/pipelines/` holds the shared web combinator module and, later, any
  cross-cutting pipeline helpers. Per-site pipelines live either in the same
  module as the function being migrated (small sites — mirrors steer-admission
  keeping gates next to the pipeline) or in a sibling file for hook-adjacent
  flows (`send-message-pipeline.ts`).
- Gates are exported named functions so tests can pin individual precedence
  rows and future call sites can reuse them.
- Every wrapper keeps its current export name/signature; the pipeline is an
  implementation detail behind it.

## Per-site detailed plans

### `packages/web/src/lib/app-routing.ts:deriveAppExpectedPath`

- **Current summary.** Ordered if-cascade over a 10-field `AppRoutingState`:
  session route wins outright; then space-task (with view-tab normalization);
  then space agents view (before space-session!); then space-session; then
  goals/memories/forge/tasks/configure views with tab normalizations
  (`!== 'active'`, `!== 'agents'` defaults collapse to undefined); then bare
  space; then `/sessions` or `/settings` by navSection; fallback `/spaces`.
  Called from a signal effect in `App.tsx` — the URL-sync guard.
- **Proposed combinator.** `decisionRun` — textbook precedence cascade, pure
  inputs, string output, cold cadence.
- **Input/output snapshot design.** Ctx = `AppRoutingState & { decision:
  string | null }`. Input is already a plain interface — no snapshot work
  needed; the App effect already builds it from signals. Output: wrapper
  returns `ctx.decision ?? '/spaces'` (the final gate always decides, so the
  fallback is defensive only).
- **Pure core design.** Gates in exact current order, each
  `(ctx) => ctx.decision !== null ? ctx : (predicate ? { ...ctx, decision:
  createXPath(...) } : ctx)`:
  `gateSessionRoute` → `gateSpaceTaskRoute` (decides when `spaceTaskId &&
  spaceId`, normalizing `spaceTaskViewTab !== 'thread'`) → `gateSpaceAgentsView`
  (`spaceId && spaceViewMode === 'agents'`, `spaceAgentHandle ?? undefined`) →
  `gateSpaceSession` → `gateSpaceSessions` (`spaceId && spaceViewMode ===
  'sessions'` without a specific `spaceSessionId`, decides
  `createSpaceSessionsPath(spaceId)`; review correction — omitting it drops
  the sessions-list URL to `/space/<id>` and the URL-sync effect navigates
  away from the view) → `gateSpaceGoals` → `gateSpaceMemories` →
  `gateSpaceForge` → `gateSpaceTasks` (tab `!== 'active'` normalization) →
  `gateSpaceConfigure` (tab `!== 'agents'` normalization) → `gateSpaceRoot` →
  `gateChatsNav` (`navSection === 'chats'`) → `gateSettingsNav` →
  `gateDefaultSpaces` (always decides `'/spaces'`).
- **Shell/effect wiring.** None beyond the existing effect; `decisionRun`
  instance at module scope (`appExpectedPathDecisionRun`), wrapper
  `deriveAppExpectedPath(state)` calls it.
- **Step-by-step migration.**
  1. Confirm `src/lib/__tests__/app-routing.test.ts` covers every branch; add
     missing precedence rows FIRST: task-beats-agents-view,
     agents-view-beats-space-session, session-beats-everything, tab-default
     collapse for tasks/configure/task-view.
  2. Introduce `AppRoutingDecisionCtx` type; rewrite the cascade as exported
     gate functions (pure, no behavior change); keep the old if-cascade body
     temporarily delegating gate-by-gate is unnecessary — replace in one
     commit once tests pin behavior.
  3. Compose via `decisionRun('app-expected-path', [...gates])`; wrapper keeps
     signature; delete the cascade.
- **Tests.** Existing characterization suite stays green unchanged. New
  `app-routing.precedence.test.ts` rows for the ordering pairs above (decision
  tables are the ADR-mandated unit shape).
- **Risks/caveats.** Gate order is behavior — the agents-view-before-session
  and session-first quirks are load-bearing for the URL-sync effect; a
  reordered gate silently desyncs history. The `?? undefined` normalizations
  must move into gates verbatim. No signal reads inside gates (state arrives
  as plain object — already true).

### `packages/web/src/lib/status-actions.ts:getCurrentAction`

- **Current summary.** Returns the status-line action label while processing:
  `!isProcessing → undefined`; `isCompacting → 'Compacting context...'`;
  message-derived action (`tool_progress` with elapsed seconds, assistant
  `tool_use` blocks, `stream_event` thinking/tool_use/text_delta); streaming
  phase label (`streaming` phase embeds `Date.now()` duration); rotating
  fallback ("Thinking...", "Processing...", ...). Two purity defects: the
  module-level `lastFallbackIndex` rotator and `Date.now()` inside
  `getPhaseAction`.
- **Proposed combinator.** `decisionRun`, with the fallback rotation hoisted
  to the shell. (The message extraction helper stays a helper — it is a
  nested type-switch, not a precedence cascade; do not pipeline it.)
- **Input/output snapshot design.** Ctx =
  `{ latestMessage: SDKMessage | null; isProcessing: boolean; isCompacting?:
  boolean; streamingPhase?: StreamingPhase; streamingStartedAt?: number;
  decision: string | 'fallback' | 'none' | null }`. Wrapper maps `'none'` →
  `undefined`, `'fallback'` → `getNextFallbackAction()` (rotation stays in the
  module, outside the pipeline), string → string.
- **Pure core design.** Gates: `gateNotProcessing` (decides `'none'`) →
  `gateCompacting` → `gateMessageAction` (decides
  `extractActionFromMessage(latestMessage)` when non-null) → `gatePhaseAction`
  (decides `getPhaseAction(...)`) → `gateFallback` (always decides
  `'fallback'`). `Date.now()` remains inside `gatePhaseAction` — impure but
  unchanged; see open questions for injecting a clock if we ever want fully
  deterministic pipeline tests (wrapper tests already fake time where needed).
- **Shell/effect wiring.** None; pure label computation. The hook's `useMemo`
  cadence is unchanged.
- **Step-by-step migration.**
  1. Extend `src/lib/__tests__/status-actions.test.ts` with gate-order rows
     (not-processing beats everything; compacting beats message; message
     beats phase; phase beats fallback) and elapsed-seconds formatting cases.
  2. Introduce the three-value decision union; extract gates; compose with
     `decisionRun('current-action', [...])`; wrapper interprets the sentinel
     values.
- **Tests.** Characterization above + a test asserting the fallback sentinel
  maps through the rotator (preserving the rotation sequence across calls).
- **Risks/caveats.** Runs per streaming tick — pipeline must stay module-scope
  and gates allocation-light (each undecided gate spreads ctx once; ~13 spreads
  worst case is fine at batch cadence). Do not move the rotator into a gate:
  `decisionRun` halts make "ran or not" order-dependent, and tests comparing
  consecutive fallback labels would become flaky. The `as unknown as`
  SDK-message narrowing in `extractActionFromMessage` stays as-is.

### `packages/web/src/lib/parse-group-message.ts:parseGroupMessage`

- **Current summary.** Tagged-union transform: `messageType ?? type` selects
  among `status` / `leader_summary` / `rate_limited` / `model_fallback`
  synthetic SDKMessages (each stamped with `_taskMeta` and a
  kind-prefixed `turnId`), else generic `JSON.parse(msg.content)` with
  timestamp override, else `null`. Called per message in `useTurnBlocks`'s
  `.map` — a per-event reducer body (ADR-legal pipeline position; the loop
  stays imperative).
- **Proposed combinator.** `decisionRun`. First-matching-type-wins is exactly
  the combinator's semantics; the JSON fallback is the final gate.
- **Input/output snapshot design.** Wrapper first normalizes the ambiguous
  input (plain transform): `{ id, content, createdAt, msgType: msgAny.messageType
  ?? msgAny.type }`. Ctx = that snapshot + `decision: SDKMessage | null`.
  Output: `ctx.decision` (the final gate always decides, including `null` on
  parse failure).
- **Pure core design.** Gates: `gateStatusMessage` → `gateLeaderSummary` →
  `gateRateLimited` (own `JSON.parse` with `{ text: content }` fallback) →
  `gateModelFallback` (same pattern) → `gateSdkJson` (always decides;
  `JSON.parse` success → `{ ...parsed, timestamp: createdAt }`, failure →
  `null`). `_taskMeta` stamping moves verbatim into each gate.
- **Shell/effect wiring.** None; pure.
- **Step-by-step migration.**
  1. **There is no dedicated test today** — write
     `src/lib/__tests__/parse-group-message.test.ts` FIRST, pinning: all four
     synthetic types (shape, `_taskMeta.turnId` prefixes, empty
     `authorSessionId`), `messageType` taking precedence over `type`,
     rate-limited/model-fallback JSON-parse failure falling back to
     `{ text }`, generic SDK JSON passthrough with timestamp override, and
     unparseable content → `null`. Cover it indirectly through
     `src/hooks/__tests__/useTurnBlocks.test.ts` afterwards.
  2. Extract the snapshot normalization into the wrapper; add gates; compose
     `decisionRun('parse-group-message', [...])`.
- **Tests.** The new characterization file is the parity proof; keep
  `useTurnBlocks` tests unchanged and green.
- **Risks/caveats.** Per-message cadence inside a memo — gate count is small
  (5) and typical messages decide in gate 5 with one JSON.parse; acceptable.
  The `as unknown as SDKMessage` casts are pre-existing and preserved (oxlint
  tolerates casts; only explicit `any` is banned). Behavior when
  `msg.content` is itself an object (not string) is currently
  `JSON.parse` throwing → `null`; pin that in a test before touching
  anything, since group-message payloads come from the store.

### `packages/web/src/hooks/useModelSwitcher.ts:mapRawModelsToModelInfos` and `inferProviderFromModelId`

- **Current summary.** `inferProviderFromModelId`: ordered prefix/regex rules
  (claude → anthropic; ollama-cloud shapes; `qwen…:NNNb` vs `qwen…:`;
  `gpt-oss:` cloud suffix; openrouter slash shapes; bare `:` → ollama; glm /
  kimi (incl. `k3` aliases) / minimax / deepseek / gpt families; else
  undefined). `mapRawModelsToModelInfos`: per-model family classification
  (second if/else chain, default `sonnet`), provider inference
  (`m.provider || inferFromId || PROVIDER_FROM_FAMILY[family] ||
  'anthropic'`), assembly, then a provider-then-family sort. Cold (fetch
  handlers only).
- **Proposed combinator.** `inferProviderFromModelId` → `decisionRun`
  (query-retry template: keep the rule order as gates). Family
  classification → extract `classifyModelFamily(modelId): string` as its own
  `decisionRun`. `mapRawModelsToModelInfos` itself → raw P1 transform
  pipeline: `stageClassifyFamily` → `stageInferProvider` → `stageAssemble` →
  `stageSort`, ctx threading the models array.
- **Input/output snapshot design.** Provider ctx: `{ modelId: string;
  decision: string | undefined | null }` — careful: `decisionRun` halts on
  `decision !== null`, and `undefined` is a meaningful outcome here; use the
  sentinel `'unknown-provider'` internally and map to `undefined` in the
  wrapper (the daemon `decisionRun` types `decision: unknown`, so a
  final `gateNoProvider` deciding the sentinel keeps halt semantics
  well-defined). Family ctx analogous with default gate deciding `'sonnet'`.
  Map pipeline ctx: `{ rawModels, classified: ModelInfo[] }`.
- **Pure core design.** Gates mirror the exact current rule order — the
  regexes (`qwen[\w.-]*:[1-9]\d{2,}b` before the looser `qwen[\w.-]*:`) and
  the `-cloud` suffix check are ordered constraints; each gate owns one rule
  verbatim. The pipeline's assemble stage keeps the
  `contextWindow ?? context_window` coalescing and `> 0` guard; sort stage
  keeps `PROVIDER_ORDER`/`FAMILY_ORDER` with `?? 99`.
- **Shell/effect wiring.** None; pure module functions consumed by fetch
  handlers and the hook.
- **Step-by-step migration.**
  1. Extend `src/hooks/__tests__/useModelSwitcher.test.ts` (exists) with
     provider-inference and family tables — every rule, plus order-sensitive
     pairs (`qwen2.5:120b` → ollama-cloud vs `qwen2.5:32b` → ollama — review
     correction: the cloud regex is `[1-9]\d{2,}b`, i.e. 100B+ only, so 2-digit
     sizes like `32b` fall through to plain `ollama`; also
     `qwen2.5:latest` → ollama; `gpt-oss:120b` vs `gpt-oss:mini-cloud`).
  2. Migrate `inferProviderFromModelId` to gates + `decisionRun`
     ('infer-model-provider'), wrapper maps sentinel → undefined.
  3. Extract `classifyModelFamily` (currently inline) as its own decisionRun;
     pin its table including the default `sonnet` and the `/` → openrouter
     tail rule.
  4. Compose `mapRawModelsToModelInfos` as the P1 pipeline; wrapper signature
     unchanged.
- **Tests.** Tables above; keep the hook-level fetch/switch tests green
  (they exercise the wrapper end-to-end).
- **Risks/caveats.** The `undefined`-vs-sentinel subtlety is the one real
  trap — a gate deciding `undefined` would NOT halt the run. The exported
  symbols live in a hook module but are pure module-scope functions; keep the
  pipeline instances outside the hook body so re-renders never rebuild them.

### `packages/web/src/lib/node-click-resolver.ts:resolveNodeClick`

- **Current summary.** Cold click resolver, four phases: (1) index
  `nodeExecutions` (filtered by run/node/declared-slot; live vs cancelled /
  pending) into `liveBySession` + authoritative `sessionByExecId`; (2) merge
  `activityMembers` (post-filtering, exec-authoritative dedupe, label
  enrichment); (3) post-approval override (delete stale agent sessions,
  ensure the post-approval session exists, using `postApprovalNodeId ? nodeId
  match : isDeclaredSlot`); (4) outcome precedence: single-live-and-no-
  unstarted → `open_session`; any live → `choose` (live + pending slots);
  no slots → `empty`; one slot → `activate_slot`; else `choose` all-pending.
- **Proposed combinator.** Steer-style direct pipeline (mixed transforms +
  final decide stage), one ctx threaded `.pipe(stage, 'ctx', 'ctx')`, ending
  `.end('ctx')` — the closest daemon template for transform-heavy resolvers.
  A pure `decisionRun` would force the map-building into gates awkwardly;
  direct composition matches the ADR default.
- **Input/output snapshot design.** `ResolveNodeClickArgs` is already a pure
  snapshot (arrays + two label/normalize function ports). Ctx extends it with
  `liveSessions: NodeLiveSession[]`, `unstartedSlots: string[]`,
  `outcome: NodeClickOutcome | null`. The `normalize` resolution
  (`args.normalizeSlotName ?? normalizeSlotName`) happens in the wrapper.
- **Pure core design.** Stages (each `(ctx) => ctx`, pure):
  `stageIndexExecutions` (phase 1, builds both maps, keeps the
  `declaredSlotNamesExact` set on ctx), `stageMergeActivityMembers` (phase 2),
  `stageApplyPostApprovalOverride` (phase 3 — note it mutates `liveBySession`
  today; stage returns a fresh map to stay allocation-honest), and
  `stageFinalizeOutcome` (phase 4: sorts live by slot order, computes
  unstarted, stamps `outcome` — the precedence stays one stage because it is
  a 4-way value computation over already-materialized data, not independent
  gates). Final `.pipe('!outcomeStamped', 'ctx')` halt guard after the
  finalize stage, or simply order finalize last and end on ctx.
- **Shell/effect wiring.** The click handler in `SpaceTaskPane.tsx` stays the
  shell — it already interprets the outcome union (`open_session` → navigate,
  `activate_slot`/`choose` → overlays). No changes there.
- **Step-by-step migration.**
  1. Audit `src/lib/__tests__/node-click-resolver.test.ts` for the tricky
     rows: exec-authoritative session overriding a stale member session;
     post-approval override deleting same-agent stale sessions AND the
     `postApprovalNodeId`-absent → `isDeclaredSlot` path; cancelled/pending
     exclusions. Add any missing rows first.
  2. Convert phases to exported stages (no behavior change); thread ctx;
     compose `superpipe` pipeline `'resolve-node-click'` at module scope with
     the daemon `as PipelineAPI` cast idiom.
  3. Wrapper `resolveNodeClick(args)` seeds derived fields as empty/absent and
     returns `ctx.outcome`.
- **Tests.** Characterization suite green + new precedence rows (single live
  + no unstarted; live + unstarted mixed choose; zero slots; single slot
  activate).
- **Risks/caveats.** The member-merge loop mutates `existing.label` /
  `existing.nodeExecutionId` on entries created by phase 1 — preserve exact
  merge semantics by copying entries in the stage rather than sharing objects
  across stages (a later stage seeing a half-mutated shared object is fine
  today only because phases run strictly in order; the pipeline keeps that
  order, but fresh objects make stages independently testable). Label
  function port (`resolveLabel`) is injected per call — stays in ctx.

### `packages/web/src/lib/task-banner.ts:resolveActiveTaskBanner`

- **Current summary.** Four-banner precedence: `blocked` status →
  `post_approval_blocked` (only when status `approved` AND trimmed reason
  non-empty) → `task_completion_pending` (checkpoint `task_completion` AND
  status `review`) → `hook_pending` (workflowRunId present AND any hook
  blocked/retrying) → `null`. Runs per `SpaceTaskPane` render.
- **Proposed combinator.** `decisionRun` — minimal, ideal first migration.
- **Input/output snapshot design.** Ctx = `{ task: TaskBannerInput; hooks?:
  readonly HookBannerSummary[]; decision: ActiveTaskBanner | null }`. Note
  `null` is itself a legitimate decision here — use a `'none'`-style sentinel?
  No: `decisionRun` halts on `!== null`, and the terminal gate deciding the
  literal `null` would never halt. Instead the terminal gate decides a
  `{ kind: 'none' }`-shaped sentinel (or simply: only four gates, no terminal
  gate — wrapper returns `ctx.decision ?? null`). Prefer the latter: no
  sentinel type pollution, `null` stays the default.
- **Pure core design.** Gates: `gateTaskBlocked` → `gatePostApprovalBlocked`
  → `gateTaskCompletionPending` → `gateHookPending`. Each returns ctx
  untouched when its predicate fails. No terminal gate.
- **Shell/effect wiring.** None; the component renders from the returned
  union unchanged.
- **Step-by-step migration.**
  1. Verify `src/lib/__tests__/task-banner.test.ts` covers all four banners
     AND the compound conditions (approved-without-reason falls through;
     review-without-checkpoint falls through; hooks present without
     workflowRunId falls through). Add missing rows.
  2. Extract gates; compose `decisionRun('active-task-banner', [...])`;
     wrapper keeps signature returning `ctx.decision ?? null`.
- **Tests.** Existing suite + precedence-order rows.
- **Risks/caveats.** Render-path cadence — trivial per-run cost, but keep the
  pipeline at module scope (component re-mounts in tests must not rebuild it;
  module scope makes it free). The `.trim()` truthiness in the post-approval
  gate must survive verbatim (`''` reason falls through).

### `packages/web/src/lib/router.ts` — path parsing functions

- **Current summary.** `getSpaceIdFromPath` is a 14-pattern ordered regex
  cascade (configure-tab → configure → archived-tasks → tasks-tab → goals →
  memories → evolve → forge → tasks → sessions-list → agent-detail →
  task-view → task → space-session → agent-list → bare space). Siblings
  `getSpaceEvolveFromPath` (evolve|forge), `getSpaceTasksTabFromPath`
  (archived→completed | explicit tab) are two-gate versions.
  `applyPathToSignals` (module-private) re-derives 13 match variables then
  runs a 16-branch else-if signal-write cascade inside `batch()`, with two
  legacy redirect writes (`/tasks/archived` → `completed`, `/forge` →
  `/evolve`) before matching.
- **Proposed combinator.** `decisionRun` for the parsers. For
  `applyPathToSignals`, a follow-on `classifySpaceRoute` decisionRun
  (pure match union) with the signal writes staying as the imperative shell
  inside `batch()` — scoped as phase 2 because it restructures the file's
  core; the parsers alone deliver most of the value at near-zero risk.
- **Input/output snapshot design.** Parser ctx: `{ path: string; decision:
  string | null }`; final gate decides `null` (no match) — same null-default
  caveat as task-banner, handled by `?? null` in the wrapper, no terminal
  gate. Phase-2 classifier ctx: `{ path, search }`, decision
  `SpaceRouteMatch` union (`session | spaceTask | spaceSession |
  spaceAgentDetail | spaceAgentList | spaceGoals | spaceMemories |
  spaceEvolve | spaceTasks | spaceSessions | spaceConfigure | spaceRoot |
  sessionsList | spacesList | settings | sessionFallback)` mirroring the
  current else-if order exactly.
- **Pure core design.** One gate per pattern, each owning its regex constant
  verbatim and deciding `match[1]`; order = current order. The classifier's
  gates reuse the same pattern constants and the `getXFromPath` helpers where
  they already encapsulate dual-pattern logic; the legacy redirect writes
  remain in the shell BEFORE the classifier runs (they are effects:
  `history.replaceState`).
- **Shell/effect wiring.** Phase 2's shell: run legacy redirects →
  `classifySpaceRoute(path, search)` → one switch over the union writing
  signals inside `batch()`. Signal writes never enter gates.
- **Step-by-step migration.**
  1. Confirm `src/lib/__tests__/router.test.ts`,
     `router-space-slug.test.ts`, `router-lifecycle-recovery.test.ts`,
     `overlay-history.test.ts` pin the parser matrix (every route shape,
     case sensitivity of session ids, task-id alternation
     `[a-fA-F0-9-]+|[a-z]-[1-9]\d*`). Add missing rows first.
  2. Migrate `getSpaceIdFromPath` to `decisionRun('space-id-from-path',
     [...14 gates])`; wrapper returns `ctx.decision`.
  3. Optionally fold `getSpaceEvolveFromPath` / `getSpaceTasksTabFromPath`
     into the same gate style (small, independent).
  4. Phase 2 (separate PR): extract `classifySpaceRoute`; rewrite
     `applyPathToSignals` match section to consume the union; keep the
     `batch()` write block as the interpretation switch.
- **Tests.** Parser suites stay green unchanged; phase 2 adds a
  `classifySpaceRoute` decision-table test (path → union member, including
  `/` → spacesList and unknown → sessionFallback).
- **Risks/caveats.** Regex order is behavior (e.g. agent-detail before
  agent-list; task-view before task). `getSpaceIdFromPath` currently has no
  external production callers — changes are contained to popstate/init.
  Phase 2 touches the app's routing spine: land it behind the full router
  test set and a manual nav smoke (`make dev`, walk every route + back/forward
  + overlay open/close). `handlePopState`'s overlay short-circuit stays
  untouched — it precedes `applyPathToSignals` and is an effect guard, not a
  parse decision.

### `packages/web/src/lib/session-load-error.ts:classifySessionLoadError`

- **Current summary.** Message-substring classification
  (disconnected / timeout / not-found / unauthorized) takes precedence; only
  when no message match, the connection state
  (`disconnected|reconnecting|connecting`) implies `disconnected`; else
  `unknown`. Message text is user-facing mapped via `loadErrorMessage`.
- **Proposed combinator.** `decisionRun` (query-retry template — keep
  `classifyByMessage` intact as gate bodies).
- **Input/output snapshot design.** Wrapper normalizes `err` to
  `{ raw, lower }` (plain transform; `JSON.stringify`-safe `String(err ?? '')`
  path preserved). Ctx = `{ raw: string; lower: string; conn:
  ConnectionState; decision: SessionLoadErrorKind | null }`; no terminal gate —
  a final `gateConnectionState` decides `disconnected` or leaves undecided,
  wrapper maps `ctx.decision ?? 'unknown'` then `loadErrorMessage`.
- **Pure core design.** Gates: `gateMessageDisconnected` →
  `gateMessageTimeout` → `gateMessageNotFound` → `gateMessageUnauthorized` →
  `gateConnectionState`. Each message gate is a one-predicate function over
  `ctx.lower`, keeping the substring lists verbatim.
- **Shell/effect wiring.** None; `session-store.ts` catch path and
  `UnavailableSessionView` rendering are unchanged consumers.
- **Step-by-step migration.**
  1. Check `src/lib/__tests__/session-load-error.test.ts` for the precedence
     pair "message match beats connected-but-degraded conn state" and the
     `reconnecting`/`connecting` inclusion; add rows if absent.
  2. Extract gates; compose `decisionRun('session-load-error', [...])`;
     wrapper keeps the exported signature `{ kind, message }`.
- **Tests.** Existing suite + precedence rows.
- **Risks/caveats.** None significant — pure, cold, fully test-covered shape.
  `describeUnavailable` and `isHardUnavailable` are out of scope (simple
  switches over a classified kind, not cascades).

### `packages/web/src/lib/user-error.ts:sanitizeUserError`

- **Current summary.** Normalize unknown error → string (Error.message /
  string / safe JSON / String); non-internal non-empty messages pass through
  unchanged (`msg || 'Something went wrong.'`); internal-looking messages map
  to friendly strings by substring (websocket/connection → queue promise;
  timeout; econn; fetch; failed-to-send) with a generic tail. Also exports
  `isAuthError` / `isTransientError` (boolean matchers, out of scope —
  flat predicates, not cascades).
- **Proposed combinator.** `decisionRun`.
- **Input/output snapshot design.** Wrapper owns normalization (the
  try/catch JSON path). Ctx = `{ msg: string; lower: string; decision:
  string | null }`; no terminal gate; wrapper returns `ctx.decision ??
  'Something went wrong. Please try again.'`.
- **Pure core design.** Gates: `gatePassThrough` (decides `msg` when NOT
  `isInternalMessage(msg)` — the `msg || 'Something went wrong.'` empty-string
  fallback folds in here) → `gateConnectionLost` (websocket / not connected) →
  `gateTimeout` → `gateEconn` (econnrefused / econnreset) → `gateFetch` →
  `gateFailedToSend`. Substring lists move verbatim; note current order checks
  `websocket` before `timeout` before `econn` before `fetch` — preserved.
- **Shell/effect wiring.** None. Consumers: `useSendMessage` catch,
  `outbound-queue` flush loop, plus `isAuthError` in `connection-manager`
  (untouched).
- **Step-by-step migration.**
  1. `src/lib/__tests__/user-error.test.ts` exists — audit for: Error vs
     string vs object inputs, circular-object `JSON.stringify` throw path,
     pass-through of internal-free messages, each mapping arm, arm ORDER
     (a message matching both `timeout` and `fetch` substrings must map to
     timeout). Add missing rows first.
  2. Extract gates; compose `decisionRun('sanitize-user-error', [...])`.
- **Tests.** Existing suite green; order-pair rows added.
- **Risks/caveats.** Cold paths only, but `outbound-queue` calls it in a
  flush loop — module-scope instance, gate count 6, negligible. Keep
  `INTERNAL_PATTERNS` untouched (regex behavior is the security-ish boundary
  here; characterization tests are the guard).

### `packages/web/src/lib/session-utils.ts:getModelLabel`

- **Current summary.** Provider-aware display-label formatter: claude family
  (date-suffix strip, two-part `Family Number`, capitalized fallback), GLM
  (suffix joined), Kimi (three exact-match special cases then dash→space),
  Moonshot, generic dash→space + camel-case split. **Zero production
  importers** — `SessionsPage.tsx:115` carries a divergent local
  `getModelLabel` (name-or-dash-replace, no provider awareness). Lib version
  is test-covered only.
- **Proposed combinator.** `decisionRun`.
- **Input/output snapshot design.** Ctx = `{ modelId: string; lower: string;
  decision: string | null }`; wrapper guards the falsy early-out
  (`!modelId → ''`) before invoking the pipeline (or a first gate decides
  `''`; prefer the wrapper guard — `null`/`undefined` input never reaches
  gates).
- **Pure core design.** Gates: `gateClaudeLabel` → `gateGlmLabel` →
  `gateKimiLabel` (exact-match table + generic) → `gateMoonshotLabel` →
  `gateGenericLabel` (terminal, always decides the dash/camel transform).
  All string surgery moves verbatim.
- **Shell/effect wiring.** None today. If the SessionsPage convergence (open
  question) lands, add a module-level `Map<string, string>` memo cache in the
  wrapper keyed by `modelId` — render-path per-item calls then cost one map
  hit after the first.
- **Step-by-step migration.**
  1. `src/lib/__tests__/session-utils.test.ts` exists — extend with the
     special cases (`kimi-k3`, `kimi-k2.7-code(-highspeed)`, claude
     date-suffix, single-part families).
  2. Extract gates; compose `decisionRun('model-label', [...])`; wrapper
     keeps signature.
- **Tests.** Suite above.
- **Risks/caveats.** Lowest-value migration in the set given zero production
  callers — schedule it last / make it optional; the real work here is the
  convergence decision, not the pipeline. Do not silently change
  SessionsPage's local copy in this migration (behavior differs by design —
  it labels by display name first).

### `packages/web/src/lib/provider-brand.ts:shortenModelName`

- **Current summary.** Sequential string scrubs: trim; openrouter (aggregator)
  vendor-prefix strip; trailing `(Provider)` tag strip; provider-keyed
  redundant brand-prefix strip (`Claude `, `Kimi K\d`, `MiniMax `,
  `Copilot `). Called in render bodies and per-item in model dropdowns
  (`NewChatModelPicker`, `SessionStatusBar`).
- **Proposed combinator.** Raw P1 transform pipeline (ordered scrubs, not a
  precedence decision — nothing here is first-match-wins).
- **Input/output snapshot design.** Ctx = `{ name: string; provider?:
  string; value: string }`; wrapper trims the empty early-out.
- **Pure core design.** Stages: `stageStripVendorPrefix` (guarded on
  `AGGREGATOR_PROVIDERS.has(provider)` — model the guard inside the stage
  rather than `?dep`, since the provider key presence is the condition, not
  output absence) → `stageStripTrailingProviderTag` →
  `stageStripRedundantBrandPrefix` (`?dep`-friendly: skips cleanly when no
  regex for the provider). `.end('value')`.
- **Shell/effect wiring.** None; pure.
- **Step-by-step migration.**
  1. `src/lib/__tests__/provider-brand.test.ts` exists — pin each scrub in
     isolation AND composition (openrouter `vendor: model (Kimi)` loses both
     wrappers; kimi `Kimi K3` keeps `K3`).
  2. Compose `superpipe('shorten-model-name')` pipeline; wrapper keeps
     `(name, provider?) => string`.
- **Tests.** Suite above.
- **Risks/caveats.** Per-item render cadence in two components. Pipeline run
  is ~µs but the dropdown loops multiply it; acceptable, and cheap to
  neutralize — either a module-level `Map<name+provider, string>` cache in
  the wrapper (model lists are small, stable), or `useMemo` the label arrays
  at the two call sites (preferred; no lib change). Flag in review whichever
  lands. `getProviderBrandColor` and the style helpers are out of scope.

### `packages/web/src/hooks/useTargetSessionContext.ts:resolveTargetSessionId`

- **Current summary.** Pure function (also called in the pre-config apply
  effect's target loop): filter activity members through `matchesNodeAndName`
  (kind/status guards; exact exec-id match; post-approval requires exact
  name; node-id scoping; normalized name matching), prefer the
  post-approval member else the first candidate, then the exec-session
  override (when the target has no exec id but a known exec session id that
  disagrees with the resolved one, trust the exec session id).
- **Proposed combinator.** Steer-style direct pipeline (transform-heavy,
  single decide at the end).
- **Input/output snapshot design.** Ctx = `{ target; activityMembers;
  candidates: SpaceTaskActivityMember[]; resolved: string | null }`; the
  `normalizeTargetName` helper stays module-scope.
- **Pure core design.** Stages: `stageFilterCandidates` (owns
  `matchesNodeAndName` verbatim as a local predicate — it is a compound
  matcher, not a cascade; do not decompose further) → `stageSelectCurrent`
  (post-approval preference, `sessionId ?? null`) → `stageApplyExecOverride`
  (stamps `resolved`). Wrapper returns `ctx.resolved`; null-target early-out
  stays in the wrapper.
- **Shell/effect wiring.** None — the hook's `useMemo` and the pre-config
  effect keep calling the same exported function.
- **Step-by-step migration.**
  1. `src/hooks/__tests__/useTargetSessionContext.test.ts` exists — audit for
     the override rule (disagreeing `nodeExecutionSessionId` wins when target
     has no `nodeExecutionId`), the exact-name requirement for post-approval
     members, cancelled/pending exclusion. Add rows first.
  2. Extract stages; compose `'resolve-target-session'`; wrapper unchanged.
- **Tests.** Suite above; keep hook-level tests green.
- **Risks/caveats.** The `?? candidates[0]` head-selection and the override's
  three-condition guard (`!target.nodeExecutionId && execSessionId &&
  resolved !== execSessionId`) are the subtle bits — copy them atomically.
  Moderate call cadence (memo + effect loop) is fine. The hook's latch logic
  (refs, render-phase writes) is explicitly OUT of scope — resource/state
  ownership stays in the hook per ADR Decision 5.

### `packages/web/src/hooks/useSendMessage.ts:sendMessage`

- **Current summary.** The prompt suggested `stagedRun`; this plan deviates
  deliberately. Flow: (1) reject empty content / busy-unqueueable; (2) reject
  archived with toast; (3) offline → enqueue outbound action + toast + return
  true; (4) `onSendStart()`, arm 15s timeout (calls `onSendComplete` +
  `onError` + error toast on fire); (5) connected-but-no-hub race → enqueue
  (non-immediate) + toast + `onSendComplete()` + clear timeout + return true;
  (6) build payload (deliveryMode only when non-immediate), await
  `hub.request('message.send')`, `onMessageAccepted` on messageId, clear
  timeout, return true; (7) catch → `sanitizeUserError`, `onError`, toast,
  `onSendComplete`, clear timeout, return false.
  `stagedRun`'s value is compensation chains over CAS-guarded writes; this
  flow has no compensable multi-stage state — its early exits are
  data-dependent halts (`!dep`), and its one await is an idempotent request
  with UI-side interpretation. A direct mixed pipeline (ADR default) is the
  honest shape; porting 738 lines of stagedRun machinery for one caller is
  not.
- **Proposed combinator.** Direct mixed pipeline, migrated in two
  independently shippable steps: Step 1 admission `decisionRun`; Step 2 full
  pipeline with async effect stages.
- **Input/output snapshot design.** Step 1 ctx: `{ content, images?,
  deliveryMode, sessionStatus, isSending, allowQueueWhileProcessing,
  isConnected, decision }` with decision union `'rejectEmpty' |
  'rejectArchived' | 'queueOffline' | 'send'`. The hook
  snapshots `session?.status`, `isSending`, and
  `connectionState.value === 'connected'` at the call boundary — no signal
  reads inside gates. Review correction: the live `getHubIfConnected()` read
  is deliberately NOT part of this snapshot — the current code performs it
  after `onSendStart()` and timeout arming, and hoisting it earlier changes
  behavior during connect/disconnect transitions (an early read can choose
  `send` with a hub that has since dropped, or queue when a hub is about to
  appear). The hub race stays a dynamic stage after the startup effects (see
  pure core design). Step 2 extends ctx with ports: `{ request:
  (payload) => Promise<{ messageId?: string }>, enqueue: (label, payload,
  immediate) => void, onSendStart, onSendComplete, onError, onMessageAccepted,
  armTimeout, clearTimeout, toastError, toastInfo }` and `outcome:
  boolean | null` — all supplied fresh per call from the hook's `useCallback`
  closures (functions pass through gate spreads by reference).
- **Pure core design.** Step 1 gates: `gateContentPresent` (decides
  `rejectEmpty` on blank/`isSending && !allowQueueWhileProcessing`) →
  `gateSessionArchived` → `gateOffline` → `gateSend` (terminal — when the
  connection-state snapshot says `connected`). The hub race is NOT an
  admission gate (review correction): `stageSendRequest` re-reads the hub
  dynamically via a `getHub` port immediately after the startup effects, and
  diverts to the queue arm when it comes back empty, preserving the current
  ordering (`onSendStart` → arm timeout → hub read). Payload assembly is a
  pure `stageBuildPayload` before effect stages. Step 2 stage order:
  admission gates → interpret-decision stage(s): the queue/reject arms
  run their effects and stamp `outcome`, then a `!outcomeStamped`-style halt
  guard; the `send` arm continues through `stageSendRequest` (async effect:
  `onSendStart`, arm timeout, live `getHub()` read with queue divert, await
  request, `onMessageAccepted`, clear
  timeout, stamp outcome). Timeout resource stays in the hook (ref owned by
  the hook per ADR Decision 5 — pipeline receives `armTimeout`/`clearTimeout`
  values). Errors: `stageSendRequest` throws propagate out of `.endAsync`;
  the shell (the `useCallback` body) keeps the existing catch and performs
  sanitize/toast/complete/clear interpretation.
- **Shell/effect wiring.** The hook keeps `clearSendTimeout` and the ref; the
  `sendMessage` `useCallback` shrinks to: snapshot inputs → build ports →
  `await sendMessagePipeline(input)` → catch → interpret. Dependency array
  unchanged in substance (ports capture the same closures).
- **Step-by-step migration.**
  1. Audit `src/hooks/__tests__/useSendMessage.test.ts` and
     `ChatContainerSendOverride.test.ts` for: empty-content false,
     busy-unqueueable false, archived toast+false, offline enqueue+true,
     race enqueue+`onSendComplete`+true, success path (`onSendStart` order,
  messageId callback, timeout cleared), failure path (sanitized message,
     `onSendComplete`, timeout cleared), timeout fire path. Add missing rows
     FIRST — the effect ordering (onSendStart before hub check) is
     behavior.
  2. Step 1: extract admission gates into
     `src/lib/send-message-pipeline.ts` (keeps the hook file lean and makes
     the pipeline unit-testable without the hook harness); hook interprets
     the decision with the existing imperative bodies. Ship.
  3. Step 2: fold the send/queue effect bodies into the direct pipeline as
     stages over injected ports; hook shell reduces to snapshot + run +
     error interpretation. `SEND_TIMEOUT_MS` stays module-scope; the hook's
     arm callback closes over it.
  4. Keep `clearSendTimeout` exported behavior identical (unmount cleanup
     paths depend on it).
- **Tests.** Characterization set above stays green through both steps
  (that is the parity proof); add a pipeline-level unit test for the
  admission decision table (pure, no mocking) once Step 1 lands.
- **Risks/caveats.** Hook-closure staleness is the top risk: every value a
  gate reads must flow through the per-call input object, never through
  captured stale state — the current `useCallback` deps list is the checklist
  for what the snapshot must carry. The offline-enqueue label truncation
  (`> 40` chars + ellipsis) is duplicated today in two branches; unify into
  one helper during Step 2 (behavior-preserving, covered by tests). Do not
  move `toast` calls into module scope; they are ports. The timeout's
  `onSendComplete` + `onError` + toast triple on fire must remain exactly
  once per fired timer; the hook-owned ref guarantees that — the pipeline
  never re-arms.

## Suggested migration order

Each step is one PR-sized unit; every step keeps `bun run check` and the
site's Vitest suite green.

1. **Prerequisite spike** — superpipe dep in `packages/web`, build/vitest/dev
   verification; `src/lib/pipelines/decision-run.ts` + parity test. Blocks
   everything else.
2. **`task-banner`** — smallest decisionRun; establishes the web conventions
   (gates, module-scope instance, wrapper) with an existing test suite.
3. **`session-load-error`** — same shape, query-retry template.
4. **`user-error`** — same shape, order-sensitive arms.
5. **`app-routing`** — first "real" consumer (signal effect caller); pure
   precedence.
6. **`router` parsers** — `getSpaceIdFromPath` decisionRun (+ the two small
   siblings). Phase 2 (`classifySpaceRoute` + `applyPathToSignals` rewrite)
   is a separate later PR.
7. **`status-actions`** — needs the fallback-rotation shim; first
   cadence-sensitive site (streaming ticks).
8. **`parse-group-message`** — new characterization file first (only site
   without one), then decisionRun; first per-event reducer body.
9. **`useModelSwitcher` transforms** — `inferProviderFromModelId`, then
   `classifyModelFamily`, then the map pipeline.
10. **`resolveTargetSessionId`** — first steer-style direct pipeline.
11. **`resolveNodeClick`** — the meaty direct pipeline; benefits from
    conventions built in step 10.
12. **`sendMessage` Step 1** (admission decisionRun) — first hook-resident
    interpretation; zero async changes.
13. **`shortenModelName`** — P1 transform; land with the call-site memoization
    decision.
14. **`getModelLabel`** — optional/last; gated on the SessionsPage
    convergence open question.
15. **`sendMessage` Step 2** — full async pipeline; lands last with the
    strongest characterization net.
16. *(Optional follow-up)* router phase 2, if the else-if cascade in
    `applyPathToSignals` is still deemed worth restructuring.

## Open questions

1. **`decisionRun` home.** Web-local copy (recommended) vs extracting to
   `@hyperneo/shared` (couples the types package to the engine, touches
   daemon/cli) vs direct-only. Revisit extraction when a third package wants
   the combinator; until then the 19-line duplication is the cheaper bill.
2. **SessionsPage `getModelLabel` divergence.** `lib/session-utils` exports a
   provider-aware formatter with zero production callers while
   `SessionsPage.tsx` runs a divergent local copy (display-name-first, no
   provider awareness). Converge on one (which semantics?), or delete the lib
   version? The pipeline migration is only worth it if the lib version
   survives this decision.
3. **Router phase 2 appetite.** Is restructuring `applyPathToSignals` around
   a `classifySpaceRoute` union wanted at all, or do the migrated parsers
   (plus tests) suffice? The else-if signal cascade is the largest remaining
   hand-rolled gate chain in web, but it is also stable and fully covered;
   the rewrite touches the routing spine for modest readability gain.
4. **`getCurrentAction` purity.** The streaming-duration `Date.now()` and the
   shell-owned fallback rotator are acceptable impurities for now; if we ever
   want deterministic pipeline-level tests, inject `now` and a rotation
   counter through the input snapshot. Worth doing only when a test actually
   needs it.
5. **`shortenModelName` memoization placement.** Wrapper-level module cache
   vs `useMemo` at the two dropdown call sites vs neither (measure first).
   Prefer call-site memoization to keep the lib stateless.
6. **Bundle impact sign-off.** The step-0 spike verifies resolution, but the
   first production build should be eyeballed for bundle-size delta before
   the PR merges (superpipe is small; confirm, don't assume).
7. **E2E coverage.** Current plan adds none (unit + characterization suffice
   per repo guidance). If `sendMessage` Step 2 lands, decide whether one
   browser-level send/queue/reconnect flow is warranted — it would be the
   only E2E in this set.
