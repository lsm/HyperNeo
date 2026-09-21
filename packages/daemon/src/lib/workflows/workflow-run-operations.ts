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

const updateRunInputSchema = z
  .object({
    runId: z.string().min(1),
    description: z.string(),
    spaceId: z.string().min(1).optional(),
  })
  .strict();

const replaceRunInputSchema = z
  .object({
    runId: z.string().min(1),
    workflowId: z.string().min(1).optional(),
    workflowHandle: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    spaceId: z.string().min(1).optional(),
  })
  .strict()
  .refine((input) => input.workflowId !== undefined || input.workflowHandle !== undefined, {
    message: 'Provide workflowId or workflowHandle',
    path: ['workflowId'],
  });

type GetRunInput = z.infer<typeof getRunInputSchema>;
type UpdateRunInput = z.infer<typeof updateRunInputSchema>;
type ReplaceRunInput = z.infer<typeof replaceRunInputSchema>;
type RunWriteInput = { runId: string; spaceId?: string };

const RunDetailSchema = z.object({
  run: WorkflowRunSchema,
  executions: z.array(NodeExecutionSchema),
});
type RunDetail = z.infer<typeof RunDetailSchema>;
type GetRunResult = RunDetail | WorkflowScopeRejection | 'run_not_found';

const RunWriteRejectionSchema = z.enum(['run_not_found', 'run_finished']);

const UpdateRunResultSchema = z.union([
  z.object({ run: WorkflowRunSchema }),
  ScopeRejectionSchema,
  RunWriteRejectionSchema,
]);
type UpdateRunResult = z.infer<typeof UpdateRunResultSchema>;

const ReplaceRunResultSchema = z.union([
  z.object({
    outcome: z.literal('switched'),
    previousRunId: z.string(),
    run: WorkflowRunSchema,
    tasks: z.array(TaskWithSpaceFieldsSchema),
  }),
  z.object({ outcome: z.literal('switch_failed'), previousRunId: z.string(), error: z.string() }),
  ScopeRejectionSchema,
  RunWriteRejectionSchema,
  z.enum(['workflow_not_found', 'workflow_disabled']),
]);
type ReplaceRunResult = z.infer<typeof ReplaceRunResultSchema>;

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

function admitRunWriter(
  input: RunWriteInput,
  caller: OperationCaller,
  deps: WorkflowRunDependencies
): { value: string } | { reason: WorkflowScopeRejection } {
  const scope = admitWorkflowScope(caller, input.spaceId);
  return 'reason' in scope ? scope : admitActiveWorkflowSession(scope.value, caller, deps);
}

function loadChangeableRun(
  input: RunWriteInput,
  spaceId: string,
  deps: WorkflowRunDependencies
): { value: SpaceWorkflowRun } | { reason: 'run_not_found' | 'run_finished' } {
  const run = deps.getRun(input.runId);
  if (!run || run.spaceId !== spaceId) return { reason: 'run_not_found' };
  if (run.status === 'done' || run.status === 'cancelled') return { reason: 'run_finished' };
  return { value: run };
}

function resolveReplacementWorkflow(
  input: ReplaceRunInput,
  run: SpaceWorkflowRun,
  deps: WorkflowRunDependencies
): { value: SpaceWorkflow } | { reason: 'workflow_not_found' | 'workflow_disabled' } {
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
  return { value: target };
}

function applyRunDescription(
  input: UpdateRunInput,
  run: SpaceWorkflowRun,
  deps: WorkflowRunDependencies
): UpdateRunResult {
  const updated = deps.updateRunDescription(run.id, input.description);
  return updated ? { run: updated } : 'run_not_found';
}

async function applyRunReplacement(
  input: ReplaceRunInput,
  run: SpaceWorkflowRun,
  target: SpaceWorkflow,
  deps: WorkflowRunDependencies
): Promise<ReplaceRunResult> {
  await deps.cancelWorkflowRun(run.spaceId, run.id);
  try {
    const started = await deps.startWorkflowRun(
      run.spaceId,
      target.id,
      run.title,
      input.description ?? run.description
    );
    return { outcome: 'switched', previousRunId: run.id, ...started };
  } catch (err) {
    return {
      outcome: 'switch_failed',
      previousRunId: run.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const GET_RUN_DESCRIPTION =
  'Read one workflow run in the Space, including every node execution recorded against it, so you can see which step the run is on. Rejects run_not_found when the run is absent or owned by another Space, space_not_resolved when no Space is in scope, and caller_not_admitted when the calling session may not read this Space.';

const UPDATE_RUN_DESCRIPTION =
  'Reword the description of an unfinished workflow run in place, leaving the run and its in-flight work untouched. Returns the updated run. Rejects run_not_found when the run is absent or owned by another Space, run_finished for a run already done or cancelled, space_not_resolved when no Space is in scope, and caller_not_admitted when the calling session is not an active member of this Space.';

const REPLACE_RUN_DESCRIPTION =
  'Cancel an unfinished workflow run and start a fresh one on another workflow with the same title, naming the target by workflowId or workflowHandle and optionally replacing the description. This is destructive: the current run is cancelled before the replacement starts, so its in-flight work is lost. Returns outcome "switched" with the new run, its seeded tasks and the cancelled previousRunId, or "switch_failed" with previousRunId when the replacement could not start — the original run stays cancelled either way. Rejects run_not_found, run_finished for a run already done or cancelled, workflow_not_found and workflow_disabled for an unusable target, space_not_resolved when no Space is in scope, and caller_not_admitted when the calling session is not an active member of this Space.';

export function createWorkflowRunOperations(deps: WorkflowRunDependencies): OperationDefinition[] {
  const getRun = (superpipe({ deps })('get-space-workflow-run') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitRunReader, ['input', 'caller'], 'result:outcome')
    .pipe(loadRunDetail, ['input', 'outcome', 'deps'], 'result:outcome')
    .end('outcome') as (input: GetRunInput, caller: OperationCaller) => GetRunResult;

  const updateRun = (superpipe({ deps })('update-space-workflow-run') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitRunWriter, ['input', 'caller', 'deps'], 'result:outcome')
    .pipe(loadChangeableRun, ['input', 'outcome', 'deps'], 'result:outcome')
    .pipe(applyRunDescription, ['input', 'outcome', 'deps'], 'outcome')
    .end('outcome') as (input: UpdateRunInput, caller: OperationCaller) => UpdateRunResult;

  const replaceRun = (superpipe({ deps })('replace-space-workflow-run') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitRunWriter, ['input', 'caller', 'deps'], 'result:outcome')
    .pipe(loadChangeableRun, ['input', 'outcome', 'deps'], 'result:outcome')
    .pipe((run: SpaceWorkflowRun) => run, 'outcome', 'run')
    .pipe(resolveReplacementWorkflow, ['input', 'run', 'deps'], 'result:outcome')
    .pipe((target: SpaceWorkflow) => target, 'outcome', 'target')
    .pipe(applyRunReplacement, ['input', 'run', 'target', 'deps'], 'outcome')
    .endAsync('outcome') as (
    input: ReplaceRunInput,
    caller: OperationCaller
  ) => Promise<ReplaceRunResult>;

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
      name: 'workflow.run.update',
      description: UPDATE_RUN_DESCRIPTION,
      policy: { safetyClass: 'mutate', roles: WORKFLOW_MUTATE_ROLES },
      inputSchema: updateRunInputSchema,
      resultSchema: UpdateRunResultSchema,
      execute: async (input, caller) => updateRun(input, caller),
    }),
    defineOperation({
      name: 'workflow.run.replace',
      description: REPLACE_RUN_DESCRIPTION,
      policy: { safetyClass: 'destructive', roles: WORKFLOW_MUTATE_ROLES },
      inputSchema: replaceRunInputSchema,
      resultSchema: ReplaceRunResultSchema,
      execute: async (input, caller) => replaceRun(input, caller),
    }),
  ];
}
