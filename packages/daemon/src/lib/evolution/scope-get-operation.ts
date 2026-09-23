import type {
  EvidenceRef,
  EvolutionEpisode,
  EvolutionLesson,
  EvolutionScope,
  MetricSnapshot,
  TaskProposal,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationPolicy,
} from '../operations/registry.ts';
import type { EvolutionEpisodeService } from './episode-service.ts';
import {
  admitForgeReader,
  denyForge,
  FORGE_CALLER_REJECTIONS,
  forgeDenialSchema,
  type EvolutionAdmissionDependencies,
  type EvolutionAuditWriter,
  type EvolutionGate,
  type EvolutionSpaceScope,
} from './admission.ts';
import {
  EvolutionEpisodeSchema,
  EvolutionLessonSchema,
  EvolutionLessonStatusSchema,
  EvolutionProposalSchema,
  EvolutionProposalStatusSchema,
} from './episode-schemas.ts';
import {
  EvolutionEvidenceRefSchema,
  EvolutionMetricSnapshotSchema,
  EvolutionScopeSchema,
} from './result-schemas.ts';
import { findForgeScopeInSpace } from './scope-operations.ts';
import type { EvolutionScopeService } from './scope-service.ts';

export interface EvolutionScopeGetDependencies extends EvolutionAdmissionDependencies {
  readonly scopeService: Pick<
    EvolutionScopeService,
    | 'getScope'
    | 'listEvidence'
    | 'listMetricSnapshots'
    | 'resolveScopeForGoal'
    | 'resolveScopeForTask'
  >;
  readonly episodeService: Pick<
    EvolutionEpisodeService,
    'listEpisodes' | 'listLessons' | 'listTaskProposals'
  >;
  readonly getGoal: (goalId: string) => { id: string; spaceId: string } | null;
  readonly taskRepo: Pick<SpaceTaskRepository, 'getTask'>;
  readonly longHorizonAgentRepo: Pick<
    SpaceLongHorizonAgentRepository,
    'getById' | 'listForgeScopeAssignments'
  >;
  readonly audit?: EvolutionAuditWriter;
}

const SCOPE_GET_REJECTIONS = [
  ...FORGE_CALLER_REJECTIONS,
  'scope_not_found',
  'goal_not_found',
  'task_not_found',
  'resolve_target_required',
] as const;

type ScopeGetRejection = (typeof SCOPE_GET_REJECTIONS)[number];

const SCOPE_GET_PARTS = [
  'scope',
  'agents',
  'evidence',
  'metrics',
  'episodes',
  'lessons',
  'proposals',
] as const;

type ScopeGetPart = (typeof SCOPE_GET_PARTS)[number];

const DEFAULT_SCOPE_GET_PARTS: readonly ScopeGetPart[] = ['scope'];
const AUDITED_SCOPE_GET_PARTS: readonly ScopeGetPart[] = ['lessons', 'proposals'];

const FORGE_READ_POLICY = {
  safetyClass: 'read',
  roles: ['ad_hoc_member', 'long_term_agent', 'universal_read'],
} as const satisfies OperationPolicy;

const ScopeGetInputSchema = z
  .object({
    spaceId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Defaults to the trusted caller Space; rejects space_required when neither is set.'
      ),
    scopeId: z.string().min(1).optional(),
    goalId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    include: z
      .array(z.enum(SCOPE_GET_PARTS))
      .optional()
      .describe('Parts to return; defaults to ["scope"], which reads no lists.'),
    lessonStatus: EvolutionLessonStatusSchema.optional(),
    proposalStatus: EvolutionProposalStatusSchema.optional(),
  })
  .strict();

type ScopeGetInput = z.infer<typeof ScopeGetInputSchema>;

interface ScopeGetParts {
  scope?: EvolutionScope;
  agents?: { agentId: string; relationship: string; createdAt: number }[];
  evidence?: EvidenceRef[];
  metricSnapshots?: MetricSnapshot[];
  episodes?: EvolutionEpisode[];
  lessons?: EvolutionLesson[];
  proposals?: TaskProposal[];
}

const ScopeGetAgentSchema = z.object({
  agentId: z.string(),
  relationship: z.string(),
  createdAt: z.number(),
});

const ScopeGetResultSchema = z.object({
  accepted: z.literal(true),
  scope: EvolutionScopeSchema.optional(),
  agents: z.array(ScopeGetAgentSchema).optional(),
  evidence: z.array(EvolutionEvidenceRefSchema).optional(),
  metricSnapshots: z.array(EvolutionMetricSnapshotSchema).optional(),
  episodes: z.array(EvolutionEpisodeSchema).optional(),
  lessons: z.array(EvolutionLessonSchema).optional(),
  proposals: z.array(EvolutionProposalSchema).optional(),
});

type ScopeGetPartReader = (
  input: ScopeGetInput,
  scope: EvolutionScope,
  evolution: EvolutionScopeGetDependencies
) => ScopeGetParts;

const SCOPE_GET_PART_READERS: Record<ScopeGetPart, ScopeGetPartReader> = {
  scope: (_input, scope) => ({ scope }),
  agents: (_input, scope, evolution) => ({
    agents: evolution.longHorizonAgentRepo.listForgeScopeAssignments(scope.id).map((link) => ({
      agentId: link.agentId,
      relationship: link.relationship,
      createdAt: link.createdAt,
    })),
  }),
  evidence: (_input, scope, evolution) => ({
    evidence: evolution.scopeService.listEvidence(scope.id).evidence,
  }),
  metrics: (_input, scope, evolution) => ({
    metricSnapshots: evolution.scopeService.listMetricSnapshots(scope.id),
  }),
  episodes: (_input, scope, evolution) => ({
    episodes: evolution.episodeService.listEpisodes(scope.id),
  }),
  lessons: (input, scope, evolution) => ({
    lessons: evolution.episodeService.listLessons(scope.id, input.lessonStatus),
  }),
  proposals: (input, scope, evolution) => ({
    proposals: evolution.episodeService.listTaskProposals(scope.id, input.proposalStatus),
  }),
};

export function selectForgeScopeGetParts(input: ScopeGetInput): ScopeGetPart[] {
  return [...new Set(input.include ?? DEFAULT_SCOPE_GET_PARTS)];
}

function resolveScopeForGoal(
  goalId: string,
  scope: EvolutionSpaceScope,
  evolution: EvolutionScopeGetDependencies
): EvolutionGate<EvolutionScope, ScopeGetRejection> {
  const goal = evolution.getGoal(goalId);
  if (!goal || (scope.spaceId && goal.spaceId !== scope.spaceId)) {
    return denyForge('goal_not_found', `Goal not found: ${goalId}`);
  }
  const resolved = evolution.scopeService.resolveScopeForGoal({ spaceGoalId: goalId });
  return resolved
    ? { value: resolved }
    : denyForge('scope_not_found', `No EvolutionScope is linked to goal: ${goalId}`);
}

function resolveScopeForTask(
  taskId: string,
  scope: EvolutionSpaceScope,
  evolution: EvolutionScopeGetDependencies
): EvolutionGate<EvolutionScope, ScopeGetRejection> {
  const task = evolution.taskRepo.getTask(taskId);
  if (!task || (scope.spaceId && task.spaceId !== scope.spaceId)) {
    return denyForge('task_not_found', `Task not found: ${taskId}`);
  }
  const resolved = evolution.scopeService.resolveScopeForTask({ taskId });
  return resolved
    ? { value: resolved }
    : denyForge('scope_not_found', `No EvolutionScope is linked to task: ${taskId}`);
}

export function resolveForgeScopeAddress(
  input: ScopeGetInput,
  scope: EvolutionSpaceScope,
  evolution: EvolutionScopeGetDependencies
): EvolutionGate<EvolutionScope, ScopeGetRejection> {
  if (input.scopeId) {
    const found = findForgeScopeInSpace(input.scopeId, scope.spaceId, evolution);
    return found
      ? { value: found }
      : denyForge('scope_not_found', `EvolutionScope not found: ${input.scopeId}`);
  }
  if (input.goalId) return resolveScopeForGoal(input.goalId, scope, evolution);
  if (input.taskId) return resolveScopeForTask(input.taskId, scope, evolution);
  return denyForge('resolve_target_required', 'Provide scopeId, goalId, or taskId');
}

export function readForgeScopeParts(
  input: ScopeGetInput,
  scope: EvolutionScope,
  caller: OperationCaller,
  evolution: EvolutionScopeGetDependencies
): { accepted: true } & ScopeGetParts {
  const parts = selectForgeScopeGetParts(input);
  const read = parts.reduce<ScopeGetParts>(
    (collected, part) =>
      Object.assign(collected, SCOPE_GET_PART_READERS[part](input, scope, evolution)),
    {}
  );
  const resolved = input.goalId !== undefined || input.taskId !== undefined;
  if (resolved || parts.some((part) => AUDITED_SCOPE_GET_PARTS.includes(part))) {
    evolution.audit?.({
      toolName: 'evolution.scope.get',
      paramsSummary: {
        scopeId: scope.id,
        goalId: input.goalId,
        taskId: input.taskId,
        include: parts,
      },
      caller,
      spaceId: scope.spaceId,
    });
  }
  return { accepted: true, ...read };
}

export function createForgeScopeGetOperation(evolution: EvolutionScopeGetDependencies) {
  const get = (superpipe({ evolution })('evolution-scope-get') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeReader, ['input', 'caller'], 'result:outcome')
    .pipe(resolveForgeScopeAddress, ['input', 'outcome', 'evolution'], 'result:outcome')
    .pipe(readForgeScopeParts, ['input', 'outcome', 'caller', 'evolution'], 'outcome')
    .endAsync('outcome');

  return defineOperation({
    name: 'evolution.scope.get',
    policy: FORGE_READ_POLICY,
    description:
      'Read one Forge scope and whatever parts of it you need in a single call. Address the scope by scopeId, or by goalId or taskId to resolve the scope linked to that goal or task (scopeId wins, then goalId, then taskId). include names the parts to return — scope, agents, evidence, metrics, episodes, lessons, proposals — and defaults to ["scope"], the scope row with its linked goal, metric definitions, and policy, which reads no lists; every other part costs one unfiltered read of that scope. agents returns the long-horizon agents this scope is routed to, which is what evolution.scope.owner.set writes. Filter with lessonStatus and proposalStatus. Parts you do not ask for are absent from the result. Rejects resolve_target_required when no address is given, goal_not_found or task_not_found when the target is absent or outside the caller Space, and scope_not_found when the scope is absent, outside the caller Space, or not linked to the target.',
    inputSchema: ScopeGetInputSchema,
    resultSchema: z.union([ScopeGetResultSchema, forgeDenialSchema(SCOPE_GET_REJECTIONS)]),
    execute: async (input, caller) => get(input, caller),
  });
}
