import type { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { CreateStandaloneTaskSchema } from '../tools/space-agent-tool-schemas.ts';
import type { SpaceAgentToolsConfig } from '../tools/space-agent-tools.ts';
import { routeCreateTaskWorkflowRef } from '../tools/task-transition-routing.ts';

export type CreateStandaloneTaskParams = z.infer<typeof CreateStandaloneTaskSchema>;
type In = CreateStandaloneTaskParams;
type Deps = Pick<SpaceAgentToolsConfig, 'spaceId' | 'spaceManager' | 'workflowManager'>;
type Draft = { workspacePath?: string; preferredWorkflowId?: string; reject?: never };
type Gate = { value: Draft } | { reason: { reject: string } };
type Input = Record<string, unknown>;
type Output = (Input & { reject?: never }) | { reject: string };

export async function resolveWorkspacePath(params: In, deps: Deps): Promise<Gate> {
  if (params.workspace === undefined) return { value: {} };
  if (!deps.spaceManager) {
    return { reason: { reject: 'Workspace selection is not available for this space' } };
  }
  try {
    const workspacePath = await deps.spaceManager.resolveWorkspaceSelection(
      deps.spaceId,
      params.workspace
    );
    return { value: { workspacePath } };
  } catch (err) {
    return { reason: { reject: err instanceof Error ? err.message : String(err) } };
  }
}
export function routeWorkflowReference(params: In, deps: Deps, draft: Draft): Gate {
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
  return ref.action === 'reject'
    ? { reason: { reject: ref.message } }
    : { value: { ...draft, preferredWorkflowId: ref.preferredWorkflowId ?? undefined } };
}
export function buildCreateTaskInput(params: In, deps: Deps, draft: Draft): Input {
  return Object.fromEntries(
    Object.entries({
      spaceId: deps.spaceId,
      title: params.title,
      description: params.description,
      priority: params.priority,
      dependsOn: params.depends_on,
      draft: params.draft,
      preferredWorkflowId: draft.preferredWorkflowId,
      workspacePath: draft.workspacePath,
    }).filter(([, value]) => value !== undefined)
  );
}
export const mapCreateTaskParams = (superpipe({})('create-task-action-params') as PipelineAPI)
  .input(['params', 'deps'])
  .pipe(resolveWorkspacePath, ['params', 'deps'], 'result:draft')
  .pipe(routeWorkflowReference, ['params', 'deps', 'draft'], 'result:draft')
  .pipe(buildCreateTaskInput, ['params', 'deps', 'draft'], 'draft')
  .endAsync('draft') as (params: In, deps: Deps) => Promise<Output>;
