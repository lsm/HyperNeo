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

export function supersedeReservedAttempt(db: Database, attempt: DirectTaskAttempt): boolean {
  const repo = new DirectTaskExecutionRepository(db);
  return db.transaction(() => {
    const current = repo.get(attempt.id);
    if (!current || current.sessionId !== attempt.sessionId || current.phase !== 'reserved')
      return false;
    repo.requestStop(current.id, current.sessionId, 'cancelled');
    return (
      repo.isStopRequested(current.id, current.sessionId) &&
      repo.get(current.id)?.phase === 'reserved'
    );
  })();
}
