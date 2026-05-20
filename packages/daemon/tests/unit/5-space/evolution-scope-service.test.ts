import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { EvolutionScopeService } from '../../../src/lib/space/evolution-scope-service';
import { EvolutionRepository } from '../../../src/storage/repositories/evolution-repository';
import { GateOpenStateRepository } from '../../../src/storage/repositories/gate-open-state-repository';
import { SpaceGoalRepository } from '../../../src/storage/repositories/space-goal-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository';
import { createSpaceTables } from '../helpers/space-test-db';

describe('EvolutionScopeService', () => {
	let db: Database;
	let service: EvolutionScopeService;
	let evolutionRepo: EvolutionRepository;
	let goalRepo: SpaceGoalRepository;
	let taskRepo: SpaceTaskRepository;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let workflowRepo: SpaceWorkflowRepository;
	let spaceRepo: SpaceRepository;
	let spaceId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);

		spaceRepo = new SpaceRepository(db as never);
		evolutionRepo = new EvolutionRepository(db as never);
		goalRepo = new SpaceGoalRepository(db as never);
		taskRepo = new SpaceTaskRepository(db as never);
		workflowRunRepo = new SpaceWorkflowRunRepository(
			db as never,
			new GateOpenStateRepository(db as never)
		);
		workflowRepo = new SpaceWorkflowRepository(db as never);
		service = new EvolutionScopeService({
			evolutionRepo,
			spaceRepo,
			goalRepo,
			taskRepo,
			workflowRunRepo,
		});

		spaceId = spaceRepo.createSpace({
			workspacePath: '/workspace/forge-service-test',
			slug: 'forge-service-test',
			name: 'Forge Service Test',
		}).id;
	});

	afterEach(() => {
		db.close();
	});

	it('creates a mission scope from an existing recurring SpaceGoal', () => {
		const goal = goalRepo.create({
			spaceId,
			title: 'Recurring Forge check-in',
			description: 'Reduce review churn over time',
			type: 'recurring',
		});

		const scope = service.createScopeFromGoal({ spaceGoalId: goal.id });

		expect(scope).toMatchObject({
			spaceId,
			spaceGoalId: goal.id,
			kind: 'mission',
			name: 'Recurring Forge check-in',
			objective: 'Reduce review churn over time',
		});
		expect(service.resolveScopeForGoal({ spaceGoalId: goal.id })?.id).toBe(scope.id);
	});

	it('attaches scheduled goal task evidence by resolving scope through spaceGoalId', () => {
		const goal = goalRepo.create({ spaceId, title: 'Weekly check-in', type: 'recurring' });
		const scope = service.createScopeFromGoal({ spaceGoalId: goal.id });
		const task = taskRepo.createTask({
			spaceId,
			title: 'Scheduled check-in task',
			description: 'Review goal progress',
			goalId: goal.id,
			createdByTaskScheduleId: 'schedule-1',
		});

		const evidence = service.attachTaskEvidence({ taskId: task.id });

		expect(evidence).toMatchObject({
			scopeId: scope.id,
			kind: 'task',
			sourceId: task.id,
			summary: 'Task #1: Scheduled check-in task',
		});
		expect(evidence.metadata).toMatchObject({
			workflowRunId: null,
			createdByTaskScheduleId: 'schedule-1',
		});
	});

	it('attaches task evidence through explicit evolutionScopeId before goal fallback', () => {
		const scope = service.createScope({
			spaceId,
			kind: 'custom',
			name: 'Explicit task scope',
			objective: 'Collect custom workflow evidence',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Custom scoped task',
			description: 'Has explicit evolution scope but no goal',
			evolutionScopeId: scope.id,
		});

		const evidence = service.attachTaskEvidence({ taskId: task.id });

		expect(evidence).toMatchObject({
			scopeId: scope.id,
			kind: 'task',
			sourceId: task.id,
		});
	});

	it('resolves task scope through linked goal and selects top 3 active lessons', () => {
		const goal = goalRepo.create({ spaceId, title: 'Weekly check-in', type: 'recurring' });
		const scope = service.createScopeFromGoal({ spaceGoalId: goal.id });
		const task = taskRepo.createTask({
			spaceId,
			title: 'Scheduled check-in task',
			description: 'Review goal progress',
			goalId: goal.id,
		});
		for (let index = 1; index <= 5; index++) {
			const lesson = evolutionRepo.createLesson({
				scopeId: scope.id,
				status: index === 5 ? 'candidate' : 'active',
				rule: `Lesson ${index}`,
				why: `Why ${index}`,
			});
			evolutionRepo.updateLesson(lesson.id, { confidence: index / 10 });
		}

		expect(service.resolveScopeForTask({ taskId: task.id })?.id).toBe(scope.id);
		expect(service.selectActiveLessonsForTask({ taskId: task.id })).toHaveLength(3);
		expect(
			service
				.selectActiveLessonsForTask({ taskId: task.id })
				.every((lesson) => lesson.status === 'active')
		).toBe(true);
	});

	it('returns no active lessons for unscoped tasks', () => {
		const task = taskRepo.createTask({
			spaceId,
			title: 'Unscoped task',
			description: 'No goal or explicit scope',
		});

		expect(service.resolveScopeForTask({ taskId: task.id })).toBeNull();
		expect(service.selectActiveLessonsForTask({ taskId: task.id })).toEqual([]);
	});

	it('returns no active lessons for tasks with stale evolutionScopeId', () => {
		const task = taskRepo.createTask({
			spaceId,
			title: 'Stale scoped task',
			description: 'References missing scope',
			evolutionScopeId: 'missing-scope',
		});

		expect(service.resolveScopeForTask({ taskId: task.id })).toBeNull();
		expect(service.selectActiveLessonsForTask({ taskId: task.id })).toEqual([]);
		expect(() => service.attachTaskEvidence({ taskId: task.id })).toThrow(
			'EvolutionScope not found: missing-scope'
		);
	});

	it('returns no active lessons for tasks with cross-space evolutionScopeId', () => {
		const otherSpaceId = spaceRepo.createSpace({
			workspacePath: '/workspace/other-forge-service-test',
			slug: 'other-forge-service-test',
			name: 'Other Forge Service Test',
		}).id;
		const otherScope = service.createScope({
			spaceId: otherSpaceId,
			kind: 'custom',
			name: 'Other scope',
			objective: 'Own unrelated lessons',
		});
		evolutionRepo.createLesson({
			scopeId: otherScope.id,
			status: 'active',
			rule: 'Unrelated lesson',
			why: 'Different space',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Cross-space scoped task',
			description: 'References another space scope',
			evolutionScopeId: otherScope.id,
		});

		expect(service.resolveScopeForTask({ taskId: task.id })).toBeNull();
		expect(service.selectActiveLessonsForTask({ taskId: task.id })).toEqual([]);
		expect(() => service.attachTaskEvidence({ taskId: task.id })).toThrow(
			'Task and scope must belong to the same space'
		);
	});

	it('attaches workflow-run evidence through explicit evolutionScopeId parent task', () => {
		const scope = service.createScope({
			spaceId,
			kind: 'custom',
			name: 'Explicit workflow scope',
			objective: 'Collect workflow evidence',
		});
		const workflow = workflowRepo.createWorkflow({
			spaceId,
			name: 'Custom workflow',
			description: 'Run custom scope',
		});
		const run = workflowRunRepo.createRun({
			spaceId,
			workflowId: workflow.id,
			title: 'Custom run',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Custom workflow task',
			description: 'Has explicit evolution scope but no goal',
			evolutionScopeId: scope.id,
		});
		taskRepo.updateTask(task.id, { workflowRunId: run.id });

		const evidence = service.attachWorkflowRunEvidence({ workflowRunId: run.id });

		expect(evidence).toMatchObject({
			scopeId: scope.id,
			kind: 'workflow_run',
			sourceId: run.id,
		});
	});

	it('attaches workflow-run evidence through its goal-linked parent task', () => {
		const goal = goalRepo.create({ spaceId, title: 'Runtime check-in', type: 'recurring' });
		const scope = service.createScopeFromGoal({ spaceGoalId: goal.id });
		const workflow = workflowRepo.createWorkflow({
			spaceId,
			name: 'Check-in workflow',
			description: 'Run check-in',
		});
		const run = workflowRunRepo.createRun({
			spaceId,
			workflowId: workflow.id,
			title: 'Check-in run',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Check-in task',
			description: 'Review goal progress',
			goalId: goal.id,
		});
		taskRepo.updateTask(task.id, { workflowRunId: run.id });

		const evidence = service.attachWorkflowRunEvidence({ workflowRunId: run.id });

		expect(evidence).toMatchObject({
			scopeId: scope.id,
			kind: 'workflow_run',
			sourceId: run.id,
			summary: 'Workflow run: Check-in run',
		});
		expect(evidence.metadata.workflowId).toBe(workflow.id);
	});

	it('adds manual notes and metric snapshots to scope timeline', () => {
		const scope = service.createScope({
			spaceId,
			kind: 'custom',
			name: 'Manual timeline',
			objective: 'Collect evidence',
		});
		const note = service.addManualNoteEvidence({
			scopeId: scope.id,
			summary: 'Reviewer noted repeated issue',
		});
		const { snapshot, evidence } = service.addMetricSnapshotEvidence({
			scopeId: scope.id,
			values: { reviewComments: 2 },
			source: 'manual',
			note: 'After first check-in',
			capturedAt: 123,
		});

		const timeline = service.listTimeline(scope.id);

		expect(timeline.scope.id).toBe(scope.id);
		expect(timeline.evidence.map((item) => item.id)).toContain(note.id);
		expect(timeline.evidence.map((item) => item.id)).toContain(evidence.id);
		expect(timeline.metricSnapshots[0]?.id).toBe(snapshot.id);
		expect(service.listMetricSnapshots(scope.id)[0]?.id).toBe(snapshot.id);
	});

	it('rejects scope creation for a non-existent space', () => {
		expect(() =>
			service.createScope({
				spaceId: 'missing-space',
				kind: 'custom',
				name: 'Missing space',
				objective: 'Should fail',
			})
		).toThrow('Space not found: missing-space');
	});

	it('rejects evidence for a non-existent scope', () => {
		expect(() =>
			service.addManualNoteEvidence({
				scopeId: 'missing-scope',
				summary: 'Should fail',
			})
		).toThrow('EvolutionScope not found: missing-scope');
	});

	it('rejects task evidence when task has no evolution scope or goal linkage', () => {
		const task = taskRepo.createTask({
			spaceId,
			title: 'Unlinked task',
			description: 'No goal or scope',
		});

		expect(() => service.attachTaskEvidence({ taskId: task.id })).toThrow(
			`Task is not linked to an EvolutionScope or SpaceGoal: ${task.id}`
		);
	});

	it('rejects scope creation when linked goal belongs to a different space', () => {
		const otherSpaceId = spaceRepo.createSpace({
			workspacePath: '/workspace/other-forge-service-test',
			slug: 'other-forge-service-test',
			name: 'Other Forge Service Test',
		}).id;
		const otherGoal = goalRepo.create({ spaceId: otherSpaceId, title: 'Other goal' });

		expect(() =>
			service.createScope({
				spaceId,
				spaceGoalId: otherGoal.id,
				kind: 'mission',
				name: 'Wrong goal space',
				objective: 'Should fail',
			})
		).toThrow(`SpaceGoal not found in space: ${otherGoal.id}`);
	});
});
