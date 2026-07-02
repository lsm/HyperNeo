# Milestone 1: Shared Types and Mission Aliases

## Milestone Goal

Extend the `RoomGoal` interface and shared type system with all mission V2 metadata fields, export the `Mission` type alias, and add supporting interfaces. This milestone has no runtime behavior changes -- it is purely type-system and no-op default values. All downstream milestones depend on this.

## Tasks

### Task 1.1: Define New Mission Types and Extend RoomGoal

**Agent**: coder
**Description**: Add all V2 mission types to `packages/shared/src/types/neo.ts` and extend the `RoomGoal` interface with the new fields.

**Subtasks** (ordered implementation steps):

1. Add `MissionType` union type:
   ```ts
   export type MissionType = 'one_shot' | 'measurable' | 'recurring';
   ```

2. Add `AutonomyLevel` union type:
   ```ts
   export type AutonomyLevel = 'supervised' | 'semi_autonomous';
   ```

3. Add `MissionMetric` interface:
   ```ts
   export interface MissionMetric {
     name: string;
     target: number;
     current: number;
     unit?: string;
     direction?: 'increase' | 'decrease'; // default: 'increase'
     baseline?: number; // required for 'decrease' direction
   }
   ```

4. Add `MetricHistoryEntry` interface:
   ```ts
   export interface MetricHistoryEntry {
     metricName: string;
     value: number;
     recordedAt: number; // unix timestamp ms
   }
   ```

5. Add `CronSchedule` interface:
   ```ts
   export interface CronSchedule {
     expression: string; // e.g. "0 9 * * *" or "@daily"
     timezone: string;   // e.g. "UTC", "America/New_York"
   }
   ```

6. Add `MissionExecutionStatus` union type:
   ```ts
   export type MissionExecutionStatus = 'running' | 'completed' | 'failed';
   ```

7. Add `MissionExecution` interface:
   ```ts
   export interface MissionExecution {
     id: string;
     goalId: string;
     executionNumber: number;
     startedAt?: number;
     completedAt?: number;
     status: MissionExecutionStatus;
     resultSummary?: string;
     taskIds: string[];
     planningAttempts: number;
   }
   ```

8. Extend `RoomGoal` interface with optional mission V2 fields:
   - `missionType?: MissionType`
   - `autonomyLevel?: AutonomyLevel`
   - `structuredMetrics?: MissionMetric[]`
   - `schedule?: CronSchedule`
   - `schedulePaused?: boolean`
   - `nextRunAt?: number` (unix timestamp ms; dedicated field for scheduler queries, NOT inside schedule JSON)
   - `maxConsecutiveFailures?: number`
   - `maxPlanningAttempts?: number`
   - `consecutiveFailures?: number`
   - `replanCount?: number` (lifetime counter of replanning events across all executions; incremented by `goal.trigger_replan` and by the auto-replan logic in Milestone 3; distinct from `mission_executions.planning_attempts` which is per-execution)

9. Add `type Mission = RoomGoal` type alias and export it from `packages/shared/src/types/neo.ts`.

10. Export all new types from `packages/shared/src/mod.ts` (or wherever shared exports are re-exported).

11. Update `CreateGoalParams` in `packages/daemon/src/storage/repositories/goal-repository.ts` to accept the new optional fields: `missionType`, `autonomyLevel`, `structuredMetrics`, `schedule`, `schedulePaused`, `nextRunAt`, `maxConsecutiveFailures`, `maxPlanningAttempts`, `replanCount`.

12. Update `UpdateGoalParams` in the same file to accept the same optional fields plus `consecutiveFailures` and `replanCount`.

13. Verify TypeScript compiles with zero new errors: `bun run typecheck`.

**Acceptance Criteria**:
- All new types are exported from `@hyperneo/shared`
- `type Mission = RoomGoal` alias compiles and is exported
- `RoomGoal` interface includes all new optional V2 fields
- `CreateGoalParams` and `UpdateGoalParams` accept the new fields
- Existing code that creates/reads `RoomGoal` objects compiles without changes
- `bun run typecheck` passes with no new errors
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Depends on**: Nothing (this is the foundation task)
