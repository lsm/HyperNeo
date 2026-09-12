import type { z } from 'zod';
import type { CreateStandaloneTaskSchema } from '../tools/space-agent-tool-schemas.ts';
import type { SpaceAgentToolsConfig } from '../tools/space-agent-tools.ts';
import { routeCreateTaskWorkflowRef } from '../tools/task-transition-routing.ts';

export type CreateStandaloneTaskParams = z.infer<typeof CreateStandaloneTaskSchema>;

export async function mapCreateTaskParams(
  params: CreateStandaloneTaskParams,
  deps: Pick<SpaceAgentToolsConfig, 'spaceId' | 'spaceManager' | 'workflowManager'>
): Promise<Record<string, unknown> | { reject: string }> {
  let workspacePath: string | undefined;
  if (params.workspace !== undefined) {
    if (!deps.spaceManager) {
      return { reject: 'Workspace selection is not available for this space' };
    }
    try {
      workspacePath = await deps.spaceManager.resolveWorkspaceSelection(
        deps.spaceId,
        params.workspace
      );
    } catch (err) {
      return { reject: err instanceof Error ? err.message : String(err) };
    }
  } else if (deps.spaceManager) {
    const error = await deps.spaceManager.validateDefaultTaskWorkspace(deps.spaceId);
    if (error) return { reject: error };
  }
  const workflowIdArg = params.workflow_id ?? null;
  const idWorkflow = workflowIdArg ? deps.workflowManager.getWorkflow(workflowIdArg) : null;
  const workflowIdUsable =
    idWorkflow !== null && idWorkflow.spaceId === deps.spaceId && !idWorkflow.disabled;
  const hasHandleArg = typeof params.workflow_handle === 'string';
  const trimmedHandle = params.workflow_handle?.trim() ?? '';
  const handleWorkflow =
    hasHandleArg && trimmedHandle !== '' && !workflowIdUsable
      ? deps.workflowManager.getWorkflowByHandle(deps.spaceId, trimmedHandle)
      : null;
  const ref = routeCreateTaskWorkflowRef({
    workflowIdArg,
    workflowIdUsable,
    hasHandleArg,
    trimmedHandle,
    handleWorkflowId: handleWorkflow?.id ?? null,
    handleWorkflowDisabled: handleWorkflow?.disabled ?? false,
  });
  if (ref.action === 'reject') return { reject: ref.message };
  return Object.fromEntries(
    Object.entries({
      title: params.title,
      description: params.description,
      priority: params.priority,
      dependsOn: params.depends_on,
      draft: params.draft,
      preferredWorkflowId: ref.preferredWorkflowId ?? undefined,
      workspacePath,
    }).filter(([, value]) => value !== undefined)
  );
}
