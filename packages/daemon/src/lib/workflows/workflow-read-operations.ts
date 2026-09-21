import type { SpaceWorkflow, SpaceWorkflowSummary } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import {
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
} from '../operations/registry.ts';
import {
  admitWorkflowScope,
  WORKFLOW_READ_ROLES,
  type WorkflowScopeRejection,
} from './workflow-operation-admission.ts';
import { WorkflowDetailSchema, WorkflowSummarySchema } from './workflow-record-schemas.ts';

export interface WorkflowReadDependencies {
  listWorkflowSummaries: (spaceId: string) => SpaceWorkflowSummary[];
  getWorkflow: (workflowId: string) => SpaceWorkflow | null;
  getWorkflowByHandle: (spaceId: string, handle: string) => SpaceWorkflow | null;
}

const ScopeRejectionSchema = z.enum(['space_not_resolved', 'caller_not_admitted']);
const WorkflowListSchema = z.object({
  workflows: z.array(WorkflowSummarySchema),
  scope: z.object({ spaceId: z.string() }),
});

const listInputSchema = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe('Keep only enabled workflows; omit to list every workflow in the Space'),
    spaceId: z.string().min(1).optional(),
  })
  .strict();
const getInputSchema = z
  .object({
    workflowId: z.string().min(1).optional(),
    workflowHandle: z.string().trim().min(1).optional(),
    spaceId: z.string().min(1).optional(),
  })
  .strict()
  .refine((input) => input.workflowId !== undefined || input.workflowHandle !== undefined, {
    message: 'Provide either workflowId or workflowHandle',
    path: ['workflowId'],
  });

type ScopedInput = { spaceId?: string };
type ListInput = z.infer<typeof listInputSchema>;
type GetInput = z.infer<typeof getInputSchema>;
type WorkflowList = z.infer<typeof WorkflowListSchema>;
type ListResult = WorkflowList | WorkflowScopeRejection;

function admitReader(
  input: ScopedInput,
  caller: OperationCaller
): { value: string } | { reason: WorkflowScopeRejection } {
  return admitWorkflowScope(caller, input.spaceId);
}

function listSummaries(
  spaceId: string,
  input: ListInput,
  deps: WorkflowReadDependencies
): WorkflowList {
  const summaries = deps.listWorkflowSummaries(spaceId);
  return {
    workflows: input.enabled === true ? summaries.filter((entry) => !entry.disabled) : summaries,
    scope: { spaceId },
  };
}

export function resolveWorkflowRef(
  input: GetInput,
  spaceId: string,
  deps: WorkflowReadDependencies
): { value: SpaceWorkflow } | { reason: 'workflow_not_found' } {
  const byId = input.workflowId ? deps.getWorkflow(input.workflowId) : null;
  const inSpace = byId && byId.spaceId === spaceId ? byId : null;
  const usableById = inSpace && !inSpace.disabled ? inSpace : null;
  const byHandle =
    !usableById && input.workflowHandle
      ? deps.getWorkflowByHandle(spaceId, input.workflowHandle)
      : null;
  const resolved = usableById ?? byHandle ?? inSpace;
  return resolved ? { value: resolved } : { reason: 'workflow_not_found' };
}

const LIST_DESCRIPTION =
  'List the workflows in the Space, every one by default or only the enabled ones with enabled: true. Returns one summary per workflow with id, handle, name, description, tags, node count, and completion autonomy level. Omitted spaceId defaults to the trusted caller Space. scope reports the Space that answered. MCP callers cannot select another Space. Rejects space_not_resolved when no Space is in scope and caller_not_admitted when the calling session may not read this Space.';

const GET_DESCRIPTION =
  'Read one workflow definition in the Space by workflowId or workflowHandle, including its nodes, agent slots, transitions, channels, and hooks. When both are given, workflowId wins unless it names a workflow that is disabled or owned by another Space, in which case workflowHandle is tried. Rejects workflow_not_found when neither reference resolves inside the Space, space_not_resolved when no Space is in scope, and caller_not_admitted when the calling session may not read this Space.';

export function createWorkflowReadOperations(
  deps: WorkflowReadDependencies
): OperationDefinition[] {
  const list = (superpipe({ deps })('list-space-workflows') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitReader, ['input', 'caller'], 'result:outcome')
    .pipe(listSummaries, ['outcome', 'input', 'deps'], 'outcome')
    .end('outcome') as (input: ListInput, caller: OperationCaller) => ListResult;

  const get = (superpipe({ deps })('get-space-workflow') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitReader, ['input', 'caller'], 'result:outcome')
    .pipe(resolveWorkflowRef, ['input', 'outcome', 'deps'], 'result:outcome')
    .end('outcome') as (
    input: GetInput,
    caller: OperationCaller
  ) => SpaceWorkflow | WorkflowScopeRejection | 'workflow_not_found';

  return [
    defineOperation({
      name: 'workflow.list',
      description: LIST_DESCRIPTION,
      policy: { safetyClass: 'read', roles: WORKFLOW_READ_ROLES },
      inputSchema: listInputSchema.default({}),
      resultSchema: z.union([WorkflowListSchema, ScopeRejectionSchema]),
      execute: async (input, caller) => list(input, caller),
    }),
    defineOperation({
      name: 'workflow.get',
      description: GET_DESCRIPTION,
      policy: { safetyClass: 'read', roles: WORKFLOW_READ_ROLES },
      inputSchema: getInputSchema,
      resultSchema: z.union([
        WorkflowDetailSchema,
        ScopeRejectionSchema,
        z.literal('workflow_not_found'),
      ]),
      execute: async (input, caller) => get(input, caller),
    }),
  ];
}
