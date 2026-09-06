# Unify anti-stuck mechanisms into one runtime service

Date: 2026-09-06. Tree: `8b0af3fcd2` (`dev`). Space task #394 (re-scoped 2026-09-05).

One service owns detection of stalled Space work and the intervention ladder that
unsticks it, gated by space autonomy level, building on the `spaceWorkflowRunTick`
pipeline. This document is the reviewable decomposition artifact (ADR 0004); each
slice below maps 1:1 to a GitHub child issue and a PR targeting `dev`.

## Inventory (measured)

| # | Mechanism | Where | State today | Cadence | Interventions |
|---|---|---|---|---|---|
| 1 | Stuck-execution recovery | `handleAliveStuckExecutions` (`space-runtime.ts:5779`, ~177 lines) + helpers (`getAgentStuckState`, `getAgentNoProgressThresholdMs`, `buildRuntimeNagMessage`, `buildRuntimeRestartNotice`) | in-memory `agentStuckRecovery` map | run tick (`recoverStrandedExecutions`) | nag → restart → block |
| 2 | Inactivity watchdog | `SpaceAgentInactivityWatchdogService` (435 lines) + `inactivity-watchdog-gates.ts` (259) + `space-agent-inactivity-repository.ts` (330) + app.ts interval + snapshot wiring in `rpc-handlers/index.ts` | durable `space_agent_inactivity_config` / `space_agent_inactivity_claims` | own `setInterval` (`app.ts:1271`) | nag only, with degraded-state handling |
| 3 | Timeout detection | `selectTimedOutExecutions` (`run-tick-admission-gates.ts`, already pure) + notify block in `recoverStrandedExecutions` (`space-runtime.ts:6223-6246`) | in-memory `notifiedTaskSet` dedup | run tick | notify only |
| 4 | Blocked-run auto-retry | `attemptBlockedRunRecovery` (`space-runtime.ts:7954`, ~111 lines) + `revertRepairedRunToBlocked` + `repairBlockedCanonicalTask` | in-memory `blockedRetryCounts` | run tick (waiting-run route) | CAS retry / `workflow_run_needs_attention` on exhaustion |
| 5 | Spawn-failure classification | classification already pure (`spawn-admission-gates.ts`, `run-spawn-decisions.ts`); crash counter `resetWorkflowNodeExecutionForSpawnRetry` (`space-runtime.ts:5957`, ~37 lines) | in-memory `taskCrashCounts` | run tick | retry-as-pending / block |

Adjacent handlers in the same cluster (stay in place unless a slice says otherwise):
`handleWaitingRebindExecutions`, `handleNonTerminalIdleExecutions`,
`handleTerminalErrorIdleExecutions`, `detectSilentStallForAttention` (notify-only),
prompt-too-long recovery.

Defects this unification removes: five liveness derivations that re-derive
"is this agent stuck" differently; three scattered in-memory state maps plus one
durable claim pair; no shared intervention vocabulary; none of it autonomy-aware.

## Pin status

The existing suites already characterize all five mechanisms (measured, not
assumed): stuck ladder — `space-runtime-tick-loop.test.ts` "Layer 1 runtime
anti-stuck recovery" (1317–2183) plus `space-runtime-stalled-recovery.test.ts`
(2658 lines) and `space-runtime-task-stop-park.test.ts`; watchdog —
`inactivity-watchdog-service.test.ts` (575) + `inactivity-watchdog-gates.test.ts`
(421); timeout — `space-runtime-notifications.test.ts` `task_timeout` describe
(446–564) + `run-tick-admission-gates.test.ts`; blocked-run retry —
`space-runtime-tick-loop.test.ts` `MAX_BLOCKED_RUN_RETRIES` suite (2325–2977);
crash retry — `space-runtime.test.ts:3081,3263`. No separate pin slice is needed;
each slice's equivalence/behavior tests ride that slice per ADR 0004.

## Target shape

- `packages/daemon/src/lib/space/runtime/anti-stuck/` owns the unified logic:
  `stuck-ladder-gates.ts` (S1), `recovery-retry-gates.ts` (S2), `policy.ts`
  (intervention ladder + autonomy requirements, S3), `anti-stuck-pipeline.ts`
  (S4), and a shared per-subject state store (S3).
- Detection reuses the run tick's already-loaded context (`loadRunContext`,
  `loadExecutionsAndSpace`, session liveness via `tam.isSessionInMemory`) — the
  anti-stuck pipeline is composed inside the tick's stranded-recovery stage
  family; it never re-derives liveness from scratch.
- Interventions form one ladder: `notify < nag < retry < restart`, with
  `escalate_needs_attention` as the always-available terminal. Autonomy level
  gates which rungs may fire; below-bar rungs are skipped and the ladder falls
  through to escalate — never to silence.

## Autonomy gating proposal (decided in S3, goes live in S5/S6)

| Intervention | Required level | Rationale |
|---|---|---|
| notify / escalate_needs_attention | 1 (always) | observability floor; the safe terminal never gated |
| nag | 2 | lightest touch; a fully supervised space escalates instead of the runtime prodding sessions |
| retry (blocked-run auto-retry, spawn-crash respawn) | 3 | autonomous re-execution of failed work |
| restart (interrupt + respawn a live session) | 4 | matches the existing `interrupt_session` / session-write precedent (`SESSION_WRITE_AUTONOMY_LEVEL = 4`) |

Compatibility note: spaces default to level 1 (`space-repository.ts:45`), so S5
intentionally changes L1 behavior — stuck executions escalate to
`needs_attention` instead of being nagged/restarted, and blocked runs stop
auto-retrying. That is the re-scope's stated intent ("none autonomy-aware");
S5 updates the affected pins with level-explicit fixtures. The mapping table is
tunable in S3 review.

## Slice ladder

Serial; each slice branches from updated `dev` after its dependency merges.

| Slice | Phase | Deliverable | Budget (prod) |
|---|---|---|---|
| AS-S1 | extract | `stuck-ladder-gates.ts`: `observeExecutionProgress` (session-change/progress-message state reducer + `observedAt` computation) and `decideStuckLadderAction` (threshold → nag → grace → restart → block), verbatim moves out of `handleAliveStuckExecutions`; equivalence pins; carries this plan doc | ~150 |
| AS-S2 | extract | `recovery-retry-gates.ts`: `decideBlockedRunRecovery` (budget, reopen-reset, CAS precondition) and `decideSpawnRetryOutcome` (crash-count exhaustion), verbatim moves; equivalence pins | ~150 |
| AS-S3 | build | `policy.ts` + shared state store: `AntiStuckIntervention` ladder, `ANTI_STUCK_INTERVENTION_REQUIREMENTS`, `decideAntiStuckIntervention`; additive dead code + tests | ~250 |
| AS-S4 | build | `anti-stuck-pipeline.ts`: one superpipe composing detection (S1/S2 gates, `selectTimedOutExecutions`, watchdog snapshot) → autonomy gate → intervention dispatch; additive dead code + per-stage tests | ~300 |
| AS-S5 | wire | run-tick paths call the pipeline; `agentStuckRecovery` / `blockedRetryCounts` / `taskCrashCounts` fold into the shared store; autonomy gating live for run mechanisms; pins updated with level-explicit fixtures. Splits into S5a (stuck ladder + timeout) / S5b (retry + crash) if measured over budget | ~300 |
| AS-S6 | wire | inactivity watchdog scan routes its decision through the unified policy (autonomy-gated nag); durable claims preserved | ~250 |
| AS-S7 | delete | superseded inline handlers, old decision copies, scattered state maps; removal-only | negative |

Standing per-slice merge contracts live in each child issue (AS-S1..AS-S7).
