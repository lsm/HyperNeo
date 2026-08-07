# Module Decomposition Program

A bounded, recurring side-stream that incrementally decomposes HyperNeo's oversized
production and test files through small, behavior-preserving changes. Each increment is
one reviewed extraction behind an existing facade.

This document is the program's continuity anchor: the rubric, the dependency-direction
rules, the baseline inventory, and the log of completed increments. Read it before
selecting the next module.

## Guiding principles

The goal is **better seams**, not smaller files. We never optimize for line count.

- **One responsibility family per increment.** A family is a set of functions/types that
  share a single cohesive concern and have a closed internal dependency boundary.
- **Behavior-preserving.** Move code verbatim; do not refactor logic in the same change.
  Observable output, initialization order, and import paths stay identical.
- **Keep public facades during migration.** Existing exports of the source module are
  preserved (re-export from the new module) until callers are migrated and a follow-up
  increment retires them deliberately.
- **Pure functions for deterministic policy/transformations.** The best first extractions
  are leaf modules with no dependencies on the rest of the file — pure
  `input → value` functions.
- **Composed state owners for mutable invariants; imperative shells for transactions and
  external effects.** These are extracted later and only when their boundary is clean.

## What we do NOT do

- Line-count reduction as a goal.
- Wholesale OOP-to-functional rewrites.
- Arbitrary file splitting ("just break it in half").
- Premature promotion to new workspace packages.
- Unrelated cleanup bundled into an extraction PR.

## Extraction rubric (how we rank candidate seams)

A seam is worth extracting when it scores well on **all four**, in priority order:

| Priority | Criterion | What "good" looks like |
|---|---|---|
| 1 | **Cohesion** | The functions form one concern with a closed internal dependency boundary; nothing outside the family is needed. |
| 2 | **Churn / conflict reduction** | Extracting it isolates stable code from a frequently-edited file, shrinking the merge-conflict surface. |
| 3 | **Test coverage** | Existing tests pin behavior, OR the family is pure enough to add fast characterization tests easily. |
| 4 | **Regression risk** | Low: pure, deterministic, clearly-typed inputs/outputs. Avoid starting with stateful or effectful code. |

Raw file size is **not** a criterion. A 6k-line file of cohesive, well-tested code with
clean seams is lower priority than a 2k-line file that mixes five concerns.

## Dependency-direction rules

- A new module may only depend **downward** (toward more primitive leaves) or sideways on
  stable shared types. It must not reach back into the module it was extracted from, nor
  into higher-level orchestration.
- The extracted family's external surface is a **narrow capability**: the minimum set of
  pure functions / types callers need. Internal helpers stay module-private.
- Re-exports used only to preserve the facade during migration are explicitly marked as
  such (comment) and tracked for retirement.

## Baseline inventory (production, top by size)

Snapshot at program start. Size is context, not priority.

| File | Lines | Notes |
|---|---|---|
| `storage/schema/migrations.ts` | 11555 | Append-only migration history; do not split arbitrarily. |
| `space/runtime/space-runtime.ts` | 10303 | Core orchestrator; high regression risk — extract only narrow pure helpers. |
| `space/tools/space-agent-tools.ts` | 5559 | Single giant factory closure; hard seams; start with top-level pure helpers. |
| `space/runtime/task-agent-manager.ts` | 5155 | Stateful; defer. |
| `rpc-handlers/live-query-handlers.ts` | 4104 | Registry + many pure mappers/transformers; **good source of leaf extractions**. |

Test files mirror these and are addressed alongside their production module.

## Pilot

**`activity-preview.ts`** — extracted from `rpc-handlers/live-query-handlers.ts`.

- **Family:** active-turn activity rendering — translating raw activity rows / tool inputs
  into human-readable one-line previews and summary entries.
- **Why it scored highest:** zero dependencies on the rest of the file (pure
  `Record<string,unknown>` / string / number → primitive), single cohesive concern, the
  aggregator already has unit tests, and the leaf formatters had **no** direct unit tests
  (a coverage gap to close in the same increment).
- **Facade:** `buildActiveTurnSummariesFromRows` stays exported from
  `live-query-handlers.ts` (re-exported from the new module) so existing dynamic-import
  tests and the `NAMED_QUERY_REGISTRY` mapper are untouched.

## Increment 2

**`external-events/github-subscription-pattern.ts`** — extracted the GitHub event
subscription topic grammar.

- **Family:** parsing and composing the GitHub branch of the subscription topic language
  (`github/<owner>/<repo>/<resource>/<entity>.<action>`) — pure `string → string | null`
  helpers with a closed internal dependency boundary.
- **Why it scored highest:**
  - *Cohesion:* nine members (one entry point, `composeGitHubSubscriptionPattern`, plus
    private validators/splitters) that call only each other; no dependencies on the rest of
    either host file.
  - *Churn / conflict:* the family was **duplicated verbatim** across
    `space/runtime/space-runtime.ts` (largest file, ~157 commits/yr) **and**
    `rpc-handlers/space-long-horizon-agent-handlers.ts`. Extracting the canonical leaf and
    consolidating both copies removes a real merge-conflict surface from two high-churn files.
    (Verified byte-identical pre-move via `diff`, exit 0 — so consolidation is provably
    behavior-preserving.)
  - *Coverage:* the family had **no** direct unit tests; characterization tests now pin
    every branch of `composeGitHubSubscriptionPattern` and `legacyGitHubTopic`.
  - *Regression risk:* low — pure functions, all module-private (no external callers), so
    no facade re-export was needed.
- **Narrow surface:** only `composeGitHubSubscriptionPattern` and `legacyGitHubTopic` are
  exported; the six validators/splitters and the `GITHUB_EVENT_RESOURCES` constant stay
  module-private.
- **Dependency direction:** the new leaf lives in `external-events/` (alongside
  `topic-validator.ts`); both consumers already depended downward on `external-events/`, so
  no new direction was introduced.
- **Deferred:** `composeLongHorizonSubscriptionPattern` is also duplicated but depends on
  `KNOWN_SOURCES` / `validateGlobPattern`; it is less pure and was left in place in both
  files (now calling the shared leaf). A follow-up increment can extract it once this leaf
  lands.

## Increment log

| # | Module extracted | From | PR | Outcome |
|---|---|---|---|---|
| 1 | `rpc-handlers/activity-preview.ts` | `live-query-handlers.ts` | #2383 | Pure leaf family moved behind facade; characterization tests added for previously-untested formatters. |
| 2 | `external-events/github-subscription-pattern.ts` | `space/runtime/space-runtime.ts` + `rpc-handlers/space-long-horizon-agent-handlers.ts` | _(this PR)_ | Pure GitHub topic-grammar leaf extracted; verbatim duplicate across two files consolidated behind a 2-function surface; characterization tests added for every branch. |
