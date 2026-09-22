import type {
  CreateEvidenceRefParams,
  CreateEvolutionScopeParams,
  EvidenceRef,
  EvolutionLesson,
  EvolutionScope,
  EvolutionScopeListParams,
  EvolutionListPagination,
  MetricSnapshot,
  UpdateEvolutionScopeParams,
  EvolutionEvidenceListResponse,
} from '@hyperneo/shared';
import { Logger } from '../logger.ts';
import type {
  AddManualNoteEvidenceParams,
  AddMetricSnapshotEvidenceParams,
  AttachTaskEvidenceParams,
  AttachWorkflowRunEvidenceParams,
  CaptureCompletedTaskEvidenceParams,
  CaptureCompletedTaskEvidenceResult,
  EvolutionScopeServiceDeps,
  ResolveScopeForGoalParams,
  ResolveScopeForTaskParams,
  ScopeTimeline,
  SelectTaskLessonsParams,
} from './scope-service-types.ts';
import { mergeEvolutionPolicy } from './scope-policy.ts';
import { rankLessonsByTaskRelevance } from './lesson-ranking.ts';
import { buildPreflightContext } from './scope-preflight-context.ts';
import {
  buildTaskResultEvidenceMetadata,
  buildTaskResultEvidenceSummary,
  buildWorkflowRunEvidenceSummary,
  selectWorkflowEvidenceKind,
  summarizeArtifact,
  summarizeArtifactTypes,
} from './scope-evidence-summaries.ts';
import {
  createAutoEvidenceOnce,
  createProposalOriginEvidence,
  createTraceDiagnosticEvidence,
  clearTraceDiagnosticEvidence,
} from './scope-auto-evidence.ts';
import {
  captureFrictionDigestEvidence,
  captureTraceEvidenceForCompletedTask,
  enqueueConversationFrictionAnalysis,
  traceCaptureErrorDiagnostic,
} from './scope-trace-capture.ts';
import {
  findScopeForTask,
  requireGoal,
  requireGoalInSpace,
  requireScope,
  requireScopeForTask,
  requireScopeForWorkflowRun,
  requireScopeInSpace,
  requireSpace,
} from './scope-resolution.ts';

export { mergeEvolutionPolicy } from './scope-policy.ts';
export type {
  AddManualNoteEvidenceParams,
  EvolutionScopeServiceDeps,
} from './scope-service-types.ts';

const log = new Logger('evolution-scope-service');

export class EvolutionScopeService {
  constructor(private deps: EvolutionScopeServiceDeps) {}

  createScope(params: CreateEvolutionScopeParams): EvolutionScope {
    requireSpace(this.deps, params.spaceId);
    if (params.spaceGoalId !== undefined && params.spaceGoalId !== null) {
      requireGoalInSpace(this.deps, params.spaceGoalId, params.spaceId);
    }
    if (params.parentScopeId) {
      requireScopeInSpace(this.deps, params.parentScopeId, params.spaceId);
    }
    return this.deps.evolutionRepo.createScope(params);
  }

  getScope(id: string): EvolutionScope | null {
    return this.deps.evolutionRepo.getScope(id);
  }

  listScopes(params: EvolutionScopeListParams): EvolutionScope[] {
    requireSpace(this.deps, params.spaceId);
    if (params.spaceGoalId !== undefined && params.spaceGoalId !== null) {
      requireGoalInSpace(this.deps, params.spaceGoalId, params.spaceId);
    }
    return this.deps.evolutionRepo.listScopes(params);
  }

  updateScope(id: string, params: UpdateEvolutionScopeParams): EvolutionScope | null {
    const existing = this.deps.evolutionRepo.getScope(id);
    if (!existing) return null;
    if (params.spaceGoalId !== undefined && params.spaceGoalId !== null) {
      requireGoalInSpace(this.deps, params.spaceGoalId, existing.spaceId);
    }
    if (params.parentScopeId) {
      requireScopeInSpace(this.deps, params.parentScopeId, existing.spaceId);
    }
    const updateParams = params.policyPatch
      ? {
          ...params,
          policy: mergeEvolutionPolicy(existing.policy, params.policyPatch),
          policyPatch: undefined,
        }
      : params;
    return this.deps.evolutionRepo.updateScope(id, updateParams);
  }

  resolveScopeForGoal(params: ResolveScopeForGoalParams): EvolutionScope | null {
    const goal = requireGoal(this.deps, params.spaceGoalId);
    return (
      this.deps.evolutionRepo.listScopes({ spaceId: goal.spaceId, spaceGoalId: goal.id })[0] ?? null
    );
  }

  resolveScopeForTask(params: ResolveScopeForTaskParams): EvolutionScope | null {
    const task = this.deps.taskRepo.getTask(params.taskId);
    if (!task) throw new Error(`Task not found: ${params.taskId}`);
    const scope = findScopeForTask(this.deps, task.evolutionScopeId ?? null, task.goalId ?? null);
    if (!scope || scope.spaceId !== task.spaceId) return null;
    return scope;
  }

  selectActiveLessonsForTask(params: SelectTaskLessonsParams): EvolutionLesson[] {
    const scope = this.resolveScopeForTask({ taskId: params.taskId });
    if (!scope) return [];
    const limit = Math.max(0, params.limit ?? 3);
    if (limit === 0) return [];
    const task = this.deps.taskRepo.getTask(params.taskId);
    const lessons = this.deps.evolutionRepo.listLessons(scope.id, 'active');
    if (!task || lessons.length === 0) return lessons.slice(0, limit);
    return rankLessonsByTaskRelevance(lessons, task).slice(0, limit);
  }

  createEvidence(params: CreateEvidenceRefParams): EvidenceRef {
    requireScope(this.deps, params.scopeId);
    return this.deps.evolutionRepo.createEvidence(params);
  }

  attachTaskEvidence(params: AttachTaskEvidenceParams): EvidenceRef {
    const task = this.deps.taskRepo.getTask(params.taskId);
    if (!task) throw new Error(`Task not found: ${params.taskId}`);
    const scope = params.scopeId
      ? requireScope(this.deps, params.scopeId)
      : requireScopeForTask(this.deps, task.id, task.evolutionScopeId ?? null, task.goalId ?? null);
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
          clearTraceDiagnosticEvidence(
            this.deps.evolutionRepo,
            scope.id,
            task.id,
            traceResult.diagnostic
          );
          captureFrictionDigestEvidence(this.deps, scope.id, task.id);
        } else {
          createTraceDiagnosticEvidence(
            this.deps.evolutionRepo,
            scope.id,
            task.id,
            traceResult.diagnostic
          );
        }
      }
    } catch (err) {
      createTraceDiagnosticEvidence(
        this.deps.evolutionRepo,
        scope.id,
        task.id,
        traceCaptureErrorDiagnostic(err)
      );
      log.warn('Trace evidence capture failed; keeping primary task evidence:', err);
    }
    return evidence;
  }

  attachWorkflowRunEvidence(params: AttachWorkflowRunEvidenceParams): EvidenceRef {
    const run = this.deps.workflowRunRepo.getRun(params.workflowRunId);
    if (!run) throw new Error(`Workflow run not found: ${params.workflowRunId}`);
    const scope = params.scopeId
      ? requireScope(this.deps, params.scopeId)
      : requireScopeForWorkflowRun(this.deps, params.workflowRunId);
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
    const forgeAutomationPrefixes = [
      'automation:completed_task_threshold:',
      'automation:self_nag:',
      'automation:external_event:',
    ];
    if (
      task.labels.includes('automation') &&
      task.labels.some((label) =>
        forgeAutomationPrefixes.some((prefix) => label.startsWith(prefix))
      )
    ) {
      return { scope: null, evidence: [] };
    }

    const scope = findScopeForTask(this.deps, task.evolutionScopeId ?? null, task.goalId ?? null);
    if (!scope || scope.spaceId !== task.spaceId) return { scope: null, evidence: [] };

    const taskResultSummary = buildTaskResultEvidenceSummary(task);
    const taskResultMetadata = buildTaskResultEvidenceMetadata(task);
    const evidence: EvidenceRef[] = [
      createAutoEvidenceOnce(this.deps.evolutionRepo, {
        scopeId: scope.id,
        kind: 'task_result',
        sourceId: task.id,
        summary: taskResultSummary,
        metadata: taskResultMetadata,
      }),
    ];

    const crossPost = createProposalOriginEvidence(this.deps.evolutionRepo, scope.id, task, {
      summary: taskResultSummary,
      metadata: taskResultMetadata,
    });
    if (crossPost) evidence.push(crossPost);

    if (task.workflowRunId) {
      const run = this.deps.workflowRunRepo.getRun(task.workflowRunId);
      if (run && run.spaceId === task.spaceId) {
        const artifacts = this.deps.artifactRepo?.listByRun(run.id) ?? [];
        evidence.push(
          createAutoEvidenceOnce(this.deps.evolutionRepo, {
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

    const traceResult = captureTraceEvidenceForCompletedTask(this.deps, scope.id, task.id);
    evidence.push(...traceResult.evidence);
    if (traceResult.evidence.length > 0) {
      const digest = captureFrictionDigestEvidence(this.deps, scope.id, task.id);
      if (digest) evidence.push(digest);
    }
    enqueueConversationFrictionAnalysis(this.deps, scope.id, task.id);

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
    requireScope(this.deps, params.scopeId);
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

  listEvidence(
    scopeId: string,
    options: { includePreflightContext?: boolean; limit?: number; offset?: number } = {}
  ): EvolutionEvidenceListResponse {
    const scope = requireScope(this.deps, scopeId);
    const evidence = this.deps.evolutionRepo.listEvidence(scopeId, {
      limit: options.limit,
      offset: options.offset,
    });
    return options.includePreflightContext
      ? {
          evidence,
          preflightContext: buildPreflightContext(this.deps, scope, evidence),
        }
      : { evidence };
  }

  listMetricSnapshots(scopeId: string, pagination?: EvolutionListPagination): MetricSnapshot[] {
    requireScope(this.deps, scopeId);
    return this.deps.evolutionRepo.listMetricSnapshots(scopeId, pagination);
  }

  listTimeline(scopeId: string): ScopeTimeline {
    const scope = requireScope(this.deps, scopeId);
    return {
      scope,
      evidence: this.deps.evolutionRepo.listEvidence(scopeId),
      metricSnapshots: this.deps.evolutionRepo.listMetricSnapshots(scopeId),
    };
  }
}
