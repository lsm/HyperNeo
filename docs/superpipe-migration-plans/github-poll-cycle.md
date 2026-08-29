# GitHub poll-cycle extraction map

## Scope and ruling

This map covers `pollWatchedRepo`/`pollWatchedRepoCore` in
`packages/daemon/src/lib/external-events/github/github-event-extension.ts`
(:2222–3217, 22 + 973 lines) — the polling half of epic #3346 (issue #3358).
The webhook-admission half (GH-B2) is mapped by `external-events.md` and is out
of scope here. No source code is changed by this plan.

**Ruling: the poll cycle itself is an ADR 0004 exclusion — no
`github-poll-cycle` pipeline.** The cycle is a stateful cursor machine: it folds
seven fetch families over a 27-field `PollCursor` (github-repository.ts:4–32)
persisted in `space_github_watched_repos.poll_cursor`, and its semantics are
resume-across-cycles (pending vs committed watermarks, per-endpoint pages,
per-head etags). ADR 0004 "Where superpipe must not be used": *as a state
machine or unbounded fold — state lives in the runtime/DB; a pipeline decides
one step; a pipeline may be a per-event reducer body, never the loop*. A single
pipeline wrapping the ~970-line core would be the loop, not a decision.

What the cycle DOES contain is a set of pure decision points repeated inline
across the fetch sites and scan clusters. Those extract as **plain pure
functions** (verbatim moves under characterization pins) — the same treatment
`external-events.md` already gave the sibling polling-row normalizers
(`normalizeGitHubPollingRow` stays a plain function; per-row pipeline invocation
is the hot-inner-loop pattern ADR 0004 Decision 8 excludes). This map corrects
epic #3346's GH-B3 slice accordingly.

## Measured anatomy of the poll cycle

| Region | Lines | Size | Role |
| --- | --- | --- | --- |
| `pollWatchedRepo` wrapper | :2222–2243 | 22 | stamps `pollCycleCredentialGeneration`, records poll failure on throw, resets cycle fingerprint |
| Cursor hydration | :2249–2301 | 53 | destructures 27 `PollCursor` fields, builds watermarks, endpoints table, rebuilds `pullRequestNumbersByHeadRef`, scan flags |
| Endpoint scan (3 endpoints) | :2305–2529 | 225 | `issue_comments` / `review_comments` / `pulls`: watermark policy, etag, pagination resume, seed, cutoff, head-ref index, publish |
| Check-run sub-scan | :2531–2768 | 238 | per-head-ref scan over fork+base repos: per-page etag keys, supersession keys, legacy-PR dedupe, prune-on-404/422, pending→committed promotion |
| Merge-conflict sub-scan | :2770–2877 | 108 | per open PR: etag, `mergeable` transition detection, sequence bump |
| Review sub-scan | :2879–3016 | 138 | per PR: paginated `while (true)`, seen-id + watermark freshness, single-page etag commit policy |
| Reaction sub-scan | :3018–3117 | 100 | per PR: positive-reaction filter, seen-ids, committed-watermark stale suppression |
| Cursor GC | :3119–3145 | 27 | prunes etag/watermark keys for PRs and head-refs no longer tracked |
| Cursor commit | :3146–3207 | 62 | commit-vs-pending watermark decision, error-field policy, `updatePollCursor` vs `updatePollCursorJson` split |
| Rate-limit observation | :3208–3215 | 8 | merges `latestRateLimit` into instance state under the generation guard |

Class-owned state the loop reads/writes (stays in the class per ADR 0004
Decision 5): `applyRateLimit` (:1691–1726), `resetRateLimitObservation`
(:1679–1689), `getNextPollDelayMs` (:1140–1152), scheduler `runPollCycle`
(:1119–1138) / `pollEnabledSpaces` (:995) / `pollSpace` (:1016).

Existing test mass: `github-event-extension.test.ts` (10,169 lines) carries
~60 fake-fetch poll-cycle tests at :4970–7871 (seed lookback, pulls cutoff,
check-run etag/supersession/legacy fan-out, reaction freshness, partial-scan
semantics); `github-event-extension-rate-limit.test.ts` (529 lines, 13 tests)
pins header parsing and the cooldown/backoff path; the extracted helper modules
(`github-pr-head-ref(-index)`, `github-pr-row-state`, `github-check-run-fields`,
`github-reaction-fields`) each carry their own suites.

## Pure extraction candidates by cluster

| # | Candidate | Home module | Pure core | Deletes (dup) | Pipeline? |
| --- | --- | --- | --- | --- | --- |
| C1 | `classifyGitHubPollResponse` + `resolveRateLimitBackoff` | new `github-poll-response.ts` | ~70 | ~150 | No — plain pure fn |
| C2 | `resolveEndpointWatermark`, `resolvePullsSeedNeed`, `resolvePullsBacklogCutoff`, `planEndpointPageAdvance` | new `github-poll-watermarks.ts` | ~85 | 0 | No — plain pure fns |
| C3a | head-ref delta maintenance, tracked-PR reconcile | `github-pr-head-ref-index.ts` | ~75 | 0 | No — explicit-state mutator fns |
| C3b | cursor GC, check-run pending→committed promotion | new `github-poll-cursor-gc.ts` | ~40 | 0 | No — explicit-state mutator fns |
| C4 | `resolveCheckRunSupersession`, `resolveCheckRunLegacyOwner` | new `github-check-run-dedupe.ts` | ~45 | 0 | No — plain pure fns |
| C5 | `resolveMergeConflictTransition`, review freshness/etag policy, reaction freshness policy | new `github-poll-subscans.ts` | ~80 | 0 | No — plain pure fns |
| C6 | `planPollCursorCommit` | new `github-poll-cursor-commit.ts` | ~60 | 0 | No — pure plan, apply stays in class |

### C1 — response classification (the three-layer rate-limit cascade)

Every fetch site in the cycle repeats the same guard cascade: network-error →
`parseRateLimitHeaders` (already pure/exported, :82–104) → primary-limited
(with the 429-remaining>0-no-`Retry-After` synthesis, :2357–2363) → 304 →
!ok secondary limit (403/429 + `isRateLimitError` body sniff with backoff
synthesis, :2377–2389) → other-http-error → ok. The primary synthesis appears
5× (:2357, :2591, :2796, :2924, :3049), the secondary sniff 5× (:2377, :2611,
:2815, :2943, :3069), the network guard 5×, the low-remaining guard 4× — plus a
sixth variant in `githubFetch` (:2197–2217) that adds the credential-generation
guard. Each inline occurrence is ~30–45 lines; the five cycle sites total
~190 lines of near-duplicate classification.

- **Shape:** `classifyGitHubPollResponse({ status, rateLimit, errorText })` →
  discriminated union `primary-limited | secondary-limited | not-modified |
  http-error | ok`, each arm carrying the rate-limit payload to apply;
  `resolveRateLimitBackoff(rateLimit, now)` computes the
  `retryAfter ? resetAt−now : MIN_BACKOFF` delay. Classification runs ≤ ~20
  times per cycle per repo — not hot. The union deliberately has no
  `network-error` arm: a failed fetch produces no `Response`, so there is no
  `status`/`rateLimit`/`errorText` to classify — network failures are caught
  at the fetch boundary (:2341–2353 and siblings) and never reach the
  classifier.
- **What stays imperative:** the per-site control flow differs legitimately
  (endpoint scan `continue`s on network error; check-run sets `headSucceeded`;
  reaction clears `reactionsFullyPolled`; review breaks its page loop). The
  call sites keep a compact switch over the classification and perform the
  `applyRateLimit`/message/flag effects — C1 unifies the decision, not the
  effects.

### C2 — watermark, seed, and pagination policy

- `resolveEndpointWatermark` (:2315–2325): seed-lookback decision
  (`saved === 0 && committed === 0 && comment endpoint` → `now −
  COMMENT_ENDPOINT_INITIAL_LOOKBACK_MS`), else saved, else committed. ~15 lines.
- `resolvePullsSeedNeed` (:2327–2332): `endpoint === 'pulls' && (pullsSeedInProgress || no tracked PRs || (PRs tracked && no head SHAs))` — the endpoint discriminator is part of the helper contract, not the caller's; without it an empty tracked-PR list would force seed mode (and suppress `since`/page-1 etag) for the comment endpoints too. ~8 lines. This flag also suppresses the
  `since` param (:2333) and the page-1 etag (:2338) — the extraction must keep
  both `!pullsNeedsSeed` uses verbatim.
- `resolvePullsBacklogCutoff` (:2403–2420): first-row-below-watermark cutoff
  over `pullRequestUpdatedAt`. ~20 lines. Note :2411–2419 is a dead
  `else if` with an empty body — preserve verbatim; deletion is out of scope.
- `planEndpointPageAdvance` (:2487–2523): pagination decision
  (`backlogClearedByCutoff ? 1 : rows ≥ 100 ? page+1 : 1`), the tied-watermark
  `+1` bump (:2508–2514), and the pending/committed endpoint watermark
  promotion. ~30 lines.

### C3a — head-ref index maintenance and tracked-PR reconcile

**These are not pure functions, and the extraction must not claim they are.**
The existing primitives (`add/removePullRequestNumberByHeadRef`,
github-pr-head-ref-index.ts) mutate their input `Map`, `clearCheckRunEtagsForHead`
mutates the etags record in place, and the sequences delete from cursor
records — a verbatim move produces deterministic, class-state-free, I/O-free
**mutators over explicitly-passed cursor/index structures**, not immutable
pure functions. The slice contract is "mutator extraction, zero behavior
change"; if immutable purity is ever wanted, that is a redesign (plan + apply),
not an extract.

- Delta maintenance during the pulls scan (:2421–2465, ~45 lines): closed-PR
  removal, head-SHA/repo change invalidation, `clearCheckRunEtagsForHead` +
  head-watermark resets for newly tracked PRs; this extracts the *policy* that
  sequences the primitives, including the initial rebuild (:2284–2294).
- Tracked-PR reconcile (:2466–2486, ~20 lines): fresh-open-first merge, drop
  closed, cap at `REACTION_POLL_PR_LIMIT`.

### C3b — cursor GC and check-run promotion

Same mutator shape (prunes keys in place on passed-in cursor structures); its
own module because it is a different purpose from index maintenance:

- Cursor GC (:3119–3145, ~27 lines): prune reaction/merge/review etags by
  tracked-PR set, head watermarks by tracked head set, check-run etags by
  `headRef:` prefix scan.
- Check-run pending→committed promotion (:2758–2767).

### C4 — check-run supersession and legacy-owner dedupe

- `resolveCheckRunSupersession` (:2674–2688): first `${checkName}:${appKey}`
  conclusion wins; `null` topic actions are consumed silently; only `failed`
  stays eligible for later same-key rows. ~15 lines.
- `resolveCheckRunLegacyOwner` (:2694–2711): the pure half of legacy-PR dedupe —
  recorded owner ?? store-observed owner ?? first fan-out PR, and the
  `legacyPrInFanOut` scoping decision. The `eventStore.getByDedupe` lookup
  (:2697–2700) is a **synchronous** store effect — the call site does not
  `await` it — and it stays at the call site unchanged so the extraction adds
  no microtask boundary; the fan-out publish loop (:2710–2729) stays
  imperative.

### C5 — PR-scoped sub-scan transitions

- `resolveMergeConflictTransition` (:2841–2855): `mergeable === null &&
  state !== 'dirty'` skip, conflicting computation, no-change suppression,
  sequence bump. ~20 lines.
- Review freshness + etag policy (:2875–2989 subset): first-seen watermark
  seed, seen-id + watermark gate, single-page etag commit
  (`complete && singlePage && pendingEtag`) vs delete (:3001–3005). ~25 lines.
- Reaction freshness (:3094–3107): positive filter + seen-ids +
  committed-watermark stale suppression. ~20 lines. C5's outputs stop at the
  scan flags (`reactionPolledAt`, `reactionsFullyPolled`); the
  `lastReactionPollAt` commit rule (:3196–3198) belongs to C6, not here.

### C6 — cursor commit policy (`planPollCursorCommit`)

The 62-line tail (:3146–3207) is the machine's commit semantics, currently
testable only by driving whole fake-fetch cycles:

- `credentialGenerationStale` / `accessible` / `pollErrorMessage` →
  `lastPollError` and the three-way `lastPartialPollError` policy
  (:3147–3165);
- `partialScan || hasBacklog || pullsCheckRunDeferred` → committed vs pending
  `lastSeenAt` (:3166–3172);
- `lastReactionPollAt` commit rule (:3196–3198, `reactionsFullyPolled ?
  reactionPolledAt ?? cursor : cursor`) — owned HERE, in C6, as part of the
  payload assembly; C5 only produces the scan flags this rule reads;
- `lastPollCredentialFingerprint` only when accessible (:3199–3201);
- the write split (:3203–3207): `updatePollCursor` (stamps `last_poll_at`,
  github-repository.ts:478) only when accessible, else `updatePollCursorJson`
  (:486).

**Shape:** `planPollCursorCommit({ scan, cursor, watched, token, now })` →
`{ payload: PollCursor; write: 'cursor' | 'json' }` as a pure function with a
decision-table test. The pipeline alternative (snapshot → plan → apply as a
mixed `stagedRun`) was considered and rejected: the apply is two repo calls,
there is no gate cascade, and ADR 0004's own rule that a pure plan + imperative
apply is acceptable for a transform-shaped boundary (functional sandwich, P7)
makes the pipeline wrapper add ceremony without exposing any hidden branch
order — the decision table IS the interface.

## What stays imperative (and why)

- **All five loops** (endpoint, per-head check-run + its page `while`, review
  pages, per-PR sub-scans): they are the state machine; per-row bodies are
  per-event reducers at up-to-100-row pages (Decision 8).
- **Effects**: `fetchImpl` calls, `applyRateLimit` class-state mutation,
  `publishEvent` awaits, `eventStore.getByDedupe`, cursor repo writes —
  resources/state stay in the class (Decision 5).
- **Scheduler** (`runPollCycle`, `getNextPollDelayMs`, `pollEnabledSpaces`):
  timer/lock ownership, not a business-path decision.
- **The dead branches** (:2411–2419, :2758–2759 empty-if): preserved verbatim
  by the extractions; removal would be its own delete slice if ever wanted.

## Slice ladder

Replaces epic #3346's GH-B3 (`github-poll-cycle` pipeline) and reshapes GH-W1
(no pipeline swap remains; each extract slice swaps its call sites in place
under its pins). Budgets are contracts (owner's decomposition playbook:
~300 prod-line ceiling, tests ride their slice under their own cap; every
slice names what it may not touch). All slices are behavior-preserving
extracts — existing suites must pass unmodified except where the slice's own
equivalence pins are added.

| Slice | Kind | Delivers | Prod Δ | Test Δ | Depends on |
| --- | --- | --- | --- | --- | --- |
| GH-P1a | pin | response-classification decision table (the 429-synthesis, secondary body-sniff, 304, low-remaining dimensions the fake-fetch suites cover only via whole cycles) | 0 | ≲200 | — |
| GH-P1b | pin | cursor-commit policy matrix (`partialScan × hasBacklog × deferred × credentialStale × accessible × pollErrorMessage × prior-error presence/value` — `cursor.lastPollError`/`lastPartialPollError` are load-bearing fallbacks at :3154, :3161–3165 — → committed/pending watermarks, error fields, reaction timestamp, write split) | 0 | ≲300 | — |
| GH-E1 | extract | C1 `classifyGitHubPollResponse` + backoff helper, swapped at the 5 cycle sites (`githubFetch` optional 6th) | ≲120 net (−~150 dup) | ≲300 | GH-P1a |
| GH-E2 | extract | C2 watermark/seed/cutoff/page-advance helpers | ≲100 | ≲250 | — |
| GH-E3a | extract | C3a head-ref delta policy + tracked-PR reconcile (mutator extraction) | ≲90 | ≲200 | GH-E2 |
| GH-E3b | extract | C3b cursor GC + check-run promotion (mutator extraction) | ≲50 | ≲150 | GH-E3a |
| GH-E4 | extract | C4 supersession + legacy-owner decisions | ≲80 | ≲200 | — |
| GH-E5 | extract | C5 merge/review/reaction transition helpers (one module; split if review prefers) | ≲90 | ≲250 | — |
| GH-E6 | extract | C6 `planPollCursorCommit` + write-split decision | ≲90 | ≲300 (decision table) | GH-P1b, GH-E2 |

Each slice: one module + its call-site swaps; may not touch the loops'
control flow, the class state methods, or the scheduler. Merge contract per
slice: "verbatim-move extraction, zero behavior change, existing fake-fetch
suites green" (C3a/C3b: "mutator extraction, zero behavior change" — see the
purity caveat there). Slice count is an output of measurement — C1 is
separately sliced from C2–C6 because it deletes duplication across five sites
while the others are single-cluster moves; C3 splits into C3a/C3b because
index maintenance and cursor GC are different purposes landing in different
modules; no slice mixes clusters or modules.

## Risks and caveats

- **Equivalence is observable only through the cursor.** Most decisions
  surface solely in the persisted `PollCursor` and published events; equivalence
  pins must assert cursor JSON and published topic/dedupe keys, not internals.
- **Per-site classification variance** (C1): the classifier must expose the
  429-synthesis inputs and the secondary-limit delay inputs; a too-narrow
  signature will force call sites to re-derive state and reintroduce drift.
- **`pullsNeedsSeed` coupling** (C2): the flag feeds three places (since-param,
  etag suppression, seed progress :2505–2506); the helper must return the flag,
  not a boolean per use.
- **Legacy-owner dedupe reads the store** (C4): the pure function takes the
  observed owner as an input; do not move the synchronous `getByDedupe`
  effect inside it or add an `await` at the call site.
- **`Date.now()` density**: watermarks, backoff, reaction timestamps, and the
  commit policy all read the clock; extracted helpers take `now` as a
  parameter (the module already has `credentialFingerprint`-style pure
  precedents).
- **GitHub API behavior drift** is pinned only as far as the fake-fetch suite
  encodes it; extractions must not "fix" oddities (dead branches, the
  `+1` tied-watermark bump) — preserve or escalate, never repair in passing.

## Open questions

1. Should `githubFetch`'s sixth classification variant (:2197–2217) join C1's
   swap, or stay separate because it carries the credential-generation guard?
   Default: include, guard stays at the call site.
2. `REACTION_STALE_INTERVALS`/`MIN_MS` feed `buildHealthSnapshot` (:1428–1433),
   not the cycle — confirm health stays out of this lane (epic says core-path
   only).
3. The `pullRequestNumbersFromCheckRun` fallback (:3359–3375) ignores its
   head-index parameter (`_pullRequestNumbersByHeadSha`) — legacy seam; worth a
   follow-up issue, not a slice here.
