# One GitHub fact source

Status: proposed GitHub-facing contract, incorporating the backend lane's six
projection requirements relayed through Neo. This document changes no runtime
API. Reconcile further interface changes through Neo before an API implementation
PR. The backend lane owns its separate todo-from-facts design and todo decisions.

The proposed [todo-state consumer design (lsm/HyperNeo#8150)](https://github.com/lsm/HyperNeo/pull/8150)
consumes this contract and owns todo binding, precedence and stall policy. Only
relevant `facts_changed` transitions reset a stall; `observation_only` never does.

Human-approved item 5 makes the existing PR ledger the daemon's single GitHub
fact source. Fairness PR #8124 merged as `571e845cec` and is the starting point.
Cleanup of terminal PR
subscriptions and polling-starvation health from #8118 belong to this lane.
Every follow-up is a small PR from fresh dev, with its own issue and measured
merge contract. No command-line parsing is a safety boundary.

## Existing reads and missing facts

Inventory at dev `571e845cec8c4e4eab2cfe147af489d545b86053`. Paths below are
relative to `packages/daemon/src/`.

| Reader | Current upstream path | Facts its ledger replacement must cover |
| --- | --- | --- |
| PR ledger | `lib/neo/packs/coding/pr-ledger-source.ts`, `lib/neo/packs/coding/pr-ledger.ts` | Repo open/recent-closed enumeration, head, review and CI summaries, ownership observations. |
| External events | `lib/external-events/github/github-event-extension.ts:2427` | PR details, comments, inline comments, formal reviews, reactions and individual check runs, with resumable page coverage. |
| Work cards | `lib/neo/packs/coding/work-prs.ts:223,329` | Head/base, checks, exact-head reviews, body/closing references, rules, signatures and unresolved threads. |
| Branch cards | `lib/neo/packs/coding/branch-prs.ts:34` | Canonical repository and branch-to-PR membership, including terminal PRs. |
| Ask/project references | `lib/neo/packs/coding/ask-prs.ts:141,205` | PR/issue state, merge target/time, issue parent and closing-PR evidence, default branch. |
| Deploy checks | `lib/neo/packs/coding/deploy-checks.ts:21,61` | Merge commit and ancestry to each observed daemon build. |
| GitHub read/query | `lib/neo/packs/coding/github-read.ts`, `github-query.ts:160` | Covered PR/issue detail and time-window lists, including list completeness. |
| Other GitHub paths | `lib/github/polling-service.ts:148,203`, `event-filter.ts:277`, `connectors/github-connector.ts`, `connectors/review-threads.ts` | Inventory active calls; move read dependencies to the same ledger collector and preserve operation authorization. |

`CodingPrLedgerRepository` currently stores a compact derived state, not the
full facts these readers need. Its GraphQL query rejects more than 100 open PRs,
reads only 50 recent terminal PRs and retains a seven-day summary. That cannot
prove an arbitrary 30-day query complete. The new design extends this ledger;
it does not establish another independent cache or turn missing fields into
empty lists, passing CI, approval, or completed work.

## Ownership and identity

The ledger owns GitHub acquisition, normalized facts, freshness, coverage and
persisted changes. Consumers read those facts locally. Repo watching works even
when the coding pack is disabled. GitHub mutations retain their existing human
and exact-head authorization; their resulting observations enter the ledger.
Read-before-write checks must use a required fresh ledger revision or refuse;
a local cache must never weaken a mutation's existing admission rules.

A subject identifies a provider/host, canonical repo and kind (`pr`, `issue`,
`commit`, `branch` or repository collection). A PR/issue has its number and,
when known, upstream node ID. Preserve repository aliases across renames.
Commit subjects include the SHA; ancestry subjects include both SHAs. Branch
membership includes its repo and branch. Time-window collections include the
kind, filter and requested interval; one partial list cannot certify another.

Worker observations keep their source `WorkRef`, observation time and provenance
separate from GitHub facts. The ledger does not interpret a worker's claim as a
GitHub merge, check result or human approval. `todoId`, dispatch id,
todo-to-worker binding, precedence and stall policy belong to the todo side.

## Proposed local read surface

Names are illustrative until the coordinated API slice; these are local typed
interfaces, not new public RPC operations or permissions.

- `readGithubFacts(subject, fields, { maxAgeMs, factRevision? })` reads persisted
  facts only and returns one coherent envelope. Historical revision reads are
  explicitly historical and cannot certify current readiness.
- `requestGithubRefresh(subject, fields)` returns the existing or newly queued
  collector request ID. Concurrent requests for the same acquisition coverage
  coalesce across consumers; a failed or quota-deferred refresh stays visible.
- `subscribeGithubFacts(subjects, destination, afterChangeId)` subscribes to
  persisted changes. Subscriptions survive restart and use destination-bound
  receipts, not an in-memory event callback as proof of delivery.

Each read envelope carries canonical identity, immutable `factRevision`,
monotonic `observationRevision`, requested field results and a change cursor.
The fact revision is a durable transition revision: a repeated observation keeps
it, while a genuine change or reversion receives a new revision. Content hashes
alone are insufficient because A -> B -> A contains two distinct transitions.

Every requested field is one of:

- `known`: value, `observedAt`, coverage evidence, and any required `headOid` or
  `baseOid`. An authoritative empty result is known only with complete coverage.
- `unknown`: reason (`missing`, `stale`, `failed`, `partial`, `rate_limited`,
  `not_authorized`, or `head_changed`), attempt time and last successful
  observation time when available. Prior values remain stored for diagnostics
  but are not eligible known values in this read.

A failed latest refresh makes its affected requested fields unknown even if a
prior snapshot exists. Failures do not advance their successful `observedAt`.
A valid 304 refreshes only the field/page coverage bound to that validator.
Freshness is field-specific, not the last time any endpoint answered for a repo.
Consumers never clear a block or certify done from an unknown field. Missing or
stale coverage requests one coalesced collector refresh; readers cannot fall
back to their own GitHub calls. Successful refresh of an unchanged value changes
observation metadata, not its fact revision or meaningful-transition cursor.

### Required PR evidence

Head and base refs include both names and OIDs when covered. Terminal state
includes merge commit, merged/closed time, target branch and source evidence.
Do not infer the merge target from the current default branch or infer ancestry
from a similar SHA. A daemon build is an independently observed runtime fact;
GitHub ancestry evidence connects that build to a merge commit.

Reviews bind to their reviewed head and reviewer; retain verdict time, engine
and eligibility evidence required by the repository's saved merge policy. Check results
bind to head, suite/run, app and attempt; retain pending/failing/superseded
states. Blockers bind to the relevant head/base and covered rules, signatures
and threads. A head/base change invalidates incompatible current coverage while
preserving historical observations. Summaries never substitute for exact-head
review eligibility or all required checks.

Lists report covered pages/window, truncation and incomplete reasons. Acquisition
is resumed until coverage is complete; caps or parse errors are not proof that
an unseen PR or issue is absent. Preserve stored history; automatic unsubscribe
removes acquisition interest only, not facts, events, audio or transcripts.

## One collector and persisted changes

Evolve the existing acquisition paths into a ledger-owned collector. Reuse #8124
request sharing, saved page/stage progress and safe event cutoffs. The coding
pack reconcile and external-event timer must not both fetch the same facts.
A staged cutover assigns each acquisition family one owner; remove obsolete
network paths only after consumers are wired and verified.

Use a shared budget per credential identity and GitHub resource (REST requests
and GraphQL cost are different), with no secret values in keys or logs. Fair
repo shares, demand coalescing, conditional reads, cooldown/reset times and
persisted continuation prevent one backlog from starving others. Demand reads
do not bypass that budget. Requests learned during a scan cannot be hidden by
advancing a cutoff past unscanned items. Out-of-order responses cannot replace
newer facts or certify coverage for a different head.

Persist an observation, normalized fact revision, meaningful changes and delivery
outbox entries atomically. Stable change IDs distinguish `facts_changed` from
`observation_only`; observation refreshes and transport errors never masquerade
as progress. The todo projection decides which actual transitions affect its
stall incident. Events identify subject, fact revision and source evidence,
without carrying or redefining todo binding.

Each destination has a stable delivery key and persisted receipt for the event:
pending, durably accepted, observed, or failed, with message/receipt IDs and
corresponding times. Durable inbox acceptance and a worker having observed the
message are distinct. Retry ambiguous sends with the same idempotency key;
receiver-side durable deduplication prevents a crash between acceptance and
receipt persistence from creating a second PR-to-worker notice.

Terminal unsubscribe requires the final event's durable acceptance by each
relevant destination, or an explicit existing cancellation disposition. Never
treat a swallowed mailbox rejection as acceptance (`app.ts:866` currently logs
that rejection; `session-event-routing.ts:86` then proceeds to unsubscribe).
Replay legacy terminal subscriptions once through this same path, retry failures
and retain all history. Restart must not reissue an already accepted notice.

A repo health record tracks last attempted/successful complete coverage and
missed eligible cycles, including empty repos and repos never reached. After
three missed eligible cycles, persist a deduplicated Neo concern and structured
log with repo, lag, coverage and next retry. Cooldowns remain visible rather than
silently making the repo healthy; recovery resolves the concern. Record request
counts/cost by acquisition family/repo, cache reads, coalesced demand, coverage
lag and pending deliveries. Never log tokens, headers or response secrets.

## Small implementation slices and proof

Implement from fresh dev after #8124 merges. Each rung has a mapped issue,
failing/contract tests first and an isolated public-RPC journey. Aim for 100-200
changed production lines, with the repo's 300-line ceiling and a measured test
budget; split any oversized rung before implementation. API implementation must
follow reconciliation of the relayed projection needs; all six are covered above.
Relay any further interface changes through Neo before touching that API.

1. Pin existing consumer contracts and count duplicate upstream reads using one
   PR, several consumers, issue references and deploy evidence. No new scheduler.
2. Extract reusable parsing/acquisition seams without behavior changes.
3. Add revisioned ledger fact/coverage persistence and local read surface;
   separate worker provenance, retain existing summary compatibility.
4. Add collector refresh coalescing and shared acquisition ownership/budget in
   separate build/wire slices; persist meaningful change IDs and delivery receipts.
5. Rewire branch/work cards, then ask/project/read/query and deploy checks in
   individual measured PRs, expanding covered facts before each consumer moves.
6. Rewire external-event delivery to ledger changes and remove its duplicate
   acquisition, preserving page resume, supersession and cutoff guarantees.
7. Replay terminal subscription cleanup through acknowledged delivery; add the
   starvation concern/health journey. Wire remaining active connector/poller
   reads, then delete unused direct-read code in deletion-only PRs.

The synthetic proof compares identical consumer requests before/after: record
actual upstream request counts and GraphQL cost separately; a repeated covered
read must make zero extra upstream requests, concurrent missing-field requests
must produce one collector acquisition, and a real head change must refresh all
readers without mixing old reviews/checks. Include partial pages, empty repos,
rate exhaustion, stale/failed fields, out-of-order responses, process restart
and crash windows around delivery acceptance. A 200+ PR repo plus small repos
must retain fair progress. No real GitHub, keys, live DB writes or port 8399.

Each merge needs eligible exact-head review and green
required CI, followed by manual squash and issue/merge audit. Stop owned services
and remove the worktree. Send Neo PR/head immediately on opening and the merge
SHA plus read-only `hyperneo build` readback afterward. A build not containing
the merge is pending deployment, not proof. Final completion requires a deployed
build containing every slice plus comparable API-read/cost and freshness
measurements; neither a static inventory nor passing tests proves the live drop.
