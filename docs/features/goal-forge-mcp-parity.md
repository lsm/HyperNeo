# Goal/Mission & Forge — UI ↔ MCP edit parity

Contract: **anything mutable from the Space UI for Goals/Missions and Forge must be
mutable through the `space-agent-tools` MCP tools with the same validation,
invariants, audit behavior, and live effects.** The reference direction is
UI → MCP. MCP-only or RPC-only capabilities are tracked separately and are not
parity gaps in the UI→MCP sense.

Both UI (RPC) and MCP call the **same domain service methods**, so a fix or
behavior change happens once. Never duplicate repository writes or business
rules between the paths.

## Goal/Mission (`SpaceGoal`)

Recurring goals are the "mission" abstraction — a goal with a linked
`TaskSchedule` (cron-driven check-ins). Autonomy is a Space/agent attribute,
not a goal field.

| Field / action | UI | RPC (`spaceGoal.*`) | MCP | Service |
|---|---|---|---|---|
| create (incl. cron + tz) | ✅ | ✅ `.create` | ✅ `create_goal` | `createGoal` |
| title / description / type / priority / labels / metrics / summary / nextSteps / preferredWorkflowId / autoTriggerNext | ✅ | ✅ `.update` | ✅ `update_goal` | `updateGoal` |
| progress (non-recurring; ignored for recurring) | ✅ | ✅ | ✅ | `updateGoal` |
| status (active/paused/completed/archived) | detail-panel buttons + `.update` | ✅ `.update` / `.pause` / `.resume` | ✅ `update_goal` / `pause_goal` / `resume_goal` | `updateGoal` / `pauseGoal` / `resumeGoal` |
| **check-in cron / timezone edit in place** | ✅ dialog (this PR) | ✅ `.update` (this PR) | ✅ `update_goal.check_in_cron_expression` / `check_in_timezone` (this PR) | `updateGoal` → `ScheduleService.updateSchedule` |
| **add a schedule to a goal** | ✅ dialog (this PR) | ✅ (this PR) | ✅ (this PR) | `updateGoal` → `createGoalSchedule` |
| **remove a schedule** | ✅ dialog (clear cron; this PR) | ✅ `null` (this PR) | ✅ `null` (this PR) | `updateGoal` → `deleteSchedule` |
| trigger immediate task | ✅ | ✅ `.createImmediateTask` | ✅ `trigger_goal_task` | `createImmediateTask` |
| list / get / list events / list tasks | ✅ | ✅ | ✅ | — |

### Schedule-edit semantics (this PR)

`update_goal` / `spaceGoal.update` accept `checkInCronExpression` and
`checkInTimezone`:

- **omit** → schedule untouched (omit === no change).
- **cron expression** → set/update the linked schedule's cadence in place
  (creates one if the goal has none). The stale pending fire job is cancelled
  and a fresh one enqueued **atomically**; `nextCheckInAt` is recomputed for
  active goals.
- **`null` / empty** → remove the linked schedule (`taskScheduleId` and
  `nextCheckInAt` cleared).

These edits are **identity-preserving and run-safe**: they never create or
detach tasks and never consume or clear `pendingNextRun` — only the schedule's
own pending fire job moves. `activeTaskId` / `lastTaskId` / history / Forge
linkage are preserved. A **paused** goal's schedule config is validated at
write time and takes effect at resume (resume recomputes from the new cron).

Internal fields (`activeTaskId`, `lastTaskId`, `taskScheduleId`,
`pendingNextRun`, `nextCheckInAt`, `completedAt`) are **not** directly
writable — they are derived/managed by the service.

## Forge (Evolution)

| Field / action | UI | RPC (`evolution.*`) | MCP | Notes |
|---|---|---|---|---|
| scope: create / name / objective / kind / metricDefinitions / parentScopeId / goal link / full `policy` replace | partial (create + goal link; name/objective/kind/metrics/parent not in edit form) | ✅ `.scope.update` | ✅ `update_forge_scope` | — |
| scope: **deep-merge `policyPatch`** (automation.*, judge model/provider) | ✅ | ✅ | ✅ `update_forge_scope.policy_patch` (this PR) | previously MCP could only full-replace `policy` |
| scope: `episodeJudgeModel` + **`episodeJudgeProvider`** | ✅ (paired) | ✅ | ✅ `episode_judge_model` / `episode_judge_provider` (provider added this PR) | provider was previously dropped |
| evidence: manual note / attach task / attach workflow run / metric snapshot | partial | ✅ | ✅ | — |
| episode: create / status (accepted/dismissed) / title / outcomeSummary | partial | ✅ `.episode.update` | ✅ `update_forge_episode` | — |
| lesson: status (active/dismissed) / rule / why / appliesTo / confidence | partial | ✅ `.lesson.update` | ✅ `update_forge_lesson` | — |
| proposal: status (accepted/dismissed) / edit fields / create task | partial | ✅ | ✅ `update_forge_task_proposal` / `create_task_from_forge_proposal` | — |
| rollup (summary + nextSteps; `progress` accepted but discarded for recurring) | ✅ | ✅ | ✅ `apply_forge_rollup` | — |
| read: list/get scope, timeline, evidence, review bundle, metric snapshots | ✅ | ✅ | ✅ | — |

`policy_patch` uses the service's `mergeEvolutionPolicy`: top-level keys are
merged (`null` clears a key), and `automation.*` is **nested-merged**, so an
agent can change `automation.completedTaskThreshold` without clobbering
`episodeJudgeModel`/`episodeJudgeProvider` — exactly what the UI does.

## Deferred follow-up parity groups

Out of scope for this PR; tracked as separate Space tasks:

1. **Forge guard alignment (parity drift).** RPC `evolution.episode.update` /
   `lesson.update` / `taskProposal.update` permit transitions that MCP blocks
   (reopen terminal episodes; reactivate dismissed lessons; set proposal
   `status:'created'` without creating a task). Decide direction and align.
2. **`list_forge_evidence` preflight context.** UI requests
   `includePreflightContext`; MCP omits it.
3. **Goal UI: "Completed" button + goal delete.** RPC/MCP can mark `completed`;
   the UI has no button. No surface supports goal deletion (archive only).
4. **RPC-only Forge mutations** (not UI-mutable, so not UI→MCP gaps, but
   undocumented): generic `evidence.create`, plain `episode.create`,
   `scope.resolveForGoal`, `task.lessons.select`, episode `timeWindow`/
   `findings`, lesson/proposal `evidenceEpisodeIds` edits.
5. **MCP-only Forge surfaces** (MCP ahead of UI): `create_forge_task_proposal`,
   `assign_agent_to_forge_scope`, proposal→task `depends_on`.
6. **Forge self-nag schedule resync via MCP.** `update_forge_scope` runs the
   shared `validateGoalAutomationSelfNagPolicy` gate (so `automation.*` is
   validated identically to RPC/UI), but does not run the RPC `onScopeSaved` →
   `syncGoalAutomationSelfNagScheduleForScope` reconciliation. Self-nag
   (`selfNagCronExpression`/`selfNagTimezone`) is not UI-editable, so this is
   not a UI→MCP gap; wire the resync if MCP authoring of self-nag cadence
   becomes supported.
