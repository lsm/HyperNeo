# Goal V2: Mission System -- Autonomous Agent Workflows

## Overview

Evolve HyperNeo's current "Goal" feature into a fully autonomous agent workflow system called **"Mission"**. The current system supports basic goal-to-task decomposition with human approval gates. The v2 system adds support for measurable outcome-based missions, recurring/scheduled missions, adaptive replanning, and tiered autonomy levels -- enabling agents to work continuously on long-term objectives with minimal human intervention.

### Naming Strategy

**"Mission"** is the user-facing name for the concept currently called "Goal" internally. It is chosen for its semantic qualities — sustained effort, clear ownership, outcome orientation — not because other frameworks use it (only HBR's enterprise AI framework does).

Why "Mission" over alternatives:
- **vs "Objective"**: Implies a finish line, conflicts with recurring missions that run indefinitely.
- **vs "Workflow"**: Too technical, implies step-by-step process rather than outcome pursuit.
- **vs "Project"**: Overloaded, doesn't convey AI autonomy.

**Rename strategy**: For this iteration, `goal` remains the internal name across storage, runtime, RPCs, events, and backend code. `Mission` is introduced at the **type-alias layer** (`type Mission = RoomGoal` in shared types) and the **UI copy layer** (labels, text, component names). A full backend/API rename is deferred to a future iteration if still justified — this avoids creating a giant conflict surface for every feature task.

### Mission Types (V2 Scope)

| Type | Description | Example | Completion |
|------|-------------|---------|------------|
| **One-Shot** | Discrete objective with clear done criteria | "Add dark mode to the app" | Completes when criteria met |
| **Measurable** | Outcome with quantifiable KPI target | "Reduce test suite runtime by 50%" | Completes when KPI target reached |
| **Recurring** | Executes on a schedule, never truly "completes" | "Check email daily, clean spam" | Runs indefinitely on schedule |

**Deferred to future iteration**: Monitoring missions (event-driven triggers via webhooks/file-watch). Cron-based monitoring is covered by the Recurring type.

### Current State

The existing system provides:
- `RoomGoal` with status (`active | needs_human | completed | archived`), priority, progress aggregation
- `RoomGoal.metrics?: Record<string, number>` -- existing metrics field for custom progress tracking
- `RoomGoal.linkedTaskIds: string[]` -- tasks linked to goal, used for progress aggregation
- `RoomGoal.planning_attempts?: number` -- lifetime counter, incremented per planning spawn
- `RoomGoal.goal_review_attempts?: number` -- exists in type and DB (migration 17) but has zero runtime usages in `packages/daemon/src/lib/`; effectively dead. Not carried forward into new mission fields.
- `NeoTask` with full lifecycle (`draft -> pending -> in_progress -> review -> completed/failed/cancelled`)
- Session groups with metadata (`submittedForReview`, `approved`, `workerRole`, etc.) -- the runtime's unit of active work
- Recovery via `findZombieGroups()` / `recoverZombieGroups()` on each tick -- re-registers sessions from DB
- Two-phase planning (plan PR -> approval -> task creation)
- Progress aggregation: average of all linked task progress values

### What V2 Adds

1. **Mission type system** -- Different runtime behaviors for one-shot, measurable, and recurring missions
2. **Structured metrics with targets** -- Extends existing metrics with target values, units, and time-series history
3. **Scheduling engine** -- Cron-based scheduling for recurring missions with execution identity
4. **Adaptive replanning** -- Smarter replanning that learns from completed/failed tasks
5. **Narrowed autonomy slice** -- Semi-autonomous mode for coder/general tasks only (plan approval stays human-gated)
6. **UI terminology** -- "Mission" in user-facing copy and component names

### Cross-Cutting Design Decisions

**`maxPlanningAttempts` precedence**: Room-level `config.maxPlanningRetries` (retries = N means N+1 total attempts) and mission-level `maxPlanningAttempts` (attempts = N means N total) could conflict. **Rule**: mission-level takes precedence when set; otherwise fall back to `roomConfig.maxPlanningRetries + 1`; default 5. Implementation: shared helper `getEffectiveMaxPlanningAttempts(mission, roomConfig)` used in all gate checks.

**`schedulePaused` as a boolean flag**: Recurring mission pause is a schedule-level flag (`schedule_paused` column), NOT a new `GoalStatus`. Current status CHECK constraint (`'active' | 'needs_human' | 'completed' | 'archived'`) stays unchanged. A recurring mission stays `active` but the scheduler skips it when `schedule_paused = true`. This mirrors how `RuntimeState.paused` is orthogonal to goal status at the room level.

**Metrics precedence**: For measurable missions, `structured_metrics` is the authoritative source. The existing `metrics` column becomes read-only (derived from `structured_metrics` for backward compatibility). For one-shot missions (no `structured_metrics`), legacy `metrics` continues to work as before. There is one writer, not two.

---

## Task Breakdown

| # | Task | Agent | Priority | Dependencies | File |
|---|------|-------|----------|-------------|------|
| 1 | Schema and Types -- Mission Metadata Foundation | `coder` | `high` | None | [task-1-schema-types.md](./goal-v2/task-1-schema-types.md) |
| 2 | Measurable Missions -- Structured Metrics and Adaptive Replanning | `coder` | `normal` | Task 1 | [task-2-measurable.md](./goal-v2/task-2-measurable.md) |
| 3 | Recurring Missions -- Scheduling with Execution Identity and Recovery | `coder` | `normal` | Task 1 | [task-3-recurring.md](./goal-v2/task-3-recurring.md) |
| 4 | Semi-Autonomous Mode -- Narrowed Autonomy Slice | `coder` | `normal` | Task 1 | [task-4-semi-autonomous.md](./goal-v2/task-4-semi-autonomous.md) |
| 5 | UI Terminology -- Goal to Mission Copy Rename | `coder` | `normal` | Task 1 | [task-5-ui-copy-rename.md](./goal-v2/task-5-ui-copy-rename.md) |
| 6 | UI Features -- Type-Specific Creation and Detail Views | `coder` | `normal` | Tasks 2, 3, 4, 5 | [task-6-ui-features.md](./goal-v2/task-6-ui-features.md) |
| 7 | Integration Testing and Documentation | `coder` | `normal` | Tasks 2, 3, 4, 6 | [task-7-testing-docs.md](./goal-v2/task-7-testing-docs.md) |

## Dependency Graph

```
Task 1 (Schema + Types)
  ├─> Task 2 (Measurable) ──────────────┐
  ├─> Task 3 (Recurring) ───────────────┤
  ├─> Task 4 (Semi-Auto) ───────────────┤
  ├─> Task 5 (UI Copy Rename) ──┐       │
  │                              v       │
  └─────────────────────> Task 6 (UI Features)
                                         │
                                         v
                                  Task 7 (Tests + Docs)
```

- Task 1 has no dependencies and unblocks everything
- Tasks 2, 3, 4, 5 can ALL run in parallel after Task 1
- Task 5 (copy-only rename) depends only on Task 1 — can run in parallel with backend tasks
- Task 6 (type-specific UI features) depends on Tasks 2, 3, 4, 5 — needs backend RPCs to accept new fields
- Task 7 (tests + docs) depends on Tasks 2, 3, 4, 6

## Future Work (Out of Scope for V2)

- **Full backend rename** (`goal` -> `mission` in RPCs, events, class names, internal code): Deferred to avoid cross-cutting churn. May never be needed if internal naming is treated as implementation detail.
- **Autonomous mode** (Leader self-approves plans, auto-merges PRs): Requires detailed design for Phase 2 planner gating changes, merge retry/failure handling, and audit trail. V2 only implements `semi_autonomous` for coder/general tasks.
- **Monitoring missions**: Event-driven triggers via webhooks/file-watch. Requires new HTTP infrastructure outside MessageHub.
- **Budget/cost controls**: Per-mission API call or token budgets.
- **Advanced risk classification**: Heuristic-based risk scoring for per-task autonomy override.
