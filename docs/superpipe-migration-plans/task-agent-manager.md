# TaskAgentManager superpipe migration map

Measured map of `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`
(5,065 lines; 365 `if`/`else if` arms + 74 ternaries + switch cases ≈ 405+
branches) against ADR 0004. Measure-only slice: no source changes are proposed
here. Child implementation slices are cut by the coordinator after owner review.
The ladder below is the current 35-row table (pin / build / wire / delete /
extract); coordinators cut child issues from that table, not from any earlier
summary of it.

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
| 6 | Injection wrappers, terminal gate, locks | 1734–1915 (~182) | Admissions compose into `deliver-injected-message` (cluster 15); inject lock stays |
| 7 | Lookups, worker identity, provenance readers | 1917–2168 (~252) | Plain helpers (extract module, optional) |
| 8 | Post-approval worker restore | 2170–2344 (~175) | **Pipeline: `restore-post-approval-worker`** |
| 9 | Activation routing | 2346–2550 (~205) | Owned by `space-runtime-tools-goals.md` P48–P50 |
| 10 | Getters + `syncLiveSessionWorkspace` | 2552–2745 (~194) | Already a `stagedRun` (exemplar) |
| 11 | Stop/resume/cancel/cleanup lifecycle | 2748–3076 (~329) | Core migrated (`runVerifiedStopFlow`); bookkeeping stays |
| 12 | Completion callbacks + handlers | 3078–3196 (~119) | Stays (subscription state machine) |
| 13 | Runtime contract + name aliases | 3198–3380 (~183) | Stays (prompt prose + pure leaves) |
| 14 | Rehydration | 3382–3805 (~424) | **Pipeline: `rehydrate-sub-session`** |
| 15 | `injectMessageIntoSession` delivery core | 3807–4047 (~241) | **Pipeline: `deliver-injected-message` (with cluster 6)** |
| 16 | Status publish, stop-preserve-DB, run helpers | 4049–4122 (~74) | Stays |
| 17 | MCP attach / self-heal | 4124–4392 (~269) | **Pipeline: `self-heal-node-agent`** (imperative prologue + staged heal tail) |
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
- `syncLiveSessionWorkspace` (:2595) and the heal TAIL of `mcpSelfHeal`
  (:4252–4325) are inline `stagedRun`s — the in-file idiom to copy. The
  self-heal PROLOGUE (:4191–4250 — execution/task/space gate cascade and the
  displaced-session adoption branch) is still imperative and is a pipeline
  candidate below (`self-heal-node-agent`).

## Pipeline candidates (business paths)

### `create-node-agent-sub-session` — cluster 4, ~298 lines

`createSubSession` (:1110) is the reuse-vs-create path: find prior execution
for the agent (skip when `freshSessionOnly`). Reuse admission includes the
COLD-CACHE branch — a prior `agentSessionId` absent from `agentSessionIndex`
awaits `rehydrateSubSession` and reuses the durable session when restoration
succeeds (:1124–1127); treating "not indexed" as "fresh" after a daemon
restart would double-spawn the worker. A FAILED cold restoration (rehydrate
returns null — durable session missing or archived) falls through to the
fresh arm, but the fresh bind (:1343–1376) then sees the OLD non-null binding
and skips its CAS, leaving the new streaming worker UNBOUND while routing
still references the ghost session — repeated retries stack orphan workers;
TAM-B1 must add a status-and-session-guarded stale-binding resolution before
the fresh arm (TAM-PB characterizes the failed-restoration fall-through as
surviving behavior; the guarded resolution lands with B1). A SUCCESSFUL cold
restoration can still fail BEFORE the create result exists: after
`rehydrateSubSession` completes and starts the worker (:1124–1126),
`updateConfig`, workspace reinjection, or `ensureRequiredMcpServersAttached`
(:1202–1268) can reject before `createSubSession` returns (:1299) — F1's
post-create cleanup can never observe such a failure, so the CREATE GROUP
itself carries a provenance-aware unwind (with the concurrent-join ownership
guard) that stops the newly restored worker without deleting its durable
session — OWNED BY TAM-B0 (which lands the provenance and its tests before
any wiring slice can expose the path). Reuse arm (rebind CAS with
`SpawnSupersededError`, stale co-owner release cascade :1167–1197, config
update, workspace migration under inject lock with node-agent-server
capture/restore compensation :1250–1264), fresh arm (`AgentSession.fromInit`,
bind CAS with superseded compensation that deletes the never-streamed session
row :1357–1371, hook installation — `reattachSlotContextReset` (:1325) and
`onMissingWorkflowMcpServers` (:1385–1389) BEFORE `startStreamingQuery`, the
same pre-stream invariant as rehydration (pin the ordering) — then stream).
The `deferFreshExecutionBind` flag is LOAD-BEARING in
the stage contract: the spawn-flow caller passes it (:968, together with
`freshSessionOnly`, which makes the reuse arm unreachable there) — under the
flag the FRESH-arm bind CAS (:1343) and BOTH arms' trailing flush (:1286,
:1391) are suppressed, leaving the outer guarded bind (`bindExecutionToSession`
with `expectAgentSessionId`, :983–997) as the SOLE commit point. The
REUSE-arm rebind CAS (:1144–1166) is NOT flag-gated — do not widen the gate
to it. A pipeline that fresh-binds or flushes without carrying the flag binds
prematurely, makes the outer CAS report `superseded`, and unwinds otherwise
valid spawns (pin the fresh arm under the flag and the reuse CAS's
independence from it). Index/registration
(:1327–1333) stays manager-owned at the same PRE-STREAM boundary as TAM-C/
TAM-D, like the callback
re-registration (:1272–1277): the pipeline reaches a registration boundary —
the manager swaps the callback and registers the session BEFORE
`startStreamingQuery` (:1389) runs, matching today's ordering (:1327–1333
precede :1389) so startup-time hooks and lookups never observe a streaming
session absent from the indexes (pin registration-before-stream). Both
arms end with a DETACHED `void flushPendingMessagesForTarget(...).catch`
(:1286–1297, :1391–1402) — suppressed under `deferFreshExecutionBind` — so a
drain failure must never reject or compensate a successfully created/reused
session. When F1 composes the create group, it needs a FLUSH-SUPPRESSION
control SEPARATE from `deferFreshExecutionBind`: the detached flush would
otherwise launch before the create group returns and keep injecting/settling
pending rows while F1 stops/unregisters/deletes the session on a later
attach/kickoff failure (no compensation can wait for or cancel that work) —
F1 runs the flush only after a successful post-approval commit, with a
pending-row failure test. The flush commit point is P46's `record-dispatched-session`
CAS, which runs AFTER F1 returns its spawn outcome: if that CAS loses or a
later route stage fails, P46 terminates the CREATED session while the flush
may already be injecting/settling rows — F1 exposes a CONTINUATION/stage for
P46 to invoke the flush ONLY after the dispatch CAS succeeds, or the flush is
awaited/cancelled before any post-F1 cleanup. Like the delivery stage group, the CREATE stage group is EXPORTED
for direct composition: the owning spawn pipelines compose the create stages
directly — `spawn-post-approval-worker` via TAM-F1, and the spawn flow's
`createSpawnedSession` dep via TAM-B3 (that slice owns the spawn-flow
stage-list edit) — no pipeline invokes the create RUNNER from inside another
pipeline. The group carries its own PARTIAL lock boundary today (bind/config
mutations :1148–1215, then `withSessionInjectLock` for workspace migration
:1221–1269), so composition needs an explicit lock protocol: the group
accepts an ALREADY-HELD handle from the owning pipeline (or performs its own
acquisition when standalone) — wrapping the whole group under F1's lock
deadlocks the non-reentrant promise lock, and leaving it unwrapped puts the
early mutations outside the terminal fence (pin the full ordering). The
held-handle protocol must ALSO extend through STARTUP SELF-HEAL:
`startStreamingQuery` awaits `onMissingWorkflowMcpServers` (query-runner.ts:793–796),
which calls `mcpSelfHeal`, which independently enters `withSessionInjectLock`
(:4252) — so a fresh or cold-restored worker starting with a missing required
MCP server would wait forever on the owner's held reset-coordination lock; the
self-heal callback must receive the held handle (or the lock is released
before startup without opening the terminal race), and the missing-MCP
startup path is pinned. Fit:
strong `stagedRun` — sync admission
gates, CAS effects, awaited
workspace migration, two compensations. The bind step composes the repo
primitive the spawn flow also wraps — `nodeExecutionRepo.casExecutionStatus`
with expected statuses derived from `SPAWN_BINDABLE_EXECUTION_STATUSES` — NOT
`rebindLiveExecution`/`bindExecutionToSession`, which are private
`buildSpawnExecutionFlowDeps` closures, not an exported API; the
expected-status derivation duplicated here (:1145–1157, :1344–1356) may become
a small plain helper inside the build slice, not a combinator. BOTH PRIMARY
binds — reuse (:1148–1157) and fresh (:1347–1356) — must ALSO pass
`expectAgentSessionId` with the OBSERVED value (`null` for a fresh target):
they guard only status today, so a same-status foreign bind between snapshot
and CAS would be overwritten and its worker orphaned; the foreign-bind race
rows land with TAM-B1's guarded binds, never in TAM-PB. Risk: the stale
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

`performPostApprovalWorkerRestore` (:2184): refusal gates — MISSING or
DETACHED task (`!task?.workflowRunId` → null, :2192–2193; pin both the
deleted-task and detached-task inputs), task
`cancelled`/`archived` (:2192–2194) AND run `cancelled` (:2195–2196) return
`null` before any space load or restore (pin all three rows; "archived
task/run" alone underspecifies them), cooldown → throw, missing space
(`getSpace` null → `null` at :2205–2206, before slot resolution or restore —
pin the pre-restore ordering) — then cached-or-
`AgentSession.restore`, slot match (a finite
configuration selection — a pure stage, not a loop to preserve), optional
slot-init overlay, MCP merge, `ensureNodeAgentAttached`, `onMissing*` hooks +
slot-context reset (this path attaches NO completion callback today, and its
identity query excludes node-execution-owned sessions; preserve that),
transcript sanitization IMMEDIATELY BEFORE `startStreamingQuery`
(:2321–2323 — `sanitizeSDKSessionTranscriptForRehydration` normalizes
malformed assistant usage counts; skipping it resumes against a broken
transcript; pin the pre-stream ordering), stream + replay with unregister
compensation (:2320–2331), detached flush. Registration AND its failure
compensation are CONDITIONED on `createdNow = !cached` (:2231–2233): a
cached-but-unindexed worker skips `registerSession` (:2318) and, on
stream/replay failure, removes only the manager indexes WITHOUT
`unregisterSession` (:2324–2329) — the pipeline must preserve that
conditioning or a restore failure evicts a globally-owned cached session
(pin a cached-session row in TAM-PC). Two admission facts also precede the
gates: the PUBLIC index check (:2177) and the IN-LOCK index re-gather
(:2190) — two concurrent restorers of the same uncached worker both miss the
public check and queue on `withSessionRestoreLock`, and the second returns
the first's session from the in-lock recheck; carry the re-gather into
TAM-C and pin two concurrent callers. Index/registration
(`agentSessionIndex` + `registerSession`, :2313–2318) stays manager-owned and
must stay at its PRE-STREAM position — the pipeline reaches a registration
BOUNDARY where the manager indexes/registers before `startStreamingQuery`
runs (startup-time lookups and the failure-path unregister depend on it), not
an after-the-pipeline return. The cooldown gate THROWS (retry deadline in the
message, :2198–2203) rather than returning null — pin the throw outcome and
its pre-restore ordering in TAM-PC, or a retryable worker reads as merely
absent. Fit: strong
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
execution, no parent task — the parent-task selection is NOT a generic
"first row of the run": :3507–3526 first matches task IDs derived from the
sub-session identity (`taskIdFromSubSessionIdentity`) and the in-memory
ownership map (`findParentTaskIdForSubSession`), CONSTRAINS those matches by
the space ID encoded in the session id, and only then falls back — carry that
owner-resolution algorithm into a stage and pin a multi-task identity row in
TAM-PD, or a multi-task run rehydrates the worker under another task's
workspace/prompt/lifecycle — task-status rejection limited to
`cancelled`/`archived`/`stopped` (:3537–3545) — `done` is deliberately
ADMISSIBLE here and must stay so (pin it); conflating it with a generic
"terminal task" gate would drop a done task's live execution during run
restoration —, no space, cancelled run) → cached or
`AgentSession.restore` → workspace resolve/update (TAM-D routes task-owned
choices through `resolveTaskWorkspace` — the registry-mandated helper —
WITHOUT dropping the persisted-session fallback: today's chain keeps
`agentSession.getSessionData().workspacePath` ahead of `space.workspacePath`
(:3588–3596), pinned by the existing "restored session keeps its own
workspace" test; a bare `resolveTaskWorkspace(space, task)` returns the
primary workspace and relocates the worker — the helper resolves the task's
registered repository, the chain still prefers cached > explicit >
session-persisted > resolved; the task-bound-secondary-workspace row lands
with D1) → SYSTEM-PROMPT-ONLY
refresh — `resolveCurrentNodeAgentInitForExecution` returns a full init but
the path applies ONLY `currentInit.systemPrompt` (:3610–3612; applying the
whole init would clobber persisted tool guards, skill overrides, and
model/provider settings — pin the narrow behavior; note cluster 8's restore
path deliberately DOES apply slot guards/overrides, a real asymmetry to
preserve) → MCP merge →
attach → `onMissingWorkflowMcpServers` hook + `reattachSlotContextReset`
(:3658–3661, BEFORE the stream starts — rehydration tests verify the
self-heal callback is visible when streaming begins; pin that ordering) →
transcript sanitization immediately before `startStreamingQuery`
(:3673–3677, same pre-stream normalization as cluster 8) → stream + replay
with bookkeeping compensation (:3675–3685) → detached flush. Index/
registration (:3646–3652) stays manager-owned at the PRE-STREAM boundary (as
in cluster 8), and the completion-callback subscription stays class-owned
(cluster 12 classification): the pipeline reaches a registration boundary,
the manager registers and attaches/detaches callbacks. The
`resolveNodeExecutionForSubSession` repair (:3759–3768) — an unconditional
`updateSessionId` write when an `:exec:`-embedded execution lacks
`agent_session_id` — runs AFTER the archived-session refusal (:3490) but
before the execution-dependent refusal gates. TAM-D1 must preserve that
order and fence the repair (expected-null CAS via `expectAgentSessionId:
null`), or keep it manager-owned outside the pipeline; never carry the blind
write into a stage.
Fit: strong `stagedRun`. The outer `rehydrateSubSessionsForRun` (:3382) loop
and `rehydrateInFlight` dedup/restore lock (:3466) stay in the class (loop +
resource ownership, P6). Its tail (attach → register →
stream+replay+compensate → flush) is shape-identical to cluster 8's but NOT
ownership-identical: cluster 14 selects a cached instance (:3568–3570) yet
registers UNCONDITIONALLY (:3652) and unregisters on stream/replay failure
(:3681–3682) — cluster 8 conditions both on `createdNow`. TAM-D1 must make
the choice explicit: adopt cluster 8's created-ness conditioning (recommended)
or preserve the divergence as a written contract; the cached-failure row
lands with D1, never in TAM-PD. Cluster 19 is NOT a third tail use: its fresh arm registers
and streams via `createSubSession` BEFORE `ensureNodeAgentAttached` and
injects a kickoff without pending replay — a different ordering. Only two
direct tail uses exist; a shared combinator needs a true third (ADR 0004
≈3-use rule).

### `deliver-injected-message` — clusters 6 + 15, ~367 lines

The complete injection path spans BOTH the outer admissions of
`injectSubSessionMessageWithOrigin` (:1779–1849 — terminal task/run refusal,
target resolution via index/subSessions scan/rehydration, inject-lock
acquisition, POST-LOCK terminal recheck, locked target re-snapshot) and the
inner `injectMessageIntoSession` (:3849) arms. TAM-E composes the whole
operation — one direct pipeline per business path. The inject-lock boundary
needs a REALIZABLE protocol: `stagedRun` has no suspend/resume, and
`withSessionResetCoordination` holds the lock for exactly one callback, while
today's path resolves/rehydrates the target BEFORE entering that callback and
rechecks+delivers INSIDE it (:1796–1849). TAM-E1 therefore models the lock as
an ACQUIRE/RELEASE effect-stage pair within the ONE pipeline — pre-lock
admissions run before acquisition, the locked stage group (terminal recheck,
target re-snapshot, delivery) runs between acquire and release, and release
is registered as compensation — with the class supplying the lock HANDLE as a
resource (ADR Decision 5); the pipeline never nests a runner inside the lock
callback and never moves rehydration under the lock (pin
rehydration-before-lock ordering). Because `stagedRun` does NOT unwind
compensations on a successful halt (`buildHaltAdapter` returns a completed
outcome directly, staged-run.ts:446–470), completed locked arms such as
`noop` and `defer` must reach an EXPLICIT release effect before halting — a
compensation-only release would leave the reset-coordination lock held and
block every later inject/reset for the session (pin release on the normal
early outcomes). The terminal admission is ORIGIN-SENSITIVE: `resolveTerminalInjectionStatus`
(:1858–1873) rejects a `done` task ONLY when `origin === 'system'` — human
and task injections remain admissible on a done task while runtime-recovery
injections are rejected; carry `origin` into BOTH the pre-lock and post-lock
predicates and pin both done-task rows in TAM-PE. The admission must also
resolve the OWNING task: with no taskId supplied it inspects
`listByWorkflowRunIncludingArchived(...)[0]` (:1864–1867), which in a
multi-task run is the WRONG task — a cancelled first task rejects delivery to
an active worker and vice versa; TAM-E1 resolves the owning task from the
session identity/ownership map for both predicates (the corrected
opposite-status multi-task rows land with E1 ONLY — TAM-PE must NOT
characterize the current `[0]`-based misrouting as surviving, because E1
replaces it (a pin of the known bug would either force E1 to preserve it or
be deleted when E1 lands). The admissions call
`resolveNodeExecutionForSubSession` twice
(:1779 pre-lock, :1814 post-lock) — the same unconditional binding repair as
cluster 14 — so TAM-E1 must use the FENCED repair (the guarded primitive
shared with TAM-D1) or sequence after the slice that lands it; never carry
the blind write into the admissions stages. Beyond the origin path, the inner
delivery cascade has three more callers: spawn-flow's `injectKickoffMessage`
dep (:1091) and both post-approval arms (:4912, :5041) — TAM-E3 composes the
extracted delivery stage group into the spawn flow directly (spawn-flow owns
its kickoff injection as part of its own business path, a separate wiring
seam from TAM-E2), and TAM-F1/F2
compose the same stage group into their pipelines (dependency TAM-E1); no
call site may keep invoking the old imperative cascade, and no owning
pipeline nests the TAM-E runner. The old cascade's DELETION is owned by
TAM-E4 (removal-only), which lands only after E2, E3, and F2 have converted
every caller. Inside, the `decideInjectDelivery` decision
(`noop`/`defer`/`clear_before_deliver`/`deliver_without_clear`) already exists;
the arms are still imperative — message assembly (pure transform) preceded
by `validateImageSizes` (:3869–3872) BEFORE any lookup, reopen, persist, or
enqueue (oversized-image rejection leaves delivery state untouched — pin in
TAM-PE), `defer` arm (:3926–3942), clear-with-error-tolerance (:3943–3958 — the
pre-clear `hasActiveDeliveryJob` RE-READ (:3943–3946) is an effect-time
concurrency guard, not the decide-snapshot fact from :3917: TAM-E1 must
RE-GATHER immediately before the clear effect, and TAM-PE pins the
first-read-false/pre-clear-read-true case, or a job arriving after the decide
snapshot gets its context reset underneath it;
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
compensation, inject) — this arm NEVER calls `createSubSession`
(:4860–4912); it only checks ownership, migrates the workspace, and injects,
so TAM-F1 composes B1's create stages in the NOMINAL FRESH ARM ONLY — running
B1's reuse sequence (rebind, config replacement, completion-callback swap,
stale co-owner clear) against an already-running worker would materially
alter it (a change that must be its own allocated, tested slice if ever
wanted) vs fresh arm (TASK-OWNERSHIP RE-SNAPSHOT: re-read the
task and reject a changed `workflowRunId` (:4923–4927) BEFORE workspace
resolution, pool reservation, or any creation side effect — pin in TAM-PF
that it precedes all creation effects; omitting it spawns a worker from a
stale task/workflow pairing — then model-pool reservation with release
compensation, init + MCP merge, `createSubSession`, attach, inject, activate
reservation). Fit: strong `stagedRun`; third instance of the reuse-vs-fresh
shape (after `spawn-flow.ts` and cluster 4). **Outcome contract (P46
coordination):** the sibling plan's P46 `post-approval-route` pipeline
consumes this spawner through a bounded spawn outcome that must distinguish
CREATED vs REUSED sessions (three-way with COLD-RESTORED for compensation;
the P46 box may keep its two-way delivery flag) and KICKOFF DELIVERED vs SKIPPED (the terminal-gate
skip) — its CAS-loss compensation and deadline cleanup run ONLY for sessions
the attempt created, and a skipped reuse routes to release/terminal handling.
TAM-F therefore owns the richer outcome record (or is explicitly sequenced
with P44/P46); preserving only today's `{ sessionId }` return leaves P46
without its required contract. The reused-delivery fence applies to EVERY
post-delivery failure, not just CAS loss: when TAM-F1 returns REUSED or
COLD-RESTORED with the kickoff already delivered and P46 fails before
`record-dispatched-session` completes, created-only termination cannot stop
the worker and the lease renewal ends once the spawn settles — the
retained reservation eventually expires and a retry can re-inject while the
first worker is still processing — so every post-delivery failure persists
the unfinalized reused-delivery fence (or awaits verified worker completion)
before the reservation can expire. The ownership flag MUST come from the NESTED
create result, not the outer arm: after a daemon restart
`findLiveSubSessionForAgent` returns `null` for an unindexed durable worker,
the outer arm looks fresh, yet the nested `createSubSession` (:5012–5016 via
:1123–1127) can rehydrate and return the EXISTING worker — labeling that
worker CREATED lets P46's deadline/CAS-loss cleanup terminate a live reused
worker (pin the cold-cache row in TAM-PF). The nested-reuse case also needs an
UNDER-LOCK POST-CREATE TERMINAL RECHECK the current code lacks: the nominal
fresh arm has no terminal check before injection, so a task/run that went
terminal while the spawn was in flight would receive the kickoff. The recheck
covers EVERY `createSubSession` outcome, not only nested reuse: both
CREATED and REUSED outcomes return KICKOFF SKIPPED on a terminal task/run —
and for a CREATED worker the skip must additionally TERMINATE the
just-created session (per P46's created-only cleanup), while a REUSED worker
is left untouched. Because TAM-F1 composes the create stages directly, the
terminal gate for the reuse arm runs BEFORE the reuse mutation sequence
(rebind, config replacement, workspace migration, callback swap
:1148–1276) under the same lock — but the inject lock does NOT serialize
task/run status updates, so a pre-mutation gate ALONE cannot guarantee the
worker stays untouched: a terminal transition between the gate and the end of
reuse would still yield a skip after mutation. TAM-F1 must close that race
with an atomic ownership protocol — a repository-level reservation/CAS
fencing terminal transitions throughout the reuse arm, or a complete
rollback of every reuse mutation when the post-create check skips; the
protocol and its race tests (terminal after the pre-mutation gate before
reuse finishes; terminal during rehydration) land TOGETHER in TAM-F1 —
TAM-PF never pins behavior the protocol does not yet provide. The protocol's
fence/rollback EXTENDS THROUGH FRESH-ARM DELIVERY: the inject lock does not
serialize task/run status updates there either, so a task going terminal
AFTER the post-create recheck but BEFORE the composed delivery effect must
terminate the just-created worker — never deliver the kickoff and report
DELIVERED. POST-CREATE FAILURES also need an ownership outcome — a THREE-WAY
one, carried in the create-stage result: CREATED / LIVE-REUSED /
COLD-RESTORED-BY-THIS-ATTEMPT. The COLD-RESTORED flag needs explicit
RESTORATION-OWNER PROVENANCE: `rehydrateSubSession` returns the shared
`rehydrateInFlight` promise to a second caller (:3470–3478), so a JOINER
cannot be classified as the restoration owner from the index miss alone —
thread an owner token through rehydration and the create result (a joiner
misclassified as owner would unwind the other caller's streaming on its own
failure; the concurrent-join row lands with TAM-F1). An owner token alone is
still NOT sufficient once a joiner has JOINED and SUCCEEDED: two callers can
share the same restored session, and if the owner later fails attach or
kickoff while the joiner succeeds, owner cleanup must NOT unwind the shared
streaming — use SHARED-OWNERSHIP / reference tracking so a restored worker's
streaming stops only when NO successful concurrent caller retains it (the
owner-fails-joiner-succeeds race row lands with TAM-F1). The reference
tracker SPANS concurrent TAM-F1 runs, so it is MANAGER-OWNED RESOURCE STATE
like the session indexes and completion callbacks: the class owns its
lifecycle, and the pipeline reads/writes it through the class boundary (not
as a stage-local variable). When
`ensureNodeAgentAttached` or kickoff
injection rejects after `createSubSession` (:5012–5042), today's catch
releases only the model-pool reservation and leaves the registered streaming
worker alive, and a bare error return gives P46 no ownership to compensate —
TAM-F compensates per outcome: a CREATED worker is stopped, unregistered, AND
its execution binding CLEARED — the fresh arm bound the execution at
:1347–1356, and stopping the session alone leaves the execution
`in_progress` pointing at a dead worker, so CREATED cleanup includes a
status-and-session-guarded execution unbind/transition AND DELETES the newly
created durable session through the repository deletion path — `resolveSessionId`
treats every remaining row as occupied, so a kept row forces suffixed-ID
retries and accumulates failed workers (the base ID must be reusable);
COLD-RESTORED and LIVE-REUSED always preserve their durable row. LIVE-REUSED and
COLD-RESTORED keep their PRE-EXISTING binding — but a cold restore is not
necessarily pre-existing: after rehydration, B1 selects an unbound same-node
execution and CAS-binds it (:1133–1157), so the create result carries whether
THIS attempt won that bind, and a COLD unwind rolls back ONLY that
attempt-won binding while retaining the genuinely pre-existing one;
a COLD-RESTORED worker (the restoration OWNER's attempt started its
streaming via `rehydrateSubSession`) has its streaming and manager
bookkeeping unwound
WITHOUT deleting the durable session — CREATED-only cleanup would leave it
registered and streaming, consuming capacity indefinitely; an already-live
REUSED worker is left intact (attach- and inject-rejection rows for all
three outcomes and the execution-row land with TAM-F1). The protocol
must also distinguish COLD-CACHE RESTORATION:
`rehydrateSubSession` registers and starts streaming the durable session
(:3646–3677) BEFORE the create stages report REUSED, so on a terminal skip
this attempt has newly started a worker — unwind that instance's streaming
and bookkeeping WITHOUT deleting the durable session. Every SKIPPED outcome must also RELEASE the model-pool
reservation taken by the fresh arm (:4961): a successful halt does not run
the catch compensation, so an unreleased reservation keeps consuming pool
capacity until restart (pin the release). The fresh arm installs
`onMissingMemberSpaceMcpServers` (:5025–5027) immediately after
`createSubSession`, before attach and kickoff — keep it, or the worker
cannot self-heal member Space tools. The terminal-transition rows land with
TAM-F1's protocol (TAM-PF keeps only surviving behavior). Pins exist
(`task-agent-manager-post-approval.test.ts`).

### `deliver-space-agent-pending-row` — cluster 5, ~71 lines

`deliverSpaceAgentPendingRow` (:1611): staleness/expiry/attempt-cap gates,
attempt record, inject with late-settlement callbacks, settle-or-reconcile
arms — with the `deferExpiration([row.id])` EXTENSION POINTS carried
(:1641 before injection, :1653 and :1672 after queued/failed outcomes): they
keep a retention pass from expiring an in-flight or retryable row; TAM-G must
keep all three and TAM-PG pins the near-expiry in-flight and retry cases.
Injector REJECTION is handled LOCALLY (:1669–1680): the catch records the
error, defers expiration, maybe fails the row, schedules reconciliation, and
RETURNS NORMALLY so the drain continues with later rows — TAM-G models it as
a settled error/reconciliation arm that completes successfully, never a
propagated stage error that aborts the whole drain and starves every later
message; TAM-PG retains the later-row-delivered characterization. The
attempt record becomes an ATOMIC PENDING-ROW CLAIM: a late settlement
between the `getById` gate and `recordDeliveryAttempt` makes the conditional
update affect zero rows and return the delivered record, which the current
body ignores before injecting — a lost claim HALTS before injection (no
double delivery); the late-settlement-between-snapshot-and-claim row lands
with TAM-G's primitive. Fit:
small pipeline; the late-settlement watcher arming (:1534–1586)
stays in the class (handles/cancel are resources), BUT its own settlement
sequence — `getById(...).status === 'pending'` followed by a blind
`markDelivered` (:1553–1555) — must be REWIRED to consume G1's status-guarded
settlement: the watcher can otherwise read `pending`, have G1's injector-error
path mark the row failed, and then overwrite that as delivered (or smear a
delivered row when only the pipeline uses the primitive). A dedicated wiring
seam slice allocates this (watcher → G1), with the read-pending/error-path/
watcher-overwrites interleaving pinned.

### `self-heal-node-agent` — cluster 17, ~142 lines

`mcpSelfHeal` (:4185) splits today across an imperative prologue and a staged
tail: resolve execution → PARENT-TASK SELECTION by the same owner-resolution
order as cluster 14 (session-derived task ID + `findParentTaskIdForSubSession`
before any fallback, :4199–4209 — in a multi-task run the first row is the
wrong owner; pin the non-first-owner case in TAM-PS) → space gates
(:4191–4222), the
displaced-session adoption branch (:4225–4250), then the inline
`self-heal-workspace` `stagedRun` (:4252–4325). One direct pipeline composes
the whole operation — prologue gates and adoption as admission/effect stages
in front of the existing heal stages — with the index mutation, completion
callback, and displaced-session interrupt lifecycle effects kept
at their class-owned boundary. The displaced-session adoption (:4225–4250)
detaches bookkeeping, starts an async interrupt, REPLACES the manager index
entries, and calls `registerSession` (which directly overwrites the cache) —
it NEVER calls `unregisterSession`; S1 must not introduce one (or allocate
and test it explicitly as a behavior change). Three fences: (a) the prologue's
`resolveNodeExecutionForSubSession` call (:4191) performs the same
unconditional binding repair as cluster 14 — TAM-S1 uses the FENCED helper
or depends on the slice that lands it; (b) the heal workspace resolution must
route task-owned choices through `resolveTaskWorkspace` instead of preserving
the hand-rolled cached/explicit/session/primary fallback (:4271–4279) —
without dropping the persisted-session preference (as in cluster 14), or a
secondary registered repository heals against the primary checkout (pin the
case); (c)
adoption executes at a manager-owned PRE-HEAL boundary BEFORE the heal
stages run — `reinjectNodeAgentMcpServer` restarts the target, so the
displaced instance must already be detached and the target's hooks installed
(pin the adoption-before-restart ordering). The INJECT LOCK gets the same
realizable protocol as TAM-E1: today's method runs the prologue and adoption
BEFORE `withSessionInjectLock` and only the heal tail inside it
(:4191–4252) — S1 models the lock as an acquire/release effect-stage pair
around the heal-tail stage group (class supplies the handle), keeping
adoption outside the lock; pin adoption-before-lock ordering. Fit:
`stagedRun`.

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
| TAM-PB | Pins for `createSubSession` reuse/fresh arms restricted to SURVIVING behavior: cold-cache reuse via `rehydrateSubSession` (successful AND failed — the fall-through to fresh creation), narrow compensation, `deferFreshExecutionBind` scope (fresh-arm bind + both arms' flush suppressed; reuse CAS unaffected), fresh-arm registration-before-stream ordering, fresh-arm hook ordering before stream, detached-flush rejection — the session-owner guards' and stale-binding-resolution rows land with TAM-B1's primitive, never here | test-only | 0 | ≲110 | — |
| TAM-PC | Pins for `restorePostApprovalWorkerSession`: refusal rows (missing task, detached task, task `cancelled`/`archived`, run `cancelled`, missing space), cooldown THROW outcome + pre-restore ordering, no-completion-callback, pre-stream registration + sanitizer ordering, cached-session ownership (register/compensate only when this operation created the session), concurrent-restore in-lock re-gather | test-only | 0 | ≲90 | — |
| TAM-PD | Pins for `rehydrateSubSession` restricted to SURVIVING behavior: refusal-gate ordering (archived row BEFORE the repair, which is unconditional today), `done` admissibility, multi-task owner-resolution identity row, system-prompt-only overlay, current workspace-fallback characterization, hooks + sanitizer pre-stream ordering — the fenced-repair and `resolveTaskWorkspace` routing land with TAM-D1, never here | test-only | 0 | ≲100 | — |
| TAM-PE | Pins for the complete injection operation: origin-sensitive done admission (done + system rejected, done + human admissible) in BOTH pre-lock and post-lock predicates, oversized-image rejection leaving delivery state untouched, outer admissions + post-lock terminal recheck, cancellation passthrough, pre-clear active-delivery-job re-gather | test-only | 0 | ≲120 | — |
| TAM-PF | Pins for `spawnPostApprovalSubSession` restricted to SURVIVING current behavior: reuse/fresh arms, fresh-arm task-ownership re-snapshot preceding all creation effects (:4923–4927), cold-cache reuse via the nested create result, member-space self-heal hook installation — the terminal-recheck/skip/race contract lands with TAM-F1's protocol, never here | test-only | 0 | ≲90 | — |
| TAM-PG | Pins for `deliverSpaceAgentPendingRow` restricted to SURVIVING current outcomes: settlement/error behavior AS IT BEHAVES TODAY, injector-rejection locality (later rows still delivered), near-expiry deferral cases — the status-safe race contract CANNOT land here (the primitive arrives with TAM-G) | test-only | 0 | ≲60 | — |
| TAM-PS | Pins for `mcpSelfHeal`: admissions incl. multi-task owner resolution (non-first-owner case), displaced-session adoption, adoption-before-restart and heal ordering | test-only | 0 | ≲80 | — |
| TAM-B1 | `create-node-agent-sub-session` stagedRun, unwired (gates + both arms + compensations + session-guarded stale-owner CAS with concurrency pin); adds a CREATED-only compensation for STREAMING-STARTUP rejection — when `startStreamingQuery` rejects (:1389) the session is already registered/indexed (and, non-deferred, execution-bound), yet `createSubSession` throws BEFORE returning an ownership result, so neither the spawn flow (which records `attempt.sessionId` only after the awaited create returns, spawn-flow.ts:281) nor TAM-F1's post-create cleanup can see it. Cleanup is COMPLETE and ownership-safe: stop/clean the owned instance (it was persisted by `AgentSession.fromInit` and may have started queue/process/timer resources), remove ALL TaskAgentManager and SessionManager registrations, clear only a matching execution binding, AND delete the newly created durable session through the repository cleanup path — an incomplete cleanup leaks durable rows and suffixed-ID retries; both deferred- and normal-bind STARTUP-FAILURE tests land WITH TAM-B1 (asserting no cached/indexed session, live resources, execution binding, or sessions row remains, and that a retry reuses the base session ID) — they cannot pass in the surviving-behavior pin slice | build | ≲250 | ≲250 | TAM-PB, TAM-LH (held-aware self-heal primitive for the missing-MCP startup row) |
| TAM-B3 | Split the spawn flow's `createSpawnedSession` dependency (a single `Promise<string>` seam, spawn-flow.ts :281) into preparation inputs + the create stage group, and compose those stages into the owning stage list — the interface CHANGE is the point: with the monolithic seam unchanged, B3 could only keep the imperative call or nest the B1 runner after B2. LANDS BEFORE TAM-B2 so no intermediate PR leaves every spawn nesting the B1 runner via the still-imperative `createSubSession`. The spawn-flow compensation is made OWNERSHIP-AWARE: it cancels only a CREATED session and leaves a COLD-RESTORED/LIVE-REUSED session (possibly retained elsewhere) intact | wire | ≲90 | ≲90 | TAM-B1, TAM-B0 |
| TAM-B0 | Add RESTORATION-OWNER provenance WITHOUT changing the stable `rehydrateSubSession` return type (it stays `AgentSession | null` — after D2 it is live at five call sites and `createSubSession`/`getSubSessionByAgentName` consume it directly): a provenance-returning companion helper/stage wraps the existing call, and the INNER restore path reports whether THIS invocation actually created/registered the worker — a wrapper alone can misclaim ownership when `rehydrateSubSession` queues behind `restorePostApprovalWorkerSession` for the same ID (that path holds `sessionRestoreLocks` but never populates `rehydrateInFlight`), so a companion can enter `performSubSessionRehydrate` and receive a session another operation already indexed; pin the cross-entry-point lock-queue race in TAM-B0; extend the B1 create-stage result to carry the THREE-WAY ownership (CREATED / LIVE-REUSED / COLD-RESTORED) — landed as its own slice (after the rehydration rewire so it doesn't conflict, before B2/B3 and F1 which consume it), NOT hidden inside TAM-F1. TAM-B0 ALSO OWNS the PRE-RETURN COLD-RESTORATION FAILURE compensation — the provenance-aware unwind inside the create group when a cold restoration succeeds but a later create-stage operation rejects before `createSubSession` returns: roll back ONLY bindings won by that attempt, stop/unregister the restored worker ONLY when no successful concurrent caller retains it, and PRESERVE the durable session (tests land with B0, so this path is implemented before any wiring slice can expose it) | build | ≲110 | ≲160 | TAM-B1, TAM-D2 |
| TAM-LH | The COMPLETE shared INJECTION-LOCK-HANDLE contract (additive): the class-owned acquire/release handle over `withSessionInjectLock`/`withSessionResetCoordination` (which today expose only the callback-form lock, task-agent-manager.ts:1876–1877) PLUS the held-handle acceptance so `mcpSelfHeal` and `startStreamingQuery`'s `onMissingWorkflowMcpServers` path (query-runner.ts:793–796 → mcpSelfHeal :4252) do not deadlock against an owner's held handle — with the missing-MCP startup test. TAM-LH OWNS this contract so E1 (acquire/release), S1 (self-heal), and the create pipelines (held startStreamingQuery) all consume the SAME primitive rather than reworking each other's API; E1 depends on it. The held handle must be RETIRED safely: `onMissingWorkflowMcpServers` stays stored on the AgentSession and `QueryRunner` invokes it on later starts/restarts — if that persistent callback captures the owner's held handle, a post-release self-heal would bypass coordination with a stale capability; the handle must DETECT release and reacquire normally, or the callback is replaced before release, and a second post-start invocation is tested | build | ≲70 | ≲100 | — |
| TAM-FH | The expected-null FENCED BINDING-REPAIR helper primitive (additive): the guarded `updateSessionId`-style repair (`expectAgentSessionId: null`) that D1, E1, and S1 all consume — landed and tested as its own slice so injection/self-heal work is not blocked behind the whole rehydration pipeline | build | ≲40 | ≲60 | — |
| TAM-B2 | Delegate the `createSubSession` method body to the B1 pipeline (the last caller-side transition); the B1 create STAGE GROUP and its three-way created/reused/restored outcome are EXPORTED for direct composition (no runner nesting); the public `Promise<string>` return and both in-file caller signatures stay; MUST NOT wire the locked startStreamingQuery path until TAM-LH's handoff is available | wire | ≲70 | ≲60 | TAM-B1, TAM-B3, TAM-B0, TAM-LH |
| TAM-C1 | `restore-post-approval-worker` stagedRun, unwired (pre-stream registration boundary), with a class-owned RESTORE-LOCK HANDLE protocol: the public index fast-path runs BEFORE acquire and the in-lock index recheck stays between acquire and release — `stagedRun` cannot suspend around the `withSessionRestoreLock` callback, so the lock is an acquire/release effect-stage pair (class supplies the handle); pin public-check-before-acquire + in-lock-recheck ordering. Because `stagedRun` does NOT unwind compensations on successful halts, EVERY successful path after acquisition — the in-lock cache hit and all refusal gates — must reach an EXPLICIT release effect before halting (compensation covers errors only); pin lock release on normal early outcomes and failures, or a post-lock refusal leaves every later restoration for that session blocked. Concurrent restores amplify this: a second caller can acquire the handle, hit the in-lock recheck, and complete — pin a THIRD waiter released after the successful recheck/refusal cases. The in-lock recheck must ALSO re-read the DURABLE identity: `postApprovalSessionId` may change while restoration is queued or awaiting `getSpace` (the identity was captured at :2174), and a concurrent dispatch can record session B while C1 restores stale session A — add an in-lock durable-identity re-read that must still match the requested session, and pin the identity-change race rather than testing only the cache recheck. TASK/RUN TERMINAL STATUS must be re-read AFTER the last pre-registration await: `getSpace` and `ensureNodeAgentAttached` both await before the worker is indexed/registered, so a cancellation during either await is invisible to cancellation cleanup and C1 could register/start a worker for the cancelled task (the restore lock does not coordinate status writers) — re-read terminal status after the final pre-registration await (or hold the TAM-F0 terminal fence) and pin cancellation-during-attachment | build | ≲180 | ≲150 | TAM-PC |
| TAM-C2 | Wire `restorePostApprovalWorkerSession` | wire | ≲40 | ≲50 | TAM-C1 |
| TAM-D1 | `rehydrate-sub-session` stagedRun, unwired (`resolveTaskWorkspace` routing, system-prompt-only overlay), consuming the TAM-FH fenced repair helper. CLOSES THE CANCELLATION RACE: `performSubSessionRehydrate` checks task/run terminal status BEFORE awaiting `getSpace` and `ensureNodeAgentAttached`, then registers/starts — a concurrent terminal transition during those awaits finishes cleanup while the session is still absent from the manager indexes, letting D1 register/start a worker for the cancelled task; D1 re-reads terminal status AFTER the final pre-registration await (or consumes the fully wired TAM-F0 terminal fence — update dependencies if chosen), with race tests for cancellation during space loading AND attachment proving no session is registered or started afterward | build | ≲220 | ≲200 | TAM-PD, TAM-FH |
| TAM-D2 | Wire `rehydrateSubSession` | wire | ≲40 | ≲50 | TAM-D1 |
| TAM-E1 | `deliver-injected-message` pipeline over the COMPLETE operation (outer admissions + inner arms), composing `decideInjectDelivery`'s gates directly; uses the TAM-FH fenced repair helper and the TAM-LH lock-handle contract; CONSUMES TAM-B0's restoration provenance/shared-ownership so a POST-LOCK REFUSAL unwinds a rehydration owned by THIS call — a task cancelled during the pre-lock `rehydrateSubSession` await can't be found by cancellation cleanup (not yet registered), and after rehydration the post-lock terminal gate returns `noop` leaving the newly registered streaming worker alive; unwind a restoration owned by this call on refusal (cancel-during-rehydrate race test); delivery stage group exported for direct composition by owning pipelines | build | ≲230 | ≲180 | TAM-PE, TAM-FH (fenced repair helper), TAM-LH (lock-handle contract), TAM-B0 (restoration provenance) |
| TAM-E2 | Wire `injectSubSessionMessageWithOrigin` (and its thin wrappers) to the E1 pipeline; inject lock stays class-owned — standalone injection only, its own wiring seam | wire | ≲50 | ≲60 | TAM-E1 |
| TAM-E3 | Split the spawn flow's `injectKickoffMessage(sessionId, message): Promise<void>` dependency (the monolithic seam the `kickoff-session` effect invokes) into TARGET/LOCK preparation inputs + a CONTINUATION-SAFE E1 delivery stage group — the group RECORDS its `defer`/`noop` result WITHOUT halting, because a halt would terminate `spawn-execution` and skip `activate-pool-assignment` + `flush-pending-messages` (:377–428), leaving the model-pool reservation unactivated; the standalone injection pipeline (E2) adds its own terminal adapter; compose those stages into the owning stage list — exactly as B3 does for creation (with the seam unchanged, E3 could only retain the imperative call or nest the E1 runner); pin that a deferred/noop kickoff still reaches both downstream spawn stages; a separate wiring seam and business path from TAM-E2; MUST land before TAM-E4 deletes the old cascade | wire | ≲90 | ≲90 | TAM-E1 |
| TAM-E4 | Delete the old imperative `injectMessageIntoSession` cascade — removal-only, zero new logic; every caller is converted by then (TAM-E2 origin path, TAM-E3 spawn-flow kickoff, TAM-F2 post-approval arms) | delete | ≲190 | 0 | TAM-E2, TAM-E3, TAM-F2 |
| TAM-F0 | Shared TERMINAL-TRANSITION FENCE PRIMITIVE (construction only, additive): the fence/API + its contract tests, so a task/run terminal transition cannot slip between the reuse gate and the end of reuse (the reservation CAS alone cannot fence a terminal transition) — the alternative "complete rollback" needs a concrete reversible protocol (execution-owner writes, config, callback swap, workspace metadata, MCP restart), landed + tested HERE | build | ≲90 | ≲140 | TAM-B0, TAM-PF |
| TAM-F0-W1 | Wire the TASK-CANCEL status writer to honor the TAM-F0 fence | wire | ≲30 | ≲30 | TAM-F0 |
| TAM-F0-W2 | Wire the TASK-ARCHIVE status writer to honor the TAM-F0 fence | wire | ≲30 | ≲30 | TAM-F0 |
| TAM-F0-W3 | Wire the TASK-STOP status writer (`parkStoppedWorkflowTask` :2998–3006) to honor the TAM-F0 fence | wire | ≲25 | ≲25 | TAM-F0 |
| TAM-F0-W4 | Wire the RUN-CANCEL status writer (`cancelWorkflowRun` :3142) to honor the TAM-F0 fence | wire | ≲25 | ≲25 | TAM-F0 |
| TAM-F0-W5 | Wire the WORKFLOW-TERMINAL status writer to honor the TAM-F0 fence | wire | ≲30 | ≲30 | TAM-F0 |
| TAM-F1 | `spawn-post-approval-worker` stagedRun, unwired, returning the P46 delivery outcome with a THREE-WAY ownership result (CREATED / LIVE-REUSED / COLD-RESTORED) carried from the create-stage result; COMPOSES the B1 create stage group and the E1 delivery stage group directly (no runner nesting); the reuse-arm terminal gate runs BEFORE the reuse mutation sequence under the same lock (fenced by TAM-F0); the fresh arm's post-create recheck covers every create outcome (CREATED skip terminates the just-created session AND deletes its durable row, REUSED skip leaves the worker untouched); lands the atomic-ownership/rollback protocol TOGETHER WITH its tests (terminal-skip rows for both outcomes, after-recheck-before-delivery transition, post-create attach/inject failure compensation per ownership — CREATED stopped/unregistered + durable-row deleted, COLD-RESTORED unwound without deleting the durable session AND only while no successful concurrent joiner retains it, LIVE-REUSED intact — cold-cache unwind, the owner-fails-joiner-succeeds race, the terminal races) | build | ≲220 | ≲250 | TAM-B0, TAM-B1 (create stage group composed directly — F1 never calls the public B2 wrapper, so B2 stays on its caller-side track), TAM-E1, TAM-F0, TAM-F0-W1, TAM-F0-W2, TAM-F0-W3, TAM-F0-W4, TAM-F0-W5, TAM-LH, TAM-PF (P46 outcome contract). F1 must RELEASE the TAM-LH injection handle AND the TAM-F0 terminal fence before EVERY completed outcome (success or terminal-skip — completed halts do not unwind compensations, and a skip before the E1 delivery group would otherwise leave both held and block later injections/status transitions); pin a subsequent lock/fence waiter |
| TAM-F2 | Wire `spawnPostApprovalSubSession` | wire | ≲40 | ≲50 | TAM-F1 |
| TAM-G1 | Status-guarded settlement/error repository primitive (risk 5) — additive, with its race-correctness tests | build | ≲60 | ≲80 | TAM-PG |
| TAM-G2 | Atomic pending-row claim repository primitive — additive, with its lost-claim race test | build | ≲50 | ≲60 | TAM-PG |
| TAM-G | `deliver-space-agent-pending-row` pipeline — trivial build+wire combined per the stated exception (≲100-line pipeline, one internal call site, few-line swap), consuming G1 + G2 | build+wire | ≲100 | ≲80 | TAM-G1, TAM-G2 |
| TAM-S1 | `self-heal-node-agent` stagedRun, unwired (prologue gates via the TAM-FH fenced repair helper + adoption admission composed in front of the existing heal stages; heal workspace routed through `resolveTaskWorkspace`; adoption at the manager-owned pre-heal boundary) | build | ≲140 | ≲120 | TAM-PS, TAM-FH, TAM-LH (shared lock-handle contract — S1 consumes no E1 delivery behavior, so it depends on the primitive directly, not the delivery build) |
| TAM-S2 | Wire `mcpSelfHeal` to the S1 pipeline; index/callback/displaced-session lifecycle effects stay class-owned | wire | ≲40 | ≲50 | TAM-S1 |
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
pipeline, and wiring; this epic defers to them. The reciprocal sequencing is
encoded in BOTH ladders: P46 depends on TAM-F1 (outcome contract) and P47 on
TAM-F2 in `space-runtime-tools-goals.md`. After TAM-B2/D2/F2 land, the
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
