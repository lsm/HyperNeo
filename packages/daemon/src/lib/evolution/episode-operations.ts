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
  denyForge,
  FORGE_CALLER_REJECTIONS,
  forgeDenialSchema,
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

const FORGE_MUTATE_POLICY = {
  safetyClass: 'mutate',
  roles: ['ad_hoc_member', 'long_term_agent'],
} as const satisfies OperationPolicy;

const FORGE_DESTRUCTIVE_POLICY = {
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

function forgeScopeInSpace(
  scopeId: string,
  spaceId: string | undefined,
  forge: EvolutionEpisodeOperationDependencies
): EvolutionScope | null {
  const scope = forge.scopeService.getScope(scopeId);
  return scope && (!spaceId || scope.spaceId === spaceId) ? scope : null;
}

export function requireEpisodeScope(
  input: { scopeId: string },
  scope: { spaceId?: string },
  forge: EvolutionEpisodeOperationDependencies
): EvolutionGate<EvolutionScope, ScopeRejection> {
  const found = forgeScopeInSpace(input.scopeId, scope.spaceId, forge);
  return found
    ? { value: found }
    : denyForge('scope_not_found', `EvolutionScope not found: ${input.scopeId}`);
}

export function requireForgeEpisode(
  input: { episodeId: string },
  scope: { spaceId?: string },
  forge: EvolutionEpisodeOperationDependencies
): EvolutionGate<EvolutionEpisode, EpisodeRejection> {
  const episode = forge.episodeService.getEpisode(input.episodeId);
  if (!episode || !forgeScopeInSpace(episode.scopeId, scope.spaceId, forge)) {
    return denyForge('episode_not_found', `EvolutionEpisode not found: ${input.episodeId}`);
  }
  return { value: episode };
}

export function requireForgeLesson(
  input: { lessonId: string },
  scope: { spaceId?: string },
  forge: EvolutionEpisodeOperationDependencies
): EvolutionGate<EvolutionLesson, LessonRejection> {
  const lesson = forge.episodeService.getLesson(input.lessonId);
  if (!lesson || !forgeScopeInSpace(lesson.scopeId, scope.spaceId, forge)) {
    return denyForge('lesson_not_found', `EvolutionLesson not found: ${input.lessonId}`);
  }
  return { value: lesson };
}

export function requireForgeProposal(
  input: { proposalId: string },
  scope: { spaceId?: string },
  forge: EvolutionEpisodeOperationDependencies
): EvolutionGate<TaskProposal, ProposalRejection> {
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
  forge: EvolutionEpisodeOperationDependencies
): Promise<EvolutionGate<Record<string, unknown>, EpisodeCreateRejection>> {
  try {
    const result = await forge.episodeService.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: input.evidenceIds,
      timeWindow: input.timeWindow,
      confirmLowConfidence: input.confirmLowConfidence,
    });
    forge.audit?.({
      toolName: 'evolution.episode.create',
      paramsSummary: { scopeId: scope.id, evidenceCount: input.evidenceIds.length },
      caller,
      spaceId: scope.spaceId,
    });
    return { value: { accepted: true, ...result } };
  } catch (err) {
    return denyForge('episode_not_generated', failureDetail(err));
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

export function applyForgeEpisodeUpdate(
  input: z.infer<typeof EpisodeUpdateInputSchema>,
  existing: EvolutionEpisode,
  caller: OperationCaller,
  forge: EvolutionEpisodeOperationDependencies
): EvolutionGate<{ accepted: true; episode: EvolutionEpisode }, EpisodeUpdateRejection> {
  if (existing.status !== 'draft' && input.status && input.status !== existing.status) {
    return denyForge('episode_terminal', 'Terminal Forge episodes cannot be reopened');
  }
  const episode = forge.episodeService.updateEpisode(existing.id, {
    status: input.status,
    title: input.title,
    outcomeSummary: input.outcomeSummary,
  });
  forge.audit?.({
    toolName: 'evolution.episode.update',
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
    status: EvolutionLessonStatusSchema.optional(),
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
  forge: EvolutionEpisodeOperationDependencies
): EvolutionGate<{ accepted: true; lesson: EvolutionLesson }, LessonUpdateRejection> {
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
    toolName: 'evolution.lesson.update',
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
    priority: EvolutionPrioritySchema.optional(),
    evidenceEpisodeIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

export function applyForgeProposalCreate(
  input: z.infer<typeof ProposalCreateInputSchema>,
  scope: EvolutionScope,
  caller: OperationCaller,
  forge: EvolutionEpisodeOperationDependencies
): EvolutionGate<{ accepted: true; proposal: TaskProposal }, EpisodeRejection> {
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

export function applyForgeProposalUpdate(
  input: z.infer<typeof ProposalUpdateInputSchema>,
  existing: TaskProposal,
  caller: OperationCaller,
  forge: EvolutionEpisodeOperationDependencies
): EvolutionGate<{ accepted: true; proposal: TaskProposal }, ProposalUpdateRejection> {
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
    toolName: 'evolution.proposal.update',
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
    priority: EvolutionPrioritySchema.optional(),
    dependsOn: z.array(z.string().min(1)).optional(),
  })
  .strict();

export function applyForgeProposalTask(
  input: z.infer<typeof ProposalCreateTaskInputSchema>,
  existing: TaskProposal,
  caller: OperationCaller,
  forge: EvolutionEpisodeOperationDependencies
): EvolutionGate<Record<string, unknown>, ProposalTaskRejection> {
  try {
    const result = forge.episodeService.createTaskFromProposal(existing.id, {
      title: input.title,
      description: input.description,
      reason: input.reason,
      priority: input.priority,
      dependsOn: input.dependsOn,
    });
    forge.audit?.({
      toolName: 'evolution.proposal.createTask',
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
        metrics: EvolutionMetricValuesSchema.optional(),
      })
      .strict(),
  })
  .strict();

export function applyForgeRollup(
  input: z.infer<typeof RollupApplyInputSchema>,
  episode: EvolutionEpisode,
  caller: OperationCaller,
  forge: EvolutionEpisodeOperationDependencies
): EvolutionGate<Record<string, unknown>, RollupRejection> {
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
    toolName: 'evolution.rollup.apply',
    paramsSummary: { episodeId: episode.id },
    caller,
    spaceId: scope.spaceId,
  });
  return { value: { accepted: true, ...result } };
}

export function createForgeEpisodeOperations(forge: EvolutionEpisodeOperationDependencies) {
  const episodeCreate = (superpipe({ forge })('forge-episode-create') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeMutator, ['input', 'caller', 'forge'], 'result:outcome')
    .pipe(requireEpisodeScope, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(applyForgeEpisodeCreate, ['input', 'outcome', 'caller', 'forge'], 'result:outcome')
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
      name: 'evolution.episode.create',
      policy: FORGE_MUTATE_POLICY,
      description:
        'Generate a draft Forge episode from selected evidence through the episode judge, returning the episode with its candidate lessons, task proposals, and the evidence-quality preflight. Set confirmLowConfidence when the preflight warns that evidence is thin. Rejects scope_not_found, and episode_not_generated when the judge, model, or credentials fail (the cause is in detail).',
      inputSchema: EpisodeCreateInputSchema,
      resultSchema: z.union([
        accepted({
          episode: EvolutionEpisodeSchema,
          lessons: z.array(EvolutionLessonSchema),
          proposals: z.array(EvolutionProposalSchema),
          preflight: EvolutionPreflightSchema,
        }),
        forgeDenialSchema(EPISODE_CREATE_REJECTIONS),
      ]),
      execute: async (input, caller) => episodeCreate(input, caller),
    }),
    defineOperation({
      name: 'evolution.episode.update',
      policy: FORGE_MUTATE_POLICY,
      description:
        'Accept, dismiss, or edit a Forge episode draft — accept and dismiss are terminal, so use them only after an explicit decision. Rejects episode_not_found and episode_terminal when the episode already left draft. Autonomy metadata: editing a draft needs the Space session-write level, and changing a terminal episode is destructive; enforcement lands with the autonomy subsystem.',
      inputSchema: EpisodeUpdateInputSchema,
      resultSchema: z.union([
        accepted({ episode: EvolutionEpisodeSchema }),
        forgeDenialSchema(EPISODE_UPDATE_REJECTIONS),
      ]),
      execute: async (input, caller) => episodeUpdate(input, caller),
    }),
    defineOperation({
      name: 'evolution.lesson.update',
      policy: FORGE_MUTATE_POLICY,
      description:
        'Activate, dismiss, or edit a candidate Forge lesson — activation is never implicit, it takes this call. Rejects lesson_not_found and lesson_dismissed, since a dismissed lesson cannot be reactivated. Autonomy metadata: editing a candidate needs the Space session-write level, and changing an active or dismissed lesson is destructive; enforcement lands with the autonomy subsystem.',
      inputSchema: LessonUpdateInputSchema,
      resultSchema: z.union([
        accepted({ lesson: EvolutionLessonSchema }),
        forgeDenialSchema(LESSON_UPDATE_REJECTIONS),
      ]),
      execute: async (input, caller) => lessonUpdate(input, caller),
    }),
    defineOperation({
      name: 'evolution.proposal.create',
      policy: FORGE_MUTATE_POLICY,
      description:
        'Create a Forge task proposal on a scope by hand. This does not create a Space task; evolution.proposal.createTask does that in a separate, explicit step. Rejects scope_not_found and episode_not_found when a cited evidence episode is missing or belongs to another scope.',
      inputSchema: ProposalCreateInputSchema,
      resultSchema: z.union([
        accepted({ proposal: EvolutionProposalSchema }),
        forgeDenialSchema(EPISODE_REJECTIONS),
      ]),
      execute: async (input, caller) => proposalCreate(input, caller),
    }),
    defineOperation({
      name: 'evolution.proposal.update',
      policy: FORGE_MUTATE_POLICY,
      description:
        'Edit, accept, or dismiss a Forge task proposal. The created status is not settable here — call evolution.proposal.createTask to turn a proposal into a real task. Rejects proposal_not_found, proposal_created, and proposal_dismissed, since neither terminal state reopens. Autonomy metadata: editing a proposed record needs the Space session-write level, and changing an accepted or dismissed one is destructive; enforcement lands with the autonomy subsystem.',
      inputSchema: ProposalUpdateInputSchema,
      resultSchema: z.union([
        accepted({ proposal: EvolutionProposalSchema }),
        forgeDenialSchema(PROPOSAL_UPDATE_REJECTIONS),
      ]),
      execute: async (input, caller) => proposalUpdate(input, caller),
    }),
    defineOperation({
      name: 'evolution.proposal.createTask',
      policy: FORGE_DESTRUCTIVE_POLICY,
      description:
        'Create a real Space task from a Forge proposal, preserving the linked goal and scope bindings and attaching dependencies during creation. Idempotent: a proposal already marked created returns its existing task. Rejects proposal_not_found, and task_not_created when the proposal was dismissed, a dependency is invalid, or a concurrent call already claimed it (the cause is in detail). Autonomy metadata: this is a destructive action at the Space session-write level; enforcement lands with the autonomy subsystem.',
      inputSchema: ProposalCreateTaskInputSchema,
      resultSchema: z.union([
        accepted({ proposal: EvolutionProposalSchema, task: TaskWithSpaceFieldsSchema }),
        forgeDenialSchema(PROPOSAL_TASK_REJECTIONS),
      ]),
      execute: async (input, caller) => proposalTask(input, caller),
    }),
    defineOperation({
      name: 'evolution.rollup.apply',
      policy: FORGE_DESTRUCTIVE_POLICY,
      description:
        "Accept a Forge episode and roll its summary, next steps, and metrics into the recurring goal behind the episode's scope. Progress is not rolled up. Rejects episode_not_found, rollup_already_applied, episode_dismissed, and goal_not_recurring when the scope has no recurring goal. Autonomy metadata: this is a destructive action at the Space session-write level; enforcement lands with the autonomy subsystem.",
      inputSchema: RollupApplyInputSchema,
      resultSchema: z.union([
        accepted({ episode: EvolutionEpisodeSchema, goal: EvolutionGoalSchema }),
        forgeDenialSchema(ROLLUP_REJECTIONS),
      ]),
      execute: async (input, caller) => rollupApply(input, caller),
    }),
  ];
}
