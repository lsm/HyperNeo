import type { SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { TaskWithSpaceFieldsSchema } from './get-operation.ts';

const inputSchema = z.object({ taskId: z.string().min(1) }).strict();
type Input = z.infer<typeof inputSchema>;
type Rejection = 'handoff_denied' | 'handoff_unavailable' | 'task_not_found';
type Outcome = SpaceTask | Rejection;

export interface HandoffWorkerSessionDependencies {
  getTask: (taskId: string) => SpaceTask | null;
  handoff: (spaceId: string, taskId: string) => Promise<SpaceTask>;
}

function admitHandoff(
  input: Input,
  caller: OperationCaller,
  deps: HandoffWorkerSessionDependencies
): { value: SpaceTask } | { reason: Rejection } {
  if (caller.source !== 'rpc') return { reason: 'handoff_denied' };
  const task = deps.getTask(input.taskId);
  if (!task) return { reason: 'task_not_found' };
  if (
    !task.workflowRunId ||
    task.status !== 'blocked' ||
    task.blockReason !== 'agent_handoff_required'
  ) {
    return { reason: 'handoff_unavailable' };
  }
  return { value: task };
}

async function handoff(task: SpaceTask, deps: HandoffWorkerSessionDependencies): Promise<Outcome> {
  return deps.handoff(task.spaceId, task.id);
}

export function createHandoffWorkerSessionOperation(deps: HandoffWorkerSessionDependencies) {
  const run = (superpipe({ deps })('handoff-worker-session') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitHandoff, ['input', 'caller', 'deps'], 'result:outcome')
    .pipe(handoff, ['outcome', 'deps'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Outcome>;
  return defineOperation({
    name: 'task.workerSession.handoff',
    description:
      'After a worker session cannot be resumed, a human can explicitly start a successor with a bounded, durable handoff from the predecessor.',
    policy: { safetyClass: 'human_only' },
    inputSchema,
    resultSchema: z.union([
      TaskWithSpaceFieldsSchema,
      z.enum(['handoff_denied', 'handoff_unavailable', 'task_not_found']),
    ]),
    execute: (input, caller) => run(input, caller),
  });
}
