import type {
  CreateEvolutionScopeParams,
  EvidenceRef,
  EvolutionPolicy,
  EvolutionScope,
  MetricSnapshot,
  UpdateEvolutionScopeParams,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { SpaceGoalRepository } from '../../storage/repositories/space-goal-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository.ts';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import { syncGoalAutomationSelfNagScheduleForScope } from '../goals/automation-schedule-sync.ts';
import { validateGoalAutomationSelfNagPolicy } from './evolution-policy-validation.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationPolicy,
} from '../operations/registry.ts';
import type { ScheduleService } from '../schedule/schedule-service.ts';
import {
  admitForgeMutator,
  admitForgeReader,
  denyForge,
  FORGE_CALLER_REJECTIONS,
  forgeDenialSchema,
  type ForgeAdmissionDependencies,
  type ForgeAuditWriter,
  type ForgeGate,
  requireForgeSpace,
} from './forge-admission.ts';
import {
  ForgeEvidenceRefSchema,
  ForgeMetadataSchema,
  ForgeMetricDefinitionSchema,
  ForgeMetricSnapshotSchema,
  ForgeMetricValuesSchema,
  ForgePolicySchema,
  ForgeScopeKindSchema,
  ForgeScopeSchema,
} from './forge-result-schemas.ts';
import { mergeEvolutionPolicy } from './scope-policy.ts';
import type { EvolutionScopeService } from './scope-service.ts';
import type { ScopeTimeline } from './scope-service-types.ts';

export interface ForgeScopeOperationDependencies extends ForgeAdmissionDependencies {
  readonly scopeService: Pick<
    EvolutionScopeService,
    | 'addManualNoteEvidence'
    | 'addMetricSnapshotEvidence'
    | 'attachTaskEvidence'
    | 'attachWorkflowRunEvidence'
    | 'createScope'
    | 'createScopeFromGoal'
    | 'getScope'
    | 'listEvidence'
    | 'listMetricSnapshots'
    | 'listScopes'
    | 'listTimeline'
    | 'resolveScopeForGoal'
    | 'resolveScopeForTask'
    | 'updateScope'
  >;
  readonly getGoal: (
    goalId: string
  ) => { id: string; spaceId: string; title: string; description: string } | null;
  readonly taskRepo: Pick<SpaceTaskRepository, 'getTask'>;
  readonly workflowRunRepo: Pick<SpaceWorkflowRunRepository, 'getRun'>;
  readonly db?: BunDatabase;
  readonly goalRepo?: SpaceGoalRepository;
  readonly scheduleService?: ScheduleService;
  readonly audit?: ForgeAuditWriter;
}

const SCOPE_ID_REJECTIONS = [...FORGE_CALLER_REJECTIONS, 'scope_not_found'] as const;
const SCOPE_CREATE_REJECTIONS = [
  ...SCOPE_ID_REJECTIONS,
  'goal_not_found',
  'invalid_policy',
] as const;
const SCOPE_RESOLVE_REJECTIONS = [
  ...SCOPE_ID_REJECTIONS,
  'goal_not_found',
  'task_not_found',
  'resolve_target_required',
] as const;
const EVIDENCE_ATTACH_REJECTIONS = [
  ...SCOPE_ID_REJECTIONS,
  'task_not_found',
  'workflow_run_not_found',
  'evidence_not_attached',
] as const;

type ScopeIdRejection = (typeof SCOPE_ID_REJECTIONS)[number];
type ScopeCreateRejection = (typeof SCOPE_CREATE_REJECTIONS)[number];
type ScopeResolveRejection = (typeof SCOPE_RESOLVE_REJECTIONS)[number];
type EvidenceAttachRejection = (typeof EVIDENCE_ATTACH_REJECTIONS)[number];

const FORGE_READ_POLICY = {
  safetyClass: 'read',
  roles: ['ad_hoc_member', 'long_term_agent', 'universal_read'],
} as const satisfies OperationPolicy;

const FORGE_MUTATE_POLICY = {
  safetyClass: 'mutate',
  roles: ['ad_hoc_member', 'long_term_agent'],
} as const satisfies OperationPolicy;

const SpaceScoped = {
  spaceId: z
    .string()
    .min(1)
    .optional()
    .describe('Defaults to the trusted caller Space; rejects space_required when neither is set.'),
};
const ScopeTargeted = { ...SpaceScoped, scopeId: z.string().min(1) };

function accepted<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object({ accepted: z.literal(true), ...shape });
}

function validateForgePolicy(policy: EvolutionPolicy): string | undefined {
  try {
    validateGoalAutomationSelfNagPolicy({ policy });
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function runForgeScopeWrite<T>(forge: ForgeScopeOperationDependencies, write: () => T): T {
  return forge.db ? forge.db.transaction(write)() : write();
}

const ForgeMetricDefinitionInputSchema = ForgeMetricDefinitionSchema.extend({
  key: z.string().min(1),
  label: z.string().min(1),
});

function syncForgeScopeAutomation(
  scope: EvolutionScope,
  forge: ForgeScopeOperationDependencies
): void {
  if (!forge.goalRepo || !forge.scheduleService) return;
  syncGoalAutomationSelfNagScheduleForScope({
    goalRepo: forge.goalRepo,
    scheduleService: forge.scheduleService,
    scope,
    db: forge.db,
  });
}

export function findForgeScopeInSpace(
  scopeId: string,
  spaceId: string | undefined,
  forge: { scopeService: Pick<EvolutionScopeService, 'getScope'> }
): EvolutionScope | null {
  const scope = forge.scopeService.getScope(scopeId);
  return scope && (!spaceId || scope.spaceId === spaceId) ? scope : null;
}

export function requireForgeScope(
  input: { scopeId: string },
  scope: { spaceId?: string },
  forge: ForgeScopeOperationDependencies
): ForgeGate<EvolutionScope, ScopeIdRejection> {
  const found = findForgeScopeInSpace(input.scopeId, scope.spaceId, forge);
  return found
    ? { value: found }
    : denyForge('scope_not_found', `EvolutionScope not found: ${input.scopeId}`);
}

const ScopeCreateInputSchema = z
  .object({
    ...SpaceScoped,
    kind: ForgeScopeKindSchema,
    name: z
      .string()
      .min(1)
      .optional()
      .describe('Defaults to the linked goal title; required when no goalId is given.'),
    objective: z
      .string()
      .min(1)
      .optional()
      .describe('Defaults to the linked goal description; required when no goalId is given.'),
    goalId: z.string().min(1).nullable().optional(),
    parentScopeId: z.string().min(1).nullable().optional(),
    metricDefinitions: z.array(ForgeMetricDefinitionInputSchema).optional(),
    policy: ForgePolicySchema.optional(),
  })
  .strict()
  .refine(
    (input) => Boolean(input.goalId) || (Boolean(input.name) && Boolean(input.objective)),
    'Provide name and objective, or a goalId to take them from'
  );

export function planForgeScopeCreate(
  input: z.infer<typeof ScopeCreateInputSchema>,
  spaceId: string,
  forge: ForgeScopeOperationDependencies
): ForgeGate<CreateEvolutionScopeParams, ScopeCreateRejection> {
  const goal = input.goalId ? forge.getGoal(input.goalId) : null;
  if (input.goalId && (!goal || goal.spaceId !== spaceId)) {
    return denyForge('goal_not_found', `Goal not found: ${input.goalId}`);
  }
  if (input.parentScopeId && !findForgeScopeInSpace(input.parentScopeId, spaceId, forge)) {
    return denyForge('scope_not_found', `EvolutionScope not found: ${input.parentScopeId}`);
  }
  const invalid = input.policy ? validateForgePolicy(input.policy) : undefined;
  if (invalid) return denyForge('invalid_policy', invalid);
  const name = input.name ?? goal?.title ?? '';
  return {
    value: {
      spaceId,
      spaceGoalId: input.goalId ?? null,
      kind: input.kind,
      name,
      objective: input.objective ?? goal?.description ?? name,
      parentScopeId: input.parentScopeId ?? null,
      metricDefinitions: input.metricDefinitions,
      policy: input.policy,
    },
  };
}

export function applyForgeScopeCreate(
  params: CreateEvolutionScopeParams,
  caller: OperationCaller,
  forge: ForgeScopeOperationDependencies
): { accepted: true; scope: EvolutionScope } {
  const scope = runForgeScopeWrite(forge, () => {
    const created = forge.scopeService.createScope(params);
    syncForgeScopeAutomation(created, forge);
    return created;
  });
  forge.audit?.({
    toolName: 'forge.scope.create',
    paramsSummary: { name: params.name, kind: params.kind, goalId: params.spaceGoalId },
    caller,
    spaceId: params.spaceId,
  });
  return { accepted: true, scope };
}

const ScopeCreateFromGoalInputSchema = z
  .object({
    ...SpaceScoped,
    goalId: z.string().min(1),
    name: z.string().min(1).optional(),
    objective: z.string().min(1).optional(),
    metricDefinitions: z.array(ForgeMetricDefinitionInputSchema).optional(),
    policy: ForgePolicySchema.optional(),
  })
  .strict();

export function planForgeScopeCreateFromGoal(
  input: z.infer<typeof ScopeCreateFromGoalInputSchema>,
  scope: { spaceId?: string },
  forge: ForgeScopeOperationDependencies
): ForgeGate<z.infer<typeof ScopeCreateFromGoalInputSchema>, ScopeCreateRejection> {
  const goal = forge.getGoal(input.goalId);
  if (!goal || (scope.spaceId && goal.spaceId !== scope.spaceId)) {
    return denyForge('goal_not_found', `Goal not found: ${input.goalId}`);
  }
  const invalid = input.policy ? validateForgePolicy(input.policy) : undefined;
  return invalid ? denyForge('invalid_policy', invalid) : { value: input };
}

export function applyForgeScopeCreateFromGoal(
  input: z.infer<typeof ScopeCreateFromGoalInputSchema>,
  caller: OperationCaller,
  forge: ForgeScopeOperationDependencies
): { accepted: true; scope: EvolutionScope } {
  const scope = runForgeScopeWrite(forge, () => {
    const created = forge.scopeService.createScopeFromGoal({
      spaceGoalId: input.goalId,
      name: input.name,
      objective: input.objective,
      metricDefinitions: input.metricDefinitions,
      policy: input.policy,
    });
    syncForgeScopeAutomation(created, forge);
    return created;
  });
  forge.audit?.({
    toolName: 'forge.scope.createFromGoal',
    paramsSummary: { goalId: input.goalId, name: input.name },
    caller,
    spaceId: scope.spaceId,
  });
  return { accepted: true, scope };
}

const ScopeListInputSchema = z
  .object({
    ...SpaceScoped,
    goalId: z.string().min(1).nullable().optional(),
    kind: ForgeScopeKindSchema.optional(),
  })
  .strict();

export function readForgeScopeList(
  input: z.infer<typeof ScopeListInputSchema>,
  spaceId: string,
  forge: ForgeScopeOperationDependencies
): ForgeGate<
  { accepted: true; scopes: EvolutionScope[]; scope: { spaceId: string } },
  ScopeCreateRejection
> {
  if (input.goalId) {
    const goal = forge.getGoal(input.goalId);
    if (!goal || goal.spaceId !== spaceId) {
      return denyForge('goal_not_found', `Goal not found: ${input.goalId}`);
    }
  }
  return {
    value: {
      accepted: true,
      scope: { spaceId },
      scopes: forge.scopeService.listScopes({
        spaceId,
        spaceGoalId: input.goalId,
        kind: input.kind,
      }),
    },
  };
}

const ScopeUpdateInputSchema = z
  .object({
    ...ScopeTargeted,
    goalId: z.string().min(1).nullable().optional(),
    kind: ForgeScopeKindSchema.optional(),
    name: z.string().min(1).optional(),
    objective: z.string().min(1).optional(),
    parentScopeId: z.string().min(1).nullable().optional(),
    metricDefinitions: z.array(ForgeMetricDefinitionInputSchema).optional(),
    policy: ForgePolicySchema.optional(),
    policyPatch: ForgePolicySchema.optional(),
    episodeJudgeModel: z.string().nullable().optional(),
    episodeJudgeProvider: z.string().nullable().optional(),
  })
  .strict();

export function planForgeScopeUpdate(
  input: z.infer<typeof ScopeUpdateInputSchema>,
  existing: EvolutionScope,
  forge: ForgeScopeOperationDependencies
): ForgeGate<UpdateEvolutionScopeParams, ScopeCreateRejection> {
  if (input.goalId) {
    const goal = forge.getGoal(input.goalId);
    if (!goal || goal.spaceId !== existing.spaceId) {
      return denyForge('goal_not_found', `Goal not found: ${input.goalId}`);
    }
  }
  if (input.parentScopeId && !findForgeScopeInSpace(input.parentScopeId, existing.spaceId, forge)) {
    return denyForge('scope_not_found', `EvolutionScope not found: ${input.parentScopeId}`);
  }
  const patch: EvolutionPolicy = { ...input.policyPatch };
  if (input.episodeJudgeModel !== undefined)
    patch.episodeJudgeModel = input.episodeJudgeModel ?? undefined;
  if (input.episodeJudgeProvider !== undefined) {
    patch.episodeJudgeProvider = input.episodeJudgeProvider ?? undefined;
  }
  const hasPatch =
    input.policyPatch !== undefined ||
    input.episodeJudgeModel !== undefined ||
    input.episodeJudgeProvider !== undefined;
  const params: UpdateEvolutionScopeParams = {
    spaceGoalId: input.goalId,
    kind: input.kind,
    name: input.name,
    objective: input.objective,
    parentScopeId: input.parentScopeId,
    metricDefinitions: input.metricDefinitions,
  };
  let resulting: EvolutionPolicy | undefined;
  if (hasPatch) {
    resulting = mergeEvolutionPolicy(existing.policy, patch);
    params.policyPatch = patch;
  } else if (input.policy) {
    resulting = input.policy;
    params.policy = resulting;
  }
  const invalid = validateForgePolicy(resulting ?? existing.policy);
  return invalid ? denyForge('invalid_policy', invalid) : { value: params };
}

export function applyForgeScopeUpdate(
  scopeId: string,
  params: UpdateEvolutionScopeParams,
  caller: OperationCaller,
  forge: ForgeScopeOperationDependencies
): ForgeGate<{ accepted: true; scope: EvolutionScope }, ScopeIdRejection> {
  const scope = forge.scopeService.updateScope(scopeId, params);
  forge.audit?.({
    toolName: 'forge.scope.update',
    paramsSummary: { scopeId },
    caller,
    spaceId: scope?.spaceId,
  });
  if (!scope) return denyForge('scope_not_found', `EvolutionScope not found: ${scopeId}`);
  syncForgeScopeAutomation(scope, forge);
  return { value: { accepted: true, scope } };
}

const ScopeResolveInputSchema = z
  .object({
    ...SpaceScoped,
    goalId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
  })
  .strict();

export function resolveForgeScopeTarget(
  input: z.infer<typeof ScopeResolveInputSchema>,
  scope: { spaceId?: string },
  caller: OperationCaller,
  forge: ForgeScopeOperationDependencies
): ForgeGate<{ accepted: true; scope: EvolutionScope }, ScopeResolveRejection> {
  let resolved: EvolutionScope | null;
  if (input.goalId) {
    const goal = forge.getGoal(input.goalId);
    if (!goal || (scope.spaceId && goal.spaceId !== scope.spaceId)) {
      return denyForge('goal_not_found', `Goal not found: ${input.goalId}`);
    }
    resolved = forge.scopeService.resolveScopeForGoal({ spaceGoalId: input.goalId });
  } else if (input.taskId) {
    const task = forge.taskRepo.getTask(input.taskId);
    if (!task || (scope.spaceId && task.spaceId !== scope.spaceId)) {
      return denyForge('task_not_found', `Task not found: ${input.taskId}`);
    }
    resolved = forge.scopeService.resolveScopeForTask({ taskId: input.taskId });
  } else {
    return denyForge('resolve_target_required', 'Provide goalId or taskId');
  }
  if (!resolved) return denyForge('scope_not_found', 'No scope found');
  forge.audit?.({
    toolName: 'forge.scope.resolve',
    paramsSummary: { goalId: input.goalId, taskId: input.taskId, scopeId: resolved.id },
    caller,
    spaceId: resolved.spaceId,
  });
  return { value: { accepted: true, scope: resolved } };
}

export function readForgeTimeline(
  scope: EvolutionScope,
  forge: ForgeScopeOperationDependencies
): { accepted: true } & ScopeTimeline {
  return { accepted: true, ...forge.scopeService.listTimeline(scope.id) };
}

const NoteAddInputSchema = z
  .object({
    ...ScopeTargeted,
    summary: z.string().min(1),
    metadata: ForgeMetadataSchema.optional(),
    createdAt: z.number().int().optional(),
  })
  .strict();

export function applyForgeNoteAdd(
  input: z.infer<typeof NoteAddInputSchema>,
  scope: EvolutionScope,
  caller: OperationCaller,
  forge: ForgeScopeOperationDependencies
): { accepted: true; evidence: EvidenceRef } {
  const evidence = forge.scopeService.addManualNoteEvidence({
    scopeId: scope.id,
    summary: input.summary,
    metadata: input.metadata,
    createdAt: input.createdAt,
  });
  forge.audit?.({
    toolName: 'forge.note.add',
    paramsSummary: { scopeId: scope.id },
    caller,
    spaceId: scope.spaceId,
  });
  return { accepted: true, evidence };
}

const EvidenceAttachTaskInputSchema = z
  .object({
    ...SpaceScoped,
    taskId: z.string().min(1),
    scopeId: z.string().min(1).optional(),
    summary: z.string().optional(),
    metadata: ForgeMetadataSchema.optional(),
  })
  .strict();

export function applyForgeTaskEvidence(
  input: z.infer<typeof EvidenceAttachTaskInputSchema>,
  scope: { spaceId?: string },
  caller: OperationCaller,
  forge: ForgeScopeOperationDependencies
): ForgeGate<{ accepted: true; evidence: EvidenceRef }, EvidenceAttachRejection> {
  const task = forge.taskRepo.getTask(input.taskId);
  if (!task || (scope.spaceId && task.spaceId !== scope.spaceId)) {
    return denyForge('task_not_found', `Task not found: ${input.taskId}`);
  }
  if (input.scopeId && !findForgeScopeInSpace(input.scopeId, scope.spaceId, forge)) {
    return denyForge('scope_not_found', `EvolutionScope not found: ${input.scopeId}`);
  }
  let evidence: EvidenceRef;
  try {
    evidence = forge.scopeService.attachTaskEvidence({
      taskId: input.taskId,
      scopeId: input.scopeId,
      summary: input.summary,
      metadata: input.metadata,
    });
  } catch (err) {
    return denyForge('evidence_not_attached', err instanceof Error ? err.message : String(err));
  }
  if (!findForgeScopeInSpace(evidence.scopeId, scope.spaceId, forge)) {
    return denyForge('scope_not_found', `EvolutionScope not found: ${evidence.scopeId}`);
  }
  forge.audit?.({
    toolName: 'forge.evidence.attachTask',
    paramsSummary: { scopeId: evidence.scopeId, taskId: input.taskId },
    caller,
    spaceId: scope.spaceId,
    taskId: input.taskId,
  });
  return { value: { accepted: true, evidence } };
}

const EvidenceAttachRunInputSchema = z
  .object({
    ...SpaceScoped,
    workflowRunId: z.string().min(1),
    scopeId: z.string().min(1).optional(),
    summary: z.string().optional(),
    metadata: ForgeMetadataSchema.optional(),
  })
  .strict();

export function applyForgeWorkflowRunEvidence(
  input: z.infer<typeof EvidenceAttachRunInputSchema>,
  scope: { spaceId?: string },
  caller: OperationCaller,
  forge: ForgeScopeOperationDependencies
): ForgeGate<{ accepted: true; evidence: EvidenceRef }, EvidenceAttachRejection> {
  const run = forge.workflowRunRepo.getRun(input.workflowRunId);
  if (!run || (scope.spaceId && run.spaceId !== scope.spaceId)) {
    return denyForge('workflow_run_not_found', `Workflow run not found: ${input.workflowRunId}`);
  }
  if (input.scopeId && !findForgeScopeInSpace(input.scopeId, scope.spaceId, forge)) {
    return denyForge('scope_not_found', `EvolutionScope not found: ${input.scopeId}`);
  }
  let evidence: EvidenceRef;
  try {
    evidence = forge.scopeService.attachWorkflowRunEvidence({
      workflowRunId: input.workflowRunId,
      scopeId: input.scopeId,
      summary: input.summary,
      metadata: input.metadata,
    });
  } catch (err) {
    return denyForge('evidence_not_attached', err instanceof Error ? err.message : String(err));
  }
  if (!findForgeScopeInSpace(evidence.scopeId, scope.spaceId, forge)) {
    return denyForge('scope_not_found', `EvolutionScope not found: ${evidence.scopeId}`);
  }
  forge.audit?.({
    toolName: 'forge.evidence.attachWorkflowRun',
    paramsSummary: { scopeId: evidence.scopeId, workflowRunId: input.workflowRunId },
    caller,
    spaceId: scope.spaceId,
  });
  return { value: { accepted: true, evidence } };
}

export function readForgeEvidence(
  scope: EvolutionScope,
  forge: ForgeScopeOperationDependencies
): { accepted: true; evidence: EvidenceRef[]; scope: { spaceId: string } } {
  return {
    accepted: true,
    evidence: forge.scopeService.listEvidence(scope.id).evidence,
    scope: { spaceId: scope.spaceId },
  };
}

const MetricAddInputSchema = z
  .object({
    ...ScopeTargeted,
    values: ForgeMetricValuesSchema,
    source: z.string().min(1),
    note: z.string().nullable().optional(),
    capturedAt: z.number().int().optional(),
    summary: z.string().optional(),
    metadata: ForgeMetadataSchema.optional(),
  })
  .strict();

export function applyForgeMetricAdd(
  input: z.infer<typeof MetricAddInputSchema>,
  scope: EvolutionScope,
  caller: OperationCaller,
  forge: ForgeScopeOperationDependencies
): { accepted: true; snapshot: MetricSnapshot; evidence: EvidenceRef } {
  const result = forge.scopeService.addMetricSnapshotEvidence({
    scopeId: scope.id,
    values: input.values,
    source: input.source,
    note: input.note,
    capturedAt: input.capturedAt,
    summary: input.summary,
    metadata: input.metadata,
  });
  forge.audit?.({
    toolName: 'forge.metric.add',
    paramsSummary: { scopeId: scope.id, source: input.source },
    caller,
    spaceId: scope.spaceId,
  });
  return { accepted: true, ...result };
}

export function readForgeMetricSnapshots(
  scope: EvolutionScope,
  forge: ForgeScopeOperationDependencies
): { accepted: true; snapshots: MetricSnapshot[]; scope: { spaceId: string } } {
  return {
    accepted: true,
    snapshots: forge.scopeService.listMetricSnapshots(scope.id),
    scope: { spaceId: scope.spaceId },
  };
}

function scopeReadPipeline<Result>(
  name: string,
  forge: ForgeScopeOperationDependencies,
  read: (scope: EvolutionScope, deps: ForgeScopeOperationDependencies) => Result
) {
  return (superpipe({ forge })(name) as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeReader, ['input', 'caller'], 'result:outcome')
    .pipe(requireForgeScope, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(read, ['outcome', 'forge'], 'outcome')
    .endAsync('outcome') as (
    input: { scopeId: string; spaceId?: string },
    caller: OperationCaller
  ) => Promise<Result>;
}

export function createForgeScopeOperations(forge: ForgeScopeOperationDependencies) {
  const create = (superpipe({ forge })('forge-scope-create') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeMutator, ['input', 'caller', 'forge'], 'result:outcome')
    .pipe(requireForgeSpace, 'outcome', 'result:outcome')
    .pipe(planForgeScopeCreate, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(applyForgeScopeCreate, ['outcome', 'caller', 'forge'], 'outcome')
    .endAsync('outcome');

  const createFromGoal = (superpipe({ forge })('forge-scope-create-from-goal') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeMutator, ['input', 'caller', 'forge'], 'result:outcome')
    .pipe(planForgeScopeCreateFromGoal, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(applyForgeScopeCreateFromGoal, ['outcome', 'caller', 'forge'], 'outcome')
    .endAsync('outcome');

  const list = (superpipe({ forge })('forge-scope-list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeReader, ['input', 'caller'], 'result:outcome')
    .pipe(requireForgeSpace, 'outcome', 'result:outcome')
    .pipe(readForgeScopeList, ['input', 'outcome', 'forge'], 'result:outcome')
    .endAsync('outcome');

  const update = (superpipe({ forge })('forge-scope-update') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeMutator, ['input', 'caller', 'forge'], 'result:outcome')
    .pipe(requireForgeScope, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(planForgeScopeUpdate, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(
      (
        input: z.infer<typeof ScopeUpdateInputSchema>,
        params: UpdateEvolutionScopeParams,
        caller: OperationCaller,
        deps: ForgeScopeOperationDependencies
      ) => applyForgeScopeUpdate(input.scopeId, params, caller, deps),
      ['input', 'outcome', 'caller', 'forge'],
      'result:outcome'
    )
    .endAsync('outcome');

  const resolve = (superpipe({ forge })('forge-scope-resolve') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeReader, ['input', 'caller'], 'result:outcome')
    .pipe(resolveForgeScopeTarget, ['input', 'outcome', 'caller', 'forge'], 'result:outcome')
    .endAsync('outcome');

  const noteAdd = (superpipe({ forge })('forge-note-add') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeMutator, ['input', 'caller', 'forge'], 'result:outcome')
    .pipe(requireForgeScope, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(applyForgeNoteAdd, ['input', 'outcome', 'caller', 'forge'], 'outcome')
    .endAsync('outcome');

  const attachTask = (superpipe({ forge })('forge-evidence-attach-task') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeMutator, ['input', 'caller', 'forge'], 'result:outcome')
    .pipe(applyForgeTaskEvidence, ['input', 'outcome', 'caller', 'forge'], 'result:outcome')
    .endAsync('outcome');

  const attachRun = (superpipe({ forge })('forge-evidence-attach-workflow-run') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeMutator, ['input', 'caller', 'forge'], 'result:outcome')
    .pipe(applyForgeWorkflowRunEvidence, ['input', 'outcome', 'caller', 'forge'], 'result:outcome')
    .endAsync('outcome');

  const metricAdd = (superpipe({ forge })('forge-metric-add') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeMutator, ['input', 'caller', 'forge'], 'result:outcome')
    .pipe(requireForgeScope, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(applyForgeMetricAdd, ['input', 'outcome', 'caller', 'forge'], 'outcome')
    .endAsync('outcome');

  const timeline = scopeReadPipeline('forge-timeline-get', forge, readForgeTimeline);
  const evidenceList = scopeReadPipeline('forge-evidence-list', forge, readForgeEvidence);
  const metricList = scopeReadPipeline('forge-metric-list', forge, readForgeMetricSnapshots);

  const scopeResult = accepted({ scope: ForgeScopeSchema });
  const evidenceResult = accepted({ evidence: ForgeEvidenceRefSchema });

  return [
    defineOperation({
      name: 'forge.scope.create',
      policy: FORGE_MUTATE_POLICY,
      description:
        'Create a Forge scope in a Space, optionally linked to a goal and a parent scope, with metric definitions and judge policy. Naming a goalId takes name and objective from that goal unless they are given explicitly; without a goalId both are required. MCP callers are scoped to their own Space; RPC callers pass spaceId. Rejects goal_not_found, scope_not_found (parent), invalid_policy, and forge_denied for sessions without Forge write access.',
      inputSchema: ScopeCreateInputSchema,
      resultSchema: z.union([scopeResult, forgeDenialSchema(SCOPE_CREATE_REJECTIONS)]),
      execute: async (input, caller) => create(input, caller),
    }),
    defineOperation({
      name: 'forge.scope.createFromGoal',
      policy: FORGE_MUTATE_POLICY,
      description:
        'Create a mission Forge scope linked to an existing goal, defaulting name and objective from the goal. Rejects goal_not_found when the goal is absent or outside the caller Space, and invalid_policy when the judge policy fails validation.',
      inputSchema: ScopeCreateFromGoalInputSchema,
      resultSchema: z.union([scopeResult, forgeDenialSchema(SCOPE_CREATE_REJECTIONS)]),
      execute: async (input, caller) => createFromGoal(input, caller),
    }),
    defineOperation({
      name: 'forge.scope.list',
      policy: FORGE_READ_POLICY,
      description:
        'List Forge scopes in a Space, optionally filtered by linked goal (null lists unlinked scopes) or by kind. Rejects space_required when no Space can be resolved and goal_not_found for a goal outside the Space.',
      inputSchema: ScopeListInputSchema,
      resultSchema: z.union([
        accepted({ scopes: z.array(ForgeScopeSchema), scope: z.object({ spaceId: z.string() }) }),
        forgeDenialSchema(SCOPE_CREATE_REJECTIONS),
      ]),
      execute: async (input, caller) => list(input, caller),
    }),
    defineOperation({
      name: 'forge.scope.update',
      policy: FORGE_MUTATE_POLICY,
      description:
        'Update a Forge scope: link or unlink a goal, rename, re-parent, replace metric definitions, and change judge policy. Prefer policyPatch to deep-merge policy fields without clobbering the rest; episodeJudgeModel and episodeJudgeProvider are patched the same way. Rejects scope_not_found, goal_not_found, and invalid_policy.',
      inputSchema: ScopeUpdateInputSchema,
      resultSchema: z.union([scopeResult, forgeDenialSchema(SCOPE_CREATE_REJECTIONS)]),
      execute: async (input, caller) => update(input, caller),
    }),
    defineOperation({
      name: 'forge.scope.resolve',
      policy: FORGE_READ_POLICY,
      description:
        'Resolve the Forge scope behind a goal or a task when the scope id is unknown. Rejects resolve_target_required when neither goalId nor taskId is given, goal_not_found or task_not_found when the target is absent or outside the caller Space, and scope_not_found when nothing is linked.',
      inputSchema: ScopeResolveInputSchema,
      resultSchema: z.union([scopeResult, forgeDenialSchema(SCOPE_RESOLVE_REJECTIONS)]),
      execute: async (input, caller) => resolve(input, caller),
    }),
    defineOperation({
      name: 'forge.timeline.get',
      policy: FORGE_READ_POLICY,
      description:
        'Read a Forge scope overview: the scope itself with its evidence and metric snapshots in one bundle. Rejects scope_not_found when the scope is absent or outside the caller Space.',
      inputSchema: z.object(ScopeTargeted).strict(),
      resultSchema: z.union([
        accepted({
          scope: ForgeScopeSchema,
          evidence: z.array(ForgeEvidenceRefSchema),
          metricSnapshots: z.array(ForgeMetricSnapshotSchema),
        }),
        forgeDenialSchema(SCOPE_ID_REJECTIONS),
      ]),
      execute: async (input, caller) => timeline(input, caller),
    }),
    defineOperation({
      name: 'forge.note.add',
      policy: FORGE_MUTATE_POLICY,
      description:
        'Attach a manual-note evidence item to a Forge scope. Rejects scope_not_found when the scope is absent or outside the caller Space.',
      inputSchema: NoteAddInputSchema,
      resultSchema: z.union([evidenceResult, forgeDenialSchema(SCOPE_ID_REJECTIONS)]),
      execute: async (input, caller) => noteAdd(input, caller),
    }),
    defineOperation({
      name: 'forge.evidence.attachTask',
      policy: FORGE_MUTATE_POLICY,
      description:
        'Attach a task as Forge evidence, resolving the scope from the task when scopeId is omitted. Rejects task_not_found, scope_not_found, and evidence_not_attached when no scope can be resolved for the task.',
      inputSchema: EvidenceAttachTaskInputSchema,
      resultSchema: z.union([evidenceResult, forgeDenialSchema(EVIDENCE_ATTACH_REJECTIONS)]),
      execute: async (input, caller) => attachTask(input, caller),
    }),
    defineOperation({
      name: 'forge.evidence.attachWorkflowRun',
      policy: FORGE_MUTATE_POLICY,
      description:
        "Attach a workflow run as Forge evidence, resolving the scope via the run's tasks when scopeId is omitted. Rejects workflow_run_not_found, scope_not_found, and evidence_not_attached when no scope can be resolved for the run.",
      inputSchema: EvidenceAttachRunInputSchema,
      resultSchema: z.union([evidenceResult, forgeDenialSchema(EVIDENCE_ATTACH_REJECTIONS)]),
      execute: async (input, caller) => attachRun(input, caller),
    }),
    defineOperation({
      name: 'forge.evidence.list',
      policy: FORGE_READ_POLICY,
      description:
        'List the evidence refs attached to a Forge scope. Rejects scope_not_found when the scope is absent or outside the caller Space.',
      inputSchema: z.object(ScopeTargeted).strict(),
      resultSchema: z.union([
        accepted({
          evidence: z.array(ForgeEvidenceRefSchema),
          scope: z.object({ spaceId: z.string() }),
        }),
        forgeDenialSchema(SCOPE_ID_REJECTIONS),
      ]),
      execute: async (input, caller) => evidenceList(input, caller),
    }),
    defineOperation({
      name: 'forge.metric.add',
      policy: FORGE_MUTATE_POLICY,
      description:
        'Record a metric snapshot on a Forge scope and attach it as evidence. Rejects scope_not_found when the scope is absent or outside the caller Space.',
      inputSchema: MetricAddInputSchema,
      resultSchema: z.union([
        accepted({ snapshot: ForgeMetricSnapshotSchema, evidence: ForgeEvidenceRefSchema }),
        forgeDenialSchema(SCOPE_ID_REJECTIONS),
      ]),
      execute: async (input, caller) => metricAdd(input, caller),
    }),
    defineOperation({
      name: 'forge.metric.list',
      policy: FORGE_READ_POLICY,
      description:
        'List the metric snapshots recorded on a Forge scope. Rejects scope_not_found when the scope is absent or outside the caller Space.',
      inputSchema: z.object(ScopeTargeted).strict(),
      resultSchema: z.union([
        accepted({
          snapshots: z.array(ForgeMetricSnapshotSchema),
          scope: z.object({ spaceId: z.string() }),
        }),
        forgeDenialSchema(SCOPE_ID_REJECTIONS),
      ]),
      execute: async (input, caller) => metricList(input, caller),
    }),
  ];
}
