import type {
  CreateEvolutionEpisodeParams,
  CreateTaskProposalParams,
  EvolutionEpisode,
  EvolutionLesson,
  EvolutionLessonStatus,
  EvolutionListPagination,
  EvolutionScope,
  SpaceTask,
  TaskProposal,
  TaskProposalStatus,
  UpdateEvolutionEpisodeParams,
  UpdateEvolutionLessonParams,
  UpdateTaskProposalParams,
} from '@hyperneo/shared';
import { generateUUID, scoreEvolutionEvidenceQuality } from '@hyperneo/shared';
import { Logger } from '../logger.ts';
import type {
  ApplyRollupGoalUpdateParams,
  ApplyRollupGoalUpdateResult,
  CreateEpisodeFromEvidenceParams,
  CreateEpisodeFromEvidenceResult,
  CreateTaskFromProposalParams,
  CreateTaskFromProposalResult,
  EpisodeJudgePromptInput,
  EpisodeReviewBundle,
  EvolutionEpisodeServiceDeps,
} from './episode-service-types.ts';
import {
  collectTasks,
  collectWorkflowRuns,
  deriveTimeWindow,
  detectResultArtifactGaps,
} from './episode-evidence-collection.ts';
import { judgeEpisodeWithModel } from './episode-judge-model.ts';
import { buildProposalTaskDescription, validateTaskDependencies } from './episode-task-proposal.ts';

export { buildEpisodeJudgePrompt } from './episode-judge-prompt.ts';
export { parseEpisodeJudgeJson } from './episode-judge-output.ts';
export { resolveEpisodeJudgeModel } from './episode-judge-model.ts';
export type {
  EpisodeJudgeOutput,
  EpisodeJudgePromptInput,
  EvolutionEpisodeServiceDeps,
} from './episode-service-types.ts';

const log = new Logger('evolution-episode-service');

export class EvolutionEpisodeService {
  constructor(private deps: EvolutionEpisodeServiceDeps) {}

  async createFromEvidence(
    params: CreateEpisodeFromEvidenceParams
  ): Promise<CreateEpisodeFromEvidenceResult> {
    const input = this.buildEpisodeInput(params);
    if (input.preflight.requiresConfirmation && !params.confirmLowConfidence) {
      throw new Error('Low-confidence evidence requires explicit confirmation');
    }
    const judged = this.deps.judgeEpisode
      ? await this.deps.judgeEpisode(input)
      : await judgeEpisodeWithModel(input, this.deps.spaceRepo);
    const gapFindings = detectResultArtifactGaps(this.deps, input);
    const findings = [...judged.findings, ...gapFindings];
    const episode = this.deps.evolutionRepo.createEpisode({
      scopeId: input.scope.id,
      status: 'draft',
      title: judged.title,
      timeWindow: input.timeWindow,
      evidenceIds: input.evidence.map((item) => item.id),
      outcomeSummary: judged.outcomeSummary,
      findings,
    });
    const lessons = (judged.candidateLessons ?? []).map((lesson) =>
      this.deps.evolutionRepo.createLesson({
        ...lesson,
        scopeId: input.scope.id,
        status: lesson.status ?? 'candidate',
        evidenceEpisodeIds: [episode.id],
      })
    );
    const proposals = (judged.proposals ?? []).map((proposal) =>
      this.deps.evolutionRepo.createTaskProposal({
        ...proposal,
        scopeId: input.scope.id,
        status: proposal.status ?? 'proposed',
        evidenceEpisodeIds: [episode.id],
      })
    );
    return { episode, lessons, proposals, preflight: input.preflight };
  }

  buildEpisodeInput(params: CreateEpisodeFromEvidenceParams): EpisodeJudgePromptInput {
    const scope = this.requireScope(params.scopeId);
    const requestedIds = new Set(params.evidenceIds);
    if (requestedIds.size === 0) throw new Error('evidenceIds is required');
    const allEvidence = this.deps.evolutionRepo.listEvidence(params.scopeId);
    const evidence = allEvidence.filter((item) => requestedIds.has(item.id));
    if (evidence.length !== requestedIds.size) {
      throw new Error('All evidenceIds must belong to the scope');
    }
    const tasks = collectTasks(this.deps, scope, evidence);
    const workflowRuns = collectWorkflowRuns(this.deps, scope, evidence);
    const metricSnapshots = this.deps.evolutionRepo.listMetricSnapshots(scope.id);
    const existingLessons = this.deps.evolutionRepo
      .listLessons(scope.id)
      .filter((lesson) => lesson.status === 'active' || lesson.status === 'candidate')
      .slice(0, 10);
    const existingProposals = this.deps.evolutionRepo
      .listTaskProposals(scope.id)
      .filter((proposal) => proposal.status === 'proposed' || proposal.status === 'accepted')
      .slice(0, 10);
    return {
      scope,
      evidence,
      metricSnapshots,
      tasks,
      workflowRuns,
      existingLessons,
      existingProposals,
      timeWindow: params.timeWindow ?? deriveTimeWindow(evidence),
      preflight: scoreEvolutionEvidenceQuality({
        evidence,
        availableScopeEvidence: allEvidence,
        tasks: tasks.map(({ task }) => task),
        workflowRuns: workflowRuns.map(({ run, tasks: runTasks, artifacts }) => ({
          run,
          tasks: runTasks,
          artifacts: artifacts.map((artifact) => ({
            type: artifact.artifactType,
            key: artifact.artifactKey,
            data: artifact.data,
          })),
        })),
        metricSnapshotCount: metricSnapshots.length,
      }),
    };
  }

  listEpisodes(scopeId: string, pagination?: EvolutionListPagination): EvolutionEpisode[] {
    this.requireScope(scopeId);
    return this.deps.evolutionRepo.listEpisodes(scopeId, pagination);
  }

  getEpisode(id: string): EvolutionEpisode | null {
    return this.deps.evolutionRepo.getEpisode(id);
  }

  createEpisode(params: CreateEvolutionEpisodeParams): EvolutionEpisode {
    this.requireScope(params.scopeId);
    return this.deps.evolutionRepo.createEpisode(params);
  }

  updateEpisode(id: string, params: UpdateEvolutionEpisodeParams): EvolutionEpisode | null {
    const { rollupAppliedAt: _rollupAppliedAt, ...safeParams } = params;
    return this.deps.evolutionRepo.updateEpisode(id, safeParams);
  }

  listReviewBundle(scopeId: string, pagination?: EvolutionListPagination): EpisodeReviewBundle {
    this.requireScope(scopeId);
    return {
      episodes: this.deps.evolutionRepo.listEpisodes(scopeId, pagination),
      lessons: this.deps.evolutionRepo.listLessons(scopeId),
      proposals: this.deps.evolutionRepo.listTaskProposals(scopeId),
    };
  }

  listLessons(
    scopeId: string,
    status?: EvolutionLessonStatus,
    pagination?: EvolutionListPagination
  ): EvolutionLesson[] {
    this.requireScope(scopeId);
    return this.deps.evolutionRepo.listLessons(scopeId, status, pagination);
  }

  getLesson(id: string): EvolutionLesson | null {
    return this.deps.evolutionRepo.getLesson(id);
  }

  updateLesson(id: string, params: UpdateEvolutionLessonParams): EvolutionLesson | null {
    return this.deps.evolutionRepo.updateLesson(id, params);
  }

  listTaskProposals(
    scopeId: string,
    status?: TaskProposalStatus,
    pagination?: EvolutionListPagination
  ): TaskProposal[] {
    this.requireScope(scopeId);
    return this.deps.evolutionRepo.listTaskProposals(scopeId, status, pagination);
  }

  getTaskProposal(id: string): TaskProposal | null {
    return this.deps.evolutionRepo.getTaskProposal(id);
  }

  createTaskProposal(params: CreateTaskProposalParams): TaskProposal {
    this.requireScope(params.scopeId);
    return this.deps.evolutionRepo.createTaskProposal(params);
  }

  updateTaskProposal(id: string, params: UpdateTaskProposalParams): TaskProposal | null {
    return this.deps.evolutionRepo.updateTaskProposal(id, params);
  }

  createTaskFromProposal(
    id: string,
    params: CreateTaskFromProposalParams = {}
  ): CreateTaskFromProposalResult {
    const result = this.runAtomic(() => {
      const existing = this.deps.evolutionRepo.getTaskProposal(id);
      const taskId = this.deps.taskIdFactory?.() ?? generateUUID();
      const dependsOn = params.dependsOn ?? [];
      if (!existing) throw new Error(`TaskProposal not found: ${id}`);
      const scope = this.requireScope(existing.scopeId);
      validateTaskDependencies({
        taskId,
        dependsOn,
        tasks: this.deps.taskRepo.listBySpace(scope.spaceId, true),
      });
      if (existing.status === 'created' && existing.createdTaskId) {
        const existingTask = this.deps.taskRepo.getTask(existing.createdTaskId);
        if (existingTask) return { proposal: existing, task: existingTask, created: false };
        throw new Error('Created proposal references a missing task');
      }
      if (existing.status === 'dismissed')
        throw new Error('Dismissed proposal cannot create a task');

      const claimed = this.deps.evolutionRepo.updateTaskProposalIfStatus(
        existing.id,
        ['proposed', 'accepted'],
        { status: 'accepted' }
      );
      if (!claimed) {
        const current = this.deps.evolutionRepo.getTaskProposal(id);
        if (current?.status === 'created' && current.createdTaskId) {
          const currentTask = this.deps.taskRepo.getTask(current.createdTaskId);
          if (currentTask) return { proposal: current, task: currentTask, created: false };
        }
        throw new Error('Task proposal is already being created');
      }

      const title = params.title?.trim() || existing.title;
      const description = params.description?.trim() || existing.description;
      const reason = params.reason?.trim() || existing.reason;
      const priority = params.priority ?? existing.priority;
      if (!title.trim()) throw new Error('title is required');
      const task = this.deps.taskRepo.createTaskWithId(taskId, {
        spaceId: scope.spaceId,
        title,
        description: buildProposalTaskDescription(description, reason, existing.evidenceEpisodeIds),
        priority,
        goalId: scope.spaceGoalId,
        evolutionScopeId: scope.id,
        dependsOn,
      });
      const proposal = this.deps.evolutionRepo.updateTaskProposal(existing.id, {
        title,
        description,
        reason,
        priority,
        status: 'created',
        createdTaskId: task.id,
      });
      if (!proposal) throw new Error(`TaskProposal not found: ${id}`);
      return { proposal, task, created: true };
    });
    if (result.created) this.emitTaskCreated(result.task);
    return { proposal: result.proposal, task: result.task };
  }

  applyRollupGoalUpdate(params: ApplyRollupGoalUpdateParams): ApplyRollupGoalUpdateResult {
    if (!this.deps.goalService) throw new Error('SpaceGoalService is required');
    const episode = this.deps.evolutionRepo.getEpisode(params.episodeId);
    if (!episode) throw new Error(`EvolutionEpisode not found: ${params.episodeId}`);
    if (episode.rollupAppliedAt !== null) throw new Error('Episode rollup already applied');
    if (episode.status === 'dismissed') throw new Error('Dismissed episode cannot accept rollup');
    const scope = this.requireScope(episode.scopeId);
    if (!scope.spaceGoalId) throw new Error('Episode scope is not linked to a recurring goal');
    const existingGoal = this.deps.goalService.getGoal(scope.spaceGoalId);
    if (
      !existingGoal ||
      existingGoal.spaceId !== scope.spaceId ||
      existingGoal.type !== 'recurring'
    ) {
      throw new Error('Episode scope is not linked to a recurring goal');
    }
    const { progress: _ignoredProgress, ...goalUpdate } = params.goalUpdate;
    const goal = this.deps.goalService.updateGoal(scope.spaceGoalId, goalUpdate, {
      source: 'rpc',
      note: `Evolution rollup accepted: ${episode.title}`,
    });
    const accepted = this.deps.evolutionRepo.updateEpisode(episode.id, {
      status: 'accepted',
      rollupAppliedAt: Date.now(),
    });
    if (!accepted) throw new Error(`EvolutionEpisode not found: ${params.episodeId}`);
    return { episode: accepted, goal };
  }

  private requireScope(scopeId: string): EvolutionScope {
    if (!scopeId) throw new Error('scopeId is required');
    const scope = this.deps.evolutionRepo.getScope(scopeId);
    if (!scope) throw new Error(`EvolutionScope not found: ${scopeId}`);
    return scope;
  }

  private runAtomic<T>(fn: () => T): T {
    if (!this.deps.db) return fn();
    return this.deps.db.transaction(fn)();
  }

  private emitTaskCreated(task: SpaceTask): void {
    if (!this.deps.taskCreatedEventHub) return;
    this.deps.taskCreatedEventHub
      .publish('space.task.created', {
        sessionId: 'global',
        spaceId: task.spaceId,
        taskId: task.id,
        task,
      })
      .catch((err) => {
        log.warn('Failed to emit space.task.created:', err);
      });
  }
}
