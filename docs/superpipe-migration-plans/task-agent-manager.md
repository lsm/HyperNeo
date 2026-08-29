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
| 9 | Activation routing | 2346–2550 (~205) | **Pipeline: `activate-agent-for-message`** |
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
workspace migration, two compensations. The rebind-CAS shape duplicates
`spawn-flow.ts` `rebindLiveExecution`; compose the same repo primitive, not a
new combinator. Risk: the stale co-owner cascade preserves
`blocked/cancelled/waiting_rebind/pending` rows via blind `update` — keep the
per-status branch order byte-for-byte in the extract.

### `restore-post-approval-worker` — cluster 8, ~175 lines

`performPostApprovalWorkerRestore` (:2184): refusal gates (archived task/run,
cooldown → throw), cached-or-`AgentSession.restore`, slot match, optional
slot-init overlay, MCP merge, `ensureNodeAgentAttached`, register + callbacks,
stream + replay with unregister compensation (:2320–2331), detached flush. Fit:
strong `stagedRun`. The identity resolution half (:2070–2168) stays plain
helpers (raw-SQL provenance/durable-id/cooldown readers).

### `activate-agent-for-message` — cluster 9, ~139 lines

`activateTargetSessionsForMessage` (:2346) makes three sequential
`decideActivationRouting` calls (existing plain-fn brick in
`activation-routing.ts`) with effects between them: resume attempt, existing
reset CAS branch (:2378–2393), undeclared gate, node activation via
ChannelRouter, gather task/run/workflow/space/execution, then spawn with a
30 s timeout race, superseded swallow, and post-spawn pending requeue. Fit:
strong `stagedRun` — the three decision calls become the decide stage group;
the timeout race and detached requeue stay effect stages. Risks: the timeout
`Promise.race` leaks the spawn promise intentionally (fire-and-forget requeue);
tests `task-agent-manager-activation-timeout.test.ts` pin it.

### `rehydrate-sub-session` — cluster 14, ~215 lines

`performSubSessionRehydrate` (:3486): six refusal gates (archived row, no
execution, no parent task, terminal task, no space, cancelled run) → cached or
`AgentSession.restore` → workspace resolve/update → init overlay → MCP merge →
attach → register + completion callback → stream + replay with bookkeeping
compensation (:3675–3685) → detached flush. Fit: strong `stagedRun`. The outer
`rehydrateSubSessionsForRun` (:3382) loop and `rehydrateInFlight` dedup/restore
lock (:3466) stay in the class (loop + resource ownership, P6). Its tail
(attach → register → stream+replay+compensate → flush) is shape-identical to
cluster 8's — compose both directly; do NOT pre-extract a shared combinator
until both exist (ADR 0004 ≈3-use rule; this is use 2 of the shape, with
cluster 19 the 3rd).

### `deliver-injected-message` — cluster 15, ~184 lines

`injectMessageIntoSession` (:3849): the `decideInjectDelivery` decision
(`noop`/`defer`/`clear_before_deliver`/`deliver_without_clear`) already exists;
the complete path is still imperative — message assembly (pure transform),
`defer` arm (:3926–3942), clear-with-error-tolerance (:3943–3958), the
not-busy backlog-replay pre-delivery block with flip-to-deferred fallback
(:3964–4017), then `deliverInjectedMessage`. Fit: strong mixed pipeline
embedding the existing decision as its decide stage. **Coordination risk:**
agent-routing.md's PRs own `message-delivery-pipeline.ts`; this slice owns the
space-runtime consumer only — the shared decision function must not be edited
by both plans. Per-message (not per-event) frequency, so pipeline overhead is
fine.

### `spawn-post-approval-worker` — cluster 19, ~239 lines

`spawnPostApprovalSubSession` (:4827): slot match → live-reuse arm (terminal
gate, run-ownership guard, workspace migration with capture/restore
compensation, inject) vs fresh arm (model-pool reservation with release
compensation, init + MCP merge, `createSubSession`, attach, inject, activate
reservation). Fit: strong `stagedRun`; third instance of the reuse-vs-fresh
shape (after `spawn-flow.ts` and cluster 4). Pins exist
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
| TAM-P | Pins: characterization for clusters 4/8/9/14/15/19 arms not covered by the 24 existing `5-space/runtime` TAM suites (gap-measure first) | test-only | 0 | ≲400 | — |
| TAM-A | `activate-agent-for-message` stagedRun, build + wire (single call-site family: RPC handlers + `AgentMessageRouter`) | build+wire | ≲200 | ≲150 | TAM-P |
| TAM-B1 | `create-node-agent-sub-session` stagedRun, unwired (gates + both arms + compensations) | build | ≲250 | ≲250 | TAM-P |
| TAM-B2 | Wire `createSubSession` call sites (spawn deps, post-approval, RPC) to the pipeline | wire | ≲80 | ≲60 | TAM-B1 |
| TAM-C | `restore-post-approval-worker` stagedRun, build + wire | build+wire | ≲200 | ≲150 | TAM-P |
| TAM-D | `rehydrate-sub-session` stagedRun, build + wire | build+wire | ≲240 | ≲200 | TAM-P |
| TAM-E | `deliver-injected-message` pipeline over `decideInjectDelivery`, build + wire (coordinate boundary with agent-routing plan) | build+wire | ≲200 | ≲180 | TAM-P |
| TAM-F | `spawn-post-approval-worker` stagedRun, build + wire | build+wire | ≲220 | ≲180 | TAM-B2 (createSubSession contract settled) |
| TAM-G | `deliver-space-agent-pending-row` pipeline | build+wire | ≲100 | ≲80 | TAM-P |
| TAM-H (optional, not superpipe) | Extract provenance/cooldown/durable-id readers + `resolveTerminalInjectionStatus` into `sub-session-identity.ts` plain helpers | extract | ≲120 | ≲60 | — |

After TAM-B2/D/F land, the reuse-vs-fresh stagedRun shape has 3 direct uses
(spawn-flow, create, post-approval) + 2 close cousins (rehydrate, restore) — a
follow-up MAY propose a combinator per ADR 0004's ≈3-use rule; never before.

## Cross-cutting ADR-0004 risks

1. **Loop bodies, not loops** — every `for` in this file iterates durable rows
   or sessions; migrating a loop into a pipeline would violate the fold/state
   machine exclusion.
2. **Hot-path discipline** — activity tracking and message injection are
   per-event/per-message; decide stages must stay synchronous where coupled to
   the run tick, and `recordActivityForSession` stays inline.
3. **CAS semantics** — `SpawnSupersededError` and `'superseded'` outcomes are
   control flow, not errors; each pipeline's outcome mapping must preserve the
   current throw/return split per caller (spawn wrapper throws; activation
   swallows and returns `[]`).
4. **Compensation duplication** — the workspace-migration capture/restore pair
   appears four times (clusters 4, 8, 10, 19). Until a combinator is justified,
   each pipeline registers its own single compensation; do not share mutable
   capture state across stages.
5. **Blind-write hot spots** — stale co-owner release (cluster 4) and
   completion/error status writes (cluster 12 handlers) use `update`/`getBy…`
   read-modify-write; extraction must not silently upgrade or downgrade their
   atomicity — flag, don't fix, in these slices.
6. **Boundary with agent-routing.md** — `decideInjectDelivery`,
   `injection-delivery-steps.ts`, and the agent-layer delivery pipelines are
   owned by that plan; TAM slices consume them read-only.

## Open questions

1. Does `activateTargetSessionsForMessage`'s timeout race belong inside the
   pipeline (an effect stage racing the spawn stage) or stay a wrapper
   concern? Recommendation: inside, as the current log/return-`[]` contract is
   path behavior.
2. Should cluster 18's builder split (TAM-H-adjacent) be in this epic at all,
   or a separate maintainability epic? It is not superpipe work.
3. Are the `legacyWorkflowRoute*` fallbacks in cluster 7 still load-bearing,
   or deletable dead legacy? A deletion slice could precede TAM-C if the owner
   confirms no persisted workflows rely on them.
