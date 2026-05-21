import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	buildEpisodeJudgePrompt,
	EvolutionEpisodeService,
	parseEpisodeJudgeJson,
} from '../../../src/lib/space/evolution-episode-service';
import { EvolutionScopeService } from '../../../src/lib/space/evolution-scope-service';
import { EvolutionRepository } from '../../../src/storage/repositories/evolution-repository';
import { GateOpenStateRepository } from '../../../src/storage/repositories/gate-open-state-repository';
import { SpaceGoalEventRepository } from '../../../src/storage/repositories/space-goal-event-repository';
import { SpaceGoalRepository } from '../../../src/storage/repositories/space-goal-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository';
import { WorkflowRunArtifactRepository } from '../../../src/storage/repositories/workflow-run-artifact-repository';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository';
import { SpaceGoalService } from '../../../src/lib/space/goals/goal-service';
import { createSpaceTables } from '../helpers/space-test-db';

describe('EvolutionEpisodeService', () => {
	let db: Database;
	let evolutionRepo: EvolutionRepository;
	let taskRepo: SpaceTaskRepository;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let artifactRepo: WorkflowRunArtifactRepository;
	let workflowRepo: SpaceWorkflowRepository;
	let goalRepo: SpaceGoalRepository;
	let spaceRepo: SpaceRepository;
	let spaceId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		spaceRepo = new SpaceRepository(db as never);
		evolutionRepo = new EvolutionRepository(db as never);
		taskRepo = new SpaceTaskRepository(db as never);
		goalRepo = new SpaceGoalRepository(db as never);
		workflowRunRepo = new SpaceWorkflowRunRepository(
			db as never,
			new GateOpenStateRepository(db as never)
		);
		artifactRepo = new WorkflowRunArtifactRepository(db as never);
		workflowRepo = new SpaceWorkflowRepository(db as never);
		spaceId = spaceRepo.createSpace({
			workspacePath: '/workspace/episode-service-test',
			slug: 'episode-service-test',
			name: 'Episode Service Test',
		}).id;
	});

	afterEach(() => {
		db.close();
	});

	it('builds episode input with task results, workflow artifacts, metrics, and notes', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Review loop',
			objective: 'Reduce review churn',
			metricDefinitions: [{ key: 'comments', label: 'Comments', direction: 'decrease' }],
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Fix review feedback',
			description: 'Address comments',
			evolutionScopeId: scope.id,
		});
		taskRepo.updateTask(task.id, {
			result: 'PR updated and tests pass',
			reportedSummary: 'Resolved reviewer comments',
		});
		const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Code workflow' });
		const run = workflowRunRepo.createRun({ spaceId, workflowId: workflow.id, title: 'Run one' });
		artifactRepo.upsert({
			id: 'artifact-1',
			runId: run.id,
			nodeId: 'coder',
			artifactType: 'result',
			artifactKey: 'final',
			data: { summary: 'Implementation ready' },
		});
		const taskEvidence = evolutionRepo.createEvidence({
			scopeId: scope.id,
			kind: 'task',
			sourceId: task.id,
			summary: 'Task completed',
			createdAt: 100,
		});
		const runEvidence = evolutionRepo.createEvidence({
			scopeId: scope.id,
			kind: 'workflow_run',
			sourceId: run.id,
			summary: 'Workflow completed',
			createdAt: 200,
		});
		const note = evolutionRepo.createEvidence({
			scopeId: scope.id,
			kind: 'manual_note',
			summary: 'Reviewer saw repeated confusion',
			createdAt: 150,
		});
		evolutionRepo.createMetricSnapshot({
			scopeId: scope.id,
			values: { comments: 2 },
			source: 'manual',
			note: 'After review',
			capturedAt: 125,
		});
		const service = new EvolutionEpisodeService({
			evolutionRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
		});

		const input = service.buildEpisodeInput({
			scopeId: scope.id,
			evidenceIds: [taskEvidence.id, runEvidence.id, note.id],
		});
		const prompt = buildEpisodeJudgePrompt(input);

		expect(input.timeWindow).toEqual({ start: 100, end: 200 });
		expect(prompt).toContain('Reduce review churn');
		expect(prompt).toContain('Resolved reviewer comments');
		expect(prompt).toContain('PR updated and tests pass');
		expect(prompt).toContain('Implementation ready');
		expect(prompt).toContain('Reviewer saw repeated confusion');
		expect(prompt).toContain('comments');
	});

	it('parses fenced judge JSON and clamps confidence', () => {
		const output = parseEpisodeJudgeJson(`\n\`\`\`json\n{
			"title": "Review churn reduced",
			"outcomeSummary": "Task landed with fewer comments.",
			"findings": [{
				"domain": "workflow",
				"kind": "optimization",
				"impact": "medium",
				"confidence": 1.4,
				"evidence": ["ev-1"],
				"proposedAction": "Keep reviewer checklist"
			}],
			"candidateLessons": [{
				"appliesTo": ["workflow"],
				"rule": "Use checklist before PR",
				"why": "It reduced comments",
				"confidence": 0.8
			}],
			"proposals": [{
				"title": "Add checklist template",
				"description": "Create review checklist",
				"reason": "Avoid repeat misses",
				"priority": "normal"
			}]
		}\n\`\`\``);

		expect(output.title).toBe('Review churn reduced');
		expect(output.findings[0]?.confidence).toBe(1);
		expect(output.candidateLessons?.[0]?.rule).toBe('Use checklist before PR');
		expect(output.proposals?.[0]?.title).toBe('Add checklist template');
	});

	it('rejects malformed judge JSON and invalid enum values', () => {
		expect(() => parseEpisodeJudgeJson('{ nope')).toThrow('Episode judge returned invalid JSON');
		expect(() =>
			parseEpisodeJudgeJson(
				JSON.stringify({
					title: 'Bad domain',
					outcomeSummary: 'Bad domain',
					findings: [
						{
							domain: 'bad',
							kind: 'friction',
							impact: 'low',
							confidence: 0.5,
							evidence: [],
							proposedAction: 'Fix it',
						},
					],
				})
			)
		).toThrow('finding.domain must be one of');
	});

	it('creates a scoped SpaceTask from a proposal and records evidence context', async () => {
		const goal = goalRepo.create({
			spaceId,
			title: 'Improve review loop',
			type: 'recurring',
		});
		const scope = evolutionRepo.createScope({
			spaceId,
			spaceGoalId: goal.id,
			kind: 'mission',
			name: 'Review scope',
			objective: 'Track review health',
		});
		const episode = evolutionRepo.createEpisode({
			scopeId: scope.id,
			title: 'Manual rollup',
			outcomeSummary: 'Review friction found',
		});
		const proposal = evolutionRepo.createTaskProposal({
			scopeId: scope.id,
			title: 'Improve review UI',
			description: 'Make actions clearer',
			reason: 'Users miss next steps',
			priority: 'high',
			evidenceEpisodeIds: [episode.id],
		});
		const service = new EvolutionEpisodeService({
			evolutionRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
		});

		const result = service.createTaskFromProposal(proposal.id);

		expect(result.proposal).toMatchObject({
			status: 'created',
			createdTaskId: result.task.id,
		});
		expect(result.task).toMatchObject({
			spaceId,
			goalId: goal.id,
			evolutionScopeId: scope.id,
			title: 'Improve review UI',
			priority: 'high',
		});
		expect(result.task.description).toContain('Make actions clearer');
		expect(result.task.description).toContain('Proposal reason:\nUsers miss next steps');
		expect(result.task.description).toContain(episode.id);
	});

	function createGoalService(): SpaceGoalService {
		return new SpaceGoalService({
			goalRepo,
			goalEventRepo: new SpaceGoalEventRepository(db as never),
			taskRepo,
			spaceRepo,
			scheduleService: {} as never,
		});
	}

	it('applies accepted rollup fields to the linked recurring goal', () => {
		const goal = goalRepo.create({
			spaceId,
			title: 'Recurring review goal',
			type: 'recurring',
			summary: 'Old summary',
			progress: 20,
			nextSteps: ['Old step'],
		});
		const scope = evolutionRepo.createScope({
			spaceId,
			spaceGoalId: goal.id,
			kind: 'mission',
			name: 'Review scope',
			objective: 'Track review health',
		});
		const episode = evolutionRepo.createEpisode({
			scopeId: scope.id,
			title: 'Weekly rollup',
			outcomeSummary: 'Progress improved',
		});
		const service = new EvolutionEpisodeService({
			evolutionRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
			goalService: createGoalService(),
		});

		const result = service.applyRollupGoalUpdate({
			episodeId: episode.id,
			goalUpdate: {
				summary: 'New rollup summary',
				progress: 75,
				nextSteps: ['Create follow-up task'],
				metrics: { latency: 3 },
			},
		});

		expect(result.episode.status).toBe('accepted');
		expect(result.episode.rollupAppliedAt).toBeNumber();
		expect(result.goal).toMatchObject({
			summary: 'New rollup summary',
			progress: 75,
			nextSteps: ['Create follow-up task'],
			metrics: { latency: 3 },
		});
	});

	it('rejects invalid proposal-to-task requests', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Review scope',
			objective: 'Track review health',
		});
		const dismissed = evolutionRepo.createTaskProposal({
			scopeId: scope.id,
			title: 'Dismissed task',
			description: 'Do not create',
			reason: 'Rejected',
			status: 'dismissed',
		});
		const service = new EvolutionEpisodeService({
			evolutionRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
		});

		expect(() => service.createTaskFromProposal(dismissed.id)).toThrow(
			'Dismissed proposal cannot create a task'
		);
		expect(() => service.createTaskFromProposal('missing-proposal')).toThrow(
			'TaskProposal not found: missing-proposal'
		);
	});

	it('rejects invalid rollup writeback requests', () => {
		const goal = goalRepo.create({ spaceId, title: 'Recurring review goal', type: 'recurring' });
		const linkedScope = evolutionRepo.createScope({
			spaceId,
			spaceGoalId: goal.id,
			kind: 'mission',
			name: 'Linked scope',
			objective: 'Track review health',
		});
		const unlinkedScope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Unlinked scope',
			objective: 'Track review health',
		});
		const draftEpisode = evolutionRepo.createEpisode({
			scopeId: linkedScope.id,
			title: 'Draft rollup',
		});
		const unlinkedEpisode = evolutionRepo.createEpisode({
			scopeId: unlinkedScope.id,
			title: 'Unlinked rollup',
		});
		const dismissedEpisode = evolutionRepo.createEpisode({
			scopeId: linkedScope.id,
			title: 'Dismissed rollup',
			status: 'dismissed',
		});
		const serviceWithoutGoalService = new EvolutionEpisodeService({
			evolutionRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
		});
		const service = new EvolutionEpisodeService({
			evolutionRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
			goalService: createGoalService(),
		});
		const serviceOnlyEpisode = evolutionRepo.createEpisode({
			scopeId: linkedScope.id,
			title: 'Service-only rollup',
		});
		const request = { episodeId: serviceOnlyEpisode.id, goalUpdate: { summary: 'Rollup' } };
		const applied = service.applyRollupGoalUpdate({
			episodeId: draftEpisode.id,
			goalUpdate: { summary: 'Applied once' },
		});

		expect(applied.episode.status).toBe('accepted');
		expect(applied.episode.rollupAppliedAt).toBeNumber();
		expect(() =>
			service.applyRollupGoalUpdate({
				episodeId: draftEpisode.id,
				goalUpdate: { summary: 'Rollup' },
			})
		).toThrow('Episode rollup already applied');
		expect(() => serviceWithoutGoalService.applyRollupGoalUpdate(request)).toThrow(
			'SpaceGoalService is required'
		);
		expect(() =>
			service.applyRollupGoalUpdate({
				episodeId: unlinkedEpisode.id,
				goalUpdate: { summary: 'Rollup' },
			})
		).toThrow('Episode scope is not linked to a recurring goal');
		expect(() =>
			service.applyRollupGoalUpdate({
				episodeId: dismissedEpisode.id,
				goalUpdate: { summary: 'Rollup' },
			})
		).toThrow('Dismissed episode cannot accept rollup');
	});

	it('dogfoods the Forge MVP loop from recurring goal to next scoped task', async () => {
		const goal = goalRepo.create({
			spaceId,
			title: 'Build NeoKai Forge MVP',
			description: 'Verify the scoped learning loop end to end',
			type: 'recurring',
			metrics: {
				completedTasks: 0,
				acceptedLessons: 0,
				reusedLessons: 0,
				repeatedFailures: 1,
				timeToNextTaskHours: null,
			},
		});
		const scopeService = new EvolutionScopeService({
			evolutionRepo,
			spaceRepo,
			goalRepo,
			taskRepo,
			workflowRunRepo,
		});
		const scope = scopeService.createScopeFromGoal({
			spaceGoalId: goal.id,
			name: 'Build NeoKai Forge MVP',
			objective: 'Verify a usable end-to-end Forge scoped learning loop',
			metricDefinitions: [
				{ key: 'completedTasks', label: 'Completed tasks', direction: 'increase' },
				{ key: 'acceptedLessons', label: 'Accepted lessons', direction: 'increase' },
				{ key: 'reusedLessons', label: 'Reused lessons', direction: 'increase' },
				{ key: 'repeatedFailures', label: 'Repeated failures', direction: 'decrease' },
				{
					key: 'timeToNextTaskHours',
					label: 'Hours from completion to next task',
					direction: 'decrease',
				},
			],
		});
		const completedTask = taskRepo.createTask({
			spaceId,
			title: 'Harden Forge MVP loop',
			description: 'Dogfood Forge against its own implementation',
			goalId: goal.id,
			createdByTaskScheduleId: 'forge-recurring-schedule',
		});
		taskRepo.updateTask(completedTask.id, {
			status: 'done',
			result: 'Scope, evidence, episode, lesson, proposal, and rollup paths verified.',
			reportedSummary: 'Forge loop completed with one accepted lesson and a follow-up task.',
		});
		const taskEvidence = scopeService.attachTaskEvidence({ taskId: completedTask.id });
		const { evidence: metricEvidence } = scopeService.addMetricSnapshotEvidence({
			scopeId: scope.id,
			values: {
				completedTasks: 1,
				acceptedLessons: 1,
				reusedLessons: 0,
				repeatedFailures: 0,
				timeToNextTaskHours: 2,
			},
			source: 'dogfood',
			note: 'First complete Forge MVP dogfood pass',
		});
		const manualEvidence = scopeService.addManualNoteEvidence({
			scopeId: scope.id,
			summary: 'Lesson injection should be visible in the next scoped task prompt.',
		});
		const service = new EvolutionEpisodeService({
			evolutionRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
			goalService: createGoalService(),
			judgeEpisode: async (input) => ({
				title: 'Forge MVP dogfood episode',
				outcomeSummary: `Reviewed ${input.evidence.length} scoped evidence items.`,
				findings: [
					{
						domain: 'neokai_product',
						kind: 'friction',
						impact: 'medium',
						confidence: 0.8,
						evidence: input.evidence.map((item) => item.id),
						proposedAction: 'Keep end-to-end dogfood metrics visible in Forge.',
					},
				],
				candidateLessons: [
					{
						appliesTo: ['workflow', 'prompt'],
						rule: 'Attach completed scoped tasks as evidence before judging an episode.',
						why: 'The judge needs task result context to produce reusable lessons.',
						confidence: 0.85,
					},
				],
				proposals: [
					{
						title: 'Polish Forge empty states',
						description: 'Make empty states explain the next action in the learning loop.',
						reason: 'Dogfood showed first-time operators need clearer prompts.',
						priority: 'normal',
					},
				],
			}),
		});

		const episodeResult = await service.createFromEvidence({
			scopeId: scope.id,
			evidenceIds: [taskEvidence.id, metricEvidence.id, manualEvidence.id],
		});
		const activeLesson = service.updateLesson(episodeResult.lessons[0].id, { status: 'active' });
		const created = service.createTaskFromProposal(episodeResult.proposals[0].id);
		const rollup = service.applyRollupGoalUpdate({
			episodeId: episodeResult.episode.id,
			goalUpdate: {
				summary: 'Forge MVP dogfood loop completed once.',
				progress: 80,
				nextSteps: ['Run the created follow-up task with injected lesson context'],
				metrics: {
					completedTasks: 1,
					acceptedLessons: 1,
					reusedLessons: 1,
					repeatedFailures: 0,
					timeToNextTaskHours: 2,
				},
			},
		});

		expect(scope).toMatchObject({
			spaceGoalId: goal.id,
			name: 'Build NeoKai Forge MVP',
			kind: 'mission',
		});
		expect(taskEvidence.metadata).toMatchObject({
			status: 'done',
			createdByTaskScheduleId: 'forge-recurring-schedule',
		});
		expect(episodeResult.episode.status).toBe('draft');
		expect(episodeResult.episode.evidenceIds).toContain(taskEvidence.id);
		expect(episodeResult.episode.evidenceIds).toContain(metricEvidence.id);
		expect(episodeResult.episode.evidenceIds).toContain(manualEvidence.id);
		expect(activeLesson).toMatchObject({ status: 'active' });
		expect(created.task).toMatchObject({
			goalId: goal.id,
			evolutionScopeId: scope.id,
			title: 'Polish Forge empty states',
		});
		expect(scopeService.selectActiveLessonsForTask({ taskId: created.task.id })).toMatchObject([
			{
				id: activeLesson?.id,
				rule: 'Attach completed scoped tasks as evidence before judging an episode.',
			},
		]);
		expect(rollup.episode.status).toBe('accepted');
		expect(rollup.episode.rollupAppliedAt).toBeNumber();
		expect(rollup.goal).toMatchObject({
			summary: 'Forge MVP dogfood loop completed once.',
			progress: 80,
			nextSteps: ['Run the created follow-up task with injected lesson context'],
			metrics: {
				completedTasks: 1,
				acceptedLessons: 1,
				reusedLessons: 1,
				repeatedFailures: 0,
				timeToNextTaskHours: 2,
			},
		});
	});

	it('persists draft episode, candidate lessons, and proposals from judge output', async () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Draft scope',
			objective: 'Create draft',
		});
		const evidence = evolutionRepo.createEvidence({
			scopeId: scope.id,
			kind: 'manual_note',
			summary: 'Manual observation',
		});
		const service = new EvolutionEpisodeService({
			evolutionRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
			judgeEpisode: async () => ({
				title: 'Manual episode',
				outcomeSummary: 'Observation summarized',
				findings: [
					{
						domain: 'neokai_product',
						kind: 'friction',
						impact: 'high',
						confidence: 0.9,
						evidence: [evidence.id],
						proposedAction: 'Reduce UI friction',
					},
				],
				candidateLessons: [
					{
						appliesTo: ['ui'],
						rule: 'Surface next step',
						why: 'User got stuck',
						confidence: 0.7,
					},
				],
				proposals: [
					{
						title: 'Improve review UI',
						description: 'Add clearer actions',
						reason: 'Reduce friction',
						priority: 'high',
					},
				],
			}),
		});

		const result = await service.createFromEvidence({
			scopeId: scope.id,
			evidenceIds: [evidence.id],
		});

		expect(result.episode).toMatchObject({
			status: 'draft',
			title: 'Manual episode',
			evidenceIds: [evidence.id],
		});
		expect(result.lessons[0]).toMatchObject({
			status: 'candidate',
			rule: 'Surface next step',
			evidenceEpisodeIds: [result.episode.id],
		});
		expect(result.proposals[0]).toMatchObject({
			status: 'proposed',
			title: 'Improve review UI',
			evidenceEpisodeIds: [result.episode.id],
		});
	});
});
