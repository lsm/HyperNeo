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

## Increment 3

**`external-events/long-horizon-subscription-pattern.ts`** — extracted the
long-horizon subscription topic composer, completing the subscription-pattern
seam started in Increment 2 (the item previously marked "deferred").

- **Family:** joining a subscription `source` and `topic` into a glob subscription
  pattern — trimming, branching to the GitHub topic grammar
  (`composeGitHubSubscriptionPattern`) when the source is `github`, echoing a
  non-github topic whose leading segment already equals the source, guarding
  against a known-source mismatch, and otherwise returning `source/topic`. Pure
  `(string, string) → string | throws`.
- **Why it scored highest:**
  - *Cohesion:* one function with a closed internal dependency boundary; it reaches
    only downward to two sibling leaves — `KNOWN_SOURCES` from `topic-validator`
    and `composeGitHubSubscriptionPattern` from `github-subscription-pattern`.
  - *Churn / conflict:* the function was **duplicated verbatim** across
    `space/runtime/space-runtime.ts` (~162 commits/yr — the highest-churn
    production file) **and** `rpc-handlers/space-long-horizon-agent-handlers.ts`.
    Verified byte-identical pre-move via `diff` (exit 0), so consolidation is
    provably behavior-preserving and removes a real merge-conflict surface from a
    hot file.
  - *Coverage:* the function had **no** direct unit tests in either host;
    characterization tests now pin every branch (empty-source passthrough, the
    three github delegations, non-github source-prefixed passthrough, all three
    known-source mismatch throws, and the generic join).
  - *Regression risk:* low — pure deterministic function; both copies were
    byte-identical; the two consumer test suites (`space-runtime-external-events`,
    187 tests; `space-long-horizon-agent-handlers`, 40 tests) pass unchanged.
- **Narrow surface:** only `composeLongHorizonSubscriptionPattern` is exported.
- **Dependency direction:** the new leaf lives in `external-events/` alongside the
  two leaves it depends on; both consumers already imported downward from
  `external-events/`, so no new direction was introduced. The now-unused
  `KNOWN_SOURCES` / `composeGitHubSubscriptionPattern` imports were removed from
  both consumers (their remaining `validate*` / `legacyGitHubTopic` imports stay).
- **Note:** `validateLongHorizonSubscriptionPattern` — a thin non-duplicated wrapper
  in `space-long-horizon-agent-handlers.ts` — was intentionally left in place; it
  now calls the shared leaf. Extracting it would not consolidate anything and would
  widen the surface, so it stays put.

## Increment 4

**`space/agent-handle.ts`** — extracted the agent handle / name-token normalization
family from `space/tools/space-agent-tools.ts`.

- **Family:** normalizing Space agent name tokens and deriving canonical reply
  target handles — pure `string → string | null | boolean` helpers. Four members:
  `normalizeAgentNameToken` (trim + lowercase for case/whitespace-insensitive
  comparison), `normalizeReplyTargetHandle` (empty → null, literal `space-agent` →
  `@coordinator`, `@`-prefixed passthrough, otherwise slugify), `isReservedAgentHandle`
  (reserved-singleton membership), and the module-private `handleFromName` (the
  slugifier `normalizeReplyTargetHandle` calls).
- **Why it scored highest:**
  - *Cohesion:* all four share one concern — agent handle/name normalization — with
    a closed internal dependency boundary (`normalizeReplyTargetHandle` →
    `handleFromName`; `isReservedAgentHandle` → `RESERVED_SPACE_AGENT_HANDLES` from
    `./slug`). Nothing else from either host file is needed.
  - *Churn / conflict:* `normalizeAgentNameToken` was **duplicated verbatim** across
    `space/tools/space-agent-tools.ts` (~84 commits/yr) **and**
    `space/tools/node-agent-tools.ts` (~63 commits/yr). Verified byte-identical
    pre-move via `diff` (exit 0), so consolidating the canonical leaf behind one
    import removes a real merge-conflict surface from two large tool files (15 call
    sites total).
  - *Coverage:* none of the four had **any** direct unit tests; characterization
    tests now pin every branch — including a non-obvious one the characterization
    pass itself surfaced (a leading `@` short-circuits slugification, so
    `normalizeReplyTargetHandle('@@@')` returns `'@@@'`, not `null`).
  - *Regression risk:* low — pure deterministic functions; the duplicated copy was
    byte-identical; both consumer suites pass unchanged (`space-agent-tools`, 290
    tests; `node-agent-tools`, 170 tests).
- **Narrow surface:** `normalizeAgentNameToken`, `normalizeReplyTargetHandle`, and
  `isReservedAgentHandle` are exported; `handleFromName` is used only by
  `normalizeReplyTargetHandle`, so it stays module-private.
- **Dependency direction:** the new leaf lives in `space/` alongside `slug.ts`, the
  only module it depends on (downward). Both consumers already imported from
  `space/`-level modules, so no new direction was introduced. `RESERVED_SPACE_AGENT_HANDLES`
  stays imported in `space-agent-tools.ts` (still spread into a literal at the call
  site), so no import was orphaned.
- **Deferred:** `task-agent-manager.ts` carries its own `private normalizeAgentNameToken`
  method (a class member, not a free function) — intentionally left in place; it is
  not byte-identical duplication of a free function and consolidating it would touch
  the class surface, so it is out of scope for a leaf extraction.

## Increment 5

**`external-events/github/github-check-run-fields.ts`** — extracted the GitHub
`check_run` row field decoders from `github-event-extension.ts`.

- **Family:** reading typed fields off a raw GitHub `check_run` row — six
  `unknown → primitive` decoders (`checkRunIdFrom`, `checkRunConclusionFrom`,
  `checkRunAppKeyFrom`, `checkRunNameFrom`, `checkRunOccurredAt`) plus the
  `isNonFailureConclusion` predicate that classifies a conclusion string. Closed
  internal dependency boundary: only `checkRunOccurredAt` reaches downward, to
  `parseGitHubTimestamp` from `github-normalizer`.
- **Why it scored highest:**
  - *Cohesion:* all six share one concern — decoding a `check_run` row — and are
    consumed together in a single contiguous block of the check-run polling
    handler. Nothing outside the family is needed except the one timestamp helper.
  - *Churn / conflict:* isolates a stable pure decoder family out of the
    4601-line `github-event-extension.ts` (~31 commits/yr — the largest
    external-events production module), leaving the class as the imperative shell
    that polls.
  - *Coverage:* none of the six had **any** direct unit tests (each was referenced
    only at its own definition site); characterization tests now pin every branch —
    including the app `slug`-over-`id` precedence in `checkRunAppKeyFrom`, the
    `completed_at → updated_at → started_at` precedence in `checkRunOccurredAt`,
    and its `Date.now()` / `parseGitHubTimestamp` fallbacks for non-object and
    unparseable rows.
  - *Regression risk:* low — pure deterministic functions; the consumer suite
    (`github-event-extension`, 209 tests) passes unchanged.
- **Narrow surface:** all six functions are exported (each has an external caller
  in the extension); the leaf has no module-private members.
- **Dependency direction:** the new leaf lives in `external-events/github/`
  alongside `github-normalizer.ts`, the only module it depends on (downward).
  `github-event-extension.ts` already imported downward from `github-normalizer`,
  so no new direction was introduced.
- **Deferred:** the neighboring PR-row and head-ref decoder families
  (`pullRequestNumberFrom`, `headShaFromPullRequest`, `gitHubRepoPath`,
  `headRepoFromPullRequest`, `headRefKey` / `parseHeadRefKey`, etc.) remain in
  `github-event-extension.ts`; they are separate responsibility families and can
  be extracted in their own increments.

## Increment 6

**`external-events/github/github-pr-head-ref.ts`** — extracted the GitHub
pull-request head-ref identity family from `github-event-extension.ts`.

- **Family:** resolving the identity of a pull request's head ref — six pure
  helpers. `gitHubRepoPath` (the URL-encoded `owner/repo` segment), two
  `/pulls` row decoders (`pullRequestNumberFrom`, `headShaFromPullRequest`),
  `headRepoFromPullRequest` (resolves the head-fork repo path, falling back to
  the watched repo at every missing/malformed step), and the inverse
  `headRefKey` / `parseHeadRefKey` pair (the durable `repoPath@headSha`
  identity key used to dedupe / compare heads across polls). Closed internal
  dependency boundary: only `headRepoFromPullRequest` reaches to
  `gitHubRepoPath`; the rest are independent leaves. The one external edge is a
  sideways type dependency on `GitHubWatchedRepo` from `github-repository`.
- **Why it scored highest:**
  - *Cohesion:* all six share one concern — identifying a PR's head ref — and
    are consumed together in a single contiguous block of the `/pulls` polling
    handler (resolve head SHA + repo + number, then compose/compare head-ref
    keys) and again in the per-head check-run loop (`parseHeadRefKey`).
  - *Churn / conflict:* isolates a stable pure decoder/transform family out of
    `github-event-extension.ts` (4601 → 4564 lines; ~31 commits/yr — the
    largest external-events production module), leaving the class as the
    imperative shell that polls.
  - *Coverage:* none of the six had **any** direct unit tests (each was
    referenced only at its own definition site); characterization tests now pin
    every branch — including `headRepoFromPullRequest`'s full watched-repo
    fallback ladder (non-row → no head → no `head.repo` → missing/empty owner
    login or repo name) and its URL-encoding of the resolved fork owner/name,
    and `parseHeadRefKey`'s separator edge cases (no `@`, leading `@` at index
    0, trailing `@`, last-`@`-wins for an embedded `@`, and the documented
    non-round-trip when a SHA itself contains `@`).
  - *Regression risk:* low — pure deterministic functions; the consumer suites
    (`github-event-extension` + health + rate-limit, 284 tests) pass unchanged.
- **Narrow surface:** all six functions are exported (each has an external
  caller in the extension); the leaf has no module-private members.
- **Dependency direction:** the new leaf lives in `external-events/github/`
  alongside `github-repository.ts` (the `GitHubWatchedRepo` type it depends on).
  `github-event-extension.ts` already imported downward from
  `./github-repository`, so no new direction was introduced;
  `github-repository` does not import back, so there is no cycle.
- **Deferred:** the remaining PR-row state decoders (`pullRequestUpdatedAt`,
  `isPullRequestOpen`, which read `updated_at` / `state`) and the
  head-sha-by-commit matcher family (`pullHeadSha`, `pickPrNumbersByHeadSha`,
  `addPullRequestNumberByHeadSha`, `removePullRequestNumberByHeadSha`) are
  separate responsibility families and remain in `github-event-extension.ts`,
  candidates for their own increments.

## Increment log

| # | Module extracted | From | PR | Outcome |
|---|---|---|---|---|
| 1 | `rpc-handlers/activity-preview.ts` | `live-query-handlers.ts` | #2383 | Pure leaf family moved behind facade; characterization tests added for previously-untested formatters. |
| 2 | `external-events/github-subscription-pattern.ts` | `space/runtime/space-runtime.ts` + `rpc-handlers/space-long-horizon-agent-handlers.ts` | #2393 | Pure GitHub topic-grammar leaf extracted; verbatim duplicate across two files consolidated behind a 2-function surface; characterization tests added for every branch. |
| 3 | `external-events/long-horizon-subscription-pattern.ts` | `space/runtime/space-runtime.ts` + `rpc-handlers/space-long-horizon-agent-handlers.ts` | #2403 | Pure long-horizon topic composer extracted; verbatim duplicate across two files consolidated behind a 1-function surface; characterization tests added for every branch. |
| 4 | `space/agent-handle.ts` | `space/tools/space-agent-tools.ts` + `space/tools/node-agent-tools.ts` | #2418 | Pure agent handle/name-token normalization family extracted; verbatim `normalizeAgentNameToken` duplicate across two tool files consolidated behind a 3-function surface; characterization tests added for every branch. |
| 5 | `external-events/github/github-check-run-fields.ts` | `external-events/github/github-event-extension.ts` | #2430 | Pure GitHub `check_run` row field decoders extracted behind a 6-function surface; characterization tests added for every branch (previously no direct unit coverage). |
| 6 | `external-events/github/github-pr-head-ref.ts` | `external-events/github/github-event-extension.ts` | _(this PR)_ | Pure GitHub PR head-ref identity family (repo path, PR number, head SHA/repo, head-ref key compose/parse) extracted behind a 6-function surface; characterization tests added for every branch (previously no direct unit coverage). |
