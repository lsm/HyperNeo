import type {
  CreateEvidenceRefParams,
  CreateEvolutionScopeParams,
  CreateMetricSnapshotParams,
  EvidenceKind,
  EvidenceRef,
  EvolutionLesson,
  EvolutionScope,
  EvolutionScopeListParams,
  MetricSnapshot,
  SpaceTask,
  SpaceWorkflowRun,
  UpdateEvolutionScopeParams,
  EvolutionEvidenceListResponse,
  EvolutionPreflightTaskSummary,
} from '@neokai/shared';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { SpaceGoalRepository } from '../../storage/repositories/space-goal-repository';
import type { SpaceRepository } from '../../storage/repositories/space-repository';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import type {
  WorkflowRunArtifactRecord,
  WorkflowRunArtifactRepository,
} from '../../storage/repositories/workflow-run-artifact-repository';
import { Logger } from '../logger';
import { SPACE_CONVERSATION_FRICTION_ANALYZE } from '../job-queue-constants';
import type {
  EvolutionTraceEvidenceService,
  TraceEvidenceDiagnostic,
} from './evolution-trace-evidence-service';

const MAX_PREFLIGHT_ARTIFACTS_PER_RUN = 8;
const MAX_PREFLIGHT_ARTIFACT_TEXT = 500;

function summarizeArtifactData(data: Record<string, unknown>): string {
  const text = stringifyArtifactField(data);
  return text.length > MAX_PREFLIGHT_ARTIFACT_TEXT
    ? `${text.slice(0, MAX_PREFLIGHT_ARTIFACT_TEXT)}…`
    : text;
}

function stringifyArtifactField(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

export interface EvolutionScopeServiceDeps {
  evolutionRepo: EvolutionRepository;
  spaceRepo: SpaceRepository;
  goalRepo: SpaceGoalRepository;
  taskRepo: SpaceTaskRepository;
  workflowRunRepo: SpaceWorkflowRunRepository;
  artifactRepo?: WorkflowRunArtifactRepository;
  traceEvidenceService?: EvolutionTraceEvidenceService;
  jobQueue?: Pick<JobQueueRepository, 'enqueueUniquePending'>;
}

export interface CreateScopeFromGoalParams {
  spaceGoalId: string;
  name?: string;
  objective?: string;
  metricDefinitions?: CreateEvolutionScopeParams['metricDefinitions'];
  policy?: CreateEvolutionScopeParams['policy'];
}

export interface ResolveScopeForGoalParams {
  spaceGoalId: string;
}

export interface AttachTaskEvidenceParams {
  scopeId?: string;
  taskId: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface AttachWorkflowRunEvidenceParams {
  scopeId?: string;
  workflowRunId: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface AddManualNoteEvidenceParams {
  scopeId: string;
  summary: string;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

export interface AddMetricSnapshotEvidenceParams {
  scopeId: string;
  values: CreateMetricSnapshotParams['values'];
  source: string;
  note?: string | null;
  capturedAt?: number;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface ResolveScopeForTaskParams {
  taskId: string;
}

export interface SelectTaskLessonsParams {
  taskId: string;
  limit?: number;
}

export interface CaptureCompletedTaskEvidenceParams {
  taskId: string;
}

export interface CaptureCompletedTaskEvidenceResult {
  scope: EvolutionScope | null;
  evidence: EvidenceRef[];
  traceDiagnostic?: TraceEvidenceDiagnostic;
}

export interface ScopeTimeline {
  scope: EvolutionScope;
  evidence: EvidenceRef[];
  metricSnapshots: MetricSnapshot[];
}

const log = new Logger('evolution-scope-service');

function traceCaptureUnavailableDiagnostic(): TraceEvidenceDiagnostic {
  return {
    status: 'no_trace_rows',
    message: 'No trace evidence generated: trace capture service is not configured',
    messageCount: 0,
    toolCallCount: 0,
    failedToolCallCount: 0,
    slowToolCallCount: 0,
    evidenceCount: 0,
  };
}

function traceCaptureErrorDiagnostic(err: unknown): TraceEvidenceDiagnostic {
  return {
    status: 'error',
    message: 'Trace evidence capture failed',
    messageCount: 0,
    toolCallCount: 0,
    failedToolCallCount: 0,
    slowToolCallCount: 0,
    evidenceCount: 0,
    error: err instanceof Error ? err.message : String(err),
  };
}

export class EvolutionScopeService {
  constructor(private deps: EvolutionScopeServiceDeps) {}

  createScope(params: CreateEvolutionScopeParams): EvolutionScope {
    this.requireSpace(params.spaceId);
    if (params.spaceGoalId !== undefined && params.spaceGoalId !== null) {
      this.requireGoalInSpace(params.spaceGoalId, params.spaceId);
    }
    if (params.parentScopeId) {
      this.requireScopeInSpace(params.parentScopeId, params.spaceId);
    }
    return this.deps.evolutionRepo.createScope(params);
  }

  createScopeFromGoal(params: CreateScopeFromGoalParams): EvolutionScope {
    const goal = this.requireGoal(params.spaceGoalId);
    return this.deps.evolutionRepo.createScope({
      spaceId: goal.spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: params.name ?? goal.title,
      objective: params.objective ?? goal.description ?? goal.title,
      metricDefinitions: params.metricDefinitions,
      policy: params.policy,
    });
  }

  getScope(id: string): EvolutionScope | null {
    return this.deps.evolutionRepo.getScope(id);
  }

  listScopes(params: EvolutionScopeListParams): EvolutionScope[] {
    this.requireSpace(params.spaceId);
    if (params.spaceGoalId !== undefined && params.spaceGoalId !== null) {
      this.requireGoalInSpace(params.spaceGoalId, params.spaceId);
    }
    return this.deps.evolutionRepo.listScopes(params);
  }

  updateScope(id: string, params: UpdateEvolutionScopeParams): EvolutionScope | null {
    const existing = this.deps.evolutionRepo.getScope(id);
    if (!existing) return null;
    if (params.spaceGoalId !== undefined && params.spaceGoalId !== null) {
      this.requireGoalInSpace(params.spaceGoalId, existing.spaceId);
    }
    if (params.parentScopeId) {
      this.requireScopeInSpace(params.parentScopeId, existing.spaceId);
    }
    return this.deps.evolutionRepo.updateScope(id, params);
  }

  resolveScopeForGoal(params: ResolveScopeForGoalParams): EvolutionScope | null {
    const goal = this.requireGoal(params.spaceGoalId);
    return (
      this.deps.evolutionRepo.listScopes({ spaceId: goal.spaceId, spaceGoalId: goal.id })[0] ?? null
    );
  }

  resolveScopeForTask(params: ResolveScopeForTaskParams): EvolutionScope | null {
    const task = this.deps.taskRepo.getTask(params.taskId);
    if (!task) throw new Error(`Task not found: ${params.taskId}`);
    const scope = this.findScopeForTask(task.evolutionScopeId ?? null, task.goalId ?? null);
    if (!scope || scope.spaceId !== task.spaceId) return null;
    return scope;
  }

  selectActiveLessonsForTask(params: SelectTaskLessonsParams): EvolutionLesson[] {
    const scope = this.resolveScopeForTask({ taskId: params.taskId });
    if (!scope) return [];
    const limit = Math.max(0, params.limit ?? 3);
    if (limit === 0) return [];
    return this.deps.evolutionRepo.listLessons(scope.id, 'active').slice(0, limit);
  }

  createEvidence(params: CreateEvidenceRefParams): EvidenceRef {
    this.requireScope(params.scopeId);
    return this.deps.evolutionRepo.createEvidence(params);
  }

  attachTaskEvidence(params: AttachTaskEvidenceParams): EvidenceRef {
    const task = this.deps.taskRepo.getTask(params.taskId);
    if (!task) throw new Error(`Task not found: ${params.taskId}`);
    const scope = params.scopeId
      ? this.requireScope(params.scopeId)
      : this.requireScopeForTask(task.id, task.evolutionScopeId ?? null, task.goalId ?? null);
    if (scope.spaceId !== task.spaceId)
      throw new Error('Task and scope must belong to the same space');
    const evidence = this.createEvidence({
      scopeId: scope.id,
      kind: 'task',
      sourceId: task.id,
      summary: params.summary ?? `Task #${task.taskNumber}: ${task.title}`,
      metadata: {
        status: task.status,
        priority: task.priority,
        workflowRunId: task.workflowRunId ?? null,
        createdByTaskScheduleId: task.createdByTaskScheduleId ?? null,
        ...params.metadata,
      },
    });
    try {
      const traceResult = this.deps.traceEvidenceService?.captureForTaskWithDiagnostic({
        scopeId: scope.id,
        taskId: task.id,
      });
      if (traceResult) {
        if (traceResult.evidence.length > 0) {
          this.clearTraceDiagnosticEvidence(scope.id, task.id, traceResult.diagnostic);
        } else {
          this.createTraceDiagnosticEvidence(scope.id, task.id, traceResult.diagnostic);
        }
      }
    } catch (err) {
      this.createTraceDiagnosticEvidence(scope.id, task.id, traceCaptureErrorDiagnostic(err));
      log.warn('Trace evidence capture failed; keeping primary task evidence:', err);
    }
    return evidence;
  }

  attachWorkflowRunEvidence(params: AttachWorkflowRunEvidenceParams): EvidenceRef {
    const run = this.deps.workflowRunRepo.getRun(params.workflowRunId);
    if (!run) throw new Error(`Workflow run not found: ${params.workflowRunId}`);
    const scope = params.scopeId
      ? this.requireScope(params.scopeId)
      : this.requireScopeForWorkflowRun(params.workflowRunId);
    if (scope.spaceId !== run.spaceId) {
      throw new Error('Workflow run and scope must belong to the same space');
    }
    return this.createEvidence({
      scopeId: scope.id,
      kind: 'workflow_run',
      sourceId: run.id,
      summary: params.summary ?? `Workflow run: ${run.title}`,
      metadata: {
        status: run.status,
        workflowId: run.workflowId,
        ...params.metadata,
      },
    });
  }

  captureCompletedTaskEvidence(
    params: CaptureCompletedTaskEvidenceParams
  ): CaptureCompletedTaskEvidenceResult {
    const task = this.deps.taskRepo.getTask(params.taskId);
    if (!task) throw new Error(`Task not found: ${params.taskId}`);
    if (task.status !== 'done') return { scope: null, evidence: [] };

    const scope = this.findScopeForTask(task.evolutionScopeId ?? null, task.goalId ?? null);
    if (!scope || scope.spaceId !== task.spaceId) return { scope: null, evidence: [] };

    const taskResultSummary = buildTaskResultEvidenceSummary(task);
    const taskResultMetadata = buildTaskResultEvidenceMetadata(task);
    const evidence: EvidenceRef[] = [
      this.createAutoEvidenceOnce({
        scopeId: scope.id,
        kind: 'task_result',
        sourceId: task.id,
        summary: taskResultSummary,
        metadata: taskResultMetadata,
      }),
    ];

    const crossPost = this.createProposalOriginEvidence(scope.id, task, {
      summary: taskResultSummary,
      metadata: taskResultMetadata,
    });
    if (crossPost) evidence.push(crossPost);

    if (task.workflowRunId) {
      const run = this.deps.workflowRunRepo.getRun(task.workflowRunId);
      if (run && run.spaceId === task.spaceId) {
        const artifacts = this.deps.artifactRepo?.listByRun(run.id) ?? [];
        evidence.push(
          this.createAutoEvidenceOnce({
            scopeId: scope.id,
            kind: selectWorkflowEvidenceKind(run, artifacts),
            sourceId: run.id,
            summary: buildWorkflowRunEvidenceSummary(run, artifacts),
            metadata: {
              status: run.status,
              workflowId: run.workflowId,
              failureReason: run.failureReason ?? null,
              completedAt: run.completedAt ?? null,
              artifactCount: artifacts.length,
              artifactTypes: summarizeArtifactTypes(artifacts),
              artifacts: artifacts.map(summarizeArtifact),
            },
          })
        );
      }
    }

    const traceResult = this.captureTraceEvidenceForCompletedTask(scope.id, task.id);
    evidence.push(...traceResult.evidence);
    this.enqueueConversationFrictionAnalysis(scope.id, task.id);

    return { scope, evidence, traceDiagnostic: traceResult.diagnostic };
  }

  addManualNoteEvidence(params: AddManualNoteEvidenceParams): EvidenceRef {
    return this.createEvidence({
      scopeId: params.scopeId,
      kind: 'manual_note',
      summary: params.summary,
      metadata: params.metadata,
      createdAt: params.createdAt,
    });
  }

  addMetricSnapshotEvidence(params: AddMetricSnapshotEvidenceParams): {
    snapshot: MetricSnapshot;
    evidence: EvidenceRef;
  } {
    this.requireScope(params.scopeId);
    const snapshot = this.deps.evolutionRepo.createMetricSnapshot({
      scopeId: params.scopeId,
      values: params.values,
      source: params.source,
      note: params.note,
      capturedAt: params.capturedAt,
    });
    const evidence = this.deps.evolutionRepo.createEvidence({
      scopeId: params.scopeId,
      kind: 'metric_snapshot',
      sourceId: snapshot.id,
      summary: params.summary ?? snapshot.note ?? `Metric snapshot from ${snapshot.source}`,
      metadata: params.metadata,
      createdAt: snapshot.capturedAt,
    });
    return { snapshot, evidence };
  }

  listEvidence(scopeId: string, includePreflightContext = false): EvolutionEvidenceListResponse {
    const scope = this.requireScope(scopeId);
    const evidence = this.deps.evolutionRepo.listEvidence(scopeId);
    return includePreflightContext
      ? {
          evidence,
          preflightContext: this.buildPreflightContext(scope, evidence),
        }
      : { evidence };
  }

  private buildPreflightContext(
    scope: EvolutionScope,
    evidence: EvidenceRef[]
  ): NonNullable<EvolutionEvidenceListResponse['preflightContext']> {
    const tasks = evidence.flatMap((item) => {
      if (item.kind !== 'task' && item.kind !== 'task_result') return [];
      if (!item.sourceId) return [];
      const task = this.deps.taskRepo.getTask(item.sourceId);
      if (!task || task.spaceId !== scope.spaceId) return [];
      return [{ evidenceId: item.id, task: summarizeTaskForPreflight(task) }];
    });
    const evidenceIdsByRunId = new Map<string, string[]>();
    for (const item of evidence) {
      if (item.kind !== 'workflow_run' && item.kind !== 'artifact' && item.kind !== 'error') {
        continue;
      }
      if (!item.sourceId) continue;
      const current = evidenceIdsByRunId.get(item.sourceId) ?? [];
      current.push(item.id);
      evidenceIdsByRunId.set(item.sourceId, current);
    }
    const workflowRuns = Array.from(evidenceIdsByRunId.entries()).flatMap(
      ([runId, evidenceIds]) => {
        const run = this.deps.workflowRunRepo.getRun(runId);
        if (!run || run.spaceId !== scope.spaceId) return [];
        return [
          {
            evidenceIds,
            run,
            tasks: this.deps.taskRepo
              .listByWorkflowRunIncludingArchived(run.id)
              .map(summarizeTaskForPreflight),
            artifacts: (this.deps.artifactRepo?.listByRun(run.id) ?? [])
              .slice(0, MAX_PREFLIGHT_ARTIFACTS_PER_RUN)
              .map((artifact) => ({
                id: artifact.id,
                runId: artifact.runId,
                nodeId: artifact.nodeId,
                artifactType: artifact.artifactType,
                artifactKey: artifact.artifactKey,
                data: { summary: summarizeArtifactData(artifact.data) },
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt,
              })),
          },
        ];
      }
    );
    return { tasks, workflowRuns };
  }

  listMetricSnapshots(scopeId: string): MetricSnapshot[] {
    this.requireScope(scopeId);
    return this.deps.evolutionRepo.listMetricSnapshots(scopeId);
  }

  listTimeline(scopeId: string): ScopeTimeline {
    const scope = this.requireScope(scopeId);
    return {
      scope,
      evidence: this.deps.evolutionRepo.listEvidence(scopeId),
      metricSnapshots: this.deps.evolutionRepo.listMetricSnapshots(scopeId),
    };
  }

  private requireSpace(spaceId: string) {
    if (!spaceId) throw new Error('spaceId is required');
    const space = this.deps.spaceRepo.getSpace(spaceId);
    if (!space) throw new Error(`Space not found: ${spaceId}`);
    return space;
  }

  private requireGoal(goalId: string) {
    if (!goalId) throw new Error('spaceGoalId is required');
    const goal = this.deps.goalRepo.getById(goalId);
    if (!goal) throw new Error(`SpaceGoal not found: ${goalId}`);
    return goal;
  }

  private requireGoalInSpace(goalId: string, spaceId: string) {
    const goal = this.requireGoal(goalId);
    if (goal.spaceId !== spaceId) throw new Error(`SpaceGoal not found in space: ${goalId}`);
    return goal;
  }

  private captureTraceEvidenceForCompletedTask(
    scopeId: string,
    taskId: string
  ): { evidence: EvidenceRef[]; diagnostic: TraceEvidenceDiagnostic } {
    const service = this.deps.traceEvidenceService;
    if (!service) return { evidence: [], diagnostic: traceCaptureUnavailableDiagnostic() };
    try {
      const result = service.captureForTaskWithDiagnostic({ scopeId, taskId });
      if (result.evidence.length === 0) {
        this.createTraceDiagnosticEvidence(scopeId, taskId, result.diagnostic);
      } else {
        this.clearTraceDiagnosticEvidence(scopeId, taskId, result.diagnostic);
      }
      return result;
    } catch (err) {
      const diagnostic = traceCaptureErrorDiagnostic(err);
      this.createTraceDiagnosticEvidence(scopeId, taskId, diagnostic);
      log.warn('Trace evidence capture failed; keeping primary completion evidence:', err);
      return { evidence: [], diagnostic };
    }
  }

  private enqueueConversationFrictionAnalysis(scopeId: string, taskId: string): void {
    this.deps.jobQueue?.enqueueUniquePending({
      queue: SPACE_CONVERSATION_FRICTION_ANALYZE,
      payload: { scopeId, taskId },
      matchPayload: { scopeId, taskId },
      maxRetries: 3,
    });
  }

  private createProposalOriginEvidence(
    assignedScopeId: string,
    task: SpaceTask,
    params: Pick<CreateEvidenceRefParams, 'summary' | 'metadata'>
  ): EvidenceRef | null {
    const proposal = this.deps.evolutionRepo.getTaskProposalByCreatedTaskId(task.id);
    if (!proposal || proposal.scopeId === assignedScopeId) return null;
    const originScope = this.deps.evolutionRepo.getScope(proposal.scopeId);
    if (!originScope || originScope.spaceId !== task.spaceId) return null;
    return this.createAutoEvidenceOnce({
      scopeId: originScope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: params.summary,
      metadata: {
        ...params.metadata,
        crossLinkedTaskId: task.id,
        originatingProposalId: proposal.id,
        assignedScopeId,
      },
    });
  }

  private createTraceDiagnosticEvidence(
    scopeId: string,
    taskId: string,
    diagnostic: TraceEvidenceDiagnostic
  ): EvidenceRef {
    return this.createAutoEvidenceOnce({
      scopeId,
      kind: 'session',
      sourceId: taskId,
      summary: diagnostic.message,
      metadata: {
        traceDiagnostic: true,
        ...diagnostic,
      },
    });
  }

  private clearTraceDiagnosticEvidence(
    scopeId: string,
    taskId: string,
    diagnostic: TraceEvidenceDiagnostic
  ): void {
    const existing = this.deps.evolutionRepo
      .listEvidence(scopeId)
      .find(
        (item) =>
          item.kind === 'session' &&
          item.sourceId === taskId &&
          item.metadata.autoCaptured === true &&
          item.metadata.traceDiagnostic === true
      );
    if (!existing) return;
    this.deps.evolutionRepo.updateEvidence(existing.id, {
      summary: diagnostic.message,
      metadata: {
        autoCaptured: true,
        traceDiagnostic: true,
        clearedByTraceEvidence: true,
        ...diagnostic,
      },
    });
  }

  private createAutoEvidenceOnce(params: CreateEvidenceRefParams): EvidenceRef {
    const sourceId = params.sourceId ?? null;
    const existing = this.deps.evolutionRepo
      .listEvidence(params.scopeId)
      .find(
        (item) =>
          item.kind === params.kind &&
          item.sourceId === sourceId &&
          item.metadata.autoCaptured === true
      );
    const metadata = { ...params.metadata, autoCaptured: true };
    if (existing) {
      return this.deps.evolutionRepo.updateEvidence(existing.id, {
        summary: params.summary,
        metadata,
      });
    }
    return this.deps.evolutionRepo.createEvidence({ ...params, metadata });
  }

  private requireScope(scopeId: string): EvolutionScope {
    if (!scopeId) throw new Error('scopeId is required');
    const scope = this.deps.evolutionRepo.getScope(scopeId);
    if (!scope) throw new Error(`EvolutionScope not found: ${scopeId}`);
    return scope;
  }

  private requireScopeInSpace(scopeId: string, spaceId: string): EvolutionScope {
    const scope = this.requireScope(scopeId);
    if (scope.spaceId !== spaceId) throw new Error(`EvolutionScope not found in space: ${scopeId}`);
    return scope;
  }

  private findScopeForTask(
    evolutionScopeId: string | null,
    goalId: string | null
  ): EvolutionScope | null {
    if (evolutionScopeId) return this.deps.evolutionRepo.getScope(evolutionScopeId) ?? null;
    if (!goalId) return null;
    const goal = this.deps.goalRepo.getById(goalId);
    if (!goal) return null;
    return (
      this.deps.evolutionRepo.listScopes({ spaceId: goal.spaceId, spaceGoalId: goal.id })[0] ?? null
    );
  }

  private requireScopeForTask(
    taskId: string,
    evolutionScopeId: string | null,
    goalId: string | null
  ): EvolutionScope {
    const scope = this.findScopeForTask(evolutionScopeId, goalId);
    if (scope) return scope;
    if (evolutionScopeId) throw new Error(`EvolutionScope not found: ${evolutionScopeId}`);
    if (!goalId) throw new Error(`Task is not linked to an EvolutionScope or SpaceGoal: ${taskId}`);
    throw new Error(`EvolutionScope not found for SpaceGoal: ${goalId}`);
  }

  private requireScopeForWorkflowRun(workflowRunId: string): EvolutionScope {
    const task = this.deps.taskRepo.listByWorkflowRunIncludingArchived(workflowRunId)[0];
    if (!task) throw new Error(`Task not found for workflow run: ${workflowRunId}`);
    return this.requireScopeForTask(task.id, task.evolutionScopeId ?? null, task.goalId ?? null);
  }
}

function buildTaskResultEvidenceSummary(task: SpaceTask): string {
  const outcome = task.result ?? task.reportedSummary ?? 'completed without task.result';
  return `Task #${task.taskNumber} done: ${task.title} — ${truncateText(outcome, 180)}`;
}

function buildTaskResultEvidenceMetadata(task: SpaceTask): Record<string, unknown> {
  return {
    status: task.status,
    priority: task.priority,
    workflowRunId: task.workflowRunId ?? null,
    result: task.result ?? null,
    reportedSummary: task.reportedSummary ?? null,
    completedAt: task.completedAt ?? null,
  };
}

function summarizeTaskForPreflight(task: SpaceTask): EvolutionPreflightTaskSummary {
  return {
    title: task.title,
    status: task.status,
    reportedStatus: task.reportedStatus ?? null,
    reportedSummary: task.reportedSummary ?? null,
    result: task.result ?? null,
  };
}

function selectWorkflowEvidenceKind(
  run: SpaceWorkflowRun,
  artifacts: WorkflowRunArtifactRecord[]
): EvidenceKind {
  if (run.status === 'blocked' || run.status === 'cancelled') return 'error';
  return artifacts.length > 0 ? 'artifact' : 'workflow_run';
}

function buildWorkflowRunEvidenceSummary(
  run: SpaceWorkflowRun,
  artifacts: WorkflowRunArtifactRecord[]
): string {
  const labels = summarizeArtifactTypes(artifacts);
  const detail =
    findArtifactDetail(artifacts) ?? activeFailureReason(run) ?? 'no artifacts captured';
  return `Workflow run ${run.status}: ${run.title} — ${labels.join(', ') || 'no artifact types'} — ${truncateText(detail, 180)}`;
}

function activeFailureReason(run: SpaceWorkflowRun): string | null {
  return run.status === 'blocked' || run.status === 'cancelled'
    ? (run.failureReason ?? null)
    : null;
}

function summarizeArtifactTypes(artifacts: WorkflowRunArtifactRecord[]): string[] {
  return Array.from(new Set(artifacts.map((artifact) => artifact.artifactType))).sort();
}

function summarizeArtifact(artifact: WorkflowRunArtifactRecord): Record<string, unknown> {
  return {
    nodeId: artifact.nodeId,
    type: artifact.artifactType,
    key: artifact.artifactKey,
    data: truncateStructuredData(artifact.data),
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function findArtifactDetail(artifacts: WorkflowRunArtifactRecord[]): string | null {
  for (const artifact of artifacts) {
    const detail = extractArtifactDetail(artifact.data);
    if (detail) return `${artifact.artifactType}/${artifact.artifactKey}: ${detail}`;
  }
  return null;
}

function extractArtifactDetail(data: Record<string, unknown>): string | null {
  for (const key of [
    'summary',
    'result',
    'status',
    'pr_url',
    'review_url',
    'merge_commit',
    'error',
  ]) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function truncateStructuredData(value: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (serialized.length <= 2000) return value;
  return { truncated: truncateText(serialized, 2000) };
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
