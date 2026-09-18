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
  admitForgeMutator,
  admitForgeReader,
  denyForge,
  FORGE_CALLER_REJECTIONS,
  forgeDenialSchema,
  type ForgeAdmissionDependencies,
  type ForgeAuditWriter,
  type ForgeGate,
} from './forge-admission.ts';
import {
  ForgeEpisodeSchema,
  ForgeEpisodeStatusSchema,
  ForgeGoalSchema,
  ForgeLessonSchema,
  ForgeLessonStatusSchema,
  ForgePreflightSchema,
  ForgePrioritySchema,
  ForgeProposalSchema,
  ForgeProposalStatusSchema,
} from './forge-episode-schemas.ts';
import { ForgeMetricValuesSchema } from './forge-result-schemas.ts';
import type { EvolutionEpisodeService } from './episode-service.ts';
import type { EvolutionScopeService } from './scope-service.ts';

export interface ForgeEpisodeOperationDependencies extends ForgeAdmissionDependencies {
  readonly episodeService: Pick<
    EvolutionEpisodeService,
    | 'applyRollupGoalUpdate'
    | 'createFromEvidence'
    | 'createTaskFromProposal'
    | 'createTaskProposal'
    | 'getEpisode'
    | 'getLesson'
    | 'getTaskProposal'
    | 'listLessons'
    | 'listReviewBundle'
    | 'listTaskProposals'
    | 'updateEpisode'
    | 'updateLesson'
    | 'updateTaskProposal'
  >;
  readonly scopeService: Pick<EvolutionScopeService, 'getScope'>;
  readonly getGoal: (goalId: string) => { id: string; spaceId: string; type: SpaceGoalType } | null;
  readonly audit?: ForgeAuditWriter;
}

const SCOPE_REJECTIONS = [...FORGE_CALLER_REJECTIONS, 'scope_not_found'] as const;
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

const FORGE_READ_POLICY = {
  safetyClass: 'read',
  roles: ['ad_hoc_member', 'long_term_agent', 'universal_read'],
} as const satisfies OperationPolicy;

const FORGE_MUTATE_POLICY = {
  safetyClass: 'mutate',
  roles: ['ad_hoc_member', 'long_term_agent'],
} as const satisfies OperationPolicy;

const FORGE_DESTRUCTIVE_POLICY = {
  safetyClass: 'destructive',
  roles: ['ad_hoc_member', 'long_term_agent'],
} as const satisfies OperationPolicy;

const SpaceScoped = { spaceId: z.string().min(1).optional() };
const ScopeTargeted = { ...SpaceScoped, scopeId: z.string().min(1) };

function accepted<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object({ accepted: z.literal(true), ...shape });
}

function failureDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function forgeScopeInSpace(
  scopeId: string,
  spaceId: string | undefined,
  forge: ForgeEpisodeOperationDependencies
): EvolutionScope | null {
  const scope = forge.scopeService.getScope(scopeId);
  return scope && (!spaceId || scope.spaceId === spaceId) ? scope : null;
}

export function requireEpisodeScope(
  input: { scopeId: string },
  scope: { spaceId?: string },
  forge: ForgeEpisodeOperationDependencies
): ForgeGate<EvolutionScope, ScopeRejection> {
  const found = forgeScopeInSpace(input.scopeId, scope.spaceId, forge);
  return found
    ? { value: found }
    : denyForge('scope_not_found', `EvolutionScope not found: ${input.scopeId}`);
}

export function requireForgeEpisode(
  input: { episodeId: string },
  scope: { spaceId?: string },
  forge: ForgeEpisodeOperationDependencies
): ForgeGate<EvolutionEpisode, EpisodeRejection> {
  const episode = forge.episodeService.getEpisode(input.episodeId);
  if (!episode || !forgeScopeInSpace(episode.scopeId, scope.spaceId, forge)) {
    return denyForge('episode_not_found', `EvolutionEpisode not found: ${input.episodeId}`);
  }
  return { value: episode };
}

export function requireForgeLesson(
  input: { lessonId: string },
  scope: { spaceId?: string },
  forge: ForgeEpisodeOperationDependencies
): ForgeGate<EvolutionLesson, LessonRejection> {
  const lesson = forge.episodeService.getLesson(input.lessonId);
  if (!lesson || !forgeScopeInSpace(lesson.scopeId, scope.spaceId, forge)) {
    return denyForge('lesson_not_found', `EvolutionLesson not found: ${input.lessonId}`);
  }
  return { value: lesson };
}

export function requireForgeProposal(
  input: { proposalId: string },
  scope: { spaceId?: string },
  forge: ForgeEpisodeOperationDependencies
): ForgeGate<TaskProposal, ProposalRejection> {
  const proposal = forge.episodeService.getTaskProposal(input.proposalId);
  if (!proposal || !forgeScopeInSpace(proposal.scopeId, scope.spaceId, forge)) {
    return denyForge('proposal_not_found', `TaskProposal not found: ${input.proposalId}`);
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

export async function applyForgeEpisodeCreate(
  input: z.infer<typeof EpisodeCreateInputSchema>,
  scope: EvolutionScope,
  caller: OperationCaller,
  forge: ForgeEpisodeOperationDependencies
): Promise<ForgeGate<Record<string, unknown>, EpisodeCreateRejection>> {
  try {
    const result = await forge.episodeService.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: input.evidenceIds,
      timeWindow: input.timeWindow,
      confirmLowConfidence: input.confirmLowConfidence,
    });
    forge.audit?.({
      toolName: 'forge.episode.create',
      paramsSummary: { scopeId: scope.id, evidenceCount: input.evidenceIds.length },
      caller,
      spaceId: scope.spaceId,
    });
    return { value: { accepted: true, ...result } };
  } catch (err) {
    return denyForge('episode_not_generated', failureDetail(err));
  }
}

export function readForgeReviewBundle(
  scope: EvolutionScope,
  forge: ForgeEpisodeOperationDependencies
): Record<string, unknown> {
  return { accepted: true, ...forge.episodeService.listReviewBundle(scope.id) };
}

const LessonListInputSchema = z
  .object({ ...ScopeTargeted, status: ForgeLessonStatusSchema.optional() })
  .strict();

export function readForgeLessons(
  input: z.infer<typeof LessonListInputSchema>,
  scope: EvolutionScope,
  caller: OperationCaller,
  forge: ForgeEpisodeOperationDependencies
): { accepted: true; lessons: EvolutionLesson[] } {
  const lessons = forge.episodeService.listLessons(scope.id, input.status);
  forge.audit?.({
    toolName: 'forge.lesson.list',
    paramsSummary: { scopeId: scope.id, status: input.status },
    caller,
    spaceId: scope.spaceId,
  });
  return { accepted: true, lessons };
}

const ProposalListInputSchema = z
  .object({ ...ScopeTargeted, status: ForgeProposalStatusSchema.optional() })
  .strict();

export function readForgeProposals(
  input: z.infer<typeof ProposalListInputSchema>,
  scope: EvolutionScope,
  caller: OperationCaller,
  forge: ForgeEpisodeOperationDependencies
): { accepted: true; proposals: TaskProposal[] } {
  const proposals = forge.episodeService.listTaskProposals(scope.id, input.status);
  forge.audit?.({
    toolName: 'forge.proposal.list',
    paramsSummary: { scopeId: scope.id, status: input.status },
    caller,
    spaceId: scope.spaceId,
  });
  return { accepted: true, proposals };
}

const EpisodeUpdateInputSchema = z
  .object({
    ...SpaceScoped,
    episodeId: z.string().min(1),
    status: ForgeEpisodeStatusSchema.optional(),
    title: z.string().min(1).optional(),
    outcomeSummary: z.string().optional(),
  })
  .strict();

export function applyForgeEpisodeUpdate(
  input: z.infer<typeof EpisodeUpdateInputSchema>,
  existing: EvolutionEpisode,
  caller: OperationCaller,
  forge: ForgeEpisodeOperationDependencies
): ForgeGate<{ accepted: true; episode: EvolutionEpisode }, EpisodeUpdateRejection> {
  if (existing.status !== 'draft' && input.status && input.status !== existing.status) {
    return denyForge('episode_terminal', 'Terminal Forge episodes cannot be reopened');
  }
  const episode = forge.episodeService.updateEpisode(existing.id, {
    status: input.status,
    title: input.title,
    outcomeSummary: input.outcomeSummary,
  });
  forge.audit?.({
    toolName: 'forge.episode.update',
    paramsSummary: { episodeId: existing.id, status: input.status },
    caller,
    spaceId: forge.scopeService.getScope(existing.scopeId)?.spaceId,
  });
  return episode
    ? { value: { accepted: true, episode } }
    : denyForge('episode_not_found', `EvolutionEpisode not found: ${existing.id}`);
}

const LessonUpdateInputSchema = z
  .object({
    ...SpaceScoped,
    lessonId: z.string().min(1),
    status: ForgeLessonStatusSchema.optional(),
    appliesTo: z.array(z.string()).optional(),
    rule: z.string().min(1).optional(),
    why: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

export function applyForgeLessonUpdate(
  input: z.infer<typeof LessonUpdateInputSchema>,
  existing: EvolutionLesson,
  caller: OperationCaller,
  forge: ForgeEpisodeOperationDependencies
): ForgeGate<{ accepted: true; lesson: EvolutionLesson }, LessonUpdateRejection> {
  if (existing.status === 'dismissed' && input.status && input.status !== 'dismissed') {
    return denyForge('lesson_dismissed', 'Dismissed lessons cannot be reactivated');
  }
  const lesson = forge.episodeService.updateLesson(existing.id, {
    status: input.status,
    appliesTo: input.appliesTo,
    rule: input.rule,
    why: input.why,
    confidence: input.confidence,
  });
  forge.audit?.({
    toolName: 'forge.lesson.update',
    paramsSummary: { lessonId: existing.id, status: input.status },
    caller,
    spaceId: forge.scopeService.getScope(existing.scopeId)?.spaceId,
  });
  return lesson
    ? { value: { accepted: true, lesson } }
    : denyForge('lesson_not_found', `EvolutionLesson not found: ${existing.id}`);
}

const ProposalCreateInputSchema = z
  .object({
    ...ScopeTargeted,
    title: z.string().min(1),
    description: z.string(),
    reason: z.string(),
    priority: ForgePrioritySchema.optional(),
    evidenceEpisodeIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

export function applyForgeProposalCreate(
  input: z.infer<typeof ProposalCreateInputSchema>,
  scope: EvolutionScope,
  caller: OperationCaller,
  forge: ForgeEpisodeOperationDependencies
): ForgeGate<{ accepted: true; proposal: TaskProposal }, EpisodeRejection> {
  for (const episodeId of input.evidenceEpisodeIds ?? []) {
    const episode = forge.episodeService.getEpisode(episodeId);
    if (!episode || episode.scopeId !== scope.id) {
      return denyForge('episode_not_found', `EvolutionEpisode not found in scope: ${episodeId}`);
    }
  }
  const proposal = forge.episodeService.createTaskProposal({
    scopeId: scope.id,
    title: input.title,
    description: input.description,
    reason: input.reason,
    priority: input.priority,
    evidenceEpisodeIds: input.evidenceEpisodeIds,
  });
  forge.audit?.({
    toolName: 'forge.proposal.create',
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
    priority: ForgePrioritySchema.optional(),
    status: z.enum(['proposed', 'accepted', 'dismissed']).optional(),
  })
  .strict();

export function applyForgeProposalUpdate(
  input: z.infer<typeof ProposalUpdateInputSchema>,
  existing: TaskProposal,
  caller: OperationCaller,
  forge: ForgeEpisodeOperationDependencies
): ForgeGate<{ accepted: true; proposal: TaskProposal }, ProposalUpdateRejection> {
  if (existing.status === 'created' && input.status) {
    return denyForge('proposal_created', 'Created task proposals cannot be reopened');
  }
  if (existing.status === 'dismissed' && input.status && input.status !== 'dismissed') {
    return denyForge('proposal_dismissed', 'Dismissed proposals cannot be reopened');
  }
  const proposal = forge.episodeService.updateTaskProposal(existing.id, {
    title: input.title,
    description: input.description,
    reason: input.reason,
    priority: input.priority,
    status: input.status,
  });
  forge.audit?.({
    toolName: 'forge.proposal.update',
    paramsSummary: { proposalId: existing.id, status: input.status },
    caller,
    spaceId: forge.scopeService.getScope(existing.scopeId)?.spaceId,
  });
  return proposal
    ? { value: { accepted: true, proposal } }
    : denyForge('proposal_not_found', `TaskProposal not found: ${existing.id}`);
}

const ProposalCreateTaskInputSchema = z
  .object({
    ...SpaceScoped,
    proposalId: z.string().min(1),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    reason: z.string().optional(),
    priority: ForgePrioritySchema.optional(),
    dependsOn: z.array(z.string().min(1)).optional(),
  })
  .strict();

export function applyForgeProposalTask(
  input: z.infer<typeof ProposalCreateTaskInputSchema>,
  existing: TaskProposal,
  caller: OperationCaller,
  forge: ForgeEpisodeOperationDependencies
): ForgeGate<Record<string, unknown>, ProposalTaskRejection> {
  try {
    const result = forge.episodeService.createTaskFromProposal(existing.id, {
      title: input.title,
      description: input.description,
      reason: input.reason,
      priority: input.priority,
      dependsOn: input.dependsOn,
    });
    forge.audit?.({
      toolName: 'forge.proposal.createTask',
      paramsSummary: { proposalId: existing.id, dependsOn: input.dependsOn },
      caller,
      spaceId: result.task.spaceId,
      taskId: result.task.id,
    });
    return { value: { accepted: true, ...result } };
  } catch (err) {
    return denyForge('task_not_created', failureDetail(err));
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
        metrics: ForgeMetricValuesSchema.optional(),
      })
      .strict(),
  })
  .strict();

export function applyForgeRollup(
  input: z.infer<typeof RollupApplyInputSchema>,
  episode: EvolutionEpisode,
  caller: OperationCaller,
  forge: ForgeEpisodeOperationDependencies
): ForgeGate<Record<string, unknown>, RollupRejection> {
  if (episode.rollupAppliedAt !== null) {
    return denyForge('rollup_already_applied', 'Episode rollup already applied');
  }
  if (episode.status === 'dismissed') {
    return denyForge('episode_dismissed', 'Dismissed episode cannot accept rollup');
  }
  const scope = forge.scopeService.getScope(episode.scopeId);
  const goal = scope?.spaceGoalId ? forge.getGoal(scope.spaceGoalId) : null;
  if (!scope || !goal || goal.spaceId !== scope.spaceId || goal.type !== 'recurring') {
    return denyForge('goal_not_recurring', 'Episode scope is not linked to a recurring goal');
  }
  const result = forge.episodeService.applyRollupGoalUpdate({
    episodeId: episode.id,
    goalUpdate: input.goalUpdate,
  });
  forge.audit?.({
    toolName: 'forge.rollup.apply',
    paramsSummary: { episodeId: episode.id },
    caller,
    spaceId: scope.spaceId,
  });
  return { value: { accepted: true, ...result } };
}

export function createForgeEpisodeOperations(forge: ForgeEpisodeOperationDependencies) {
  const episodeCreate = (superpipe({ forge })('forge-episode-create') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeMutator, ['input', 'caller', 'forge'], 'result:outcome')
    .pipe(requireEpisodeScope, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(applyForgeEpisodeCreate, ['input', 'outcome', 'caller', 'forge'], 'result:outcome')
    .endAsync('outcome');

  const reviewBundle = (superpipe({ forge })('forge-review-bundle-list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeReader, ['input', 'caller'], 'result:outcome')
    .pipe(requireEpisodeScope, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(readForgeReviewBundle, ['outcome', 'forge'], 'outcome')
    .endAsync('outcome');

  const lessonList = (superpipe({ forge })('forge-lesson-list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeReader, ['input', 'caller'], 'result:outcome')
    .pipe(requireEpisodeScope, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(readForgeLessons, ['input', 'outcome', 'caller', 'forge'], 'outcome')
    .endAsync('outcome');

  const proposalList = (superpipe({ forge })('forge-proposal-list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeReader, ['input', 'caller'], 'result:outcome')
    .pipe(requireEpisodeScope, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(readForgeProposals, ['input', 'outcome', 'caller', 'forge'], 'outcome')
    .endAsync('outcome');

  const episodeUpdate = (superpipe({ forge })('forge-episode-update') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeMutator, ['input', 'caller', 'forge'], 'result:outcome')
    .pipe(requireForgeEpisode, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(applyForgeEpisodeUpdate, ['input', 'outcome', 'caller', 'forge'], 'result:outcome')
    .endAsync('outcome');

  const lessonUpdate = (superpipe({ forge })('forge-lesson-update') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeMutator, ['input', 'caller', 'forge'], 'result:outcome')
    .pipe(requireForgeLesson, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(applyForgeLessonUpdate, ['input', 'outcome', 'caller', 'forge'], 'result:outcome')
    .endAsync('outcome');

  const proposalCreate = (superpipe({ forge })('forge-proposal-create') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeMutator, ['input', 'caller', 'forge'], 'result:outcome')
    .pipe(requireEpisodeScope, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(applyForgeProposalCreate, ['input', 'outcome', 'caller', 'forge'], 'result:outcome')
    .endAsync('outcome');

  const proposalUpdate = (superpipe({ forge })('forge-proposal-update') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeMutator, ['input', 'caller', 'forge'], 'result:outcome')
    .pipe(requireForgeProposal, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(applyForgeProposalUpdate, ['input', 'outcome', 'caller', 'forge'], 'result:outcome')
    .endAsync('outcome');

  const proposalTask = (superpipe({ forge })('forge-proposal-create-task') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeMutator, ['input', 'caller', 'forge'], 'result:outcome')
    .pipe(requireForgeProposal, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(applyForgeProposalTask, ['input', 'outcome', 'caller', 'forge'], 'result:outcome')
    .endAsync('outcome');

  const rollupApply = (superpipe({ forge })('forge-rollup-apply') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeMutator, ['input', 'caller', 'forge'], 'result:outcome')
    .pipe(requireForgeEpisode, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(applyForgeRollup, ['input', 'outcome', 'caller', 'forge'], 'result:outcome')
    .endAsync('outcome');

  return [
    defineOperation({
      name: 'forge.episode.create',
      policy: { ...FORGE_MUTATE_POLICY, audit: { selfAudited: true } },
      description:
        'Generate a draft Forge episode from selected evidence through the episode judge, returning the episode with its candidate lessons, task proposals, and the evidence-quality preflight. Set confirmLowConfidence when the preflight warns that evidence is thin. Rejects scope_not_found, and episode_not_generated when the judge, model, or credentials fail (the cause is in detail).',
      inputSchema: EpisodeCreateInputSchema,
      resultSchema: z.union([
        accepted({
          episode: ForgeEpisodeSchema,
          lessons: z.array(ForgeLessonSchema),
          proposals: z.array(ForgeProposalSchema),
          preflight: ForgePreflightSchema,
        }),
        forgeDenialSchema(EPISODE_CREATE_REJECTIONS),
      ]),
      execute: async (input, caller) => episodeCreate(input, caller),
    }),
    defineOperation({
      name: 'forge.reviewBundle.list',
      policy: FORGE_READ_POLICY,
      description:
        'Read everything needed to review a Forge scope in one call: its episodes, lessons, and task proposals. Rejects scope_not_found when the scope is absent or outside the caller Space.',
      inputSchema: z.object(ScopeTargeted).strict(),
      resultSchema: z.union([
        accepted({
          episodes: z.array(ForgeEpisodeSchema),
          lessons: z.array(ForgeLessonSchema),
          proposals: z.array(ForgeProposalSchema),
        }),
        forgeDenialSchema(SCOPE_REJECTIONS),
      ]),
      execute: async (input, caller) => reviewBundle(input, caller),
    }),
    defineOperation({
      name: 'forge.lesson.list',
      policy: { ...FORGE_READ_POLICY, audit: { selfAudited: true } },
      description:
        'List the lessons a Forge scope has accumulated, optionally filtered by status (candidate, active, dismissed). Rejects scope_not_found when the scope is absent or outside the caller Space.',
      inputSchema: LessonListInputSchema,
      resultSchema: z.union([
        accepted({ lessons: z.array(ForgeLessonSchema) }),
        forgeDenialSchema(SCOPE_REJECTIONS),
      ]),
      execute: async (input, caller) => lessonList(input, caller),
    }),
    defineOperation({
      name: 'forge.proposal.list',
      policy: { ...FORGE_READ_POLICY, audit: { selfAudited: true } },
      description:
        'List the task proposals on a Forge scope, optionally filtered by status (proposed, accepted, dismissed, created). Rejects scope_not_found when the scope is absent or outside the caller Space.',
      inputSchema: ProposalListInputSchema,
      resultSchema: z.union([
        accepted({ proposals: z.array(ForgeProposalSchema) }),
        forgeDenialSchema(SCOPE_REJECTIONS),
      ]),
      execute: async (input, caller) => proposalList(input, caller),
    }),
    defineOperation({
      name: 'forge.episode.update',
      policy: { ...FORGE_MUTATE_POLICY, audit: { selfAudited: true } },
      description:
        'Accept, dismiss, or edit a Forge episode draft — accept and dismiss are terminal, so use them only after an explicit decision. Rejects episode_not_found and episode_terminal when the episode already left draft. Autonomy metadata: editing a draft needs the Space session-write level, and changing a terminal episode is destructive; enforcement lands with the autonomy subsystem.',
      inputSchema: EpisodeUpdateInputSchema,
      resultSchema: z.union([
        accepted({ episode: ForgeEpisodeSchema }),
        forgeDenialSchema(EPISODE_UPDATE_REJECTIONS),
      ]),
      execute: async (input, caller) => episodeUpdate(input, caller),
    }),
    defineOperation({
      name: 'forge.lesson.update',
      policy: { ...FORGE_MUTATE_POLICY, audit: { selfAudited: true } },
      description:
        'Activate, dismiss, or edit a candidate Forge lesson — activation is never implicit, it takes this call. Rejects lesson_not_found and lesson_dismissed, since a dismissed lesson cannot be reactivated. Autonomy metadata: editing a candidate needs the Space session-write level, and changing an active or dismissed lesson is destructive; enforcement lands with the autonomy subsystem.',
      inputSchema: LessonUpdateInputSchema,
      resultSchema: z.union([
        accepted({ lesson: ForgeLessonSchema }),
        forgeDenialSchema(LESSON_UPDATE_REJECTIONS),
      ]),
      execute: async (input, caller) => lessonUpdate(input, caller),
    }),
    defineOperation({
      name: 'forge.proposal.create',
      policy: { ...FORGE_MUTATE_POLICY, audit: { selfAudited: true } },
      description:
        'Create a Forge task proposal on a scope by hand. This does not create a Space task; forge.proposal.createTask does that in a separate, explicit step. Rejects scope_not_found and episode_not_found when a cited evidence episode is missing or belongs to another scope.',
      inputSchema: ProposalCreateInputSchema,
      resultSchema: z.union([
        accepted({ proposal: ForgeProposalSchema }),
        forgeDenialSchema(EPISODE_REJECTIONS),
      ]),
      execute: async (input, caller) => proposalCreate(input, caller),
    }),
    defineOperation({
      name: 'forge.proposal.update',
      policy: { ...FORGE_MUTATE_POLICY, audit: { selfAudited: true } },
      description:
        'Edit, accept, or dismiss a Forge task proposal. The created status is not settable here — call forge.proposal.createTask to turn a proposal into a real task. Rejects proposal_not_found, proposal_created, and proposal_dismissed, since neither terminal state reopens. Autonomy metadata: editing a proposed record needs the Space session-write level, and changing an accepted or dismissed one is destructive; enforcement lands with the autonomy subsystem.',
      inputSchema: ProposalUpdateInputSchema,
      resultSchema: z.union([
        accepted({ proposal: ForgeProposalSchema }),
        forgeDenialSchema(PROPOSAL_UPDATE_REJECTIONS),
      ]),
      execute: async (input, caller) => proposalUpdate(input, caller),
    }),
    defineOperation({
      name: 'forge.proposal.createTask',
      policy: { ...FORGE_DESTRUCTIVE_POLICY, audit: { selfAudited: true } },
      description:
        'Create a real Space task from a Forge proposal, preserving the linked goal and scope bindings and attaching dependencies during creation. Idempotent: a proposal already marked created returns its existing task. Rejects proposal_not_found, and task_not_created when the proposal was dismissed, a dependency is invalid, or a concurrent call already claimed it (the cause is in detail). Autonomy metadata: this is a destructive action at the Space session-write level; enforcement lands with the autonomy subsystem.',
      inputSchema: ProposalCreateTaskInputSchema,
      resultSchema: z.union([
        accepted({ proposal: ForgeProposalSchema, task: TaskWithSpaceFieldsSchema }),
        forgeDenialSchema(PROPOSAL_TASK_REJECTIONS),
      ]),
      execute: async (input, caller) => proposalTask(input, caller),
    }),
    defineOperation({
      name: 'forge.rollup.apply',
      policy: { ...FORGE_DESTRUCTIVE_POLICY, audit: { selfAudited: true } },
      description:
        "Accept a Forge episode and roll its summary, next steps, and metrics into the recurring goal behind the episode's scope. Progress is not rolled up. Rejects episode_not_found, rollup_already_applied, episode_dismissed, and goal_not_recurring when the scope has no recurring goal. Autonomy metadata: this is a destructive action at the Space session-write level; enforcement lands with the autonomy subsystem.",
      inputSchema: RollupApplyInputSchema,
      resultSchema: z.union([
        accepted({ episode: ForgeEpisodeSchema, goal: ForgeGoalSchema }),
        forgeDenialSchema(ROLLUP_REJECTIONS),
      ]),
      execute: async (input, caller) => rollupApply(input, caller),
    }),
  ];
}
