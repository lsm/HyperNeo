import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type {
  CreateEvolutionEpisodeParams,
  CreateEvolutionLessonParams,
  CreateTaskProposalParams,
  EvidenceQualityPreflight,
  EvidenceRef,
  EvolutionEpisode,
  EvolutionFinding,
  EvolutionFindingDomain,
  EvolutionFindingKind,
  EvolutionImpact,
  EvolutionLesson,
  EvolutionLessonStatus,
  EvolutionListPagination,
  EvolutionScope,
  SpaceTaskPriority,
  MetricSnapshot,
  SpaceGoal,
  SpaceTask,
  SpaceTaskStatus,
  TaskProposal,
  TaskProposalStatus,
  UpdateEvolutionEpisodeParams,
  UpdateEvolutionLessonParams,
  UpdateTaskProposalParams,
} from '@hyperneo/shared';
import { generateUUID, scoreEvolutionEvidenceQuality } from '@hyperneo/shared';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository.ts';
import type { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository.ts';
import type {
  WorkflowRunArtifactRecord,
  WorkflowRunArtifactRepository,
} from '../../storage/repositories/workflow-run-artifact-repository.ts';
import type { SpaceGoalService } from './goals/goal-service.ts';
import type { WorkflowArtifactProfile } from './runtime/artifact-profile.ts';
import { isRunningUnderBun, resolveSDKCliPath } from '../agent/sdk-cli-resolver.ts';
import { Logger } from '../logger.ts';
import { getProviderService, mergeProviderEnvVars } from '../provider-service.ts';
import { normalizeMeaningfulTaskResult } from './task-result-utils.ts';
import { KimiProvider } from '../providers/kimi-provider.js';
import { getAvailableModels } from '../model-service.ts';
import { inferProviderForModel } from '../providers/registry.ts';
import { withSdkTranscriptRetention } from '../agent/sdk-transcript-retention.ts';

const log = new Logger('evolution-episode-service');

const FINDING_DOMAINS: EvolutionFindingDomain[] = [
  'workflow',
  'target_artifact',
  'hyperneo_product',
];
const FINDING_KINDS: EvolutionFindingKind[] = [
  'friction',
  'bug',
  'optimization',
  'missing_capability',
  'new_opportunity',
];
const IMPACTS: EvolutionImpact[] = ['low', 'medium', 'high'];
const LESSON_STATUSES: EvolutionLessonStatus[] = ['candidate', 'active', 'dismissed'];
const PROPOSAL_STATUSES: TaskProposalStatus[] = ['proposed', 'accepted', 'dismissed', 'created'];
const PRIORITIES: SpaceTaskPriority[] = ['low', 'normal', 'high', 'urgent'];
const MAX_TEXT = 1200;
const MAX_ARTIFACTS_PER_RUN = 8;
const TERMINAL_TASK_STATUSES = new Set<SpaceTaskStatus>(['done']);

export interface CreateEpisodeFromEvidenceParams {
  scopeId: string;
  evidenceIds: string[];
  timeWindow?: CreateEvolutionEpisodeParams['timeWindow'];
  confirmLowConfidence?: boolean;
}

export interface CreateEpisodeFromEvidenceResult {
  episode: EvolutionEpisode;
  lessons: EvolutionLesson[];
  proposals: TaskProposal[];
  preflight: EvidenceQualityPreflight;
}

export interface EpisodeReviewBundle {
  episodes: EvolutionEpisode[];
  lessons: EvolutionLesson[];
  proposals: TaskProposal[];
}

export interface CreateTaskFromProposalParams {
  title?: string;
  description?: string;
  reason?: string;
  priority?: SpaceTaskPriority;
  dependsOn?: string[];
}

export interface CreateTaskFromProposalResult {
  proposal: TaskProposal;
  task: SpaceTask;
}

export interface ApplyRollupGoalUpdateParams {
  episodeId: string;
  goalUpdate: {
    summary?: string;
    progress?: number;
    nextSteps?: string[];
    metrics?: Record<string, string | number | boolean | null>;
  };
}

export interface ApplyRollupGoalUpdateResult {
  episode: EvolutionEpisode;
  goal: SpaceGoal;
}

export interface EvolutionEpisodeServiceDeps {
  evolutionRepo: EvolutionRepository;
  spaceRepo?: Pick<SpaceRepository, 'getSpace'>;
  taskRepo: SpaceTaskRepository;
  workflowRunRepo: SpaceWorkflowRunRepository;
  artifactRepo: WorkflowRunArtifactRepository;
  artifactProfile?: WorkflowArtifactProfile;
  goalService?: Pick<SpaceGoalService, 'getGoal' | 'updateGoal'>;
  taskIdFactory?: () => string;
  db?: BunDatabase;
  taskCreatedEventHub?: {
    publish: (event: string, data: Record<string, unknown>) => Promise<unknown>;
  };
  judgeEpisode?: (input: EpisodeJudgePromptInput) => Promise<EpisodeJudgeOutput>;
}

export interface EpisodeJudgePromptInput {
  scope: EvolutionScope;
  evidence: EvidenceRef[];
  metricSnapshots: MetricSnapshot[];
  tasks: EpisodeTaskContext[];
  workflowRuns: EpisodeWorkflowRunContext[];
  timeWindow: CreateEvolutionEpisodeParams['timeWindow'];
  preflight: EvidenceQualityPreflight;
  existingLessons: EvolutionLesson[];
  existingProposals: TaskProposal[];
}

export interface EpisodeTaskContext {
  evidenceId: string;
  task: SpaceTask;
}

export interface EpisodeWorkflowRunContext {
  evidenceId: string;
  run: NonNullable<ReturnType<SpaceWorkflowRunRepository['getRun']>>;
  tasks: SpaceTask[];
  artifacts: WorkflowRunArtifactRecord[];
}

export interface EpisodeJudgeOutput {
  title: string;
  outcomeSummary: string;
  findings: EvolutionFinding[];
  candidateLessons?: Array<Omit<CreateEvolutionLessonParams, 'scopeId' | 'evidenceEpisodeIds'>>;
  proposals?: Array<Omit<CreateTaskProposalParams, 'scopeId' | 'evidenceEpisodeIds'>>;
}

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
    const gapFindings = this.detectResultArtifactGaps(input);
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
    const tasks = this.collectTasks(scope, evidence);
    const workflowRuns = this.collectWorkflowRuns(scope, evidence);
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

  private collectTasks(scope: EvolutionScope, evidence: EvidenceRef[]): EpisodeTaskContext[] {
    const seenTaskIds = new Set<string>();
    return evidence.flatMap((item) => {
      if (
        item.kind !== 'task' &&
        item.kind !== 'task_result' &&
        item.kind !== 'error_cluster' &&
        item.kind !== 'retry_loop' &&
        item.kind !== 'tool_failure' &&
        item.kind !== 'test_failure' &&
        item.kind !== 'permission_block' &&
        item.kind !== 'slow_tool_call' &&
        item.kind !== 'conversation_friction' &&
        item.kind !== 'friction_digest' &&
        item.kind !== 'verification_triage'
      )
        return [];
      if (!item.sourceId || seenTaskIds.has(item.sourceId)) return [];
      const task = this.deps.taskRepo.getTask(item.sourceId);
      if (!task) return [];
      if (task.spaceId !== scope.spaceId) {
        throw new Error(`Task and scope must belong to the same space: ${task.id}`);
      }
      seenTaskIds.add(task.id);
      return [{ evidenceId: item.id, task }];
    });
  }

  private collectWorkflowRuns(
    scope: EvolutionScope,
    evidence: EvidenceRef[]
  ): EpisodeWorkflowRunContext[] {
    const seenRunIds = new Set<string>();
    return evidence.flatMap((item) => {
      if (item.kind !== 'workflow_run' && item.kind !== 'artifact' && item.kind !== 'error')
        return [];
      if (!item.sourceId) return [];
      const run = this.deps.workflowRunRepo.getRun(item.sourceId);
      if (!run) return [];
      if (run.spaceId !== scope.spaceId) {
        throw new Error(`Workflow run and scope must belong to the same space: ${run.id}`);
      }
      if (seenRunIds.has(run.id)) return [];
      seenRunIds.add(run.id);
      return [
        {
          evidenceId: item.id,
          run,
          tasks: this.deps.taskRepo.listByWorkflowRunIncludingArchived(run.id),
          artifacts: this.deps.artifactRepo.listByRun(run.id).slice(0, MAX_ARTIFACTS_PER_RUN),
        },
      ];
    });
  }

  private detectResultArtifactGaps(input: EpisodeJudgePromptInput): EvolutionFinding[] {
    const gaps: EvolutionFinding[] = [];
    const processedTaskIds = new Set<string>();
    const runHasResultArtifact = new Map<string, boolean>();

    const processTask = (task: SpaceTask, taskEvidenceId?: string) => {
      if (processedTaskIds.has(task.id)) return;
      processedTaskIds.add(task.id);
      const runId = task.workflowRunId;
      if (!runId) return;
      if (!TERMINAL_TASK_STATUSES.has(task.status)) return;
      if (normalizeMeaningfulTaskResult(task.result) !== null) return;

      let hasResultArtifact = runHasResultArtifact.get(runId);
      if (hasResultArtifact === undefined) {
        hasResultArtifact = this.deps.artifactProfile?.summarizeRunOutcome(runId) != null;
        runHasResultArtifact.set(runId, hasResultArtifact);
      }
      if (!hasResultArtifact) return;

      const runContext = input.workflowRuns.find((wr) => wr.run.id === runId);
      const evidence = taskEvidenceId ? [taskEvidenceId] : [];
      if (runContext && runContext.evidenceId !== taskEvidenceId) {
        evidence.push(runContext.evidenceId);
      }
      gaps.push({
        domain: 'hyperneo_product',
        kind: 'bug',
        impact: 'medium',
        confidence: 0.9,
        evidence,
        proposedAction: `Backfill task.result for "${task.title}" from the result artifact on workflow run ${runId}; the artifact exists but the task record has no result.`,
      });
    };

    for (const { evidenceId: taskEvidenceId, task } of input.tasks) {
      processTask(task, taskEvidenceId);
    }
    for (const { tasks, evidenceId: runEvidenceId } of input.workflowRuns) {
      for (const task of tasks) {
        processTask(task, runEvidenceId);
      }
    }
    return gaps;
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

export function buildEpisodeJudgePrompt(input: EpisodeJudgePromptInput): string {
  return `You are Forge Episode Judge for HyperNeo.

Build a structured draft episode from scoped evidence. Focus on factual outcomes, product/workflow findings, candidate lessons, and follow-up proposals. Do not mutate anything.

Return ONLY valid JSON with this shape:
{
  "title": "short episode title",
  "outcomeSummary": "what happened and why it matters",
  "findings": [
    { "domain": "workflow|target_artifact|hyperneo_product", "kind": "friction|bug|optimization|missing_capability|new_opportunity", "impact": "low|medium|high", "confidence": 0.0, "evidence": ["evidence id or summary"], "proposedAction": "specific action" }
  ],
  "candidateLessons": [
    { "appliesTo": ["workflow|prompt|tool|ui"], "rule": "lesson candidate", "why": "supporting reason", "confidence": 0.0 }
  ],
  "proposals": [
    { "title": "task title", "description": "task body", "reason": "why now", "priority": "low|normal|high|urgent" }
  ]
}

Scope:
${JSON.stringify({ id: input.scope.id, name: input.scope.name, objective: input.scope.objective, metrics: input.scope.metricDefinitions, policy: input.scope.policy }, null, 2)}

Time window:
${JSON.stringify(input.timeWindow)}

Evidence quality preflight:
${JSON.stringify(input.preflight, null, 2)}

Use this evidence quality context to calibrate finding and lesson confidence. If preflight level is low, avoid high-confidence findings unless directly supported by concrete task, artifact, metric, CI, QA, PR, merge, or error data.

Selected evidence:
${JSON.stringify(
  input.evidence.map((item) => ({
    id: item.id,
    kind: item.kind,
    summary: item.summary,
    sourceId: item.sourceId,
    metadata: truncate(JSON.stringify(item.metadata), MAX_TEXT),
    createdAt: item.createdAt,
  })),
  null,
  2
)}

Task results and summaries:
${JSON.stringify(
  input.tasks.map(({ evidenceId, task }) => ({
    evidenceId,
    id: task.id,
    number: task.taskNumber,
    title: task.title,
    status: task.status,
    reportedStatus: task.reportedStatus,
    reportedSummary: truncate(task.reportedSummary ?? '', MAX_TEXT),
    result: truncate(
      task.result ??
        (task.status === 'done' || task.status === 'blocked' ? task.reportedSummary : '') ??
        '',
      MAX_TEXT
    ),
  })),
  null,
  2
)}

Workflow run artifacts:
${JSON.stringify(
  input.workflowRuns.map(({ evidenceId, run, tasks, artifacts }) => ({
    evidenceId,
    run: {
      id: run.id,
      title: run.title,
      status: run.status,
      failureReason: run.failureReason ?? null,
    },
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      reportedSummary: truncate(task.reportedSummary ?? '', 500),
      result: truncate(
        task.result ??
          (task.status === 'done' || task.status === 'blocked' ? task.reportedSummary : '') ??
          '',
        500
      ),
    })),
    artifacts: artifacts.map((artifact) => ({
      nodeId: artifact.nodeId,
      type: artifact.artifactType,
      key: artifact.artifactKey,
      data: truncate(JSON.stringify(artifact.data), MAX_TEXT),
    })),
  })),
  null,
  2
)}

Metric snapshots and manual notes:
${JSON.stringify({ metricSnapshots: input.metricSnapshots, manualNotes: input.evidence.filter((item) => item.kind === 'manual_note').map((item) => ({ id: item.id, summary: item.summary, metadata: truncate(JSON.stringify(item.metadata), MAX_TEXT), createdAt: item.createdAt })) }, null, 2)}

Existing accepted and candidate lessons in this scope (do not re-derive these):
${JSON.stringify(
  input.existingLessons.map((lesson) => ({
    status: lesson.status,
    appliesTo: lesson.appliesTo,
    rule: truncate(lesson.rule, MAX_TEXT),
    confidence: lesson.confidence,
  })),
  null,
  2
)}

Open proposals in this scope (do not duplicate these):
${JSON.stringify(
  input.existingProposals.map((proposal) => ({
    title: truncate(proposal.title, MAX_TEXT),
    description: truncate(proposal.description, MAX_TEXT),
    reason: truncate(proposal.reason, MAX_TEXT),
    status: proposal.status,
    priority: proposal.priority,
  })),
  null,
  2
)}

When generating candidate lessons and proposals, omit any that duplicate or substantially overlap with the items above.`;
}

export function parseEpisodeJudgeJson(raw: string): EpisodeJudgeOutput {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    text = fenced[1].trim();
  } else {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0) {
      throw new Error(`Episode judge returned non-JSON text: ${truncate(text, 300)}`);
    }
    if (end > start) text = text.slice(start, end + 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Episode judge returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return normalizeJudgeOutput(parsed);
}

export async function resolveEpisodeJudgeModel(
  input: EpisodeJudgePromptInput,
  spaceRepo?: Pick<SpaceRepository, 'getSpace'>
): Promise<{ provider: string; modelId: string }> {
  const scopeModel = readEpisodeJudgeModel(input.scope);
  const scopeProvider = scopeModel ? readEpisodeJudgeProvider(input.scope) : undefined;
  const spaceModel = scopeModel
    ? undefined
    : spaceRepo?.getSpace(input.scope.spaceId)?.defaultModel;
  const selectedModel = scopeModel ?? spaceModel?.trim();
  if (selectedModel) {
    const cachedModel = findCachedModel(selectedModel, scopeProvider);
    return {
      provider: scopeProvider ?? cachedModel?.provider ?? inferProviderForModel(selectedModel),
      modelId: cachedModel?.id ?? selectedModel,
    };
  }
  const providerService = getProviderService();
  const provider = await providerService.getDefaultProvider();
  const cfg = await providerService.getTitleGenerationConfig(provider);
  if (!cfg) {
    throw new Error(`Provider ${provider} has no visible models for episode judging`);
  }
  return { provider, modelId: cfg.modelId };
}

function readEpisodeJudgeModel(scope: EvolutionScope): string | undefined {
  const value = scope.policy.episodeJudgeModel;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readEpisodeJudgeProvider(scope: EvolutionScope): string | undefined {
  const value = scope.policy.episodeJudgeProvider;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function findCachedModel(
  modelId: string,
  provider?: string
): { id: string; provider: string } | undefined {
  const models = getAvailableModels('global');
  const providerMatches = provider ? models.filter((model) => model.provider === provider) : models;
  return (
    providerMatches.find((model) => model.id === modelId) ??
    providerMatches.find((model) => model.alias === modelId)
  );
}

async function judgeEpisodeWithModel(
  input: EpisodeJudgePromptInput,
  spaceRepo?: Pick<SpaceRepository, 'getSpace'>
): Promise<EpisodeJudgeOutput> {
  const providerService = getProviderService();
  const { provider, modelId } = await resolveEpisodeJudgeModel(input, spaceRepo);
  const prompt = buildEpisodeJudgePrompt(input);
  const originalEnv = await providerService.applyEnvVarsToProcessForProvider(provider, modelId);
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { isSDKAssistantMessage } = await import('@hyperneo/shared/sdk/type-guards');
    const providerEnvVars = (await providerService.getEnvVarsForModel(modelId, provider)) as Record<
      string,
      string | undefined
    >;
    const sdkModelId = provider === 'glm' ? 'haiku' : (providerEnvVars.ANTHROPIC_MODEL ?? modelId);
    const agentQuery = query({
      prompt,
      options: {
        model: sdkModelId,
        maxTurns: 1,
        permissionMode: 'acceptEdits',
        allowDangerouslySkipPermissions: false,
        mcpServers: {},
        settingSources: [],
        tools: [],
        pathToClaudeCodeExecutable: resolveSDKCliPath(),
        executable: isRunningUnderBun() ? 'bun' : undefined,
        settings: withSdkTranscriptRetention(),
        env: mergeProviderEnvVars(providerEnvVars),
        thinking:
          provider === 'kimi'
            ? KimiProvider.resolveKimiTitleThinkingConfig(sdkModelId)
            : { type: 'disabled' },
      },
    });
    let raw = '';
    for await (const message of agentQuery) {
      if (isSDKAssistantMessage(message)) {
        const textBlocks = message.message.content.filter(
          (block: { type: string }) => block.type === 'text'
        ) as Array<{ text?: string }>;
        raw = textBlocks
          .map((block) => block.text ?? '')
          .join('\n')
          .trim();
        if (raw) break;
      }
    }
    if (!raw) throw new Error('Episode judge returned no text');
    return parseEpisodeJudgeJson(raw);
  } catch (err) {
    log.warn('Episode judge model call failed:', err);
    throw err;
  } finally {
    providerService.restoreEnvVars(originalEnv);
  }
}

function normalizeJudgeOutput(value: unknown): EpisodeJudgeOutput {
  const record = requireRecord(value, 'episode judge output');
  const title = requireString(record.title, 'title');
  const outcomeSummary = requireString(record.outcomeSummary, 'outcomeSummary');
  const findingsValue = Array.isArray(record.findings) ? record.findings : [];
  const findings = findingsValue.map(normalizeFinding);
  const candidateLessons = Array.isArray(record.candidateLessons)
    ? record.candidateLessons.map(normalizeLesson)
    : [];
  const proposals = Array.isArray(record.proposals) ? record.proposals.map(normalizeProposal) : [];
  return { title, outcomeSummary, findings, candidateLessons, proposals };
}

function normalizeFinding(value: unknown): EvolutionFinding {
  const record = requireRecord(value, 'finding');
  return {
    domain: enumValue(record.domain, FINDING_DOMAINS, 'finding.domain'),
    kind: enumValue(record.kind, FINDING_KINDS, 'finding.kind'),
    impact: enumValue(record.impact, IMPACTS, 'finding.impact'),
    confidence: clampConfidence(record.confidence),
    evidence: stringArray(record.evidence),
    proposedAction: requireString(record.proposedAction, 'finding.proposedAction'),
  };
}

function normalizeLesson(
  value: unknown
): Omit<CreateEvolutionLessonParams, 'scopeId' | 'evidenceEpisodeIds'> {
  const record = requireRecord(value, 'candidate lesson');
  return {
    status:
      record.status === undefined
        ? 'candidate'
        : enumValue(record.status, LESSON_STATUSES, 'lesson.status'),
    appliesTo: stringArray(record.appliesTo),
    rule: requireString(record.rule, 'lesson.rule'),
    why: requireString(record.why, 'lesson.why'),
    confidence: clampConfidence(record.confidence),
  };
}

function normalizeProposal(
  value: unknown
): Omit<CreateTaskProposalParams, 'scopeId' | 'evidenceEpisodeIds'> {
  const record = requireRecord(value, 'proposal');
  return {
    title: requireString(record.title, 'proposal.title'),
    description: requireString(record.description, 'proposal.description'),
    reason: requireString(record.reason, 'proposal.reason'),
    priority: enumValue(record.priority ?? 'normal', PRIORITIES, 'proposal.priority'),
    status:
      record.status === undefined
        ? 'proposed'
        : enumValue(record.status, PROPOSAL_STATUSES, 'proposal.status'),
  };
}

function deriveTimeWindow(evidence: EvidenceRef[]): CreateEvolutionEpisodeParams['timeWindow'] {
  if (evidence.length === 0) return null;
  const times = evidence.map((item) => item.createdAt);
  return { start: Math.min(...times), end: Math.max(...times) };
}

function buildProposalTaskDescription(
  description: string,
  reason: string,
  evidenceEpisodeIds: string[]
): string {
  const parts = [description.trim()];
  if (reason.trim()) parts.push(`Proposal reason:\n${reason.trim()}`);
  if (evidenceEpisodeIds.length > 0) {
    parts.push(
      `Evolution evidence episodes:\n${evidenceEpisodeIds.map((id) => `- ${id}`).join('\n')}`
    );
  }
  return parts.filter(Boolean).join('\n\n');
}

function validateTaskDependencies(params: {
  taskId: string;
  dependsOn: string[];
  tasks: SpaceTask[];
}): void {
  const taskIds = new Set(params.tasks.map((task) => task.id));
  for (const depId of params.dependsOn) {
    if (depId === params.taskId) throw new Error('A task cannot depend on itself');
    if (!taskIds.has(depId)) throw new Error(`Dependency task not found in space: ${depId}`);
  }
  if (params.dependsOn.length === 0) return;

  const adj = new Map<string, string[]>();
  for (const task of params.tasks) {
    adj.set(task.id, [...(task.dependsOn ?? [])]);
  }
  adj.set(params.taskId, [...params.dependsOn]);
  if (hasDependencyCycle(adj)) {
    throw new Error('Adding these dependencies would create a circular dependency');
  }
}

function hasDependencyCycle(adj: Map<string, string[]>): boolean {
  const white = 0;
  const gray = 1;
  const black = 2;
  const color = new Map<string, number>();
  for (const id of adj.keys()) color.set(id, white);

  const dfs = (node: string): boolean => {
    color.set(node, gray);
    for (const neighbor of adj.get(node) ?? []) {
      const state = color.get(neighbor);
      if (state === gray) return true;
      if (state === white && dfs(neighbor)) return true;
    }
    color.set(node, black);
    return false;
  };

  for (const id of adj.keys()) {
    if (color.get(id) === white && dfs(id)) return true;
  }
  return false;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function clampConfidence(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, numeric));
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
