import type { SpaceTask } from '@hyperneo/shared';
import type { Database } from '../../../storage/sqlite-compat.ts';
import {
  DirectTaskExecutionRepository,
  type DirectTaskAttempt,
} from '../../../storage/repositories/direct-task-execution-repository.ts';

export type CancellationRoute =
  | { kind: 'workflow' }
  | { kind: 'direct'; attempt: DirectTaskAttempt }
  | { kind: 'reserved'; attempt: DirectTaskAttempt }
  | { kind: 'plain' };

export function resolveCancellationRoute(
  db: Database,
  task: Pick<SpaceTask, 'id' | 'workflowRunId' | 'taskAgentSessionId'>
): CancellationRoute {
  if (task.workflowRunId) return { kind: 'workflow' };
  const attempt = new DirectTaskExecutionRepository(db).getActive(task.id);
  if (!attempt) return { kind: 'plain' };
  return attempt.phase === 'reserved' ? { kind: 'reserved', attempt } : { kind: 'direct', attempt };
}

const VALID_FENCE_OUTCOMES = new Set(['cancelled', 'start_superseded']);

export function supersedeReservedAttempt(db: Database, attempt: DirectTaskAttempt): boolean {
  const repo = new DirectTaskExecutionRepository(db);
  return db.transaction(() => {
    const current = repo.get(attempt.id);
    if (!current || current.sessionId !== attempt.sessionId || current.phase !== 'reserved')
      return false;
    repo.requestStop(current.id, current.sessionId, 'cancelled');
    const request = db
      .prepare(
        'SELECT outcome FROM direct_task_stop_requests WHERE attempt_id = ? AND session_id = ?'
      )
      .get(current.id, current.sessionId) as { outcome: string } | null;
    return (
      repo.get(current.id)?.phase === 'reserved' &&
      !!request &&
      VALID_FENCE_OUTCOMES.has(request.outcome)
    );
  })();
}
