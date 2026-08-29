# TaskAgentManager superpipe migration map

Measured map of `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`
(5,065 lines; 365 `if`/`else if` arms + 74 ternaries + switch cases ≈ 405+
branches) against ADR 0004. Measure-only slice: no source changes are proposed
here. Child implementation slices are cut by the coordinator after owner review.

Two epic suspects are verified **gone from this file**:
`recoverWorkflowBackedTask` now lives in `space-runtime-service.ts`, and the
verified-stop cascade was extracted to `verified-stop-flow.ts` — the suspected
"workflow node spawn/handoff lifecycle" cluster has already largely migrated
(see Already-migrated below).

## Deferred-cap verification (post-#3310)

Fully gone. #3310 deleted ~53 lines from this file — the
`enforceDeferredExternalEventCap` method, its call site, and the
`foldDeferredExternalEventOverflow` / `parseDeferredExternalEventText` /
`DEFERRED_EXTERNAL_EVENT_ROW_CAP` imports — plus
`tests/unit/5-space/runtime/task-agent-manager-deferred-event-cap.test.ts`. A
grep of the current file for cap/fold/parse-back/digest concepts returns zero
matches. No migration work remains there.

## Measurement summary

| # | Cluster | Lines (range) | Verdict |
| --- | --- | --- | --- |
| 1 | Module head: imports, config, module helpers | 1–312 | Stays (types + pure leaves) |
| 2 | Subscriptions, rate-limit restriction, archive | 313–633 (~320) | Stays (P6 bodies; small pure fold optional) |
| 3 | Spawn lifecycle wrapper + flow deps | 635–1098 (~464) | Already migrated at core; deps bag stays prose |
| 4 | `createSubSession` reuse-vs-create | 1110–1407 (~298) | **Pipeline: `create-node-agent-sub-session`** |
| 5 | Pending drain/flush (node + space agent) | 1409–1732 (~324) | Core migrated; `deliverSpaceAgentPendingRow` pipeline candidate |
| 6 | Injection wrappers, terminal gate, locks | 1734–1915 (~182) | Terminal gate reusable; locks stay |
| 7 | Lookups, worker identity, provenance readers | 1917–2168 (~252) | Plain helpers (extract module, optional) |
| 8 | Post-approval worker restore | 2170–2344 (~175) | **Pipeline: `restore-post-approval-worker`** |
| 9 | Activation routing | 2346–2550 (~205) | Owned by `space-runtime-tools-goals.md` P48–P50 |
| 10 | Getters + `syncLiveSessionWorkspace` | 2552–2745 (~194) | Already a `stagedRun` (exemplar) |
| 11 | Stop/resume/cancel/cleanup lifecycle | 2748–3076 (~329) | Core migrated (`runVerifiedStopFlow`); bookkeeping stays |
| 12 | Completion callbacks + handlers | 3078–3196 (~119) | Stays (subscription state machine) |
| 13 | Runtime contract + name aliases | 3198–3380 (~183) | Stays (prompt prose + pure leaves) |
| 14 | Rehydration | 3382–3805 (~424) | **Pipeline: `rehydrate-sub-session`** |
| 15 | `injectMessageIntoSession` delivery core | 3807–4047 (~241) | **Pipeline: `deliver-injected-message`** |
| 16 | Status publish, stop-preserve-DB, run helpers | 4049–4122 (~74) | Stays |
| 17 | MCP attach / self-heal | 4124–4392 (~269) | Heal core migrated; prologue candidate |
| 18 | `buildNodeAgentMcpServerForSession` | 4394–4826 (~433) | Stays (construction prose; no pipeline) |
| 19 | `spawnPostApprovalSubSession` | 4827–5065 (~239) | **Pipeline: `spawn-post-approval-worker`** |

## Already migrated (reuse, do not rebuild)

- `spawnWorkflowNodeAgentForExecution` (:635) is a thin wrapper over the
  `runSpawnExecutionFlow` `stagedRun` (`spawn-flow.ts`); the concurrent-spawn
  waiter machinery (:685–760) is resource ownership and stays in the class.
- `stopSessionVerified` (:2853) delegates to `runVerifiedStopFlow`.
- `flushPendingMessagesForSpaceAgent` (:1498) owns only the drain mutex/rerun
  queue; the drain itself is the `runSpaceAgentPendingDrain` superpipe.
- `flushPendingMessagesForTarget` (:1409) already admits via the
  `decidePendingDrainAdmission` `decisionRun` + `pending-drain-gates.ts`.
- `injectMessageIntoSession` (:3849) already routes via the
  `decideInjectDelivery` `decisionRun` (agent-layer
  `message-delivery-pipeline.ts`) and settles rows through
  `injection-delivery-steps.ts`.
- `syncLiveSessionWorkspace` (:2595) and the heal core of `mcpSelfHeal`
  (:4252–4325) are inline `stagedRun`s — the in-file idiom to copy.

## Pipeline candidates (business paths)

### `create-node-agent-sub-session` — cluster 4, ~298 lines

`createSubSession` (:1110) is the reuse-vs-create path: find prior execution
for the agent (skip when `freshSessionOnly`), reuse arm (rebind CAS with
`SpawnSupersededError`, stale co-owner release cascade :1167–1197, config
update, workspace migration under inject lock with node-agent-server
capture/restore compensation :1250–1264, callback re-register, flush), fresh
arm (`AgentSession.fromInit`, index/register, bind CAS with superseded
compensation that deletes the never-streamed session row :1357–1371, stream,
flush). Fit: strong `stagedRun` — sync admission gates, CAS effects, awaited
workspace migration, two compensations. The bind step composes the repo
primitive the spawn flow also wraps — `nodeExecutionRepo.casExecutionStatus`
with expected statuses derived from `SPAWN_BINDABLE_EXECUTION_STATUSES` — NOT
`rebindLiveExecution`/`bindExecutionToSession`, which are private
`buildSpawnExecutionFlowDeps` closures, not an exported API; the
expected-status derivation duplicated here (:1145–1157, :1344–1356) may become
a small plain helper inside the build slice, not a combinator. Risk: the stale
co-owner cascade (:1167–1197) reads executions via `listByWorkflowRun` then
writes them with a blind `update` — ADR 0004 bans blind read-modify-write
inside stages, so the build slice must resolve the write first: a stale-owner
CAS guarding BOTH the observed status AND the observed `agentSessionId`
(`casExecutionStatus` already takes `expectAgentSessionId`,
`node-execution-repository.ts:211`). Every branch that clears a binding —
the status-preserving branch AND the idle-transition branch — must condition
on the existing session id: a same-status rebind by another writer would
otherwise be cleared and the worker orphaned (double-spawn). A concurrency
pin must prove a row rebound to another session at the same status is NOT
cleared. The per-status branch OUTCOMES are preserved; the blind write itself
is not.

### `restore-post-approval-worker` — cluster 8, ~175 lines

`performPostApprovalWorkerRestore` (:2184): refusal gates (archived task/run,
cooldown → throw), cached-or-`AgentSession.restore`, slot match (a finite
configuration selection — a pure stage, not a loop to preserve), optional
slot-init overlay, MCP merge, `ensureNodeAgentAttached`, index/register (this
path attaches ONLY the `onMissing*` hooks and slot-context reset — it
registers NO completion callback today, and its identity query excludes
node-execution-owned sessions; preserve that), stream + replay with
unregister compensation (:2320–2331), detached flush. Fit: strong
`stagedRun`. The workspace update here (:2246–2248) writes metadata only —
NO node-agent capture/restore pair; preserve that asymmetry. The identity
resolution half (:2070–2168) stays plain helpers (raw-SQL
provenance/durable-id/cooldown readers).

### `activate-agent-for-message` — cluster 9, ~139 lines — OWNED BY SIBLING PLAN

`activateTargetSessionsForMessage` (:2346) is measured here for completeness,
but its migration is already assigned, slice by slice, to
`space-runtime-tools-goals.md` P48–P50: the P48 pins, the P49 unwired
`activation-routing-pipeline.ts` carrying the complete effect inventory
(resume-before-classification snapshot, stale-index cleanup before the reset
CAS, `reopenReason`/`reopenBy` forwarding, the bounded 30 s spawn race), and
the P50 TaskAgentManager wiring. This epic contributes nothing to it —
executing both plans would produce two competing pipelines for one operation —
so the ladder below carries no activation slice.

### `rehydrate-sub-session` — cluster 14, ~215 lines

`performSubSessionRehydrate` (:3486): six refusal gates (archived row, no
execution, no parent task, terminal task, no space, cancelled run) → cached or
`AgentSession.restore` → workspace resolve/update → init overlay → MCP merge →
attach → index/register → stream + replay with bookkeeping compensation
(:3675–3685) → detached flush. Completion-callback subscription stays
class-owned (cluster 12 classification): the pipeline declares the outcome,
the manager attaches/detaches callbacks at the lifecycle boundary. The
`resolveNodeExecutionForSubSession` repair (:3759–3768) — an unconditional
`updateSessionId` write when an `:exec:`-embedded execution lacks
`agent_session_id` — runs BEFORE the refusal gates; TAM-D1 must fence it
(expected-null CAS via `expectAgentSessionId: null`) or keep the repair
manager-owned outside the pipeline, never carry the blind write into a stage.
Fit: strong `stagedRun`. The outer `rehydrateSubSessionsForRun` (:3382) loop
and `rehydrateInFlight` dedup/restore lock (:3466) stay in the class (loop +
resource ownership, P6). Its tail (attach → register →
stream+replay+compensate → flush) is shape-identical to cluster 8's — compose
both directly. Cluster 19 is NOT a third tail use: its fresh arm registers
and streams via `createSubSession` BEFORE `ensureNodeAgentAttached` and
injects a kickoff without pending replay — a different ordering. Only two
direct tail uses exist; a shared combinator needs a true third (ADR 0004
≈3-use rule).

### `deliver-injected-message` — cluster 15, ~184 lines

`injectMessageIntoSession` (:3849): the `decideInjectDelivery` decision
(`noop`/`defer`/`clear_before_deliver`/`deliver_without_clear`) already exists;
the complete path is still imperative — message assembly (pure transform),
`defer` arm (:3926–3942), clear-with-error-tolerance (:3943–3958 —
`ClearConversationCancelledError` is RETHROWN, never tolerated: cancellation
must pass through so no message is delivered during a cancelled reset; only
ordinary clear errors fall through to deliver), the
not-busy backlog-replay pre-delivery block with flip-to-deferred fallback
(:3964–4017; structured replay FAILURES drive the flip — they are not
swallowed), then `deliverInjectedMessage`. Fit: strong mixed pipeline
composing `decideInjectDelivery`'s gate functions DIRECTLY as its decide stage
group — never an invocation of the `decisionRun('message-inject-delivery')`
runner as a nested sub-pipeline (one business path, one pipeline; the same
direct-composition convention agent-routing.md applies to query-retry).
**Coordination risk:** agent-routing.md's PRs own the gates in
`message-delivery-pipeline.ts`; this slice embeds them read-only and must not
fork them. Per-message (not per-event) frequency, so pipeline overhead is
fine.

### `spawn-post-approval-worker` — cluster 19, ~239 lines

`spawnPostApprovalSubSession` (:4827): slot match → live-reuse arm (terminal
gate, run-ownership guard, workspace migration with capture/restore
compensation, inject) vs fresh arm (model-pool reservation with release
compensation, init + MCP merge, `createSubSession`, attach, inject, activate
reservation). Fit: strong `stagedRun`; third instance of the reuse-vs-fresh
shape (after `spawn-flow.ts` and cluster 4). **Outcome contract (P46
coordination):** the sibling plan's P46 `post-approval-route` pipeline
consumes this spawner through a bounded spawn outcome that must distinguish
CREATED vs REUSED sessions and KICKOFF DELIVERED vs SKIPPED (the terminal-gate
skip) — its CAS-loss compensation and deadline cleanup run ONLY for sessions
the attempt created, and a skipped reuse routes to release/terminal handling.
TAM-F therefore owns the richer outcome record (or is explicitly sequenced
with P44/P46); preserving only today's `{ sessionId }` return leaves P46
without its required contract. Pins exist
(`task-agent-manager-post-approval.test.ts`).

### `deliver-space-agent-pending-row` — cluster 5, ~71 lines

`deliverSpaceAgentPendingRow` (:1611): staleness/expiry/attempt-cap gates,
attempt record, inject with late-settlement callbacks, settle-or-reconcile
arms. Fit: small pipeline; the late-settlement watcher arming (:1534–1586)
stays in the class (handles/cancel are resources).

## Stays plain (ADR 0004 exclusions)

- **Per-event subscriber bodies** (cluster 2): rate-limit pause/resume
  listeners, activity tracking (`recordActivityForSession` fires on every
  tool-use event — hot, Decision 8), archive listener. `recomputeTaskRestriction`
  (:510) is a ~25-line pure fold feeding one CAS — a plain helper extracted
  next to the listener is enough; no pipeline value at this frequency.
- **Loops stay loops** (P6): the per-row drain loop (:1444), the per-execution
  rehydrate loop (:3397), the per-session archive/cleanup loops. Only bodies
  may compose.
- **Resource ownership** (Decision 5): concurrent-spawn waiters, drain
  mutex/rerun sets, retry timers, restore/inject locks, session indexes,
  completion-callback subscriptions (cluster 12), late-settlement handles.
- **Construction prose** (clusters 3 deps bag, 13, 18):
  `buildSpawnExecutionFlowDeps`, `buildKickoffMessage` (delegates to
  `buildCustomAgentTaskMessage` — composition prose, stays per epic note),
  `buildNodeExecutionRuntimeContract` (prompt prose), and
  `buildNodeAgentMcpServerForSession` — a ~433-line builder wiring routers,
  end-node handlers, the PR-merged gate, and ~20 tool-handler closures. Not a
  business-path cascade; a pipeline here would only obscure DI. Optional
  non-superpipe follow-up: split into per-concern builder modules.
- **Lookups** (clusters 7, 16): identity/provenance readers, getters,
  `pickBestNodeExecution` — pure or DB-bound queries.

## Proposed slice ladder

Ordering runs lowest-risk first; every PR targets `dev`, ≤ ~300 prod lines,
tests ride their slice. Exact cut is the coordinator's after owner review.

| Slice | Deliverable | Kind | Prod Δ | Test Δ | Depends on |
| --- | --- | --- | --- | --- | --- |
| TAM-PB | Pins for `createSubSession` reuse/fresh arms (incl. the narrow-compensation and same-status-rebind rows) | test-only | 0 | ≲120 | — |
| TAM-PC | Pins for `restorePostApprovalWorkerSession` (incl. no-completion-callback) | test-only | 0 | ≲80 | — |
| TAM-PD | Pins for `rehydrateSubSession` refusal gates + repair effect | test-only | 0 | ≲100 | — |
| TAM-PE | Pins for `injectMessageIntoSession` arms (incl. cancellation passthrough ordering) | test-only | 0 | ≲120 | — |
| TAM-PF | Pins for `spawnPostApprovalSubSession` reuse/fresh arms | test-only | 0 | ≲100 | — |
| TAM-PG | Pins for `deliverSpaceAgentPendingRow` settlement/error races | test-only | 0 | ≲60 | — |
| TAM-B1 | `create-node-agent-sub-session` stagedRun, unwired (gates + both arms + compensations + session-guarded stale-owner CAS with concurrency pin) | build | ≲250 | ≲250 | TAM-PB |
| TAM-B2 | Delegate the `createSubSession` method body to the B1 pipeline (its only two callers — spawn-flow deps and post-approval, both in-file — stay unchanged) | wire | ≲50 | ≲60 | TAM-B1 |
| TAM-C1 | `restore-post-approval-worker` stagedRun, unwired | build | ≲180 | ≲150 | TAM-PC |
| TAM-C2 | Wire `restorePostApprovalWorkerSession` | wire | ≲40 | ≲50 | TAM-C1 |
| TAM-D1 | `rehydrate-sub-session` stagedRun, unwired (fenced repair) | build | ≲220 | ≲200 | TAM-PD |
| TAM-D2 | Wire `rehydrateSubSession` | wire | ≲40 | ≲50 | TAM-D1 |
| TAM-E1 | `deliver-injected-message` pipeline composing `decideInjectDelivery`'s gates directly (coordinate boundary with agent-routing plan) | build | ≲170 | ≲180 | TAM-PE |
| TAM-E2 | Wire `injectMessageIntoSession` | wire | ≲50 | ≲60 | TAM-E1 |
| TAM-F1 | `spawn-post-approval-worker` stagedRun, unwired, returning the P46 CREATED/REUSED + DELIVERED/SKIPPED outcome | build | ≲200 | ≲180 | TAM-B2, TAM-PF (P46 outcome contract) |
| TAM-F2 | Wire `spawnPostApprovalSubSession` | wire | ≲40 | ≲50 | TAM-F1 |
| TAM-G | `deliver-space-agent-pending-row` pipeline — trivial build+wire combined per the stated exception (≲100-line pipeline, one internal call site, few-line swap); requires the status-guarded settlement/error primitive (risk 5) | build+wire | ≲100 | ≲80 | TAM-PG |
| TAM-H (optional, not superpipe) | Extract provenance/cooldown/durable-id readers + `resolveTerminalInjectionStatus` into `sub-session-identity.ts` plain helpers | extract | ≲120 | ≲60 | — |

Pin slices are one per business path (one purpose, one PR): each build slice
depends only on its own pins, so unrelated matrices never gate an
implementation. Every pin slice gap-measures against the existing suites in
BOTH `5-space/runtime` (9 `task-agent-manager*` files plus the
spawn/pending/injection brick suites) and `5-space/agent` (7 more, incl.
spawn-admission/spawn-cas/spawn-flow, post-approval-*, cancel) before
writing new rows.

Construction and integration do not share a PR: every build slice lands as
additive dead code pinned by per-stage tests, and its wire slice is a
single-family call-site swap; TAM-G is the one combined slice and stays within
the trivial build+wire exception. Cluster 9 (activation) carries NO slice
here — `space-runtime-tools-goals.md` P48–P50 already own its pins, unwired
pipeline, and wiring; this epic defers to them. After TAM-B2/D2/F2 land, the
reuse-vs-fresh stagedRun shape has 3 direct uses (spawn-flow, create,
post-approval) + 2 close cousins (rehydrate, restore) — a follow-up MAY
propose a combinator per ADR 0004's ≈3-use rule; never before.

## Cross-cutting ADR-0004 risks

1. **Two loop kinds** — loops over durable rows/sessions (the drain rows, the
   rehydrate executions, the archive/cleanup sessions) are folds owned by the
   class: only bodies may compose. Finite configuration selections (cluster
   8's slot match :2219–2229, cluster 19's node/slot scan :4844–4853) are not
   folds — they compose as pure selection stages/helpers inside their
   pipelines.
2. **Hot-path discipline** — activity tracking and message injection are
   per-event/per-message; decide stages must stay synchronous where coupled to
   the run tick, and `recordActivityForSession` stays inline.
3. **CAS semantics** — `SpawnSupersededError` and `'superseded'` outcomes are
   control flow, not errors; each pipeline's outcome mapping must preserve the
   current throw/return split per caller (spawn wrapper throws; activation
   swallows and returns `[]`).
4. **Compensation duplication** — the workspace-migration capture/restore pair
   appears four times (clusters 4, 10, 17, 19; cluster 8's restore writes
   workspace metadata only, with no pair — preserve that asymmetry). Until a
   combinator is justified, each pipeline registers its own single
   compensation; do not share mutable capture state across stages. The
   capture/restore is scoped to `reinjectNodeAgentMcpServer` failure ONLY — a
   LATER attach/inject failure must NOT roll back the migrated workspace
   (pinned for cluster 4: `ensureRequiredMcpServersAttached` rejects but the
   new workspace remains); it is not a general stagedRun unwind.
5. **Blind-write hot spots** — stale co-owner release (cluster 4), the
   space-agent settlement/error writes (cluster 5: a late `onConsumed` can
   settle a row while the injector failure path runs, and `recordDeliveryError`
   writes unconditionally across statuses, smearing failure metadata onto a
   delivered row), and completion/error status writes (cluster 12 handlers)
   use `update`/`getBy…` read-modify-write; ADR 0004 bans carrying them into
   stages as-is. Each slice that touches one must resolve it up front — a CAS
   guarding status AND session/row ownership (`expectAgentSessionId`), or the
   effect stays in the class — never silently preserving or altering the
   atomicity. Status-only CAS is NOT sufficient where a binding is cleared: a
   same-status rebind by another writer must not lose ownership. TAM-G in
   particular needs a status-guarded settlement/error primitive (or those
   effects stay outside the pipeline) before it lands.
6. **Boundary with agent-routing.md** — `decideInjectDelivery`'s gates,
   `injection-delivery-steps.ts`, and the agent-layer delivery pipelines are
   owned by that plan; TAM-E1 embeds the gate functions directly — no nested
   runner invocation, no forking.

## Open questions

1. ~~For TAM-B1's stale-owner write (risk 5): expected-status CAS primitive,
   or the effect stays class-owned?~~ Resolved by review: the dual-guard CAS
   (status + `expectAgentSessionId`) — both clear-binding branches condition
   on the observed session id, plus a concurrency pin for the same-status
   rebind case.
2. Should cluster 18's builder split (TAM-H-adjacent) be in this epic at all,
   or a separate maintainability epic? It is not superpipe work.
3. Are the `legacyWorkflowRoute*` fallbacks in cluster 7 still load-bearing,
   or deletable dead legacy? A deletion slice could precede TAM-C if the owner
   confirms no persisted workflows rely on them.
