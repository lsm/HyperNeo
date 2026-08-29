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
| C1 | `classifyPollResponseStatus` / `classifyPollResponseError` (two-phase) + `resolveRateLimitBackoff` | new `github-poll-response.ts` | ~70 | ~150 | No — plain pure fns |
| C2 | `resolveEndpointWatermark`, `resolvePullsSeedNeed`, `resolvePullsBacklogCutoff`, `planEndpointPageAdvance` | new `github-poll-watermarks.ts` | ~85 | 0 | No — plain pure fns |
| C3a | initial head-ref index rebuild | `github-pr-head-ref-index.ts` | ~11 | 0 | No — explicit-state mutator fn |
| C3b | pulls-scan head-ref index delta maintenance | `github-pr-head-ref-index.ts` | ~45 | 0 | No — explicit-state mutator fns |
| C3c | tracked-PR reconcile (page-1 list policy) | `github-pr-head-ref-index.ts` | ~20 | 0 | No — explicit-state mutator fn |
| C3d | check-run pending→committed promotion | new `github-poll-cursor-gc.ts` | ~15 | 0 | No — returns the replacement pending record |
| C3e | cursor GC prunes | `github-poll-cursor-gc.ts` | ~27 | 0 | No — in-place mutators |
| C4a | `resolveCheckRunSupersession` (pure plan w/ set updates) | new `github-check-run-dedupe.ts` | ~15 | 0 | No — pure plan |
| C4b | `resolveCheckRunLegacyOwner` (owner + recordObservedOwner) | `github-check-run-dedupe.ts` | ~30 | 0 | No — pure plan |
| C5a/C5b/C5c/C5d | merge-conflict / review row-freshness / review etag-finalization / reaction plans (one module, three entry families) | new `github-poll-subscans.ts` | ~80 | 0 | No — pure plans returning cursor-state updates |
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

- **Shape:** two phases, split at the body read. Phase A,
  `classifyPollResponseStatus({ status, rateLimit, precedence })` →
  `primary-limited | not-modified | needs-body | ok`, each arm carrying the
  rate-limit payload to apply; phase B, `classifyPollResponseError({ status,
  rateLimit, errorText })` → `secondary-limited | http-error`, run only for
  `needs-body` after the caller's `await response.text()` — the body is read
  only past the primary-limited and 304 guards today (:2376 and siblings),
  and the extraction must not add an earlier `await` or a new failure mode
  for primary-limited responses. `resolveRateLimitBackoff(rateLimit, now)`
  computes the `retryAfter ? resetAt−now : MIN_BACKOFF` delay.
  Classification runs ≤ ~20 times per cycle per repo — not hot. Neither
  phase has a `network-error` arm: a failed fetch produces no `Response`, so
  there is no `status`/`rateLimit`/`errorText` to classify — network
  failures are caught at the fetch boundary (:2341–2353 and siblings) and
  never reach the classifier.
- **304-vs-limited precedence is site-specific and part of the contract.**
  The endpoint and check-run scans evaluate `rateLimit.limited` before
  `status === 304` (:2356 before :2370; :2590 before :2606); the
  merge/review/reaction scans evaluate 304 first (:2794, :2917, :3044 before
  their `limited` checks). Today the divergence is unobservable —
  `parseRateLimitHeaders` derives `limited` from status only (429, or 403
  with exhausted-quota headers, :91–92), so a 304 is never `limited` — but a
  verbatim extraction must not silently unify the two orders: phase A takes
  an explicit `precedence: 'limited-first' | 'not-modified-first'` parameter
  matching each site's current order, and GH-E1a's unit tests pin both
  variants with synthetic inputs — the divergence is unreachable through the
  real fetch sites, so its parity oracle lives with the classifier build,
  not in GH-P1a (which stays limited to behavior reachable through current
  fetch sites).
- **The two phases are ONE policy at one loop.** The body read between them
  is an awaited data dependency inside the policy, not a seam — each
  GH-E1b–f wire slice installs BOTH phases and may await inside its policy
  (see the seam contract in the slice ladder).
- **What stays imperative:** the per-site control flow differs legitimately
  (endpoint scan `continue`s on network error; check-run sets `headSucceeded`;
  reaction clears `reactionsFullyPolled`; review breaks its page loop). The
  call sites keep a compact switch over the classification and perform the
  `applyRateLimit`/message/flag effects — C1 unifies the decision, not the
  effects.

### C2 — watermark, seed, and pagination policy

- `resolveEndpointWatermark` (:2315–2325): seed-lookback decision
  (`saved === 0 && committed === 0 && comment endpoint` → `now −
  COMMENT_ENDPOINT_INITIAL_LOOKBACK_MS`), else saved, else committed.
  Returns the watermark AND the seeded-write update: the source persists the
  lookback into `endpointLastSeenAt` BEFORE the fetch (:2325), so a failed
  first poll still pins the seed for the next cycle — a contract returning
  only the timestamp would let the caller recompute `now − lookback` on every
  failed cycle, drifting the lower bound forward through an outage and
  skipping outage-window comments. ~15 lines.
- `resolvePullsSeedNeed` (:2327–2332): `endpoint === 'pulls' && (pullsSeedInProgress || no tracked PRs || (PRs tracked && no head SHAs))` — the endpoint discriminator is part of the helper contract, not the caller's; without it an empty tracked-PR list would force seed mode (and suppress `since`/page-1 etag) for the comment endpoints too. ~8 lines. This flag also suppresses the
  `since` param (:2333) and the page-1 etag (:2338) — the extraction must keep
  both `!pullsNeedsSeed` uses verbatim.
- `resolvePullsBacklogCutoff` (:2403–2420): first-row-below-watermark cutoff
  over `pullRequestUpdatedAt`. ~20 lines. Note :2411–2419 is a dead
  `else if` with an empty body — preserve verbatim; deletion is out of scope.
- `planEndpointPageAdvance` (:2487–2523): pagination decision
  (`backlogClearedByCutoff ? 1 : rows ≥ 100 ? page+1 : 1`), the tied-watermark
  `+1` bump (:2508–2514), the pending/committed endpoint watermark promotion,
  AND the next `pullsSeedInProgress` state for the pulls endpoint
  (:2505–2506, `pullsNeedsSeed && processedPages.pulls > 1`) — the plan
  returns it for the caller to persist; a dropped flag exits seed mode after
  the first 100-row page and lets the old-watermark cutoff truncate the
  backlog prematurely. ~30 lines.

### C3a — initial head-ref index rebuild

**These are not pure functions, and the extraction must not claim they are.**
The existing primitives (`add/removePullRequestNumberByHeadRef`,
github-pr-head-ref-index.ts) mutate their input `Map`, `clearCheckRunEtagsForHead`
mutates the etags record in place, and the sequences delete from cursor
records — a verbatim move produces deterministic, class-state-free, I/O-free
**mutators over explicitly-passed cursor/index structures**, not immutable
pure functions. The slice contract is "mutator extraction, zero behavior
change"; if immutable purity is ever wanted, that is a redesign (plan + apply),
not an extract.

- Rebuild (:2284–2294, ~11 lines): reconstruct `pullRequestNumbersByHeadRef`
  from `recentPullRequestHeadShas`/`recentPullRequestHeadRepos`. Its wiring
  seam runs BEFORE the endpoint loop — distinct from the pulls-scan seam, so
  it is its own slice.

### C3b — pulls-scan head-ref index delta maintenance

- Delta maintenance during the pulls scan (:2421–2465, ~45 lines): closed-PR
  removal, head-SHA/repo change invalidation, `clearCheckRunEtagsForHead` +
  head-watermark resets for newly tracked PRs; this extracts the *policy*
  that sequences the primitives. Same module and seam family as C3a; updates
  the head-ref index structures (`pullRequestNumbersByHeadRef`,
  `recentPullRequestHeadShas`/`Repos`, `checkRunEtags`).

### C3c — tracked-PR reconcile

- Page-one reconcile (:2466–2486, ~20 lines): fresh-open-first merge, drop
  closed, cap at `REACTION_POLL_PR_LIMIT`. A different policy from C3b — it
  maintains the `recentPullRequestNumbers` list (the reaction/review/merge
  target set), not the head-ref index, and runs only on pulls page 1 — so it
  is its own slice despite sharing the pulls loop.

### C3d — check-run pending→committed promotion

- Promotion (:2758–2767): NOT an in-place mutation — after copying entries
  the source REASSIGNS `checkRunHeadPendingLastSeenAt = {}` (:2763; the
  binding is `let` at :2260 for exactly this). The helper returns the
  replacement pending record for the caller to assign; deleting keys in
  place instead would change what a mid-scan failure persists before the
  final cursor write. Its wiring seam is inside the check-run scan.

### C3e — cursor GC

- GC (:3119–3145, ~27 lines): prune reaction/merge/review etags by
  tracked-PR set, head watermarks by tracked head set, check-run etags by
  `headRef:` prefix scan — in-place mutators over passed-in cursor
  structures. Its wiring seam is the cycle tail, separate from the scan.
  Shares the C3d module; different seam and purpose, so a different slice.

### C4 — check-run supersession and legacy-owner dedupe (two decisions, two slices)

The two decisions are separated by the synchronous store lookup, so they
wire at two seams and land as two serial slices.

- C4a `resolveCheckRunSupersession` (:2674–2688): first `${checkName}:${appKey}`
  conclusion wins; `null` topic actions are consumed silently; only `failed`
  stays eligible for later same-key rows. A pure PLAN, not a bare predicate:
  it returns the eligibility decision AND the set updates for the caller to
  apply (`markSeen: checkRunId`, optional `addSupersessionKey`), because the
  current sequence inserts every accepted ID into `seenCheckRunIds` (:2675)
  and conditionally into `supersededCheckKeys` (:2681–2688) — a resolver
  returning only eligibility would drop those cross-row updates and
  republish duplicate IDs or superseded conclusions. ~15 lines.
- C4b `resolveCheckRunLegacyOwner` (:2694–2711): the pure half of legacy-PR
  dedupe — recorded owner ?? store-observed owner ?? first fan-out PR, and
  the `legacyPrInFanOut` scoping decision. It returns the owner AND an
  optional `recordObservedOwner` update: when the store lookup finds an
  existing unscoped event whose key is not yet recorded, the source writes
  the observed PR into `checkRunLegacyPrs` BEFORE fan-out resolution
  (:2705–2707), and a resolver without that output would re-query the store
  every cycle and lose the stable legacy owner in the cursor. The
  `eventStore.getByDedupe` lookup (:2697–2700) is a **synchronous** store
  effect — the call site does not `await` it — and it stays at the call site
  unchanged so the extraction adds no microtask boundary; the fan-out
  publish loop (:2710–2729, including its own `checkRunLegacyPrs` write at
  :2724–2726) stays imperative.

### C5 — PR-scoped sub-scan transitions (three entry families, four slices)

The three sub-scans are independent loops (:2770, :2879, :3018) — three entry
families, sliced separately (GH-E5a–d below) into one shared module that
grows across the slices; the review family splits again at the row/scan
level. Every helper here is a **pure plan returning its cursor-state updates
for the caller to apply** — eligibility alone cannot preserve the current
writes (`mergeConflictStates`/`mergeConflictSequences` :2851/:2854,
`seenReviewIds`/`reviewLastSeenAt` :2982/:2986–2987, `seenReactionIds`
:3101/:3105), and a bare predicate would either go impure or drop state
transitions (same contract class as C4's supersession plan).

- C5a `resolveMergeConflictTransition` (:2841–2855): `mergeable === null &&
  mergeableState !== 'dirty'` skip — the input is the `mergeable_state` field
  (:2845–2848), NOT the PR `state`; an open PR with `mergeable: null` and
  `mergeable_state: 'dirty'` must NOT skip (name the helper input
  `mergeableState` so a literal implementation cannot suppress dirty-state
  conflict events). Returns `{clearState} | {skip} | {stateWrite,
  transition}`: `{clearState}` for a closed PR (`pullDetail.state !== 'open'`,
  :2841–2843 — the caller applies `delete mergeConflictStates[prNumber]`;
  without that arm a literal extraction retains stale conflict state for
  closed PRs); `{skip}` when `mergeable === null && mergeableState !==
  'dirty'` (mergeability unresolved — the source continues WITHOUT touching
  the recorded state, so a prior conflict must not be re-resolved on unknown
  mergeability); otherwise the plan carries the `mergeConflictStates` write
  (`stateWrite: conflicting` — the source writes the state on every RESOLVED
  open-PR observation, :2851, including a first non-conflicting one that
  then continues without a transition, :2852) plus `transition:
  `{sequence} | null`` — `null` when `conflicting === (previous ?? false)`
  (no sequence bump, no publish). Collapsing the no-transition observation
  into a bare `skip` would lose the cursor write; collapsing it into the
  transition arm would invent a publish — and dropping the unresolved
  `skip` arm would publish a false resolution of a prior conflict.
  ~20 lines.
- C5b review row freshness (:2886–2888 pre-loop seed, :2975–2989 per-row
  gate): seen-id + watermark gate (note the stale path marks the id seen
  WITHOUT advancing the watermark, :2981–2984). Returns
  `{seedWatermark?, markSeen?, advanceWatermark?}` — `seedWatermark` is the
  PRE-LOOP first-seen seed: the source persists
  `reviewLastSeenAt[prNumber] = watermarks.committed` BEFORE fetching
  (:2886–2888), so a scan that returns no rows, 304s, or fails before row
  iteration still seeds; without the explicit seed action a later advance of
  the committed watermark would stale-suppress a delayed review instead of
  publishing it. The seed applies once per PR scan; `markSeen`/
  `advanceWatermark` run once per review row. ~15 lines.
- C5c review scan-level etag finalization (:2966–2968 pending capture,
  :3001–3005 commit/clear): single-page etag commit
  (`complete && singlePage && pendingEtag`) vs delete. A scan-level decision
  — it can only be made after the page loop completes, so it is a separate
  slice from C5b despite the same loop. Returns `{commitEtag | clearEtag}`.
  ~10 lines.
- C5d reaction freshness (:3094–3107): positive filter + seen-ids +
  committed-watermark stale suppression (the stale path also marks seen,
  :3100–3103). Returns `{markSeen?, publish?}`. Its outputs stop at the scan
  flags (`reactionPolledAt`, `reactionsFullyPolled`); the
  `lastReactionPollAt` commit rule (:3196–3198) belongs to C6, not here.
  ~20 lines.

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
slice names what it may not touch). All slices are behavior-preserving —
extracts and wires swap in place under their pins (existing suites pass
unmodified except where the slice's own equivalence pins are added), and
GH-E1a lands additive and unwired per the playbook's build step.

| Slice | Kind | Delivers | Prod Δ | Test Δ | Depends on |
| --- | --- | --- | --- | --- | --- |
| GH-P1a | pin | response-classification pins for the ENDPOINT family only (reachable 429-synthesis, secondary body-sniff, 304, low-remaining through the endpoint scan; synthetic 304-vs-limited cases live in GH-E1a — see C1). The other four families' pins ride their own wire slices (GH-E1c–f) | 0 | ≲150 | — |
| GH-P1b | pin | cursor-commit policy matrix (`partialScan × hasBacklog × deferred × credentialStale × accessible × pollErrorMessage × prior-error presence/value × reactionsFullyPolled × reactionPolledAt × prior cursor.lastReactionPollAt × current token fingerprint × prior cursor.lastPollCredentialFingerprint` — the error fields are load-bearing fallbacks at :3154, :3161–3165, the reaction timestamp reads all three reaction axes at :3196–3198, and the credential fingerprint is written from the current token only when accessible (:3199–3201) — → committed/pending watermarks, error fields, reaction timestamp, credential fingerprint, write split). MUST also assert the COMPLETE payload: every carried cursor field from :3173–3193 (etags, processedPages, recent PR/head indexes, check-run watermarks/etags/legacy PRs, pullsSeedInProgress, seen IDs, merge/review/reaction state, endpoint watermarks) — all `PollCursor` fields are optional, so an extraction that silently drops a carried field would still satisfy the branch outputs and restart pages or republish events | 0 | ≲400 | — |
| GH-E1a | build | C1 `github-poll-response.ts` two-phase classifiers + precedence + backoff, UNWIRED, incl. synthetic 304-vs-limited decision tests as the precedence parity oracle (cycle contract only; `githubFetch` keeps its own classification — open question 1) | ≲80 | ≲250 | GH-P1a |
| GH-E1b | wire | swap endpoint scan (limited-first precedence; rides GH-P1a pins) | ≲40 net | ≲120 | GH-E1a, GH-P1a |
| GH-E1c | wire | swap check-run scan (limited-first; carries its family's pins) | ≲40 net | ≲150 | GH-E1b |
| GH-E1d | wire | swap merge-conflict scan (not-modified-first; carries its family's pins) | ≲30 net | ≲150 | GH-E1c |
| GH-E1e | wire | swap review scan (not-modified-first; carries its family's pins) | ≲30 net | ≲150 | GH-E1d |
| GH-E1f | wire | swap reaction scan (not-modified-first; carries its family's pins) | ≲30 net | ≲150 | GH-E1e |
| GH-E2 | extract | C2 endpoint watermark/pagination policy — one named policy at the endpoint loop's pre-fetch/post-decode/post-publish points (see the seam contract below) | ≲100 | ≲250 | — |
| GH-E3a | extract | C3a initial head-ref rebuild (pre-loop seam, mutator) | ≲30 | ≲100 | — |
| GH-E3b | extract | C3b pulls-scan head-ref index delta maintenance (mutator, same module) | ≲70 | ≲150 | GH-E3a |
| GH-E3c | extract | C3c tracked-PR reconcile (page-1 list policy, same module) | ≲30 | ≲100 | GH-E3b |
| GH-E3d | extract | C3d check-run promotion (returns replacement record) | ≲30 | ≲100 | GH-E3c |
| GH-E3e | extract | C3e cursor GC prunes (same module, different seam) | ≲30 | ≲100 | GH-E3d |
| GH-E4a | extract | C4a check-run supersession plan (first seam, before the store lookup) | ≲40 | ≲120 | — |
| GH-E4b | extract | C4b check-run legacy-owner plan (second seam, after the store lookup) | ≲40 | ≲120 | GH-E4a |
| GH-E5a | extract | C5a merge-conflict transition plan (first into `github-poll-subscans.ts`) | ≲40 | ≲120 | — |
| GH-E5b | extract | C5b review row-freshness plan (extends `github-poll-subscans.ts`) | ≲30 | ≲100 | GH-E5a |
| GH-E5c | extract | C5c review scan-level etag finalization (extends module) | ≲25 | ≲100 | GH-E5b |
| GH-E5d | extract | C5d reaction freshness plan (extends module) | ≲30 | ≲100 | GH-E5c |
| GH-E6 | extract | C6 `planPollCursorCommit` + write-split decision | ≲90 | ≲300 (decision table) | GH-P1b, GH-E2 |

Each slice: one module, one purpose, ONE wiring seam — where a seam is an
entry family (a loop) for wire slices, and within one loop a NAMED POLICY
(not a helper): a slice may swap one policy's helper family at several
program points of one loop when those points form that single policy
(GH-E2's watermark/seed/cutoff/advance are one endpoint-watermark policy at
the pre-fetch, post-decode, and post-publish points of the endpoint loop).
Separate POLICIES get their own slice: different loops (E1b–f), separate
policies in one loop (E3b vs E3c), row-vs-scan levels (E5b vs E5c). An
awaited effect BETWEEN two policies forces the split (the synchronous store
lookup between E4a's supersession and E4b's legacy-owner decisions); an
awaited data dependency WITHIN one policy does not — the two classifier
phases of response classification sit on either side of
`await response.text()`, but they are one policy at one loop, so each
GH-E1b–f wire slice installs both phases and MAY await inside its policy.
May not touch the loops' control flow, the class
state methods, or the scheduler. Merge contract per slice:
"verbatim-move extraction, zero behavior change, existing fake-fetch suites
green" (C3a–c: "mutator extraction, zero behavior change" — see the purity
caveat there; GH-E1a: "additive dead code, no call-site changes"). Slice
count is an output of measurement — C1 deletes duplication across five sites
so its classifier is built once (E1a), pinned per family, and wired per site
(E1b–f); C3 splits five ways (pre-loop rebuild, pulls-scan index maintenance,
tracked-PR reconcile, in-scan promotion, tail GC — five purposes at four
seams); C4 splits at the store lookup between its two decisions; C5's three
sub-scans are three entry families with the review family split again at the
row/scan level (GH-E5a–d), growing one shared module across serially chained
slices; no slice mixes clusters or modules.

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

1. RESOLVED (review round 2): `githubFetch` stays OUT of GH-E1's swap. Beyond
   the credential-generation guard, its rate-limit policy differs: for
   429-with-`remaining > 0`-no-`Retry-After` it passes the header reset epoch
   through to `applyRateLimit` (:2202–2216), while the cycle sites synthesize
   `now + RATE_LIMIT_MIN_BACKOFF_MS` — reusing the cycle classification there
   would shorten its cooldown and resume requests before GitHub's reset.
   Unifying the two policies would be a behavior change, not an extraction.
2. `REACTION_STALE_INTERVALS`/`MIN_MS` feed `buildHealthSnapshot` (:1428–1433),
   not the cycle — confirm health stays out of this lane (epic says core-path
   only).
3. The `pullRequestNumbersFromCheckRun` fallback (:3359–3375) ignores its
   head-index parameter (`_pullRequestNumbersByHeadSha`) — legacy seam; worth a
   follow-up issue, not a slice here.
