import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { EvolutionScopeService } from '../../../src/lib/space/evolution-scope-service';
import { EvolutionTraceEvidenceService } from '../../../src/lib/space/evolution-trace-evidence-service';
import { SpaceTaskManager } from '../../../src/lib/space/managers/space-task-manager';
import { EvolutionRepository } from '../../../src/storage/repositories/evolution-repository';
import { GateOpenStateRepository } from '../../../src/storage/repositories/gate-open-state-repository';
import { SpaceGoalRepository } from '../../../src/storage/repositories/space-goal-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository';
import { WorkflowRunArtifactRepository } from '../../../src/storage/repositories/workflow-run-artifact-repository';
import { createSpaceTables } from '../helpers/space-test-db';

describe('Forge evidence capture on task completion', () => {
	let db: Database;
	let spaceRepo: SpaceRepository;
	let goalRepo: SpaceGoalRepository;
	let taskRepo: SpaceTaskRepository;
	let workflowRepo: SpaceWorkflowRepository;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let artifactRepo: WorkflowRunArtifactRepository;
	let evolutionRepo: EvolutionRepository;
	let evolutionScopeService: EvolutionScopeService;
	let spaceId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		spaceRepo = new SpaceRepository(db as never);
		goalRepo = new SpaceGoalRepository(db as never);
		taskRepo = new SpaceTaskRepository(db as never);
		workflowRepo = new SpaceWorkflowRepository(db as never);
		workflowRunRepo = new SpaceWorkflowRunRepository(
			db as never,
			new GateOpenStateRepository(db as never)
		);
		artifactRepo = new WorkflowRunArtifactRepository(db as never);
		evolutionRepo = new EvolutionRepository(db as never);
		spaceId = spaceRepo.createSpace({
			workspacePath: '/workspace/forge-evidence-capture',
			slug: 'forge-evidence-capture',
			name: 'Forge Evidence Capture',
		}).id;
		const traceEvidenceService = new EvolutionTraceEvidenceService({
			db: db as never,
			evolutionRepo,
			taskRepo,
		});
		evolutionScopeService = new EvolutionScopeService({
			evolutionRepo,
			spaceRepo,
			goalRepo,
			taskRepo,
			workflowRunRepo,
			artifactRepo,
			traceEvidenceService,
		});
	});

	it('creates task_result and workflow artifact evidence for scoped task completion', async () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Forge hardening',
			objective: 'Capture useful scoped task evidence',
		});
		const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Coding workflow' });
		const run = workflowRunRepo.createRun({ spaceId, workflowId: workflow.id, title: 'Task run' });
		const task = taskRepo.createTask({
			spaceId,
			title: 'Ship Forge capture',
			description: 'Complete implementation',
			evolutionScopeId: scope.id,
			workflowRunId: run.id,
		});
		artifactRepo.upsert({
			id: 'artifact-result',
			runId: run.id,
			nodeId: 'Coding',
			artifactType: 'result',
			artifactKey: 'final',
			data: {
				summary: 'Implemented capture and opened PR',
				pr_url: 'https://github.com/x/y/pull/1',
			},
		});
		await taskRepo.updateTask(task.id, { status: 'in_progress' });
		const manager = new SpaceTaskManager(db as never, spaceId, undefined, evolutionScopeService);

		await manager.setTaskStatus(task.id, 'done', { result: 'PR ready and tests pass' });

		const evidence = evolutionRepo.listEvidence(scope.id);
		expect(evidence.map((item) => item.kind).sort()).toEqual([
			'artifact',
			'session',
			'task_result',
		]);
		expect(evidence.find((item) => item.kind === 'session')?.metadata.traceDiagnostic).toBe(true);
		expect(evidence.find((item) => item.kind === 'task_result')?.summary).toContain(
			'PR ready and tests pass'
		);
		const artifactEvidence = evidence.find((item) => item.kind === 'artifact');
		expect(artifactEvidence?.summary).toContain('result/final');
		expect(artifactEvidence?.metadata.artifactTypes).toEqual(['result']);
		expect(artifactEvidence?.metadata.artifactCount).toBe(1);
	});

	it('auto-captured task_result evidence includes summary populated from result artifact', async () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Populated result task',
			objective: 'Learn from propagated task summaries',
		});
		const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Coding workflow' });
		const run = workflowRunRepo.createRun({ spaceId, workflowId: workflow.id, title: 'Task run' });
		const task = taskRepo.createTask({
			spaceId,
			title: 'Ship propagated summary',
			description: 'Complete implementation',
			evolutionScopeId: scope.id,
			workflowRunId: run.id,
		});
		artifactRepo.upsert({
			id: 'artifact-populated-result',
			runId: run.id,
			nodeId: 'Coding',
			artifactType: 'result',
			artifactKey: 'final',
			data: { summary: 'Propagated summary reaches task evidence' },
		});
		await taskRepo.updateTask(task.id, {
			status: 'in_progress',
			result: 'Propagated summary reaches task evidence',
			reportedSummary: 'Propagated summary reaches task evidence',
		});
		const manager = new SpaceTaskManager(db as never, spaceId, undefined, evolutionScopeService);

		await manager.setTaskStatus(task.id, 'done');

		const taskEvidence = evolutionRepo
			.listEvidence(scope.id)
			.find((item) => item.kind === 'task_result');
		expect(taskEvidence?.summary).toContain('Propagated summary reaches task evidence');
		expect(taskEvidence?.metadata.reportedSummary).toBe('Propagated summary reaches task evidence');
	});

	it('captures useful workflow artifact evidence when task result is null', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Artifact-only task',
			objective: 'Learn from artifacts when task.result is empty',
		});
		const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Review workflow' });
		const run = workflowRunRepo.createRun({
			spaceId,
			workflowId: workflow.id,
			title: 'Artifact run',
		});
		workflowRunRepo.updateRun(run.id, { status: 'done' });
		const task = taskRepo.createTask({
			spaceId,
			title: 'Finish with artifacts',
			description: 'Result stays null',
			evolutionScopeId: scope.id,
			workflowRunId: run.id,
		});
		taskRepo.updateTask(task.id, { status: 'done', result: null });
		artifactRepo.upsert({
			id: 'artifact-review',
			runId: run.id,
			nodeId: 'Review',
			artifactType: 'review',
			artifactKey: 'approval',
			data: {
				summary: 'Reviewer approved after CI passed',
				review_url: 'https://github.com/x/y/pull/2#review',
			},
		});

		const result = evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

		expect(result.evidence).toHaveLength(2);
		expect(result.traceDiagnostic?.status).toBe('no_trace_rows');
		const taskEvidence = result.evidence.find((item) => item.kind === 'task_result');
		expect(taskEvidence?.summary).toContain('completed without task.result');
		const artifactEvidence = result.evidence.find((item) => item.kind === 'artifact');
		expect(artifactEvidence?.summary).toContain('Reviewer approved after CI passed');
		expect(artifactEvidence?.metadata.artifacts).toEqual([
			expect.objectContaining({ nodeId: 'Review', type: 'review', key: 'approval' }),
		]);
	});

	it('deduplicates repeated completion evidence capture', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Dedupe task',
			objective: 'Do not duplicate evidence',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Complete once',
			description: 'Repeat event should be idempotent',
			evolutionScopeId: scope.id,
		});
		taskRepo.updateTask(task.id, { status: 'done', result: 'Done once' });

		evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });
		evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

		const evidence = evolutionRepo.listEvidence(scope.id);
		expect(evidence).toHaveLength(2);
		expect(evidence.map((item) => item.kind).sort()).toEqual(['session', 'task_result']);
	});

	it('keeps manual workflow_run evidence and adds artifact evidence for the same run', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Run evidence kinds',
			objective: 'Keep distinct workflow evidence kinds',
		});
		const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Coding workflow' });
		const run = workflowRunRepo.createRun({
			spaceId,
			workflowId: workflow.id,
			title: 'Run with artifacts',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Capture artifacts after manual run evidence',
			description: 'Manual workflow_run evidence already exists',
			evolutionScopeId: scope.id,
			workflowRunId: run.id,
		});
		taskRepo.updateTask(task.id, { status: 'done', result: 'Done with artifact' });
		evolutionScopeService.attachWorkflowRunEvidence({ workflowRunId: run.id });
		artifactRepo.upsert({
			id: 'artifact-ci',
			runId: run.id,
			nodeId: 'CI',
			artifactType: 'ci',
			artifactKey: 'summary',
			data: { summary: 'CI passed after retry' },
		});

		evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

		const evidence = evolutionRepo.listEvidence(scope.id);
		expect(evidence.map((item) => item.kind).sort()).toEqual([
			'artifact',
			'session',
			'task_result',
			'workflow_run',
		]);
		expect(evidence.find((item) => item.kind === 'artifact')?.summary).toContain(
			'CI passed after retry'
		);
	});

	it('preserves manual workflow_run evidence when auto-capturing a run without artifacts', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Manual run evidence',
			objective: 'Keep user-authored workflow evidence',
		});
		const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Manual workflow' });
		const run = workflowRunRepo.createRun({
			spaceId,
			workflowId: workflow.id,
			title: 'Run without artifacts',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Complete with manual run evidence',
			description: 'Auto workflow_run evidence should not overwrite manual note',
			evolutionScopeId: scope.id,
			workflowRunId: run.id,
		});
		taskRepo.updateTask(task.id, { status: 'done', result: 'Done without artifacts' });
		const manual = evolutionScopeService.attachWorkflowRunEvidence({
			workflowRunId: run.id,
			summary: 'Manual reviewer context',
			metadata: { source: 'manual' },
		});

		evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

		const evidence = evolutionRepo.listEvidence(scope.id);
		expect(evidence.find((item) => item.kind === 'session')?.summary).toContain(
			'No trace evidence generated'
		);
		const runEvidence = evidence.filter((item) => item.kind === 'workflow_run');
		expect(runEvidence).toHaveLength(2);
		expect(evolutionRepo.getEvidence(manual.id)?.summary).toBe('Manual reviewer context');
		expect(runEvidence.map((item) => item.summary)).toContain(
			'Workflow run pending: Run without artifacts — no artifact types — no artifacts captured'
		);
	});

	it('keeps manual task evidence append-only for repeated task attachments', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Manual task evidence',
			objective: 'Keep task evidence timeline append-only',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Attach task evidence twice',
			description: 'Manual task evidence should append',
			evolutionScopeId: scope.id,
		});

		const before = evolutionScopeService.attachTaskEvidence({
			taskId: task.id,
			summary: 'Before implementation',
		});
		const after = evolutionScopeService.attachTaskEvidence({
			taskId: task.id,
			summary: 'After implementation',
		});

		const taskEvidence = evolutionRepo
			.listEvidence(scope.id)
			.filter((item) => item.kind === 'task');
		expect(taskEvidence).toHaveLength(2);
		expect(after.id).not.toBe(before.id);
		expect(taskEvidence.map((item) => item.summary).sort()).toEqual([
			'After implementation',
			'Before implementation',
		]);
	});

	it('ignores stale failureReason when completed workflow run has artifacts', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Recovered run scope',
			objective: 'Recovered runs should not look like failures',
		});
		const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Recovered workflow' });
		const run = workflowRunRepo.createRun({
			spaceId,
			workflowId: workflow.id,
			title: 'Recovered run',
		});
		workflowRunRepo.updateRun(run.id, {
			status: 'done',
			failureReason: 'agentCrash',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Capture recovered run',
			description: 'Stale failureReason should not force error kind',
			evolutionScopeId: scope.id,
			workflowRunId: run.id,
		});
		taskRepo.updateTask(task.id, { status: 'done', result: 'Recovered and shipped' });
		artifactRepo.upsert({
			id: 'artifact-recovered',
			runId: run.id,
			nodeId: 'CI',
			artifactType: 'ci',
			artifactKey: 'summary',
			data: { summary: 'Recovered CI passed' },
		});

		const result = evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

		expect(result.evidence.find((item) => item.kind === 'error')).toBeUndefined();
		const artifactEvidence = result.evidence.find((item) => item.kind === 'artifact');
		expect(artifactEvidence?.summary).toContain('Recovered CI passed');
		expect(artifactEvidence?.metadata.failureReason).toBe('agentCrash');
	});

	it('does not include stale failureReason in recovered run summary without artifacts', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Recovered run without artifacts',
			objective: 'Avoid stale failure details in success summaries',
		});
		const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Recovered workflow' });
		const run = workflowRunRepo.createRun({
			spaceId,
			workflowId: workflow.id,
			title: 'Recovered run without artifacts',
		});
		workflowRunRepo.updateRun(run.id, {
			status: 'done',
			failureReason: 'agentCrash',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Capture recovered run without artifacts',
			description: 'Stale failureReason should stay out of summary',
			evolutionScopeId: scope.id,
			workflowRunId: run.id,
		});
		taskRepo.updateTask(task.id, { status: 'done', result: 'Recovered without artifacts' });

		const result = evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

		const runEvidence = result.evidence.find((item) => item.kind === 'workflow_run');
		expect(runEvidence?.summary).toContain('no artifacts captured');
		expect(runEvidence?.summary).not.toContain('agentCrash');
		expect(runEvidence?.metadata.failureReason).toBe('agentCrash');
	});

	it('updates existing task_result evidence when a task is completed again', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Recompleted task',
			objective: 'Keep evidence current after reactivation',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Complete twice',
			description: 'Second completion supersedes first evidence data',
			evolutionScopeId: scope.id,
		});
		taskRepo.updateTask(task.id, { status: 'done', result: 'First result' });
		const first = evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });
		taskRepo.updateTask(task.id, { result: 'Second result' });

		const second = evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

		const evidence = evolutionRepo.listEvidence(scope.id);
		expect(evidence).toHaveLength(2);
		expect(second.evidence[0]?.id).toBe(first.evidence[0]?.id);
		const taskEvidence = evidence.find((item) => item.kind === 'task_result');
		expect(taskEvidence?.summary).toContain('Second result');
		expect(taskEvidence?.metadata.result).toBe('Second result');
	});

	it('creates error evidence for failed workflow runs', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Failed run scope',
			objective: 'Capture blockers as evidence',
		});
		const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Blocked workflow' });
		const run = workflowRunRepo.createRun({
			spaceId,
			workflowId: workflow.id,
			title: 'Blocked run',
		});
		workflowRunRepo.updateRun(run.id, {
			status: 'cancelled',
			failureReason: 'agentCrash',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Capture failed run',
			description: 'Workflow failed before merge',
			evolutionScopeId: scope.id,
			workflowRunId: run.id,
		});
		taskRepo.updateTask(task.id, { status: 'done', result: 'Closed with blocker' });

		const result = evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

		const errorEvidence = result.evidence.find((item) => item.kind === 'error');
		expect(errorEvidence?.summary).toContain('agentCrash');
		expect(errorEvidence?.metadata.failureReason).toBe('agentCrash');
	});

	it('captures trace-derived evidence for completed scoped task failures', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Trace task scope',
			objective: 'Capture process friction',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Finish with failed test first',
			description: 'Synthetic failed test trace',
			evolutionScopeId: scope.id,
		});
		insertToolExchange(
			task.id,
			'session-trace',
			'tool-test-1',
			'Bash',
			{ command: 'bun test' },
			true,
			{
				text: 'Error: expected true to be false',
			}
		);
		taskRepo.updateTask(task.id, { status: 'done', result: 'Fixed after failed test' });

		const result = evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

		expect(result.traceDiagnostic?.status).toBe('generated');
		expect(result.traceDiagnostic?.failedToolCallCount).toBe(1);
		expect(result.evidence.some((item) => item.kind === 'test_failure')).toBe(true);
		expect(evolutionRepo.listEvidence(scope.id).some((item) => item.kind === 'test_failure')).toBe(
			true
		);
	});

	it('clears stale trace diagnostics when later completion generates trace evidence', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Retried trace scope',
			objective: 'Avoid stale trace diagnostics',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Retried trace task',
			description: 'First clean, then failed trace',
			evolutionScopeId: scope.id,
		});
		insertToolExchange(
			task.id,
			'session-retry',
			'tool-test-pass-first',
			'Bash',
			{ command: 'bun test' },
			false,
			{
				text: '1 pass',
			}
		);
		taskRepo.updateTask(task.id, { status: 'done', result: 'First clean pass' });
		evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });
		expect(
			evolutionRepo
				.listEvidence(scope.id)
				.some((item) => item.kind === 'session' && item.metadata.status === 'no_friction')
		).toBe(true);
		insertToolExchange(
			task.id,
			'session-retry',
			'tool-test-fail-later',
			'Bash',
			{ command: 'bun test' },
			true,
			{
				text: 'Error: later retry failed',
			}
		);

		const result = evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

		expect(result.traceDiagnostic?.status).toBe('generated');
		const evidence = evolutionRepo.listEvidence(scope.id);
		expect(evidence.some((item) => item.kind === 'test_failure')).toBe(true);
		expect(
			evidence.some(
				(item) =>
					item.kind === 'session' &&
					item.metadata.traceDiagnostic === true &&
					item.metadata.status !== 'generated'
			)
		).toBe(false);
	});

	it('records a trace diagnostic when completed task trace has no friction', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Clean trace scope',
			objective: 'Explain missing trace evidence',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Clean trace task',
			description: 'No friction trace',
			evolutionScopeId: scope.id,
		});
		insertToolExchange(
			task.id,
			'session-clean',
			'tool-test-pass',
			'Bash',
			{ command: 'bun test' },
			false,
			{
				text: '1 pass',
			}
		);
		taskRepo.updateTask(task.id, { status: 'done', result: 'Clean pass' });

		const result = evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

		expect(result.traceDiagnostic?.status).toBe('no_friction');
		const diagnostic = evolutionRepo
			.listEvidence(scope.id)
			.find((item) => item.kind === 'session' && item.metadata.traceDiagnostic === true);
		expect(diagnostic?.summary).toContain('No trace evidence generated');
		expect(diagnostic?.metadata.toolCallCount).toBe(1);
		expect(diagnostic?.metadata.failedToolCallCount).toBe(0);
	});

	it('does not create Forge evidence for non-done tasks', () => {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Active task scope',
			objective: 'Only done tasks become evidence',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Still running',
			description: 'Should not produce evidence yet',
			evolutionScopeId: scope.id,
		});
		taskRepo.updateTask(task.id, { status: 'in_progress' });

		const result = evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

		expect(result.scope).toBeNull();
		expect(result.evidence).toEqual([]);
		expect(evolutionRepo.listEvidence(scope.id)).toEqual([]);
	});

	it('does not create Forge evidence for unscoped tasks', () => {
		const task = taskRepo.createTask({
			spaceId,
			title: 'Unscoped task',
			description: 'No scope or scoped goal',
		});
		taskRepo.updateTask(task.id, { status: 'done', result: 'Done' });

		const result = evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

		expect(result.scope).toBeNull();
		expect(result.evidence).toEqual([]);
	});

	it('uses linked goal Forge scope when task has no direct evolutionScopeId', () => {
		const goal = goalRepo.create({
			spaceId,
			title: 'Forge goal',
			description: 'Goal owns scope',
		});
		const scope = evolutionRepo.createScope({
			spaceId,
			spaceGoalId: goal.id,
			kind: 'mission',
			name: 'Goal scope',
			objective: 'Capture linked goal tasks',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Goal-linked task',
			description: 'Scope resolved through goal',
			goalId: goal.id,
		});
		taskRepo.updateTask(task.id, { status: 'done', result: 'Goal task done' });

		const result = evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

		expect(result.scope?.id).toBe(scope.id);
		expect(evolutionRepo.listEvidence(scope.id)).toHaveLength(2);
	});

	function insertToolExchange(
		taskId: string,
		sessionId: string,
		toolUseId: string,
		toolName: string,
		input: Record<string, unknown>,
		failed: boolean,
		options: { text: string }
	) {
		insertMessage(taskId, sessionId, 'assistant', {
			type: 'assistant',
			uuid: `${toolUseId}-assistant`,
			session_id: sessionId,
			message: {
				role: 'assistant',
				content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
			},
		});
		insertMessage(taskId, sessionId, 'user', {
			type: 'user',
			uuid: `${toolUseId}-result`,
			session_id: sessionId,
			message: {
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: toolUseId,
						is_error: failed,
						content: options.text,
					},
				],
			},
		});
	}

	function insertMessage(
		taskId: string,
		sessionId: string,
		messageType: string,
		message: Record<string, unknown>
	) {
		const count = db.prepare('SELECT COUNT(*) AS count FROM sdk_messages').get() as {
			count: number;
		};
		const sequence = count.count + 1;
		db.prepare(
			`INSERT INTO sdk_messages (
				id, session_id, message_type, sdk_message, timestamp, send_status,
				is_renderable, is_terminal, task_id
			) VALUES (?, ?, ?, ?, ?, 'consumed', 1, 0, ?)`
		).run(
			`message-${sequence}`,
			sessionId,
			messageType,
			JSON.stringify(message),
			new Date(1_700_000_000_000 + sequence * 1000).toISOString(),
			taskId
		);
	}
});
