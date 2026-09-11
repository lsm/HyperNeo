import type { Session, SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { DirectTaskAttempt } from '../../../storage/repositories/direct-task-execution-repository.ts';

export interface DirectTaskWorkerLookups {
  getSession: (sessionId: string) => Session | null;
  getTask: (taskId: string) => SpaceTask | null;
  getActiveAttempt: (taskId: string) => DirectTaskAttempt | null;
}

export interface DirectTaskWorkerIdentity {
  role: 'direct_task_worker';
  owner: 'direct-task-executor';
  isWorkflowWorker: false;
  sessionId: string;
  spaceId: string;
  taskId: string;
  attemptId: string;
  generation: number;
  phase: 'reserved' | 'running';
}

export interface DirectTaskWorkerEvidence {
  session: Session | null;
  task: SpaceTask | null;
  attempt: DirectTaskAttempt | null;
}

export function loadDirectTaskWorkerEvidence(
  sessionId: string,
  getSession: DirectTaskWorkerLookups['getSession'],
  getTask: DirectTaskWorkerLookups['getTask'],
  getActiveAttempt: DirectTaskWorkerLookups['getActiveAttempt']
): DirectTaskWorkerEvidence {
  const session = getSession(sessionId);
  const taskId = session?.context?.taskId;
  return {
    session,
    task: taskId ? getTask(taskId) : null,
    attempt: taskId ? getActiveAttempt(taskId) : null,
  };
}

export function requireDirectTaskWorkerIdentity(
  sessionId: string,
  { session, task, attempt }: DirectTaskWorkerEvidence
): { value: DirectTaskWorkerIdentity } | { reason: null } {
  if (
    !session ||
    session.id !== sessionId ||
    session.type !== 'worker' ||
    session.status !== 'active' ||
    !task?.spaceId ||
    task.id !== session.context?.taskId ||
    task.spaceId !== session.context.spaceId ||
    task.workflowRunId ||
    (task.taskAgentSessionId && task.taskAgentSessionId !== sessionId) ||
    !attempt ||
    attempt.taskId !== task.id ||
    attempt.sessionId !== sessionId ||
    (attempt.phase !== 'reserved' && attempt.phase !== 'running')
  )
    return { reason: null };
  return {
    value: {
      role: 'direct_task_worker',
      owner: 'direct-task-executor',
      isWorkflowWorker: false,
      sessionId,
      spaceId: task.spaceId,
      taskId: task.id,
      attemptId: attempt.id,
      generation: attempt.generation,
      phase: attempt.phase,
    },
  };
}

export function createDirectTaskWorkerResolver(lookups: DirectTaskWorkerLookups) {
  return (superpipe({ ...lookups })('resolve-direct-task-worker') as PipelineAPI)
    .input('sessionId')
    .pipe(
      loadDirectTaskWorkerEvidence,
      ['sessionId', 'getSession', 'getTask', 'getActiveAttempt'],
      'evidence'
    )
    .pipe(requireDirectTaskWorkerIdentity, ['sessionId', 'evidence'], 'result:identity')
    .end('identity') as (sessionId: string) => DirectTaskWorkerIdentity | null;
}
