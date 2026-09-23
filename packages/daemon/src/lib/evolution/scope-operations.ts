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
  admitEvolutionMutator,
  admitEvolutionReader,
  denyEvolution,
  EVOLUTION_CALLER_REJECTIONS,
  evolutionDenialSchema,
  type EvolutionAdmissionDependencies,
  type EvolutionAuditWriter,
  type EvolutionGate,
  requireEvolutionSpace,
} from './admission.ts';
import {
  EvolutionEvidenceRefSchema,
  EvolutionMetadataSchema,
  EvolutionMetricDefinitionSchema,
  EvolutionMetricSnapshotSchema,
  EvolutionMetricValuesSchema,
  EvolutionPolicySchema,
  EvolutionScopeKindSchema,
  EvolutionScopeSchema,
} from './result-schemas.ts';
import { mergeEvolutionPolicy } from './scope-policy.ts';
import type { EvolutionScopeService } from './scope-service.ts';

export interface EvolutionScopeOperationDependencies extends EvolutionAdmissionDependencies {
  readonly scopeService: Pick<
    EvolutionScopeService,
    'addMetricSnapshotEvidence' | 'createScope' | 'getScope' | 'listScopes' | 'updateScope'
  >;
  readonly getGoal: (
    goalId: string
  ) => { id: string; spaceId: string; title: string; description: string } | null;
  readonly db?: BunDatabase;
  readonly goalRepo?: SpaceGoalRepository;
  readonly scheduleService?: ScheduleService;
  readonly audit?: EvolutionAuditWriter;
}

const SCOPE_ID_REJECTIONS = [...EVOLUTION_CALLER_REJECTIONS, 'scope_not_found'] as const;
const SCOPE_CREATE_REJECTIONS = [
  ...SCOPE_ID_REJECTIONS,
  'goal_not_found',
  'invalid_policy',
] as const;

type ScopeIdRejection = (typeof SCOPE_ID_REJECTIONS)[number];
type ScopeCreateRejection = (typeof SCOPE_CREATE_REJECTIONS)[number];

const EVOLUTION_READ_POLICY = {
  safetyClass: 'read',
  roles: ['ad_hoc_member', 'long_term_agent', 'universal_read'],
} as const satisfies OperationPolicy;

const EVOLUTION_MUTATE_POLICY = {
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

function validateEvolutionPolicy(policy: EvolutionPolicy): string | undefined {
  try {
    validateGoalAutomationSelfNagPolicy({ policy });
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function runEvolutionScopeWrite<T>(
  evolution: EvolutionScopeOperationDependencies,
  write: () => T
): T {
  return evolution.db ? evolution.db.transaction(write)() : write();
}

const EvolutionMetricDefinitionInputSchema = EvolutionMetricDefinitionSchema.extend({
  key: z.string().min(1),
  label: z.string().min(1),
});

function syncEvolutionScopeAutomation(
  scope: EvolutionScope,
  evolution: EvolutionScopeOperationDependencies
): void {
  if (!evolution.goalRepo || !evolution.scheduleService) return;
  syncGoalAutomationSelfNagScheduleForScope({
    goalRepo: evolution.goalRepo,
    scheduleService: evolution.scheduleService,
    scope,
    db: evolution.db,
  });
}

export function findEvolutionScopeInSpace(
  scopeId: string,
  spaceId: string | undefined,
  evolution: { scopeService: Pick<EvolutionScopeService, 'getScope'> }
): EvolutionScope | null {
  const scope = evolution.scopeService.getScope(scopeId);
  return scope && (!spaceId || scope.spaceId === spaceId) ? scope : null;
}

export function requireEvolutionScope(
  input: { scopeId: string },
  scope: { spaceId?: string },
  evolution: EvolutionScopeOperationDependencies
): EvolutionGate<EvolutionScope, ScopeIdRejection> {
  const found = findEvolutionScopeInSpace(input.scopeId, scope.spaceId, evolution);
  return found
    ? { value: found }
    : denyEvolution('scope_not_found', `EvolutionScope not found: ${input.scopeId}`);
}

const ScopeCreateInputSchema = z
  .object({
    ...SpaceScoped,
    kind: EvolutionScopeKindSchema,
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
    metricDefinitions: z.array(EvolutionMetricDefinitionInputSchema).optional(),
    policy: EvolutionPolicySchema.optional(),
  })
  .strict()
  .refine(
    (input) => Boolean(input.goalId) || (Boolean(input.name) && Boolean(input.objective)),
    'Provide name and objective, or a goalId to take them from'
  );

export function planEvolutionScopeCreate(
  input: z.infer<typeof ScopeCreateInputSchema>,
  spaceId: string,
  evolution: EvolutionScopeOperationDependencies
): EvolutionGate<CreateEvolutionScopeParams, ScopeCreateRejection> {
  const goal = input.goalId ? evolution.getGoal(input.goalId) : null;
  if (input.goalId && (!goal || goal.spaceId !== spaceId)) {
    return denyEvolution('goal_not_found', `Goal not found: ${input.goalId}`);
  }
  if (input.parentScopeId && !findEvolutionScopeInSpace(input.parentScopeId, spaceId, evolution)) {
    return denyEvolution('scope_not_found', `EvolutionScope not found: ${input.parentScopeId}`);
  }
  const invalid = input.policy ? validateEvolutionPolicy(input.policy) : undefined;
  if (invalid) return denyEvolution('invalid_policy', invalid);
  const name = input.name ?? goal?.title ?? '';
  return {
    value: {
      spaceId,
      spaceGoalId: input.goalId ?? null,
      kind: input.kind,
      name,
      objective: input.objective ?? (goal?.description || name),
      parentScopeId: input.parentScopeId ?? null,
      metricDefinitions: input.metricDefinitions,
      policy: input.policy,
    },
  };
}

export function applyEvolutionScopeCreate(
  params: CreateEvolutionScopeParams,
  caller: OperationCaller,
  evolution: EvolutionScopeOperationDependencies
): { accepted: true; scope: EvolutionScope } {
  const scope = runEvolutionScopeWrite(evolution, () => {
    const created = evolution.scopeService.createScope(params);
    syncEvolutionScopeAutomation(created, evolution);
    return created;
  });
  evolution.audit?.({
    toolName: 'evolution.scope.create',
    paramsSummary: { name: params.name, kind: params.kind, goalId: params.spaceGoalId },
    caller,
    spaceId: params.spaceId,
  });
  return { accepted: true, scope };
}

const ScopeListInputSchema = z
  .object({
    ...SpaceScoped,
    goalId: z.string().min(1).nullable().optional(),
    kind: EvolutionScopeKindSchema.optional(),
  })
  .strict();

export function readEvolutionScopeList(
  input: z.infer<typeof ScopeListInputSchema>,
  spaceId: string,
  evolution: EvolutionScopeOperationDependencies
): EvolutionGate<
  { accepted: true; scopes: EvolutionScope[]; scope: { spaceId: string } },
  ScopeCreateRejection
> {
  if (input.goalId) {
    const goal = evolution.getGoal(input.goalId);
    if (!goal || goal.spaceId !== spaceId) {
      return denyEvolution('goal_not_found', `Goal not found: ${input.goalId}`);
    }
  }
  return {
    value: {
      accepted: true,
      scope: { spaceId },
      scopes: evolution.scopeService.listScopes({
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
    kind: EvolutionScopeKindSchema.optional(),
    name: z.string().min(1).optional(),
    objective: z.string().min(1).optional(),
    parentScopeId: z.string().min(1).nullable().optional(),
    metricDefinitions: z.array(EvolutionMetricDefinitionInputSchema).optional(),
    policy: EvolutionPolicySchema.optional(),
    policyPatch: EvolutionPolicySchema.optional(),
    episodeJudgeModel: z.string().nullable().optional(),
    episodeJudgeProvider: z.string().nullable().optional(),
  })
  .strict();

export function planEvolutionScopeUpdate(
  input: z.infer<typeof ScopeUpdateInputSchema>,
  existing: EvolutionScope,
  evolution: EvolutionScopeOperationDependencies
): EvolutionGate<UpdateEvolutionScopeParams, ScopeCreateRejection> {
  if (input.goalId) {
    const goal = evolution.getGoal(input.goalId);
    if (!goal || goal.spaceId !== existing.spaceId) {
      return denyEvolution('goal_not_found', `Goal not found: ${input.goalId}`);
    }
  }
  if (
    input.parentScopeId &&
    !findEvolutionScopeInSpace(input.parentScopeId, existing.spaceId, evolution)
  ) {
    return denyEvolution('scope_not_found', `EvolutionScope not found: ${input.parentScopeId}`);
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
  const invalid = validateEvolutionPolicy(resulting ?? existing.policy);
  return invalid ? denyEvolution('invalid_policy', invalid) : { value: params };
}

export function applyEvolutionScopeUpdate(
  scopeId: string,
  params: UpdateEvolutionScopeParams,
  caller: OperationCaller,
  evolution: EvolutionScopeOperationDependencies
): EvolutionGate<{ accepted: true; scope: EvolutionScope }, ScopeIdRejection> {
  const scope = evolution.scopeService.updateScope(scopeId, params);
  evolution.audit?.({
    toolName: 'evolution.scope.update',
    paramsSummary: { scopeId },
    caller,
    spaceId: scope?.spaceId,
  });
  if (!scope) return denyEvolution('scope_not_found', `EvolutionScope not found: ${scopeId}`);
  syncEvolutionScopeAutomation(scope, evolution);
  return { value: { accepted: true, scope } };
}

const MetricAddInputSchema = z
  .object({
    ...ScopeTargeted,
    values: EvolutionMetricValuesSchema,
    source: z.string().min(1),
    note: z.string().nullable().optional(),
    capturedAt: z.number().int().optional(),
    summary: z.string().optional(),
    metadata: EvolutionMetadataSchema.optional(),
  })
  .strict();

export function applyEvolutionMetricAdd(
  input: z.infer<typeof MetricAddInputSchema>,
  scope: EvolutionScope,
  caller: OperationCaller,
  evolution: EvolutionScopeOperationDependencies
): { accepted: true; snapshot: MetricSnapshot; evidence: EvidenceRef } {
  const result = evolution.scopeService.addMetricSnapshotEvidence({
    scopeId: scope.id,
    values: input.values,
    source: input.source,
    note: input.note,
    capturedAt: input.capturedAt,
    summary: input.summary,
    metadata: input.metadata,
  });
  evolution.audit?.({
    toolName: 'evolution.metric.add',
    paramsSummary: { scopeId: scope.id, source: input.source },
    caller,
    spaceId: scope.spaceId,
  });
  return { accepted: true, ...result };
}

export function createEvolutionScopeOperations(evolution: EvolutionScopeOperationDependencies) {
  const create = (superpipe({ evolution })('evolution-scope-create') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitEvolutionMutator, ['input', 'caller', 'evolution'], 'result:outcome')
    .pipe(requireEvolutionSpace, 'outcome', 'result:outcome')
    .pipe(planEvolutionScopeCreate, ['input', 'outcome', 'evolution'], 'result:outcome')
    .pipe(applyEvolutionScopeCreate, ['outcome', 'caller', 'evolution'], 'outcome')
    .endAsync('outcome');

  const list = (superpipe({ evolution })('evolution-scope-list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitEvolutionReader, ['input', 'caller'], 'result:outcome')
    .pipe(requireEvolutionSpace, 'outcome', 'result:outcome')
    .pipe(readEvolutionScopeList, ['input', 'outcome', 'evolution'], 'result:outcome')
    .endAsync('outcome');

  const update = (superpipe({ evolution })('evolution-scope-update') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitEvolutionMutator, ['input', 'caller', 'evolution'], 'result:outcome')
    .pipe(requireEvolutionScope, ['input', 'outcome', 'evolution'], 'result:outcome')
    .pipe(planEvolutionScopeUpdate, ['input', 'outcome', 'evolution'], 'result:outcome')
    .pipe(
      (
        input: z.infer<typeof ScopeUpdateInputSchema>,
        params: UpdateEvolutionScopeParams,
        caller: OperationCaller,
        deps: EvolutionScopeOperationDependencies
      ) => applyEvolutionScopeUpdate(input.scopeId, params, caller, deps),
      ['input', 'outcome', 'caller', 'evolution'],
      'result:outcome'
    )
    .endAsync('outcome');

  const metricAdd = (superpipe({ evolution })('evolution-metric-add') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitEvolutionMutator, ['input', 'caller', 'evolution'], 'result:outcome')
    .pipe(requireEvolutionScope, ['input', 'outcome', 'evolution'], 'result:outcome')
    .pipe(applyEvolutionMetricAdd, ['input', 'outcome', 'caller', 'evolution'], 'outcome')
    .endAsync('outcome');

  const scopeResult = accepted({ scope: EvolutionScopeSchema });

  return [
    defineOperation({
      name: 'evolution.scope.create',
      policy: EVOLUTION_MUTATE_POLICY,
      description:
        'Create an Evolution scope in a Space, optionally linked to a goal and a parent scope, with metric definitions and judge policy. Naming a goalId takes name and objective from that goal unless they are given explicitly; without a goalId both are required. MCP callers are scoped to their own Space; RPC callers pass spaceId. Rejects goal_not_found, scope_not_found (parent), invalid_policy, and evolution_denied for sessions without Evolution write access.',
      inputSchema: ScopeCreateInputSchema,
      resultSchema: z.union([scopeResult, evolutionDenialSchema(SCOPE_CREATE_REJECTIONS)]),
      execute: async (input, caller) => create(input, caller),
    }),
    defineOperation({
      name: 'evolution.scope.list',
      policy: EVOLUTION_READ_POLICY,
      description:
        'List Evolution scopes in a Space, optionally filtered by linked goal (null lists unlinked scopes) or by kind. Rejects space_required when no Space can be resolved and goal_not_found for a goal outside the Space.',
      inputSchema: ScopeListInputSchema,
      resultSchema: z.union([
        accepted({
          scopes: z.array(EvolutionScopeSchema),
          scope: z.object({ spaceId: z.string() }),
        }),
        evolutionDenialSchema(SCOPE_CREATE_REJECTIONS),
      ]),
      execute: async (input, caller) => list(input, caller),
    }),
    defineOperation({
      name: 'evolution.scope.update',
      policy: EVOLUTION_MUTATE_POLICY,
      description:
        'Update an Evolution scope: link or unlink a goal, rename, re-parent, replace metric definitions, and change judge policy. Prefer policyPatch to deep-merge policy fields without clobbering the rest; episodeJudgeModel and episodeJudgeProvider are patched the same way. Rejects scope_not_found, goal_not_found, and invalid_policy.',
      inputSchema: ScopeUpdateInputSchema,
      resultSchema: z.union([scopeResult, evolutionDenialSchema(SCOPE_CREATE_REJECTIONS)]),
      execute: async (input, caller) => update(input, caller),
    }),
    defineOperation({
      name: 'evolution.metric.add',
      policy: EVOLUTION_MUTATE_POLICY,
      description:
        'Record a metric snapshot on an Evolution scope and attach it as evidence. Rejects scope_not_found when the scope is absent or outside the caller Space.',
      inputSchema: MetricAddInputSchema,
      resultSchema: z.union([
        accepted({ snapshot: EvolutionMetricSnapshotSchema, evidence: EvolutionEvidenceRefSchema }),
        evolutionDenialSchema(SCOPE_ID_REJECTIONS),
      ]),
      execute: async (input, caller) => metricAdd(input, caller),
    }),
  ];
}
