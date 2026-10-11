# Neo daemon: simplification plan

Status: proposal for review. Nothing here is implemented.
Scope: `packages/daemon/src/lib/neo/` (62 files, about 11,500 lines), the 15 `neo-*` repositories and `shared/types/neo-*`, read at dev `ea41bb176`.
Tracks: epic #6002.

## Why

Neo grew fast. Most fixes this week followed one pattern: a rule written in the web, iOS and the daemon was moved into the daemon, and the clients started reading a field. That pattern is right, but it was applied one field at a time. Several restart bugs were fixed one by one too. This plan names the few structural gaps behind those fixes, lists the cleanups that change no behaviour, and records the bugs the review found.

Five slices were reviewed separately and the main claims were checked by hand: service core, operations, the card lifecycle, intake and routing, and packs and evidence. Line counts are estimates.

## Design gaps

### 1. The daemon should publish views, not parts

The snapshot sends `work` plus seven arrays that clients join by work id: `workDrivers`, `workGoals`, `workContinues`, `workPrs`, `workSupersessions`, `workResources`, `workChecks`. Each client then works out what a card should say. Tonight's fixes each moved one such rule back into the daemon: `retryable`, `uncheckedSince`, the PR verdict (#6400), supersession (#6397) and `pooled`/`approvalSpent` (#6426).

Proposal: the daemon publishes one presentation-ready `NeoCardView` per card and one `NeoAskView` per ask. These carry the phase, its label, the actions allowed, the PR summary, and whether the card is superseded or unchecked. Web and iOS only render them. The seven arrays go once both clients read the views.

### 2. A card has one phase, computed in one place

A card's state is spread over nine tables. They are `neo_work`, `neo_work_driver_targets`, `neo_work_goals`, `neo_work_continues`, `neo_work_prs`, `neo_work_checks`, `neo_work_resources`, `neo_work_supersessions` and `neo_agent_work_targets`. It is also described in three vocabularies: `work.status`, the driver's `live_status`, and the evidence or PR verdict. They disagree in practice. A card read `queued` while its session was `running`.

Proposal: one pure `neoCardPhase(work, driver, evidence)` that every reader uses (the view in item 1, done checks, follow-up, notices). Later, fold the one-row-per-card tables into fewer tables: continues, goal and supersession move onto the card or driver row. That later step needs a migration and is out of this plan's first steps.

### 3. Restart safety is an invariant, not a patch list

Restarts caused #6356, #6389, #6395, #6396 and #6432 (a rate-limit cooldown never retried). `NeoService` holds 17 in-memory maps and sets. Some drive behaviour or the UI: `cardChecks` feeds "not checked since", which silently resets on restart. Several are never pruned (`cardChecks`, `followReads`, `askEvidenceReads`, `processingStatus`).

Proposal: anything in flight is a persisted row with a resume rule. That covers turns, cooldowns, pending deliveries, reminders and checks. Memory may only cache what can be rebuilt from the database. There is no second reconciler. The rows hook into the startup pass `app.ts` already runs, and each owner keeps its own resume rule: the session, the Space runtime and Neo. A generic sweep almost broke the Space workers' `TaskAgentManager` rehydrate in #6433.

### 4. Finish the pack seam

ADR 0009 says core reads evidence through packs. Core still calls the coding pack directly:

- `checkDone` reads coding PRs (`service.ts:394`, `done-check.ts:4,70`).
- Ask ticks build evidence with `neoAskPrEvidence` (`service.ts:1894`).
- "Told" is recorded from coding PR rows (`service.ts:2008-2011`), while the refresh path plans from pack evidence (`service.ts:1452`).

With a second pack that reads evidence, the recorded signature and the planned one differ, and done-check notes would re-send every pass. Also, `checks` has one kind, fixed in three places. And nothing uses `workerSkills` or `workerMcpServers`.

Proposal: every done check goes through `readEvidence`, "told" is recorded from the evidence that was planned, and the unused contract members are dropped until a pack needs them.

### 5. Stamp the ask on the turn

Which ask a turn belongs to is worked out again for every streamed message. The code parses message ids, then walks mutable work and consultation status (`ask-origin.ts`, up to eight hops). Because the status can change during the turn, a reply can lose its ask. That is the "unknown ask origin" refusal (#6394, and B1 below).

Proposal: the daemon stamps the ask id on a turn's input when it delivers it, and resolution reads it in one hop.

### 6. Fewer concepts

The model has concerns, consultations, holders, bindings, a routing log, publications, conversation asks, asks and work. On the main laptop daemon there are 26 asks and 55 cards. There is one concern, and the consultation tables, context write grants, work resources and agent work targets have never held a row. These paths are still reachable: `neo.concern.consult` is in the root prompt.

Proposal: converge on ask → card → note → reply. Once other daemons confirm the same usage, retire or fold consultations, holders and concerns.

### 7. Revisit how ADR 0004 applies here

Every business path is a superpipe pipeline, but each is cast to its final signature with `as PipelineAPI`. So the compiler never checks how stages connect. The rule costs identity stages, `result:` round trips and repeated gates without the type safety. The gate and `result:` discipline has caught real bugs and stays. The proposal is typed helpers, so that stage inputs and outputs are checked rather than cast. This is a decision for ADR 0004 and `CLAUDE.md`, not a cleanup.

## Cleanups that change no behaviour

| # | What | Where | ~Lines |
|---|---|---|---|
| 1 | Stop writing `neo_work_prs.delivered/delivered_at/reminded`. Nothing reads them since m320 moved delivery to `neo_work_checks`. Drop `markDelivered` and `neoWorkPrSignature`. | `service.ts:2008`, `neo-work-pr-repository.ts:71-79`, `work-prs.ts:83,133` | 35 |
| 2 | The minute pass loads every `neo_work` row ever stored (`listWork()` has no `WHERE`) and does about six reads per reported card before an age gate drops it. Iterate the bounded `driverTargets.cardRefs(...)` instead, and merge the two `listLive()` loops. | `service.ts:1143-1172` | 10, plus bounded DB work |
| 3 | Read a card's driver-target row once. Today nine single-column getters cost 3–4 queries per card. | `neo-work-driver-target-repository.ts:59-158` | 60 |
| 4 | Remove about 30 `hasTable()` guards and the per-query `PRAGMA table_info` probes. Migrations always run first (`database-core.ts:84`). Some migration tests build partial schemas, so run the migration shards. | 7 work repositories, `neo-ask-repository.ts:46-63,239-317` | 80 |
| 5 | Parse a driver status reply once per settle tick and pass the parsed value down; don't write a new parser. Today it is parsed up to five times. Do this after #6417. | `driver-work.ts:278-301,445-563` | 35 |
| 6 | Ask operations: one shared "owned, live ask" opening stage and one "re-plan status" closing stage. Propose's three back-to-back ask gates become one. | `ask-operations.ts:477-667`, `operations.ts:968-985` | 75 |
| 7 | One check for where proposed work may run. It is written twice today. | `operations.ts:1030-1079`, `work-target.ts:103-150` | 40 |
| 8 | The snapshot zod schema re-declares `NeoSnapshot` and has drifted (`waitingOnHuman`, `consultations`). Add `satisfies z.ZodType<NeoSnapshot>` so drift fails the build. | `operations.ts:105-283` | 0–60 |
| 9 | Add helpers for repeated code in `service.ts`. `failWork()` replaces "fail, then return the report", written five times, and the `12000` report limit is copied five times. `deliverToOrigin()` and `invokeAsCard()` cover six repeats each. Use `notifyChanged` instead of six inline lambdas. | `service.ts` | 90 |
| 10 | Extract `NeoSessionWatcher`, which is self-contained and about 200 lines. Build the follow card in one `followCard()`: it is assembled twice today and the copies have already drifted. | `service.ts:280-284,1182-1374` | 200 moved, 20 cut |
| 11 | Remove repeated liveness checks with nothing in between, identity stages and single-stage pipes. Share one page reader between the publication and conversation-ask read ops. | consult and propose pipelines, `intake.ts`, `response-input.ts`, the two read ops | 130 |
| 12 | Remove dead or test-only code: the consult branch in `admitNeoCaller`, the never-written `'new'` route destination, `NeoRoutingLogRepository.listAfter`, a dozen exports nothing imports, and `NODE_ENV === 'test'` branches in the router. | see slices | 60 |
| 13 | Parse GitHub URLs through `lib/github/parse-pr-url.ts` (`parsePrUrl`, `parseGitHubTopic`), with the lowercase key added there. They are parsed three ways in Neo today. Use one `gh api graphql` argument builder. | `work-prs.ts`, `ask-prs.ts`, `lib/github/parse-pr-url.ts` | 20 |

Together these remove roughly 700–900 lines, about 7% of the Neo daemon, with no behaviour change.

## Bugs found on the way

These come from reading the code. Each needs a failing test before its fix.

- **B1.** If root continues a card in the middle of a turn, the rest of the turn loses its ask, and `neo.publication.publish` is refused with `unknown_ask_origin` (`ask-origin.ts:75-81`). Item 5 removes the cause.
- **B2.** A retried ask replays its route from the best-effort routing log, not from the ask ledger. If the log write failed or was corrected, the retry gets a false "request id already belongs to a different ask" (`intake.ts:197-228`).
- **B3.** The router's `profileVectors` map is module-level and never cleared, so it grows about one embedding per routed ask (`router.ts:82`).
- **B4.** PR URLs are compared case-sensitively in three places and case-insensitively in one. A link in a different case from GitHub's never ticks `coding.pr_merged` (`work-prs.ts:42,109-146`).
- **B5.** A continued card under a concern has its second report dropped as "already routed". The review id ignores the continue count (`work-return.ts:11-13` vs `service.ts:1853`).
- **B6.** When `start()` fails, the card is marked failed but its report is never returned (`service.ts:888-898`).
- **B7.** If `coding` is left out of `settings.neo.packs`, refresh waits forever while `checkDone` still reads PRs (`service.ts:1471-1478`).
- **B8.** An issue closed as duplicate is reported as "closed as completed" (`ask-prs.ts:179`).
- **B9.** `neo.work.retry` refuses with "…can continue it" (`operations.ts:1249`).

## Order

1. **Bugs.** One PR per bug, each with its failing test first.
2. **Cleanups.** One PR per slice, all behaviour-preserving, each green on the existing suite: service core (1, 2, 9, 10), card lifecycle (3, 4, 5), operations (6, 7, 8), intake (11, 12), packs (13).
3. **Design.** Items 1, 3 and 5 first. They match this week's recurring failures. Items 2, 4 and 6 follow. Item 7 is an ADR 0004 amendment.

## Open questions

1. Item 6: do other daemons (Space, remote) use consultations, holders or concerns?
2. Item 7: which typed helpers, and does the ADR 0004 amendment also change `CLAUDE.md`?
3. Item 1: replace the seven snapshot arrays, or add the views alongside them for a release?
