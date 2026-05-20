import type {
	CreateEvidenceRefParams,
	CreateEvolutionScopeParams,
	CreateMetricSnapshotParams,
	EvidenceRef,
	EvolutionScope,
	EvolutionScopeListParams,
	MetricSnapshot,
	UpdateEvolutionScopeParams,
} from '@neokai/shared';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository';
import type { SpaceGoalRepository } from '../../storage/repositories/space-goal-repository';
import type { SpaceRepository } from '../../storage/repositories/space-repository';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';

export interface EvolutionScopeServiceDeps {
	evolutionRepo: EvolutionRepository;
	spaceRepo: SpaceRepository;
	goalRepo: SpaceGoalRepository;
	taskRepo: SpaceTaskRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
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
		return this.deps.evolutionRepo.createEvidence({
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
		return this.deps.evolutionRepo.createEvidence({
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

	private requireScopeForTask(
		taskId: string,
		evolutionScopeId: string | null,
		goalId: string | null
	): EvolutionScope {
		if (evolutionScopeId) return this.requireScope(evolutionScopeId);
		if (!goalId) throw new Error(`Task is not linked to an EvolutionScope or SpaceGoal: ${taskId}`);
		const scope = this.resolveScopeForGoal({ spaceGoalId: goalId });
		if (!scope) throw new Error(`EvolutionScope not found for SpaceGoal: ${goalId}`);
		return scope;
	}

	private requireScopeForWorkflowRun(workflowRunId: string): EvolutionScope {
		const task = this.deps.taskRepo.listByWorkflowRunIncludingArchived(workflowRunId)[0];
		if (!task) throw new Error(`Task not found for workflow run: ${workflowRunId}`);
		return this.requireScopeForTask(task.id, task.evolutionScopeId ?? null, task.goalId ?? null);
	}
}
