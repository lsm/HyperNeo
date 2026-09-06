import type { NodeExecution, Space, SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import type { Result } from 'superpipe';
import type {
  AdmitSpawnExecutionOutcome,
  ExecutorMeta,
  RunTickContext,
  SpawnPendingExecutionsOutcome,
} from './space-runtime.ts';
import type { TaskAgentManager } from './task-agent-manager.ts';

export type TickSkipReason =
  | 'missing_run'
  | 'no_run_context'
  | 'rate_or_usage_limited'
  | 'task_stopped'
  | 'no_executions';

export type SpaceWorkflowRunTickOutcome =
  | { action: 'skip'; reason: TickSkipReason }
  | { action: 'cleared_finished_run' }
  | { action: 'recovered_waiting_run' }
  | { action: 'blocked_invalid_workflow' }
  | { action: 'blocked_on_blocked_executions' }
  | { action: 'halted_stranded_recovery' }
  | { action: 'settled_run' }
  | { action: 'halted_node_handoff_drain' }
  | { action: 'blocked_for_spawn_failure' }
  | { action: 'ran_to_completion' };

export type StrandedExecutionRecoveryResult =
  | { action: 'halted' }
  | {
      action: 'continue';
      tam: TaskAgentManager;
      blockedByCrash: boolean;
      preTickPendingIds: Set<string>;
    };

export interface SpaceWorkflowRunTickDeps {
  getRun(runId: string): SpaceWorkflowRun | null;
  clearAgentStuckStateForRun(runId: string): void;
  recoverBlockedRun(runId: string, run: SpaceWorkflowRun): Promise<void>;
  loadRunContext(runId: string, run: SpaceWorkflowRun): Promise<RunTickContext | null>;
  blockInvalidWorkflowRun(
    runId: string,
    meta: ExecutorMeta,
    canonicalTask: SpaceTask
  ): Promise<void>;
  pruneStaleNotifyDedupKeys(canonicalTask: SpaceTask): void;
  blockRunOnBlockedExecutions(
    runId: string,
    meta: ExecutorMeta,
    canonicalTask: SpaceTask,
    blockedReason: string
  ): Promise<void>;
  getSpace(spaceId: string): Promise<Space | null>;
  recoverStrandedExecutions(
    runId: string,
    run: SpaceWorkflowRun,
    context: RunTickContext,
    nodeExecutions: NodeExecution[],
    runIsComplete: boolean,
    space: Space | null
  ): Promise<StrandedExecutionRecoveryResult>;
  settleIfComplete(
    runId: string,
    runIsComplete: boolean,
    meta: ExecutorMeta,
    canonicalTask: SpaceTask
  ): Promise<boolean>;
  drainPendingNodeHandoffs(
    runId: string,
    run: SpaceWorkflowRun,
    context: RunTickContext
  ): Promise<'halted' | 'continue'>;
  promotePendingExecutionsWithLiveSessions(
    runId: string,
    preTickPendingIds: Set<string>,
    tam: TaskAgentManager
  ): NodeExecution[];
  admitSpawnExecution(
    runId: string,
    meta: ExecutorMeta,
    canonicalTask: SpaceTask,
    nodeExecutions: NodeExecution[],
    space: Space | null
  ): AdmitSpawnExecutionOutcome;
  spawnPendingExecutions(
    runId: string,
    canonicalTask: SpaceTask,
    space: Space,
    meta: ExecutorMeta,
    run: SpaceWorkflowRun,
    pendingExecutions: NodeExecution[],
    tam: TaskAgentManager,
    blockedByCrash: boolean
  ): Promise<SpawnPendingExecutionsOutcome>;
  blockRunForSpawnFailure(
    runId: string,
    meta: ExecutorMeta,
    canonicalTask: SpaceTask,
    permanentSpawnFailureReason: string | null,
    blockedByCrash: boolean
  ): Promise<boolean>;
  casCanonicalTaskOpenToInProgress(spaceId: string, canonicalTask: SpaceTask): Promise<void>;
}

export interface RunTickCtx {
  runId: string;
  deps: SpaceWorkflowRunTickDeps;
  run?: SpaceWorkflowRun | null;
  context?: RunTickContext | null;
  nodeExecutions?: NodeExecution[];
  runIsComplete?: boolean;
  space?: Space | null;
  recovery?: {
    tam: TaskAgentManager;
    blockedByCrash: boolean;
    preTickPendingIds: Set<string>;
  };
  spawn?: AdmitSpawnExecutionOutcome;
  spawned?: SpawnPendingExecutionsOutcome;
  spawnFailureBlocked?: boolean;
}

export type TickResult = Result<RunTickCtx, SpaceWorkflowRunTickOutcome>;

export function continued(ctx: RunTickCtx): TickResult {
  return { value: ctx };
}

export function skipped(reason: TickSkipReason): TickResult {
  return { reason: { action: 'skip', reason } };
}
