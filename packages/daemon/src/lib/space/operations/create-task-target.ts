import type { Session } from '@hyperneo/shared';
import { z } from 'zod';
import type { OperationCaller } from '../../operations/registry.ts';
import { TaskCoreSchema } from '../../operations/task-get.ts';

export const SpaceCreateTaskInputSchema = z
  .object({
    spaceId: z.string().min(1).optional(),
    title: z.string().trim().min(1),
    description: z.string().optional(),
    priority: TaskCoreSchema.shape.priority.optional(),
    labels: z.array(z.string()).optional(),
    dependsOn: z.array(z.string()).optional(),
    draft: z.boolean().optional(),
    preferredWorkflowId: z.string().min(1).optional(),
    workspacePath: z.string().min(1).optional(),
  })
  .strict();

export type SpaceCreateTaskInput = z.infer<typeof SpaceCreateTaskInputSchema>;
type TargetField = 'spaceId' | 'dependsOn' | 'draft' | 'preferredWorkflowId' | 'workspacePath';

export function resolveCreateTaskTarget(
  input: Pick<SpaceCreateTaskInput, TargetField>,
  caller: OperationCaller,
  sessionSpaceId: string | undefined
): { value: { spaceId: string | undefined } } | { reason: string } {
  const spaceId = caller.source === 'mcp' ? (input.spaceId ?? sessionSpaceId) : input.spaceId;
  if (caller.source === 'mcp' && spaceId !== undefined && spaceId !== sessionSpaceId) {
    return { reason: 'Task creation requires a session in the owning Space' };
  }
  const spaceOnly = [input.dependsOn, input.draft, input.preferredWorkflowId, input.workspacePath];
  if (spaceId === undefined && spaceOnly.some((field) => field !== undefined)) {
    return {
      reason: 'dependsOn, draft, preferredWorkflowId and workspacePath require a Space task',
    };
  }
  return { value: { spaceId } };
}

export function resolveCreatedBy(session: Session | null): string | null {
  if (!session) return null;
  return session.type === 'space_chat'
    ? 'space-agent'
    : (session.metadata.promptProvenance?.agentName ?? null);
}
