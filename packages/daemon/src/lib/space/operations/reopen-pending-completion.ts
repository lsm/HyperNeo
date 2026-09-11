import type { SpaceTask } from '@hyperneo/shared';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { ReactiveDatabase } from '../../../storage/reactive-database.ts';
import { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import { DirectTaskExecutionRepository } from '../../../storage/repositories/direct-task-execution-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { claimDirectStart } from '../runtime/start-direct-task.ts';
import { PendingCompletionSupersededError } from './pending-completion-guard.ts';

export function reopenDirectCompletion(
  db: Database,
  reactiveDb: ReactiveDatabase | undefined,
  task: SpaceTask | null,
  taskId: string,
  reason: string | null,
  expectedGeneration: number,
  onTaskReopened?: (taskId: string) => void
): { value: SpaceTask } | { reason: { task: SpaceTask; reasonPersisted: true } } {
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const attempts = new DirectTaskExecutionRepository(db);
  if (!attempts.isSelected(task.id)) return { value: task };
  const active = attempts.getActive(task.id);
  if (
    active?.phase === 'running' &&
    active.sessionId === task.taskAgentSessionId &&
    !task.workflowRunId &&
    !attempts.isStopRequested(active.id, active.sessionId)
  )
    return { value: task };
  const previous = db
    .prepare(
      'SELECT id, generation FROM direct_task_execution_attempts WHERE task_id = ? AND session_id = ? AND phase = ?'
    )
    .get(task.id, task.taskAgentSessionId ?? '', 'stopped') as {
    id: string;
    generation: number;
  } | null;
  if (!previous) throw new PendingCompletionSupersededError(task.id);
  const claimed = claimDirectStart(
    db,
    reactiveDb,
    {
      taskId: task.id,
      requestKey: `review-rejection:${expectedGeneration}`,
      retryFrom: { attemptId: previous.id, generation: previous.generation },
      reviewRejection: { expectedPendingCompletionGeneration: expectedGeneration, reason },
    },
    onTaskReopened,
    new JobQueueRepository(db)
  );
  if ('reason' in claimed && !claimed.reason.started)
    throw new PendingCompletionSupersededError(task.id);
  const updated = new SpaceTaskRepository(db).getTask(task.id);
  if (!updated) throw new PendingCompletionSupersededError(task.id);
  return { reason: { task: updated, reasonPersisted: true } };
}
