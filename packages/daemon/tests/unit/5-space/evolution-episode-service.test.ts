import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	buildEpisodeJudgePrompt,
	EvolutionEpisodeService,
	parseEpisodeJudgeJson,
	resolveEpisodeJudgeModel,
} from '../../../src/lib/space/evolution-episode-service';
import { EvolutionScopeService } from '../../../src/lib/space/evolution-scope-service';
import { clearModelsCache, setModelsCache } from '../../../src/lib/model-service';
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
		clearModelsCache('global');
		db.close();
	});

	it('resolves episode judge model from scope policy before Space default', async () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Judge scope',
			objective: 'Select judge model',
			policy: { episodeJudgeModel: 'claude-opus-4-5', maxActiveLessons: 5 },
		});
		const input = {
			scope,
			evidence: [],
			metricSnapshots: [],
			tasks: [],
			workflowRuns: [],
			timeWindow: null,
		};

		await expect(
			resolveEpisodeJudgeModel(input, {
				getSpace: () => ({ defaultModel: 'claude-sonnet-4-5' }) as never,
			})
		).resolves.toEqual({ provider: 'anthropic', modelId: 'claude-opus-4-5' });

		const cleared = evolutionRepo.updateScope(scope.id, {
			policy: { maxActiveLessons: 5 },
		});

		expect(cleared?.policy).toEqual({ maxActiveLessons: 5 });
		await expect(
			resolveEpisodeJudgeModel(
				{ ...input, scope: cleared as NonNullable<typeof cleared> },
				{ getSpace: () => ({ defaultModel: 'claude-sonnet-4-5' }) as never }
			)
		).resolves.toEqual({ provider: 'anthropic', modelId: 'claude-sonnet-4-5' });
	});

	it('resolves episode judge model provider from cached model catalog', async () => {
		setModelsCache(
			new Map([
				[
					'global',
					[
						{
							id: 'shared-model',
							name: 'Shared model',
							alias: 'shared',
							family: 'sonnet',
							provider: 'openrouter',
							contextWindow: 200000,
							description: 'Shared model ID with provider context',
							releaseDate: '2026-01-01',
							available: true,
						},
					],
				],
			])
		);
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Judge scope',
			objective: 'Select judge model',
			policy: { episodeJudgeModel: 'shared' },
		});

		await expect(
			resolveEpisodeJudgeModel({
				scope,
				evidence: [],
				metricSnapshots: [],
				tasks: [],
				workflowRuns: [],
				timeWindow: null,
			})
		).resolves.toEqual({ provider: 'openrouter', modelId: 'shared-model' });
	});

	it('resolves exact cached model IDs before alias fallback', async () => {
		setModelsCache(
			new Map([
				[
					'global',
					[
						{
							id: 'sonnet',
							name: 'Claude Sonnet',
							alias: 'default',
							family: 'sonnet',
							provider: 'anthropic',
							contextWindow: 200000,
							description: 'Fallback sonnet',
							releaseDate: '2026-01-01',
							available: true,
						},
						{
							id: 'default',
							name: 'Custom default',
							alias: 'custom-default',
							family: 'sonnet',
							provider: 'openrouter',
							contextWindow: 200000,
							description: 'Custom endpoint default model',
							releaseDate: '2026-01-01',
							available: true,
						},
					],
				],
			])
		);
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Judge scope',
			objective: 'Select judge model',
			policy: { episodeJudgeModel: 'default' },
		});

		await expect(
			resolveEpisodeJudgeModel({
				scope,
				evidence: [],
				metricSnapshots: [],
				tasks: [],
				workflowRuns: [],
				timeWindow: null,
			})
		).resolves.toEqual({ provider: 'openrouter', modelId: 'default' });
	});

	it('resolves scope judge model with stored provider identity', async () => {
		setModelsCache(
			new Map([
				[
					'global',
					[
						{
							id: 'shared-model',
							name: 'Anthropic shared',
							alias: 'shared',
							family: 'sonnet',
							provider: 'anthropic',
							contextWindow: 200000,
							description: 'Anthropic shared model',
							releaseDate: '2026-01-01',
							available: true,
						},
						{
							id: 'shared-model',
							name: 'OpenRouter shared',
							alias: 'shared',
							family: 'sonnet',
							provider: 'openrouter',
							contextWindow: 200000,
							description: 'OpenRouter shared model',
							releaseDate: '2026-01-01',
							available: true,
						},
					],
				],
			])
		);
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Judge scope',
			objective: 'Select judge model',
			policy: { episodeJudgeModel: 'shared-model', episodeJudgeProvider: 'openrouter' },
		});

		await expect(
			resolveEpisodeJudgeModel({
				scope,
				evidence: [],
				metricSnapshots: [],
				tasks: [],
				workflowRuns: [],
				timeWindow: null,
			})
		).resolves.toEqual({ provider: 'openrouter', modelId: 'shared-model' });
	});

	it('warns and blocks manual-note-only evidence without explicit confirmation', async () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Thin evidence',
			objective: 'Avoid generic findings',
		});
		const note = evolutionRepo.createEvidence({
			scopeId: scope.id,
			kind: 'manual_note',
			summary: 'Operator thinks the work went well',
		});
		let judgeCalled = false;
		const service = new EvolutionEpisodeService({
			evolutionRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
			judgeEpisode: async () => {
				judgeCalled = true;
				return { title: 'Should not run', outcomeSummary: 'Nope', findings: [] };
			},
		});
		const input = service.buildEpisodeInput({ scopeId: scope.id, evidenceIds: [note.id] });
		const prompt = buildEpisodeJudgePrompt(input);

		expect(input.preflight.level).toBe('low');
		expect(input.preflight.requiresConfirmation).toBe(true);
		expect(input.preflight.warnings).toContain(
			'Only manual notes selected; findings will be low confidence without task results or artifacts.'
		);
		expect(input.preflight.warnings).toContain('No task evidence selected.');
		expect(prompt).toContain('Evidence quality preflight');
		expect(prompt).toContain('low');
		await expect(
			service.createFromEvidence({ scopeId: scope.id, evidenceIds: [note.id] })
		).rejects.toThrow('Low-confidence evidence requires explicit confirmation');
		expect(judgeCalled).toBe(false);
	});

	it('passes task plus workflow artifact evidence through preflight', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Artifact-backed evidence',
			objective: 'Trust concrete outcomes',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Ship Forge preflight',
			description: 'Add preflight',
			evolutionScopeId: scope.id,
		});
		taskRepo.updateTask(task.id, {
			status: 'done',
			result: 'PR merged after CI and QA passed',
			reportedSummary: 'Completed with artifact-backed validation',
		});
		const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Code workflow' });
		const run = workflowRunRepo.createRun({ spaceId, workflowId: workflow.id, title: 'Forge run' });
		artifactRepo.upsert({
			id: 'artifact-quality',
			runId: run.id,
			nodeId: 'qa',
			artifactType: 'result',
			artifactKey: 'qa',
			data: { summary: 'QA passed, CI green, PR https://github.com/lsm/neokai/pull/1 merged' },
		});
		const taskEvidence = evolutionRepo.createEvidence({
			scopeId: scope.id,
			kind: 'task',
			sourceId: task.id,
			summary: 'Task linked to completed work',
		});
		const workflowTask = taskRepo.createTask({
			spaceId,
			title: 'Supervised completion gate',
			description: 'Report completion before human approval',
			workflowRunId: run.id,
		});
		taskRepo.updateTask(workflowTask.id, {
			reportedStatus: 'done',
			reportedSummary: 'Ready for review after validation',
		});
		const artifactEvidence = evolutionRepo.createEvidence({
			scopeId: scope.id,
			kind: 'artifact',
			sourceId: run.id,
			summary: 'Workflow artifact captured QA and merge outcome',
		});
		const errorEvidence = evolutionRepo.createEvidence({
			scopeId: scope.id,
			kind: 'error',
			sourceId: run.id,
			summary: 'Workflow run had retryable error',
		});
		const scopeService = new EvolutionScopeService({
			evolutionRepo,
			spaceRepo,
			goalRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
		});
		const listedWithoutContext = scopeService.listEvidence(scope.id);
		expect(listedWithoutContext.preflightContext).toBeUndefined();

		const listed = scopeService.listEvidence(scope.id, true);
		const taskContext = listed.preflightContext?.tasks[0]?.task;
		const runContext = listed.preflightContext?.workflowRuns[0];
		expect(taskContext).toEqual({
			title: 'Ship Forge preflight',
			status: 'done',
			reportedStatus: null,
			reportedSummary: 'Completed with artifact-backed validation',
			result: 'PR merged after CI and QA passed',
		});
		expect('description' in (taskContext ?? {})).toBe(false);
		expect('metadata' in (taskContext ?? {})).toBe(false);
		const largePayload = 'x'.repeat(1000);
		artifactRepo.upsert({
			id: 'artifact-large',
			runId: run.id,
			nodeId: 'logs',
			artifactType: 'log',
			artifactKey: 'large',
			data: {
				summary: 'Generic artifact',
				result: 'CI passed and PR merged',
				details: 'Tool-specific field says QA passed after merge validation',
				message: largePayload,
			},
		});
		for (let index = 0; index < 8; index++) {
			artifactRepo.upsert({
				id: `artifact-extra-${index}`,
				runId: run.id,
				nodeId: 'extra',
				artifactType: 'result',
				artifactKey: `extra-${index}`,
				data: { summary: 'later artifact outside preflight window' },
			});
		}
		const listedWithArtifacts = scopeService.listEvidence(scope.id, true);
		const cappedRunContext = listedWithArtifacts.preflightContext?.workflowRuns[0];
		const service = new EvolutionEpisodeService({
			evolutionRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
		});

		const input = service.buildEpisodeInput({
			scopeId: scope.id,
			evidenceIds: [taskEvidence.id, artifactEvidence.id],
		});

		expect(input.preflight.level).toBe('high');
		expect(input.preflight.requiresConfirmation).toBe(false);
		expect(input.preflight.counts.taskResults).toBe(1);
		expect(input.preflight.counts.workflowArtifacts).toBe(1);
		expect(input.preflight.counts.outcomes).toBeGreaterThanOrEqual(3);
		expect(runContext?.evidenceIds).toContain(artifactEvidence.id);
		expect(runContext?.evidenceIds).toContain(errorEvidence.id);
		expect(cappedRunContext?.artifacts).toHaveLength(8);
		expect(cappedRunContext?.artifacts[0]?.data.summary).toContain('QA passed');
		expect(cappedRunContext?.artifacts[1]?.data.summary).toContain('Generic artifact');
		expect(cappedRunContext?.artifacts[1]?.data.summary).toContain('CI passed and PR merged');
		expect(cappedRunContext?.artifacts[1]?.data.summary).toContain(
			'Tool-specific field says QA passed after merge validation'
		);
		expect(cappedRunContext?.artifacts[1]?.data.summary.length).toBeLessThanOrEqual(501);
		expect(cappedRunContext?.artifacts.some((artifact) => 'large' in artifact.data)).toBe(false);
	});

	it('metric snapshot improves evidence readiness', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Metrics evidence',
			objective: 'Use measurements',
		});
		const note = evolutionRepo.createEvidence({
			scopeId: scope.id,
			kind: 'manual_note',
			summary: 'Manual note says review completed',
		});
		const service = new EvolutionEpisodeService({
			evolutionRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
		});
		const before = service.buildEpisodeInput({
			scopeId: scope.id,
			evidenceIds: [note.id],
		}).preflight;
		evolutionRepo.createMetricSnapshot({
			scopeId: scope.id,
			values: { comments: 2 },
			source: 'manual',
			note: 'Review comments decreased',
		});
		const after = service.buildEpisodeInput({
			scopeId: scope.id,
			evidenceIds: [note.id],
		}).preflight;

		expect(after.score).toBeGreaterThan(before.score);
		expect(after.counts.metricSnapshots).toBe(1);
		expect(after.warnings).not.toContain('No metric snapshot context selected.');
	});

	it('builds episode input with task results, workflow artifacts, metrics, and notes', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Review loop',
			objective: 'Reduce review churn',
			metricDefinitions: [{ key: 'comments', label: 'Comments', direction: 'decrease' }],
			policy: { episodeJudgeModel: 'claude-sonnet-4-6' },
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
			kind: 'task_result',
			sourceId: task.id,
			summary: 'Task completed',
			createdAt: 100,
		});
		const runEvidence = evolutionRepo.createEvidence({
			scopeId: scope.id,
			kind: 'artifact',
			sourceId: run.id,
			summary: 'Workflow completed',
			createdAt: 200,
		});
		const errorEvidence = evolutionRepo.createEvidence({
			scopeId: scope.id,
			kind: 'error',
			sourceId: run.id,
			summary: 'Same workflow run had rework',
			createdAt: 225,
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
			evidenceIds: [taskEvidence.id, runEvidence.id, errorEvidence.id, note.id],
		});
		const prompt = buildEpisodeJudgePrompt(input);

		expect(input.timeWindow).toEqual({ start: 100, end: 225 });
		expect(input.workflowRuns).toHaveLength(1);
		expect(input.workflowRuns[0]?.run.id).toBe(run.id);
		expect(prompt).toContain('Reduce review churn');
		expect(prompt).toContain('Resolved reviewer comments');
		expect(prompt).toContain('PR updated and tests pass');
		expect(prompt).toContain('Implementation ready');
		expect(prompt).toContain('Reviewer saw repeated confusion');
		expect(prompt).toContain('comments');
		expect(prompt).toContain('claude-sonnet-4-6');
	});

	it('resolves judge model from scope policy before Space default', async () => {
		const scopedInput = {
			scope: evolutionRepo.createScope({
				spaceId,
				kind: 'custom',
				name: 'Scoped model',
				objective: 'Use scope override',
				policy: { episodeJudgeModel: 'claude-opus-4-7' },
			}),
			evidence: [],
			metricSnapshots: [],
			tasks: [],
			workflowRuns: [],
			timeWindow: undefined,
		};

		expect(await resolveEpisodeJudgeModel(scopedInput, spaceRepo)).toEqual({
			provider: 'anthropic',
			modelId: 'claude-opus-4-7',
		});
	});

	it('falls back to Space default model when scope has no judge model', async () => {
		const space = spaceRepo.createSpace({
			workspacePath: '/workspace/episode-service-default-model',
			slug: 'episode-service-default-model',
			name: 'Episode Service Default Model',
			defaultModel: 'claude-sonnet-4-6',
		});
		const input = {
			scope: evolutionRepo.createScope({
				spaceId: space.id,
				kind: 'custom',
				name: 'Space model',
				objective: 'Use space default',
			}),
			evidence: [],
			metricSnapshots: [],
			tasks: [],
			workflowRuns: [],
			timeWindow: undefined,
		};

		expect(await resolveEpisodeJudgeModel(input, spaceRepo)).toEqual({
			provider: 'anthropic',
			modelId: 'claude-sonnet-4-6',
		});
	});

	it('includes evidence metadata so backfilled task artifacts reach the judge', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Forge dogfood',
			objective: 'Generate useful episodes from completed task evidence',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Implement Forge storage',
			description: 'Add storage and shared contracts',
			evolutionScopeId: scope.id,
		});
		const evidence = evolutionRepo.createEvidence({
			scopeId: scope.id,
			kind: 'task',
			sourceId: task.id,
			summary: 'Task completed; workflow artifacts contain review and QA results.',
			metadata: {
				artifacts: [
					{
						type: 'result',
						summary: 'Requested changes: missing review-path tests',
						prUrl: 'https://github.com/lsm/neokai/pull/1963',
					},
				],
			},
		});
		const service = new EvolutionEpisodeService({
			evolutionRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
		});

		const prompt = buildEpisodeJudgePrompt(
			service.buildEpisodeInput({ scopeId: scope.id, evidenceIds: [evidence.id] })
		);

		expect(prompt).toContain('Requested changes: missing review-path tests');
		expect(prompt).toContain('https://github.com/lsm/neokai/pull/1963');
	});

	it('truncates manual note metadata in every prompt section', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Manual note metadata',
			objective: 'Keep prompt metadata bounded',
		});
		const note = evolutionRepo.createEvidence({
			scopeId: scope.id,
			kind: 'manual_note',
			summary: 'Manual note with oversized metadata',
			metadata: { marker: 'metadata-marker', payload: 'x'.repeat(1500) },
		});
		const service = new EvolutionEpisodeService({
			evolutionRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
		});

		const prompt = buildEpisodeJudgePrompt(
			service.buildEpisodeInput({ scopeId: scope.id, evidenceIds: [note.id] })
		);

		expect(prompt).toContain('metadata-marker');
		expect(prompt).not.toContain('x'.repeat(1300));
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
		expect(() => parseEpisodeJudgeJson('Failed to authenticate')).toThrow(
			'Episode judge returned non-JSON text: Failed to authenticate'
		);
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
		const publishedEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
		const service = new EvolutionEpisodeService({
			evolutionRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
			db,
			taskCreatedEventHub: {
				publish: async (event, data) => {
					publishedEvents.push({ event, data });
				},
			},
		});

		const result = service.createTaskFromProposal(proposal.id);
		const duplicate = service.createTaskFromProposal(proposal.id);

		expect(duplicate.task.id).toBe(result.task.id);
		expect(
			taskRepo.listBySpace(spaceId).filter((item) => item.title === 'Improve review UI')
		).toHaveLength(1);
		expect(publishedEvents).toHaveLength(1);
		expect(publishedEvents[0]).toMatchObject({
			event: 'space.task.created',
			data: { spaceId, taskId: result.task.id, task: result.task },
		});
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
		const updated = service.updateEpisode(episode.id, { rollupAppliedAt: null });

		expect(result.episode.status).toBe('accepted');
		expect(result.episode.rollupAppliedAt).toBeNumber();
		expect(updated?.rollupAppliedAt).toBe(result.episode.rollupAppliedAt);
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
		const oneShotGoal = goalRepo.create({ spaceId, title: 'One-shot goal', type: 'one_shot' });
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
		const oneShotScope = evolutionRepo.createScope({
			spaceId,
			spaceGoalId: oneShotGoal.id,
			kind: 'mission',
			name: 'One-shot scope',
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
		const oneShotEpisode = evolutionRepo.createEpisode({
			scopeId: oneShotScope.id,
			title: 'One-shot rollup',
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
		const failingGoalService = {
			getGoal: (goalId: string) => goalRepo.getById(goalId),
			updateGoal: () => {
				throw new Error('goal update failed');
			},
		};
		const failingService = new EvolutionEpisodeService({
			evolutionRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
			goalService: failingGoalService,
		});
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
		expect(() => failingService.applyRollupGoalUpdate(request)).toThrow('goal update failed');
		expect(evolutionRepo.getEpisode(serviceOnlyEpisode.id)?.status).toBe('draft');
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
				episodeId: oneShotEpisode.id,
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
		let judgePreflight: unknown;
		const service = new EvolutionEpisodeService({
			evolutionRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
			judgeEpisode: async (input) => {
				judgePreflight = input.preflight;
				return {
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
				};
			},
		});

		const result = await service.createFromEvidence({
			scopeId: scope.id,
			evidenceIds: [evidence.id],
			confirmLowConfidence: true,
		});

		expect(judgePreflight).toMatchObject({
			level: 'low',
			requiresConfirmation: true,
			warnings: expect.arrayContaining([
				'Only manual notes selected; findings will be low confidence without task results or artifacts.',
			]),
		});
		expect(result.preflight).toBe(judgePreflight);
		expect(result.preflight.score).toBeGreaterThanOrEqual(0);
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
