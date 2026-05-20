import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	buildEpisodeJudgePrompt,
	EvolutionEpisodeService,
	parseEpisodeJudgeJson,
} from '../../../src/lib/space/evolution-episode-service';
import { EvolutionRepository } from '../../../src/storage/repositories/evolution-repository';
import { GateOpenStateRepository } from '../../../src/storage/repositories/gate-open-state-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository';
import { WorkflowRunArtifactRepository } from '../../../src/storage/repositories/workflow-run-artifact-repository';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository';
import { createSpaceTables } from '../helpers/space-test-db';

describe('EvolutionEpisodeService', () => {
	let db: Database;
	let evolutionRepo: EvolutionRepository;
	let taskRepo: SpaceTaskRepository;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let artifactRepo: WorkflowRunArtifactRepository;
	let workflowRepo: SpaceWorkflowRepository;
	let spaceId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		const spaceRepo = new SpaceRepository(db as never);
		evolutionRepo = new EvolutionRepository(db as never);
		taskRepo = new SpaceTaskRepository(db as never);
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
