import type { NodeExecution, SpaceTask, SpaceWorkflow, SpaceWorkflowRun } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import {
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
} from '../operations/registry.ts';
import { TaskWithSpaceFieldsSchema } from '../tasks/get-operation.ts';
import {
  admitActiveWorkflowSession,
  admitWorkflowScope,
  WORKFLOW_MUTATE_ROLES,
  WORKFLOW_READ_ROLES,
  type WorkflowScopeRejection,
  type WorkflowSessionAdmission,
} from './workflow-operation-admission.ts';
import { NodeExecutionSchema, WorkflowRunSchema } from './workflow-record-schemas.ts';

export interface WorkflowRunDependencies extends WorkflowSessionAdmission {
  getRun: (runId: string) => SpaceWorkflowRun | null;
  updateRunDescription: (runId: string, description: string) => SpaceWorkflowRun | null;
  listRunExecutions: (runId: string) => NodeExecution[];
  getWorkflow: (workflowId: string) => SpaceWorkflow | null;
  getWorkflowByHandle: (spaceId: string, handle: string) => SpaceWorkflow | null;
  cancelWorkflowRun: (spaceId: string, runId: string) => Promise<SpaceWorkflowRun>;
  startWorkflowRun: (
    spaceId: string,
    workflowId: string,
    title: string,
    description?: string
  ) => Promise<{ run: SpaceWorkflowRun; tasks: SpaceTask[] }>;
}

const ScopeRejectionSchema = z.enum(['space_not_resolved', 'caller_not_admitted']);

const getRunInputSchema = z
  .object({ runId: z.string().min(1), spaceId: z.string().min(1).optional() })
  .strict();

const changePlanInputSchema = z
  .object({
    runId: z.string().min(1),
    description: z.string().optional(),
    workflowId: z.string().min(1).optional(),
    workflowHandle: z.string().trim().min(1).optional(),
    spaceId: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.description !== undefined ||
      input.workflowId !== undefined ||
      input.workflowHandle !== undefined,
    {
      message: 'Provide at least one of description, workflowId or workflowHandle',
      path: ['description'],
    }
  );

type GetRunInput = z.infer<typeof getRunInputSchema>;
type ChangePlanInput = z.infer<typeof changePlanInputSchema>;

const RunDetailSchema = z.object({
  run: WorkflowRunSchema,
  executions: z.array(NodeExecutionSchema),
});
type RunDetail = z.infer<typeof RunDetailSchema>;
type GetRunResult = RunDetail | WorkflowScopeRejection | 'run_not_found';

const ChangePlanResultSchema = z.union([
  z.object({
    outcome: z.literal('switched'),
    previousRunId: z.string(),
    run: WorkflowRunSchema,
    tasks: z.array(TaskWithSpaceFieldsSchema),
  }),
  z.object({ outcome: z.literal('described'), run: WorkflowRunSchema }),
  z.object({ outcome: z.literal('switch_failed'), previousRunId: z.string(), error: z.string() }),
  ScopeRejectionSchema,
  z.enum([
    'run_not_found',
    'run_finished',
    'nothing_to_change',
    'workflow_not_found',
    'workflow_disabled',
  ]),
]);
type ChangePlanResult = z.infer<typeof ChangePlanResultSchema>;
type PlanChangeRejection =
  | WorkflowScopeRejection
  | 'run_not_found'
  | 'run_finished'
  | 'nothing_to_change'
  | 'workflow_not_found'
  | 'workflow_disabled';

type PlanChange =
  | { kind: 'switch'; run: SpaceWorkflowRun; target: SpaceWorkflow; description?: string }
  | { kind: 'describe'; run: SpaceWorkflowRun; description: string };

function admitRunReader(
  input: GetRunInput,
  caller: OperationCaller
): { value: string } | { reason: WorkflowScopeRejection } {
  return admitWorkflowScope(caller, input.spaceId);
}

function loadRunDetail(
  input: GetRunInput,
  spaceId: string,
  deps: WorkflowRunDependencies
): { value: RunDetail } | { reason: 'run_not_found' } {
  const run = deps.getRun(input.runId);
  if (!run || run.spaceId !== spaceId) return { reason: 'run_not_found' };
  return { value: { run, executions: deps.listRunExecutions(run.id) } };
}

export function admitPlanChanger(
  input: ChangePlanInput,
  caller: OperationCaller,
  deps: WorkflowRunDependencies
): { value: string } | { reason: WorkflowScopeRejection } {
  const scope = admitWorkflowScope(caller, input.spaceId);
  return 'reason' in scope ? scope : admitActiveWorkflowSession(scope.value, caller, deps);
}

function loadChangeableRun(
  input: ChangePlanInput,
  spaceId: string,
  deps: WorkflowRunDependencies
): { value: SpaceWorkflowRun } | { reason: 'run_not_found' | 'run_finished' } {
  const run = deps.getRun(input.runId);
  if (!run || run.spaceId !== spaceId) return { reason: 'run_not_found' };
  if (run.status === 'done' || run.status === 'cancelled') return { reason: 'run_finished' };
  return { value: run };
}

export function planPlanChange(
  input: ChangePlanInput,
  run: SpaceWorkflowRun,
  deps: WorkflowRunDependencies
): { value: PlanChange } | { reason: PlanChangeRejection } {
  if (input.workflowId === undefined && input.workflowHandle === undefined) {
    return input.description === undefined
      ? { reason: 'nothing_to_change' }
      : { value: { kind: 'describe', run, description: input.description } };
  }
  const byId = input.workflowId ? deps.getWorkflow(input.workflowId) : null;
  const inSpace = byId && byId.spaceId === run.spaceId ? byId : null;
  const usableById = inSpace && !inSpace.disabled ? inSpace : null;
  const byHandle =
    !usableById && input.workflowHandle
      ? deps.getWorkflowByHandle(run.spaceId, input.workflowHandle)
      : null;
  const target = usableById ?? byHandle ?? inSpace;
  if (!target) return { reason: 'workflow_not_found' };
  if (target.disabled) return { reason: 'workflow_disabled' };
  return { value: { kind: 'switch', run, target, description: input.description } };
}

async function applyPlanChange(
  plan: PlanChange,
  deps: WorkflowRunDependencies
): Promise<ChangePlanResult> {
  if (plan.kind === 'describe') {
    const updated = deps.updateRunDescription(plan.run.id, plan.description);
    return updated ? { outcome: 'described', run: updated } : 'run_not_found';
  }
  await deps.cancelWorkflowRun(plan.run.spaceId, plan.run.id);
  try {
    const started = await deps.startWorkflowRun(
      plan.run.spaceId,
      plan.target.id,
      plan.run.title,
      plan.description ?? plan.run.description
    );
    return { outcome: 'switched', previousRunId: plan.run.id, ...started };
  } catch (err) {
    return {
      outcome: 'switch_failed',
      previousRunId: plan.run.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const GET_RUN_DESCRIPTION =
  'Read one workflow run in the Space, including every node execution recorded against it, so you can see which step the run is on. Rejects run_not_found when the run is absent or owned by another Space, space_not_resolved when no Space is in scope, and caller_not_admitted when the calling session may not read this Space.';

const CHANGE_PLAN_DESCRIPTION =
  'Change the plan of an unfinished workflow run: pass description alone to reword it in place, or pass workflowId or workflowHandle to cancel the run and start a fresh one on that workflow with the same title. Switching is destructive — the current run is cancelled before the replacement starts, so its in-flight work is lost. Returns outcome "described" with the reworded run, "switched" with the new run plus its seeded tasks and the cancelled previousRunId, or "switch_failed" with previousRunId when the replacement could not start (the original run stays cancelled). Rejects run_not_found, run_finished for a run already done or cancelled, nothing_to_change when no reword and no target were supplied, workflow_not_found and workflow_disabled for an unusable target, space_not_resolved when no Space is in scope, and caller_not_admitted when the calling session is not an active member of this Space.';

export function createWorkflowRunOperations(deps: WorkflowRunDependencies): OperationDefinition[] {
  const getRun = (superpipe({ deps })('get-space-workflow-run') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitRunReader, ['input', 'caller'], 'result:outcome')
    .pipe(loadRunDetail, ['input', 'outcome', 'deps'], 'result:outcome')
    .end('outcome') as (input: GetRunInput, caller: OperationCaller) => GetRunResult;

  const changePlan = (superpipe({ deps })('change-space-workflow-plan') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitPlanChanger, ['input', 'caller', 'deps'], 'result:outcome')
    .pipe(loadChangeableRun, ['input', 'outcome', 'deps'], 'result:outcome')
    .pipe(planPlanChange, ['input', 'outcome', 'deps'], 'result:outcome')
    .pipe(applyPlanChange, ['outcome', 'deps'], 'outcome')
    .endAsync('outcome') as (
    input: ChangePlanInput,
    caller: OperationCaller
  ) => Promise<ChangePlanResult>;

  return [
    defineOperation({
      name: 'workflow.run.get',
      description: GET_RUN_DESCRIPTION,
      policy: { safetyClass: 'read', roles: WORKFLOW_READ_ROLES },
      inputSchema: getRunInputSchema,
      resultSchema: z.union([RunDetailSchema, ScopeRejectionSchema, z.literal('run_not_found')]),
      execute: async (input, caller) => getRun(input, caller),
    }),
    defineOperation({
      name: 'workflow.changePlan',
      description: CHANGE_PLAN_DESCRIPTION,
      policy: { safetyClass: 'destructive', roles: WORKFLOW_MUTATE_ROLES },
      inputSchema: changePlanInputSchema,
      resultSchema: ChangePlanResultSchema,
      execute: async (input, caller) => changePlan(input, caller),
    }),
  ];
}
