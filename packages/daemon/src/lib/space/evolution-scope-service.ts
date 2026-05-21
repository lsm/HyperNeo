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
} from '@neokai/shared';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository';
import type { SpaceGoalRepository } from '../../storage/repositories/space-goal-repository';
import type { SpaceRepository } from '../../storage/repositories/space-repository';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import type {
	WorkflowRunArtifactRecord,
	WorkflowRunArtifactRepository,
} from '../../storage/repositories/workflow-run-artifact-repository';

export interface EvolutionScopeServiceDeps {
	evolutionRepo: EvolutionRepository;
	spaceRepo: SpaceRepository;
	goalRepo: SpaceGoalRepository;
	taskRepo: SpaceTaskRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
	artifactRepo?: WorkflowRunArtifactRepository;
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
}

export interface ScopeTimeline {
	scope: EvolutionScope;
	evidence: EvidenceRef[];
	metricSnapshots: MetricSnapshot[];
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
		return this.createEvidenceOnce({
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
		return this.createEvidenceOnce({
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

		const evidence: EvidenceRef[] = [
			this.createEvidenceOnce({
				scopeId: scope.id,
				kind: 'task_result',
				sourceId: task.id,
				summary: buildTaskResultEvidenceSummary(task),
				metadata: {
					status: task.status,
					priority: task.priority,
					workflowRunId: task.workflowRunId ?? null,
					result: task.result ?? null,
					reportedSummary: task.reportedSummary ?? null,
					completedAt: task.completedAt ?? null,
				},
			}),
		];

		if (task.workflowRunId) {
			const run = this.deps.workflowRunRepo.getRun(task.workflowRunId);
			if (run && run.spaceId === task.spaceId) {
				const artifacts = this.deps.artifactRepo?.listByRun(run.id) ?? [];
				evidence.push(
					this.createEvidenceOnce({
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

		return { scope, evidence };
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

	listEvidence(scopeId: string): EvidenceRef[] {
		this.requireScope(scopeId);
		return this.deps.evolutionRepo.listEvidence(scopeId);
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

	private createEvidenceOnce(params: CreateEvidenceRefParams): EvidenceRef {
		const sourceId = params.sourceId ?? null;
		const existing = this.deps.evolutionRepo
			.listEvidence(params.scopeId)
			.find((item) => item.kind === params.kind && item.sourceId === sourceId);
		if (existing) {
			return this.deps.evolutionRepo.updateEvidence(existing.id, {
				summary: params.summary,
				metadata: params.metadata,
			});
		}
		return this.deps.evolutionRepo.createEvidence(params);
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

function selectWorkflowEvidenceKind(
	run: SpaceWorkflowRun,
	artifacts: WorkflowRunArtifactRecord[]
): EvidenceKind {
	if (run.status === 'blocked' || run.status === 'cancelled' || run.failureReason) return 'error';
	return artifacts.length > 0 ? 'artifact' : 'workflow_run';
}

function buildWorkflowRunEvidenceSummary(
	run: SpaceWorkflowRun,
	artifacts: WorkflowRunArtifactRecord[]
): string {
	const labels = summarizeArtifactTypes(artifacts);
	const detail = findArtifactDetail(artifacts) ?? run.failureReason ?? 'no artifacts captured';
	return `Workflow run ${run.status}: ${run.title} — ${labels.join(', ') || 'no artifact types'} — ${truncateText(detail, 180)}`;
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
