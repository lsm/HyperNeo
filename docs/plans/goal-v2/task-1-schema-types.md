# Task 1: Schema and Types -- Mission Metadata Foundation

**Agent**: `coder`
**Priority**: `high`
**Dependencies**: None

## Description

Add mission metadata columns to the existing `goals` table, create supporting tables, and define shared types. The physical table name remains `goals`. Internal code continues to use `goal` naming — only type aliases and UI copy use "Mission".

### 1. New shared types in `packages/shared/src/types/neo.ts`

- `MissionType = 'one_shot' | 'measurable' | 'recurring'`
- `AutonomyLevel = 'supervised' | 'semi_autonomous'` (narrowed scope — no `autonomous` in V2)
- `MissionMetric`:
  ```ts
  interface MissionMetric {
    name: string;
    target: number;
    current: number;
    unit?: string;
    direction?: 'increase' | 'decrease'; // default: 'increase'
    baseline?: number; // required for 'decrease' direction
  }
  ```
- `MetricHistoryEntry`: `{ metricName: string; value: number; recordedAt: number }` -- unix timestamp, matches DB INTEGER
- `CronSchedule`: `{ expression: string; timezone: string }` -- `nextRunAt` lives on `RoomGoal` as a dedicated field (see below), not inside the schedule JSON
- `MissionExecutionStatus = 'running' | 'completed' | 'failed'`
- `type Mission = RoomGoal` (alias for UI/type layer; `RoomGoal` stays canonical)
- Add to `RoomGoal` interface: `missionType?: MissionType`, `autonomyLevel?: AutonomyLevel`, `structuredMetrics?: MissionMetric[]`, `schedule?: CronSchedule`, `schedulePaused?: boolean`, `nextRunAt?: number` (unix timestamp), `maxConsecutiveFailures?: number`, `maxPlanningAttempts?: number`, `consecutiveFailures?: number`

### 2. Add new columns to `goals` table via migration

- `mission_type` (TEXT, default `'one_shot'`, CHECK constraint)
- `autonomy_level` (TEXT, default `'supervised'`, CHECK constraint)
- `schedule` (TEXT/JSON, nullable)
- `schedule_paused` (INTEGER, default 0)
- `next_run_at` (INTEGER, nullable) -- dedicated column for scheduler queries; not inside schedule JSON
- `structured_metrics` (TEXT/JSON, nullable)
- `max_consecutive_failures` (INTEGER, default 3)
- `max_planning_attempts` (INTEGER, default 5)
- `consecutive_failures` (INTEGER, default 0)
- Index on `(mission_type, schedule_paused, next_run_at)` for efficient scheduler queries
- Migrate existing rows: `mission_type = 'one_shot'`, `autonomy_level = 'supervised'`

### 3. New `mission_metric_history` table

- `id` (TEXT PK), `goal_id` (TEXT FK to `goals.id` ON DELETE CASCADE), `metric_name` (TEXT NOT NULL), `value` (REAL NOT NULL), `recorded_at` (INTEGER NOT NULL)
- Index on `(goal_id, metric_name, recorded_at)`

### 4. New `mission_executions` table

- `id` (TEXT PK), `goal_id` (TEXT FK), `execution_number` (INTEGER NOT NULL), `started_at` (INTEGER), `completed_at` (INTEGER), `status` (TEXT), `result_summary` (TEXT), `task_ids` (TEXT/JSON), `planning_attempts` (INTEGER, default 0)
- Unique constraint on `(goal_id, execution_number)`
- Partial unique index on `(goal_id) WHERE status = 'running'` — DB-enforced at-most-one-running-execution invariant
- `planning_attempts` is per-execution for recurring missions (see [Task 3](./task-3-recurring.md) per-execution storage model)

### 5. Update `GoalRepository` (keep class name)

- Add CRUD for new columns
- Add `mission_metric_history` queries (insert, query by time range)
- Add `mission_executions` queries (insert, list, update status, get active execution)
- Implement shared helper `getEffectiveMaxPlanningAttempts(goal, roomConfig)`

## Acceptance Criteria

- Migration runs cleanly on fresh DB and with existing goals data
- Physical table remains `goals`, all existing SQL unchanged
- New types exported from `@hyperneo/shared`
- `Mission` type alias exists; `RoomGoal` continues to compile everywhere
- `mission_metric_history` and `mission_executions` tables created and queryable
- Unit tests for: migration, new column defaults, metric history CRUD, execution CRUD, `getEffectiveMaxPlanningAttempts` helper
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
