import type {
  EvolutionEpisode,
  EvolutionLesson,
  EvolutionScope,
  SpaceGoalType,
  TaskProposal,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import {
  defineOperation,
  type OperationCaller,
  type OperationPolicy,
} from '../operations/registry.ts';
import { TaskWithSpaceFieldsSchema } from '../tasks/get-operation.ts';
import {
  admitEvolutionMutator,
  denyEvolution,
  EVOLUTION_CALLER_REJECTIONS,
  evolutionDenialSchema,
  type EvolutionAdmissionDependencies,
  type EvolutionAuditWriter,
  type EvolutionGate,
} from './admission.ts';
import {
  EvolutionEpisodeSchema,
  EvolutionEpisodeStatusSchema,
  EvolutionGoalSchema,
  EvolutionLessonSchema,
  EvolutionLessonStatusSchema,
  EvolutionPreflightSchema,
  EvolutionPrioritySchema,
  EvolutionProposalSchema,
} from './episode-schemas.ts';
import { EvolutionMetricValuesSchema } from './result-schemas.ts';
import type { EvolutionEpisodeService } from './episode-service.ts';
import type { EvolutionScopeService } from './scope-service.ts';

export interface EvolutionEpisodeOperationDependencies extends EvolutionAdmissionDependencies {
  readonly episodeService: Pick<
    EvolutionEpisodeService,
    | 'applyRollupGoalUpdate'
    | 'createFromEvidence'
    | 'createTaskFromProposal'
    | 'createTaskProposal'
    | 'getEpisode'
    | 'getLesson'
    | 'getTaskProposal'
    | 'updateEpisode'
    | 'updateLesson'
    | 'updateTaskProposal'
  >;
  readonly scopeService: Pick<EvolutionScopeService, 'getScope'>;
  readonly getGoal: (goalId: string) => { id: string; spaceId: string; type: SpaceGoalType } | null;
  readonly audit?: EvolutionAuditWriter;
}

const SCOPE_REJECTIONS = [...EVOLUTION_CALLER_REJECTIONS, 'scope_not_found'] as const;
const EPISODE_REJECTIONS = [...SCOPE_REJECTIONS, 'episode_not_found'] as const;
const LESSON_REJECTIONS = [...SCOPE_REJECTIONS, 'lesson_not_found'] as const;
const PROPOSAL_REJECTIONS = [...SCOPE_REJECTIONS, 'proposal_not_found'] as const;
const EPISODE_CREATE_REJECTIONS = [...SCOPE_REJECTIONS, 'episode_not_generated'] as const;
const EPISODE_UPDATE_REJECTIONS = [...EPISODE_REJECTIONS, 'episode_terminal'] as const;
const LESSON_UPDATE_REJECTIONS = [...LESSON_REJECTIONS, 'lesson_dismissed'] as const;
const PROPOSAL_UPDATE_REJECTIONS = [
  ...PROPOSAL_REJECTIONS,
  'proposal_created',
  'proposal_dismissed',
] as const;
const PROPOSAL_TASK_REJECTIONS = [...PROPOSAL_REJECTIONS, 'task_not_created'] as const;
const ROLLUP_REJECTIONS = [
  ...EPISODE_REJECTIONS,
  'rollup_already_applied',
  'episode_dismissed',
  'goal_not_recurring',
] as const;

type ScopeRejection = (typeof SCOPE_REJECTIONS)[number];
type EpisodeRejection = (typeof EPISODE_REJECTIONS)[number];
type LessonRejection = (typeof LESSON_REJECTIONS)[number];
type ProposalRejection = (typeof PROPOSAL_REJECTIONS)[number];
type EpisodeCreateRejection = (typeof EPISODE_CREATE_REJECTIONS)[number];
type EpisodeUpdateRejection = (typeof EPISODE_UPDATE_REJECTIONS)[number];
type LessonUpdateRejection = (typeof LESSON_UPDATE_REJECTIONS)[number];
type ProposalUpdateRejection = (typeof PROPOSAL_UPDATE_REJECTIONS)[number];
type ProposalTaskRejection = (typeof PROPOSAL_TASK_REJECTIONS)[number];
type RollupRejection = (typeof ROLLUP_REJECTIONS)[number];

const EVOLUTION_MUTATE_POLICY = {
  safetyClass: 'mutate',
  roles: ['ad_hoc_member', 'long_term_agent'],
} as const satisfies OperationPolicy;

const EVOLUTION_DESTRUCTIVE_POLICY = {
  safetyClass: 'destructive',
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

function failureDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function evolutionScopeInSpace(
  scopeId: string,
  spaceId: string | undefined,
  evolution: EvolutionEpisodeOperationDependencies
): EvolutionScope | null {
  const scope = evolution.scopeService.getScope(scopeId);
  return scope && (!spaceId || scope.spaceId === spaceId) ? scope : null;
}

export function requireEpisodeScope(
  input: { scopeId: string },
  scope: { spaceId?: string },
  evolution: EvolutionEpisodeOperationDependencies
): EvolutionGate<EvolutionScope, ScopeRejection> {
  const found = evolutionScopeInSpace(input.scopeId, scope.spaceId, evolution);
  return found
    ? { value: found }
    : denyEvolution('scope_not_found', `EvolutionScope not found: ${input.scopeId}`);
}

export function requireEvolutionEpisode(
  input: { episodeId: string },
  scope: { spaceId?: string },
  evolution: EvolutionEpisodeOperationDependencies
): EvolutionGate<EvolutionEpisode, EpisodeRejection> {
  const episode = evolution.episodeService.getEpisode(input.episodeId);
  if (!episode || !evolutionScopeInSpace(episode.scopeId, scope.spaceId, evolution)) {
    return denyEvolution('episode_not_found', `EvolutionEpisode not found: ${input.episodeId}`);
  }
  return { value: episode };
}

export function requireEvolutionLesson(
  input: { lessonId: string },
  scope: { spaceId?: string },
  evolution: EvolutionEpisodeOperationDependencies
): EvolutionGate<EvolutionLesson, LessonRejection> {
  const lesson = evolution.episodeService.getLesson(input.lessonId);
  if (!lesson || !evolutionScopeInSpace(lesson.scopeId, scope.spaceId, evolution)) {
    return denyEvolution('lesson_not_found', `EvolutionLesson not found: ${input.lessonId}`);
  }
  return { value: lesson };
}

export function requireEvolutionProposal(
  input: { proposalId: string },
  scope: { spaceId?: string },
  evolution: EvolutionEpisodeOperationDependencies
): EvolutionGate<TaskProposal, ProposalRejection> {
  const proposal = evolution.episodeService.getTaskProposal(input.proposalId);
  if (!proposal || !evolutionScopeInSpace(proposal.scopeId, scope.spaceId, evolution)) {
    return denyEvolution('proposal_not_found', `TaskProposal not found: ${input.proposalId}`);
  }
  return { value: proposal };
}

const EpisodeCreateInputSchema = z
  .object({
    ...ScopeTargeted,
    evidenceIds: z.array(z.string().min(1)).min(1),
    timeWindow: z.object({ start: z.number().int(), end: z.number().int() }).nullable().optional(),
    confirmLowConfidence: z.boolean().optional(),
  })
  .strict();

export async function applyEvolutionEpisodeCreate(
  input: z.infer<typeof EpisodeCreateInputSchema>,
  scope: EvolutionScope,
  caller: OperationCaller,
  evolution: EvolutionEpisodeOperationDependencies
): Promise<EvolutionGate<Record<string, unknown>, EpisodeCreateRejection>> {
  try {
    const result = await evolution.episodeService.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: input.evidenceIds,
      timeWindow: input.timeWindow,
      confirmLowConfidence: input.confirmLowConfidence,
    });
    evolution.audit?.({
      toolName: 'evolution.episode.create',
      paramsSummary: { scopeId: scope.id, evidenceCount: input.evidenceIds.length },
      caller,
      spaceId: scope.spaceId,
    });
    return { value: { accepted: true, ...result } };
  } catch (err) {
    return denyEvolution('episode_not_generated', failureDetail(err));
  }
}

const EpisodeUpdateInputSchema = z
  .object({
    ...SpaceScoped,
    episodeId: z.string().min(1),
    status: EvolutionEpisodeStatusSchema.optional(),
    title: z.string().min(1).optional(),
    outcomeSummary: z.string().optional(),
  })
  .strict();

export function applyEvolutionEpisodeUpdate(
  input: z.infer<typeof EpisodeUpdateInputSchema>,
  existing: EvolutionEpisode,
  caller: OperationCaller,
  evolution: EvolutionEpisodeOperationDependencies
): EvolutionGate<{ accepted: true; episode: EvolutionEpisode }, EpisodeUpdateRejection> {
  if (existing.status !== 'draft' && input.status && input.status !== existing.status) {
    return denyEvolution('episode_terminal', 'Terminal Evolution episodes cannot be reopened');
  }
  const episode = evolution.episodeService.updateEpisode(existing.id, {
    status: input.status,
    title: input.title,
    outcomeSummary: input.outcomeSummary,
  });
  evolution.audit?.({
    toolName: 'evolution.episode.update',
    paramsSummary: { episodeId: existing.id, status: input.status },
    caller,
    spaceId: evolution.scopeService.getScope(existing.scopeId)?.spaceId,
  });
  return episode
    ? { value: { accepted: true, episode } }
    : denyEvolution('episode_not_found', `EvolutionEpisode not found: ${existing.id}`);
}

const LessonUpdateInputSchema = z
  .object({
    ...SpaceScoped,
    lessonId: z.string().min(1),
    status: EvolutionLessonStatusSchema.optional(),
    appliesTo: z.array(z.string()).optional(),
    rule: z.string().min(1).optional(),
    why: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

export function applyEvolutionLessonUpdate(
  input: z.infer<typeof LessonUpdateInputSchema>,
  existing: EvolutionLesson,
  caller: OperationCaller,
  evolution: EvolutionEpisodeOperationDependencies
): EvolutionGate<{ accepted: true; lesson: EvolutionLesson }, LessonUpdateRejection> {
  if (existing.status === 'dismissed' && input.status && input.status !== 'dismissed') {
    return denyEvolution('lesson_dismissed', 'Dismissed lessons cannot be reactivated');
  }
  const lesson = evolution.episodeService.updateLesson(existing.id, {
    status: input.status,
    appliesTo: input.appliesTo,
    rule: input.rule,
    why: input.why,
    confidence: input.confidence,
  });
  evolution.audit?.({
    toolName: 'evolution.lesson.update',
    paramsSummary: { lessonId: existing.id, status: input.status },
    caller,
    spaceId: evolution.scopeService.getScope(existing.scopeId)?.spaceId,
  });
  return lesson
    ? { value: { accepted: true, lesson } }
    : denyEvolution('lesson_not_found', `EvolutionLesson not found: ${existing.id}`);
}

const ProposalCreateInputSchema = z
  .object({
    ...ScopeTargeted,
    title: z.string().min(1),
    description: z.string(),
    reason: z.string(),
    priority: EvolutionPrioritySchema.optional(),
    evidenceEpisodeIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

export function applyEvolutionProposalCreate(
  input: z.infer<typeof ProposalCreateInputSchema>,
  scope: EvolutionScope,
  caller: OperationCaller,
  evolution: EvolutionEpisodeOperationDependencies
): EvolutionGate<{ accepted: true; proposal: TaskProposal }, EpisodeRejection> {
  for (const episodeId of input.evidenceEpisodeIds ?? []) {
    const episode = evolution.episodeService.getEpisode(episodeId);
    if (!episode || episode.scopeId !== scope.id) {
      return denyEvolution(
        'episode_not_found',
        `EvolutionEpisode not found in scope: ${episodeId}`
      );
    }
  }
  const proposal = evolution.episodeService.createTaskProposal({
    scopeId: scope.id,
    title: input.title,
    description: input.description,
    reason: input.reason,
    priority: input.priority,
    evidenceEpisodeIds: input.evidenceEpisodeIds,
  });
  evolution.audit?.({
    toolName: 'evolution.proposal.create',
    paramsSummary: { scopeId: scope.id, title: input.title },
    caller,
    spaceId: scope.spaceId,
  });
  return { value: { accepted: true, proposal } };
}

const ProposalUpdateInputSchema = z
  .object({
    ...SpaceScoped,
    proposalId: z.string().min(1),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    reason: z.string().optional(),
    priority: EvolutionPrioritySchema.optional(),
    status: z.enum(['proposed', 'accepted', 'dismissed']).optional(),
  })
  .strict();

export function applyEvolutionProposalUpdate(
  input: z.infer<typeof ProposalUpdateInputSchema>,
  existing: TaskProposal,
  caller: OperationCaller,
  evolution: EvolutionEpisodeOperationDependencies
): EvolutionGate<{ accepted: true; proposal: TaskProposal }, ProposalUpdateRejection> {
  if (existing.status === 'created' && input.status) {
    return denyEvolution('proposal_created', 'Created task proposals cannot be reopened');
  }
  if (existing.status === 'dismissed' && input.status && input.status !== 'dismissed') {
    return denyEvolution('proposal_dismissed', 'Dismissed proposals cannot be reopened');
  }
  const proposal = evolution.episodeService.updateTaskProposal(existing.id, {
    title: input.title,
    description: input.description,
    reason: input.reason,
    priority: input.priority,
    status: input.status,
  });
  evolution.audit?.({
    toolName: 'evolution.proposal.update',
    paramsSummary: { proposalId: existing.id, status: input.status },
    caller,
    spaceId: evolution.scopeService.getScope(existing.scopeId)?.spaceId,
  });
  return proposal
    ? { value: { accepted: true, proposal } }
    : denyEvolution('proposal_not_found', `TaskProposal not found: ${existing.id}`);
}

const ProposalCreateTaskInputSchema = z
  .object({
    ...SpaceScoped,
    proposalId: z.string().min(1),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    reason: z.string().optional(),
    priority: EvolutionPrioritySchema.optional(),
    dependsOn: z.array(z.string().min(1)).optional(),
  })
  .strict();

export function applyEvolutionProposalTask(
  input: z.infer<typeof ProposalCreateTaskInputSchema>,
  existing: TaskProposal,
  caller: OperationCaller,
  evolution: EvolutionEpisodeOperationDependencies
): EvolutionGate<Record<string, unknown>, ProposalTaskRejection> {
  try {
    const result = evolution.episodeService.createTaskFromProposal(existing.id, {
      title: input.title,
      description: input.description,
      reason: input.reason,
      priority: input.priority,
      dependsOn: input.dependsOn,
    });
    evolution.audit?.({
      toolName: 'evolution.proposal.task.create',
      paramsSummary: { proposalId: existing.id, dependsOn: input.dependsOn },
      caller,
      spaceId: result.task.spaceId,
      taskId: result.task.id,
    });
    return { value: { accepted: true, ...result } };
  } catch (err) {
    return denyEvolution('task_not_created', failureDetail(err));
  }
}

const RollupApplyInputSchema = z
  .object({
    ...SpaceScoped,
    episodeId: z.string().min(1),
    goalUpdate: z
      .object({
        summary: z.string().optional(),
        progress: z.number().int().min(0).max(100).optional(),
        nextSteps: z.array(z.string()).optional(),
        metrics: EvolutionMetricValuesSchema.optional(),
      })
      .strict(),
  })
  .strict();

export function applyEvolutionRollup(
  input: z.infer<typeof RollupApplyInputSchema>,
  episode: EvolutionEpisode,
  caller: OperationCaller,
  evolution: EvolutionEpisodeOperationDependencies
): EvolutionGate<Record<string, unknown>, RollupRejection> {
  if (episode.rollupAppliedAt !== null) {
    return denyEvolution('rollup_already_applied', 'Episode rollup already applied');
  }
  if (episode.status === 'dismissed') {
    return denyEvolution('episode_dismissed', 'Dismissed episode cannot accept rollup');
  }
  const scope = evolution.scopeService.getScope(episode.scopeId);
  const goal = scope?.spaceGoalId ? evolution.getGoal(scope.spaceGoalId) : null;
  if (!scope || !goal || goal.spaceId !== scope.spaceId || goal.type !== 'recurring') {
    return denyEvolution('goal_not_recurring', 'Episode scope is not linked to a recurring goal');
  }
  const result = evolution.episodeService.applyRollupGoalUpdate({
    episodeId: episode.id,
    goalUpdate: input.goalUpdate,
  });
  evolution.audit?.({
    toolName: 'evolution.rollup.apply',
    paramsSummary: { episodeId: episode.id },
    caller,
    spaceId: scope.spaceId,
  });
  return { value: { accepted: true, ...result } };
}

export function createEvolutionEpisodeOperations(evolution: EvolutionEpisodeOperationDependencies) {
  const episodeCreate = (superpipe({ evolution })('evolution-episode-create') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitEvolutionMutator, ['input', 'caller', 'evolution'], 'result:outcome')
    .pipe(requireEpisodeScope, ['input', 'outcome', 'evolution'], 'result:outcome')
    .pipe(
      applyEvolutionEpisodeCreate,
      ['input', 'outcome', 'caller', 'evolution'],
      'result:outcome'
    )
    .endAsync('outcome');

  const episodeUpdate = (superpipe({ evolution })('evolution-episode-update') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitEvolutionMutator, ['input', 'caller', 'evolution'], 'result:outcome')
    .pipe(requireEvolutionEpisode, ['input', 'outcome', 'evolution'], 'result:outcome')
    .pipe(
      applyEvolutionEpisodeUpdate,
      ['input', 'outcome', 'caller', 'evolution'],
      'result:outcome'
    )
    .endAsync('outcome');

  const lessonUpdate = (superpipe({ evolution })('evolution-lesson-update') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitEvolutionMutator, ['input', 'caller', 'evolution'], 'result:outcome')
    .pipe(requireEvolutionLesson, ['input', 'outcome', 'evolution'], 'result:outcome')
    .pipe(applyEvolutionLessonUpdate, ['input', 'outcome', 'caller', 'evolution'], 'result:outcome')
    .endAsync('outcome');

  const proposalCreate = (superpipe({ evolution })('evolution-proposal-create') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitEvolutionMutator, ['input', 'caller', 'evolution'], 'result:outcome')
    .pipe(requireEpisodeScope, ['input', 'outcome', 'evolution'], 'result:outcome')
    .pipe(
      applyEvolutionProposalCreate,
      ['input', 'outcome', 'caller', 'evolution'],
      'result:outcome'
    )
    .endAsync('outcome');

  const proposalUpdate = (superpipe({ evolution })('evolution-proposal-update') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitEvolutionMutator, ['input', 'caller', 'evolution'], 'result:outcome')
    .pipe(requireEvolutionProposal, ['input', 'outcome', 'evolution'], 'result:outcome')
    .pipe(
      applyEvolutionProposalUpdate,
      ['input', 'outcome', 'caller', 'evolution'],
      'result:outcome'
    )
    .endAsync('outcome');

  const proposalTask = (superpipe({ evolution })('evolution-proposal-create-task') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitEvolutionMutator, ['input', 'caller', 'evolution'], 'result:outcome')
    .pipe(requireEvolutionProposal, ['input', 'outcome', 'evolution'], 'result:outcome')
    .pipe(applyEvolutionProposalTask, ['input', 'outcome', 'caller', 'evolution'], 'result:outcome')
    .endAsync('outcome');

  const rollupApply = (superpipe({ evolution })('evolution-rollup-apply') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitEvolutionMutator, ['input', 'caller', 'evolution'], 'result:outcome')
    .pipe(requireEvolutionEpisode, ['input', 'outcome', 'evolution'], 'result:outcome')
    .pipe(applyEvolutionRollup, ['input', 'outcome', 'caller', 'evolution'], 'result:outcome')
    .endAsync('outcome');

  return [
    defineOperation({
      name: 'evolution.episode.create',
      policy: EVOLUTION_MUTATE_POLICY,
      description:
        'Generate a draft Evolution episode from selected evidence through the episode judge, returning the episode with its candidate lessons, task proposals, and the evidence-quality preflight. Set confirmLowConfidence when the preflight warns that evidence is thin. Rejects scope_not_found, and episode_not_generated when the judge, model, or credentials fail (the cause is in detail).',
      inputSchema: EpisodeCreateInputSchema,
      resultSchema: z.union([
        accepted({
          episode: EvolutionEpisodeSchema,
          lessons: z.array(EvolutionLessonSchema),
          proposals: z.array(EvolutionProposalSchema),
          preflight: EvolutionPreflightSchema,
        }),
        evolutionDenialSchema(EPISODE_CREATE_REJECTIONS),
      ]),
      execute: async (input, caller) => episodeCreate(input, caller),
    }),
    defineOperation({
      name: 'evolution.episode.update',
      policy: EVOLUTION_MUTATE_POLICY,
      description:
        'Accept, dismiss, or edit an Evolution episode draft — accept and dismiss are terminal, so use them only after an explicit decision. Rejects episode_not_found and episode_terminal when the episode already left draft. Autonomy metadata: editing a draft needs the Space session-write level, and changing a terminal episode is destructive; enforcement lands with the autonomy subsystem.',
      inputSchema: EpisodeUpdateInputSchema,
      resultSchema: z.union([
        accepted({ episode: EvolutionEpisodeSchema }),
        evolutionDenialSchema(EPISODE_UPDATE_REJECTIONS),
      ]),
      execute: async (input, caller) => episodeUpdate(input, caller),
    }),
    defineOperation({
      name: 'evolution.lesson.update',
      policy: EVOLUTION_MUTATE_POLICY,
      description:
        'Activate, dismiss, or edit a candidate Evolution lesson — activation is never implicit, it takes this call. Rejects lesson_not_found and lesson_dismissed, since a dismissed lesson cannot be reactivated. Autonomy metadata: editing a candidate needs the Space session-write level, and changing an active or dismissed lesson is destructive; enforcement lands with the autonomy subsystem.',
      inputSchema: LessonUpdateInputSchema,
      resultSchema: z.union([
        accepted({ lesson: EvolutionLessonSchema }),
        evolutionDenialSchema(LESSON_UPDATE_REJECTIONS),
      ]),
      execute: async (input, caller) => lessonUpdate(input, caller),
    }),
    defineOperation({
      name: 'evolution.proposal.create',
      policy: EVOLUTION_MUTATE_POLICY,
      description:
        'Create an Evolution task proposal on a scope by hand. This does not create a Space task; evolution.proposal.task.create does that in a separate, explicit step. Rejects scope_not_found and episode_not_found when a cited evidence episode is missing or belongs to another scope.',
      inputSchema: ProposalCreateInputSchema,
      resultSchema: z.union([
        accepted({ proposal: EvolutionProposalSchema }),
        evolutionDenialSchema(EPISODE_REJECTIONS),
      ]),
      execute: async (input, caller) => proposalCreate(input, caller),
    }),
    defineOperation({
      name: 'evolution.proposal.update',
      policy: EVOLUTION_MUTATE_POLICY,
      description:
        'Edit, accept, or dismiss an Evolution task proposal. The created status is not settable here — call evolution.proposal.task.create to turn a proposal into a real task. Rejects proposal_not_found, proposal_created, and proposal_dismissed, since neither terminal state reopens. Autonomy metadata: editing a proposed record needs the Space session-write level, and changing an accepted or dismissed one is destructive; enforcement lands with the autonomy subsystem.',
      inputSchema: ProposalUpdateInputSchema,
      resultSchema: z.union([
        accepted({ proposal: EvolutionProposalSchema }),
        evolutionDenialSchema(PROPOSAL_UPDATE_REJECTIONS),
      ]),
      execute: async (input, caller) => proposalUpdate(input, caller),
    }),
    defineOperation({
      name: 'evolution.proposal.task.create',
      policy: EVOLUTION_DESTRUCTIVE_POLICY,
      description:
        'Create a real Space task from an Evolution proposal, preserving the linked goal and scope bindings and attaching dependencies during creation. Idempotent: a proposal already marked created returns its existing task. Rejects proposal_not_found, and task_not_created when the proposal was dismissed, a dependency is invalid, or a concurrent call already claimed it (the cause is in detail). Autonomy metadata: this is a destructive action at the Space session-write level; enforcement lands with the autonomy subsystem.',
      inputSchema: ProposalCreateTaskInputSchema,
      resultSchema: z.union([
        accepted({ proposal: EvolutionProposalSchema, task: TaskWithSpaceFieldsSchema }),
        evolutionDenialSchema(PROPOSAL_TASK_REJECTIONS),
      ]),
      execute: async (input, caller) => proposalTask(input, caller),
    }),
    defineOperation({
      name: 'evolution.rollup.apply',
      policy: EVOLUTION_DESTRUCTIVE_POLICY,
      description:
        "Accept an Evolution episode and roll its summary, next steps, and metrics into the recurring goal behind the episode's scope. Progress is not rolled up. Rejects episode_not_found, rollup_already_applied, episode_dismissed, and goal_not_recurring when the scope has no recurring goal. Autonomy metadata: this is a destructive action at the Space session-write level; enforcement lands with the autonomy subsystem.",
      inputSchema: RollupApplyInputSchema,
      resultSchema: z.union([
        accepted({ episode: EvolutionEpisodeSchema, goal: EvolutionGoalSchema }),
        evolutionDenialSchema(ROLLUP_REJECTIONS),
      ]),
      execute: async (input, caller) => rollupApply(input, caller),
    }),
  ];
}
