import type { SpaceWorkflowSummary } from '@hyperneo/shared';
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
import { WorkflowSummarySchema } from './workflow-record-schemas.ts';

export interface WorkflowReadDependencies {
  listWorkflowSummaries: (spaceId: string) => SpaceWorkflowSummary[];
}

const ScopeRejectionSchema = z.enum(['space_not_resolved', 'caller_not_admitted']);
const WorkflowListSchema = z.object({ workflows: z.array(WorkflowSummarySchema) });

const listInputSchema = z.object({ spaceId: z.string().min(1).optional() }).strict();
const suggestInputSchema = z
  .object({ description: z.string(), spaceId: z.string().min(1).optional() })
  .strict();

type ScopedInput = { spaceId?: string };
type WorkflowList = z.infer<typeof WorkflowListSchema>;
type ListResult = WorkflowList | WorkflowScopeRejection;

function admitReader(
  input: ScopedInput,
  caller: OperationCaller
): { value: string } | { reason: WorkflowScopeRejection } {
  return admitWorkflowScope(caller, input.spaceId, WORKFLOW_READ_ROLES);
}

function listSummaries(spaceId: string, deps: WorkflowReadDependencies): WorkflowList {
  return { workflows: deps.listWorkflowSummaries(spaceId) };
}

function listEnabledSummaries(spaceId: string, deps: WorkflowReadDependencies): WorkflowList {
  return { workflows: deps.listWorkflowSummaries(spaceId).filter((entry) => !entry.disabled) };
}

const LIST_DESCRIPTION =
  'List every workflow in the Space, enabled or not. Returns one summary per workflow with id, handle, name, description, tags, node count, and completion autonomy level. MCP callers are scoped to the Space their session belongs to; RPC callers pass spaceId. Rejects space_not_resolved when no Space is in scope and caller_not_admitted when the calling session may not read this Space.';

const SUGGEST_DESCRIPTION =
  'List the enabled workflows in the Space so you can pick one for a described piece of work. description is context for your own reasoning only — every enabled workflow is returned, and nothing is ranked or filtered by it. Returns the same summaries as workflow.list minus disabled workflows. Rejects space_not_resolved when no Space is in scope and caller_not_admitted when the calling session may not read this Space.';

export function createWorkflowReadOperations(
  deps: WorkflowReadDependencies
): OperationDefinition[] {
  const list = (superpipe({ deps })('list-space-workflows') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitReader, ['input', 'caller'], 'result:outcome')
    .pipe(listSummaries, ['outcome', 'deps'], 'outcome')
    .end('outcome') as (input: ScopedInput, caller: OperationCaller) => ListResult;

  const suggest = (superpipe({ deps })('suggest-space-workflow') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitReader, ['input', 'caller'], 'result:outcome')
    .pipe(listEnabledSummaries, ['outcome', 'deps'], 'outcome')
    .end('outcome') as (input: ScopedInput, caller: OperationCaller) => ListResult;

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
      name: 'workflow.suggest',
      description: SUGGEST_DESCRIPTION,
      policy: { safetyClass: 'read', roles: WORKFLOW_READ_ROLES },
      inputSchema: suggestInputSchema,
      resultSchema: z.union([WorkflowListSchema, ScopeRejectionSchema]),
      execute: async (input, caller) => suggest(input, caller),
    }),
  ];
}
