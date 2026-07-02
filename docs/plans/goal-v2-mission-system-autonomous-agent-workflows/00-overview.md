# Goal V2: Mission System -- Autonomous Agent Workflows

## Goal Summary

Evolve HyperNeo's current "Goal" feature into a fully autonomous agent workflow system called **"Mission"**. The current system supports basic goal-to-task decomposition with human approval gates. V2 adds support for measurable outcome-based missions, recurring/scheduled missions, adaptive replanning, and tiered autonomy levels -- enabling agents to work continuously on long-term objectives with minimal human intervention.

## Naming Strategy

"Mission" is the user-facing name for the concept currently called "Goal" internally. `goal` remains the internal name across storage, RPCs, events, and backend code. `Mission` is introduced at the **type-alias layer** (`type Mission = RoomGoal` in shared types) and the **UI copy layer** (labels, text, component names) only. A full backend/API rename is deferred to avoid creating a giant cross-cutting conflict surface.

## Approach

1. Foundation first: extend the shared type system and database schema with new mission fields
2. Backend logic: implement each new capability (measurable KPIs, recurring scheduling, semi-autonomous approval) as isolated daemon features
3. RPC layer: extend existing RPC handlers to support new fields and add new dedicated RPCs
4. Frontend: update UI copy to "Mission" terminology, then add type-specific creation/display features
5. Tests: comprehensive unit, integration, and E2E coverage

Feature branches are created from `dev`. All PRs target `dev`.

## Milestones

1. **Shared Types and Mission Aliases** -- Extend `RoomGoal` with `missionType`, `autonomyLevel`, `structuredMetrics`, `schedule`, and related fields; export `Mission` type alias; add new supporting interfaces.
2. **Database Schema Migration** -- Add new columns to the `goals` table via a numbered migration; create `mission_metric_history` and `mission_executions` tables; update `GoalRepository` to handle all new fields.
3. **Measurable Missions: Metrics and Adaptive Replanning** -- Implement structured KPI tracking in `GoalManager`, runtime auto-replan logic when metric targets aren't met, and MCP tools for metric reporting.
4. **Recurring Missions: Scheduling and Execution Identity** -- Cron-based scheduler inside `RoomRuntime`, execution identity via `mission_executions`, per-execution task isolation, overlap prevention, and recovery after daemon restart.
5. **Semi-Autonomous Mode** -- Auto-approve coder/general tasks under `semi_autonomous` autonomy level, deferred post-tool callback for auto-resume, `approvalSource` in session group metadata, consecutive-failure escalation.
6. **RPC Layer Extensions** -- Extend `goal.create`/`goal.update` RPCs to accept and persist new fields; add `goal.update_kpi` and `goal.trigger_replan` RPCs; update `DaemonEventMap` with new goal events.
7. **UI: Mission Creation, Dashboard, and Status** -- Rename all UI copy from "Goal" to "Mission"; add mission-type selector, conditional form fields, type-specific detail views, KPI progress display, recurrence indicators, and execution history.

## Cross-Milestone Dependencies

```
Milestone 1 (Types)
  -> Milestone 2 (Schema)
       -> Milestone 3 (Measurable)  ─┐
       -> Milestone 4 (Recurring)   ─┤-> Milestone 6 (RPC)
       -> Milestone 5 (Semi-Auto)   ─┘      -> Milestone 7 (UI)
```

Milestones 3, 4, and 5 all depend on Milestones 1 and 2 and can run in parallel with each other. Milestone 6 depends on Milestones 3, 4, and 5 (it consolidates `DaemonEventMap` entries from those milestones and references their manager methods). Milestone 7 depends on Milestone 6 (RPCs must accept new fields before UI forms can function end-to-end).

**Note on `DaemonEventMap`**: The `goal.task.auto_completed` event entry is defined exclusively in Milestone 6 (not in Milestone 5) to avoid merge conflicts when 3–5 run on parallel branches.

## Key Design Decisions

- **`schedulePaused` as a boolean flag**: Recurring mission pause is a schedule-level flag, NOT a new `GoalStatus`. Current status CHECK constraint stays unchanged.
- **Metrics precedence**: `structured_metrics` is the authoritative source for measurable missions; the legacy `metrics` column becomes a derived read-only view.
- **`maxPlanningAttempts` precedence**: Mission-level `maxPlanningAttempts` overrides room-level `config.maxPlanningRetries + 1`; default 5.
- **Execution identity**: Each recurring trigger creates a `mission_executions` row. Overlap is prevented by a DB-level partial unique index AND an app-level check.
- **Per-execution task isolation**: `goals.linked_task_ids` is overwritten per execution so existing runtime progress aggregation code works unchanged.
- **Semi-autonomous scope**: Only coder/general tasks auto-approve. Planning tasks always require human sign-off.
- **Auto-resume timing**: Deferred via post-tool callback, not inline from `handleLeaderTool`.

## Estimated Task Count

7 milestones, 10 total tasks (1.1, 2.1, 2.2, 3.1, 4.1, 5.1, 6.1, 7.1, 7.2, 7.3).
