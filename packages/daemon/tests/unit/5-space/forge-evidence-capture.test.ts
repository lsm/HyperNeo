import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../src/storage/sqlite-compat';
import { EvolutionScopeService } from '../../../src/lib/space/evolution-scope-service';
import { EvolutionTraceEvidenceService } from '../../../src/lib/space/evolution-trace-evidence-service';
import { SpaceTaskManager } from '../../../src/lib/space/managers/space-task-manager';
import { EvolutionRepository } from '../../../src/storage/repositories/evolution-repository';
import { JobQueueRepository } from '../../../src/storage/repositories/job-queue-repository';
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
  let jobQueue: JobQueueRepository;
  let evolutionScopeService: EvolutionScopeService;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    db.exec(`
			CREATE TABLE IF NOT EXISTS job_queue (
				id TEXT PRIMARY KEY,
				queue TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
				payload TEXT NOT NULL DEFAULT '{}',
				result TEXT,
				error TEXT,
				priority INTEGER NOT NULL DEFAULT 0,
				max_retries INTEGER NOT NULL DEFAULT 3,
				retry_count INTEGER NOT NULL DEFAULT 0,
				run_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				heartbeat_at INTEGER,
				completed_at INTEGER
			)
		`);
    spaceRepo = new SpaceRepository(db as never);
    goalRepo = new SpaceGoalRepository(db as never);
    taskRepo = new SpaceTaskRepository(db as never);
    workflowRepo = new SpaceWorkflowRepository(db as never);
    workflowRunRepo = new SpaceWorkflowRunRepository(db as never);
    artifactRepo = new WorkflowRunArtifactRepository(db as never);
    evolutionRepo = new EvolutionRepository(db as never);
    jobQueue = new JobQueueRepository(db as never);
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
      ...createScopeServiceDeps(),
      traceEvidenceService,
      jobQueue,
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
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM job_queue
					 WHERE queue = 'space.conversationFriction.analyze' AND json_extract(payload, '$.taskId') = ?`
          )
          .get(task.id) as { count: number }
      ).count
    ).toBe(1);
    expect(evidence.find((item) => item.kind === 'session')?.metadata.traceDiagnostic).toBe(true);
    expect(evidence.find((item) => item.kind === 'task_result')?.summary).toContain(
      'PR ready and tests pass'
    );
    const artifactEvidence = evidence.find((item) => item.kind === 'artifact');
    expect(artifactEvidence?.summary).toContain('result/final');
    expect(artifactEvidence?.metadata.artifactTypes).toEqual(['result']);
    expect(artifactEvidence?.metadata.artifactCount).toBe(1);
  });

  it('skips evidence capture for automation review tasks', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Automation skip',
      objective: 'Do not capture automation task evidence',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Review Forge retrospective: Automation skip',
      evolutionScopeId: scope.id,
      labels: [
        'forge',
        'review',
        'automation',
        'automation:completed_task_threshold:threshold:1:run',
      ],
    });
    const manager = new SpaceTaskManager(db as never, spaceId, undefined, evolutionScopeService);

    await manager.setTaskStatus(task.id, 'done', { result: 'Reviewed' });

    expect(evolutionRepo.listEvidence(scope.id)).toHaveLength(0);
  });

  it('still captures evidence for tasks with a generic automation label', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Generic automation label',
      objective: 'Capture evidence for generic automation label',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Generic automation task',
      evolutionScopeId: scope.id,
      labels: ['automation'],
    });
    const manager = new SpaceTaskManager(db as never, spaceId, undefined, evolutionScopeService);

    await manager.setTaskStatus(task.id, 'done', { result: 'Done' });

    expect(evolutionRepo.listEvidence(scope.id).some((item) => item.kind === 'task_result')).toBe(
      true
    );
  });

  it('captures evidence for user-defined automation labels like automation:ci', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'User automation label',
      objective: 'Capture evidence for user automation labels',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'CI automation task',
      evolutionScopeId: scope.id,
      labels: ['automation', 'automation:ci'],
    });
    const manager = new SpaceTaskManager(db as never, spaceId, undefined, evolutionScopeService);

    await manager.setTaskStatus(task.id, 'done', { result: 'Done' });

    expect(evolutionRepo.listEvidence(scope.id).some((item) => item.kind === 'task_result')).toBe(
      true
    );
  });

  it('captures trace-derived evidence through the normal task completion path', async () => {
    const manager = new SpaceTaskManager(db as never, spaceId, undefined, evolutionScopeService);
    const slowFailureScope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Slow failure path',
      objective: 'Capture slow tool failures from completed tasks',
    });
    const slowFailureTask = taskRepo.createTask({
      spaceId,
      title: 'Finish after slow tool failure',
      description: 'Normal completion should run trace capture for slow failures',
      evolutionScopeId: slowFailureScope.id,
    });
    insertTextMessage(
      slowFailureTask.id,
      'session-slow-failure',
      'message-human-correction',
      'user',
      'human',
      'No, keep the slow failure fix in this PR.'
    );
    insertToolExchangeAt(
      slowFailureTask.id,
      'session-slow-failure',
      'tool-slow-failure',
      'Bash',
      { command: 'curl https://example.invalid' },
      true,
      { text: 'Error: connection timed out' },
      1_700_000_000_000,
      1_700_000_045_000
    );
    await taskRepo.updateTask(slowFailureTask.id, {
      status: 'in_progress',
      result: 'Recovered from slow tool failure',
    });

    await manager.setTaskStatus(slowFailureTask.id, 'done');

    const slowFailureEvidence = evolutionRepo.listEvidence(slowFailureScope.id);
    expect(slowFailureEvidence.some((item) => item.kind === 'task_result')).toBe(true);
    expect(slowFailureEvidence.some((item) => item.kind === 'slow_tool_call')).toBe(true);
    expect(slowFailureEvidence.some((item) => item.kind === 'tool_failure')).toBe(true);
    expect(slowFailureEvidence.some((item) => item.kind === 'friction_digest')).toBe(true);
    const slowDigest = slowFailureEvidence.find((item) => item.kind === 'friction_digest');
    expect(slowDigest?.metadata.counts).toMatchObject({ slowToolCall: 1, toolFailure: 1 });
    expect(
      slowFailureEvidence.some(
        (item) => item.kind === 'session' && item.metadata.traceDiagnostic === true
      )
    ).toBe(false);
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM job_queue
						 WHERE queue = 'space.conversationFriction.analyze' AND json_extract(payload, '$.taskId') = ?`
          )
          .get(slowFailureTask.id) as { count: number }
      ).count
    ).toBe(1);

    const retryLoopScope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Retry loop path',
      objective: 'Capture retry loops from completed tasks',
    });
    const retryLoopTask = taskRepo.createTask({
      spaceId,
      title: 'Finish after retry loop',
      description: 'Normal completion should run trace capture for retry loops',
      evolutionScopeId: retryLoopScope.id,
    });
    insertToolExchange(
      retryLoopTask.id,
      'session-retry-loop',
      'tool-check-fail-1',
      'Bash',
      { command: 'bun run check' },
      true,
      { text: 'Typecheck failed in foo.ts' }
    );
    insertToolExchange(
      retryLoopTask.id,
      'session-retry-loop',
      'tool-check-fail-2',
      'Bash',
      { command: 'bun run check' },
      true,
      { text: 'Lint failed in bar.ts' }
    );
    insertToolExchange(
      retryLoopTask.id,
      'session-retry-loop',
      'tool-check-pass',
      'Bash',
      { command: 'bun run check' },
      false,
      { text: 'All checks passed' }
    );
    await taskRepo.updateTask(retryLoopTask.id, {
      status: 'in_progress',
      result: 'Recovered after retry loop',
    });

    await manager.setTaskStatus(retryLoopTask.id, 'done');

    const retryLoopEvidence = evolutionRepo.listEvidence(retryLoopScope.id);
    expect(retryLoopEvidence.some((item) => item.kind === 'task_result')).toBe(true);
    expect(retryLoopEvidence.some((item) => item.kind === 'friction_digest')).toBe(true);
    const retryLoop = retryLoopEvidence.find((item) => item.kind === 'retry_loop');
    expect(retryLoop?.metadata.retriesBeforeSuccess).toBe(2);
    expect(
      retryLoopEvidence.some(
        (item) => item.kind === 'session' && item.metadata.traceDiagnostic === true
      )
    ).toBe(false);
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM job_queue
						 WHERE queue = 'space.conversationFriction.analyze' AND json_extract(payload, '$.taskId') = ?`
          )
          .get(retryLoopTask.id) as { count: number }
      ).count
    ).toBe(1);
  });

  it('records clean-trace diagnostics through the normal task completion path', async () => {
    const manager = new SpaceTaskManager(db as never, spaceId, undefined, evolutionScopeService);
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Clean normal completion path',
      objective: 'Record diagnostics when completed task trace has no friction',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Finish clean trace task',
      description: 'Normal completion should record no-friction trace diagnostics',
      evolutionScopeId: scope.id,
    });
    insertToolExchange(
      task.id,
      'session-clean-normal',
      'tool-clean-normal',
      'Bash',
      { command: 'bun test packages/daemon/tests/unit/5-space/forge-evidence-capture.test.ts' },
      false,
      { text: '1 pass' }
    );
    await taskRepo.updateTask(task.id, {
      status: 'in_progress',
      result: 'Clean trace validation complete',
    });

    await manager.setTaskStatus(task.id, 'done');

    const evidence = evolutionRepo.listEvidence(scope.id);
    const diagnostic = evidence.find(
      (item) => item.kind === 'session' && item.metadata.traceDiagnostic === true
    );
    expect(evidence.some((item) => item.kind === 'task_result')).toBe(true);
    expect(diagnostic?.metadata.status).toBe('no_friction');
    expect(diagnostic?.metadata.toolCallCount).toBe(1);
    expect(diagnostic?.metadata.failedToolCallCount).toBe(0);
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM job_queue
							 WHERE queue = 'space.conversationFriction.analyze' AND json_extract(payload, '$.taskId') = ?`
          )
          .get(task.id) as { count: number }
      ).count
    ).toBe(1);
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

  it('does not cross-post proposal evidence when proposal and task scopes match', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Same-scope proposal',
      objective: 'Avoid duplicate same-scope proposal evidence',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Complete same-scope proposal task',
      description: 'Task stays with proposal scope',
      evolutionScopeId: scope.id,
    });
    evolutionRepo.createTaskProposal({
      scopeId: scope.id,
      title: task.title,
      description: task.description,
      reason: 'Same scope proposal',
      status: 'created',
      createdTaskId: task.id,
    });
    taskRepo.updateTask(task.id, { status: 'done', result: 'Same scope done' });

    evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

    const evidence = evolutionRepo.listEvidence(scope.id);
    expect(evidence).toHaveLength(2);
    expect(evidence.filter((item) => item.kind === 'task_result')).toHaveLength(1);
    expect(evidence.some((item) => item.metadata.crossLinkedTaskId === task.id)).toBe(false);
  });

  it('cross-posts proposal-originating task evidence to different originating scope', () => {
    const originScope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Originating Forge scope',
      objective: 'Learn from proposed tasks',
    });
    const assignedScope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Assigned execution scope',
      objective: 'Run tasks from other scopes',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Complete cross-scope proposal task',
      description: 'Task runs under assigned scope',
      evolutionScopeId: assignedScope.id,
    });
    const proposal = evolutionRepo.createTaskProposal({
      scopeId: originScope.id,
      title: task.title,
      description: task.description,
      reason: 'Origin scope proposed this work',
      status: 'created',
      createdTaskId: task.id,
    });
    taskRepo.updateTask(task.id, { status: 'done', result: 'Cross-scope done' });

    evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

    const assignedEvidence = evolutionRepo.listEvidence(assignedScope.id);
    const originEvidence = evolutionRepo.listEvidence(originScope.id);
    expect(assignedEvidence.map((item) => item.kind).sort()).toEqual(['session', 'task_result']);
    expect(originEvidence.map((item) => item.kind)).toEqual(['task_result']);
    expect(originEvidence[0].sourceId).toBe(task.id);
    expect(originEvidence[0].metadata).toMatchObject({
      autoCaptured: true,
      crossLinkedTaskId: task.id,
      originatingProposalId: proposal.id,
      assignedScopeId: assignedScope.id,
      result: 'Cross-scope done',
    });
  });

  it('deduplicates repeated proposal-origin evidence cross-posts', () => {
    const originScope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Dedupe origin scope',
      objective: 'Avoid duplicate cross-post evidence',
    });
    const assignedScope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Dedupe assigned scope',
      objective: 'Run duplicated capture events',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Complete cross-post once',
      description: 'Repeated capture should update existing cross-post',
      evolutionScopeId: assignedScope.id,
    });
    const proposal = evolutionRepo.createTaskProposal({
      scopeId: originScope.id,
      title: task.title,
      description: task.description,
      reason: 'Needs dedupe',
      status: 'created',
      createdTaskId: task.id,
    });
    taskRepo.updateTask(task.id, { status: 'done', result: 'Initial result' });

    evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });
    taskRepo.updateTask(task.id, { result: 'Updated result' });
    evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

    const originEvidence = evolutionRepo.listEvidence(originScope.id);
    expect(originEvidence).toHaveLength(1);
    expect(originEvidence[0].summary).toContain('Updated result');
    expect(originEvidence[0].metadata).toMatchObject({
      autoCaptured: true,
      crossLinkedTaskId: task.id,
      originatingProposalId: proposal.id,
      assignedScopeId: assignedScope.id,
      result: 'Updated result',
    });
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
      'Workflow run Queued: Run without artifacts — no artifact types — no artifacts captured'
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
    const diagnostic = evidence.find(
      (item) => item.kind === 'session' && item.metadata.traceDiagnostic === true
    );
    expect(diagnostic?.metadata.autoCaptured).toBe(true);
    expect(diagnostic?.metadata.status).toBe('generated');
    expect(diagnostic?.metadata.failedToolCallCount).toBe(1);
    expect(diagnostic?.metadata.evidenceCount).toBeGreaterThan(0);
    expect(diagnostic?.metadata.error).toBeUndefined();

    const cleanResult = evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

    expect(cleanResult.traceDiagnostic?.status).toBe('generated');
    expect(
      evolutionRepo
        .listEvidence(scope.id)
        .filter((item) => item.kind === 'session' && item.metadata.traceDiagnostic === true)
    ).toHaveLength(1);
  });

  it('clears attach-time trace diagnostics when later attachment generates trace evidence', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Attachment retry scope',
      objective: 'Avoid stale attach diagnostics',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Attach task evidence twice',
      description: 'First throws, then captures trace evidence',
      evolutionScopeId: scope.id,
    });
    const throwingService = new EvolutionScopeService({
      ...createScopeServiceDeps(),
      traceEvidenceService: {
        captureForTaskWithDiagnostic: () => {
          throw new Error('temporary trace failure');
        },
      } as never,
    });
    throwingService.attachTaskEvidence({ taskId: task.id });
    expect(
      evolutionRepo
        .listEvidence(scope.id)
        .find((item) => item.kind === 'session' && item.metadata.traceDiagnostic === true)?.metadata
        .error
    ).toBe('temporary trace failure');
    insertToolExchange(
      task.id,
      'session-attach-retry',
      'tool-attach-fail',
      'Bash',
      { command: 'bun test' },
      true,
      { text: 'Error: attach retry failed test' }
    );

    evolutionScopeService.attachTaskEvidence({ taskId: task.id });

    const evidence = evolutionRepo.listEvidence(scope.id);
    expect(evidence.some((item) => item.kind === 'test_failure')).toBe(true);
    const diagnostic = evidence.find(
      (item) => item.kind === 'session' && item.metadata.traceDiagnostic === true
    );
    expect(diagnostic?.metadata.autoCaptured).toBe(true);
    expect(diagnostic?.metadata.status).toBe('generated');
    expect(diagnostic?.metadata.error).toBeUndefined();
    expect(diagnostic?.metadata.evidenceCount).toBeGreaterThan(0);
  });

  it('clears attach-time trace errors when later attachment has no trace friction', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Clean attachment retry scope',
      objective: 'Clear stale attach errors without generated evidence',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Attach clean task evidence twice',
      description: 'First throws, then has clean trace',
      evolutionScopeId: scope.id,
    });
    const throwingService = new EvolutionScopeService({
      ...createScopeServiceDeps(),
      traceEvidenceService: {
        captureForTaskWithDiagnostic: () => {
          throw new Error('temporary trace failure');
        },
      } as never,
    });
    throwingService.attachTaskEvidence({ taskId: task.id });
    expect(
      evolutionRepo
        .listEvidence(scope.id)
        .find((item) => item.kind === 'session' && item.metadata.traceDiagnostic === true)?.metadata
        .error
    ).toBe('temporary trace failure');
    insertToolExchange(
      task.id,
      'session-attach-clean-retry',
      'tool-attach-clean',
      'Bash',
      { command: 'bun test' },
      false,
      { text: '1 pass' }
    );

    evolutionScopeService.attachTaskEvidence({ taskId: task.id });

    const diagnostics = evolutionRepo
      .listEvidence(scope.id)
      .filter((item) => item.kind === 'session' && item.metadata.traceDiagnostic === true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.metadata.autoCaptured).toBe(true);
    expect(diagnostics[0]?.metadata.status).toBe('no_friction');
    expect(diagnostics[0]?.metadata.error).toBeUndefined();
  });

  it('does not enqueue duplicate conversation friction analysis beyond the newest 100 jobs', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Large queue scope',
      objective: 'Avoid duplicate analyzer jobs',
    });
    const duplicateTask = taskRepo.createTask({
      spaceId,
      title: 'Already queued task',
      description: 'Existing old job should be found',
      evolutionScopeId: scope.id,
    });
    for (let index = 0; index < 101; index += 1) {
      jobQueue.enqueue({
        queue: 'space.conversationFriction.analyze',
        payload: {
          scopeId: scope.id,
          taskId: index === 0 ? duplicateTask.id : `other-task-${index}`,
        },
      });
    }
    await taskRepo.updateTask(duplicateTask.id, { status: 'in_progress', result: 'Done' });
    const manager = new SpaceTaskManager(db as never, spaceId, undefined, evolutionScopeService);

    await manager.setTaskStatus(duplicateTask.id, 'done');

    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM job_queue
						 WHERE queue = 'space.conversationFriction.analyze' AND json_extract(payload, '$.taskId') = ?`
          )
          .get(duplicateTask.id) as { count: number }
      ).count
    ).toBe(1);
  });

  it('captures slow successful tool calls as trace-derived evidence', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Slow tool scope',
      objective: 'Capture slow successful operations',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Slow successful tool call',
      description: 'Slow Bash call should count as friction',
      evolutionScopeId: scope.id,
    });
    insertToolExchangeAt(
      task.id,
      'session-slow',
      'tool-slow-1',
      'Bash',
      { command: 'bun run check' },
      false,
      { text: 'Checks passed' },
      1_700_000_000_000,
      1_700_000_045_000
    );
    taskRepo.updateTask(task.id, { status: 'done', result: 'Slow check passed' });

    const result = evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

    expect(result.traceDiagnostic?.status).toBe('generated');
    expect(result.traceDiagnostic?.slowToolCallCount).toBe(1);
    const slowEvidence = evolutionRepo
      .listEvidence(scope.id)
      .find((item) => item.kind === 'slow_tool_call');
    expect(slowEvidence?.metadata.slowToolCallCount).toBe(1);
    expect(
      (slowEvidence?.metadata.slowToolCalls as Array<{ durationMs: number }>)[0]?.durationMs
    ).toBe(45_000);
  });

  it('captures tool failure evidence for slow failed generic commands', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Slow failed tool scope',
      objective: 'Preserve failure signal for slow failed operations',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Slow failed generic command',
      description: 'Slow failed Bash call should emit both slow and failure evidence',
      evolutionScopeId: scope.id,
    });
    insertToolExchangeAt(
      task.id,
      'session-slow-failed',
      'tool-slow-failed-1',
      'Bash',
      { command: 'curl https://example.invalid' },
      true,
      { text: 'Error: connection timed out' },
      1_700_000_000_000,
      1_700_000_045_000
    );
    taskRepo.updateTask(task.id, { status: 'done', result: 'Recovered after slow failure' });

    const result = evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });

    expect(result.traceDiagnostic?.status).toBe('generated');
    expect(result.traceDiagnostic?.failedToolCallCount).toBe(1);
    expect(result.traceDiagnostic?.slowToolCallCount).toBe(1);
    const evidenceKinds = evolutionRepo.listEvidence(scope.id).map((item) => item.kind);
    expect(evidenceKinds).toContain('slow_tool_call');
    expect(evidenceKinds).toContain('tool_failure');
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

  function createScopeServiceDeps() {
    return {
      evolutionRepo,
      spaceRepo,
      goalRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
    };
  }

  function insertToolExchange(
    taskId: string,
    sessionId: string,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    failed: boolean,
    options: { text: string }
  ) {
    insertToolExchangeAt(
      taskId,
      sessionId,
      toolUseId,
      toolName,
      input,
      failed,
      options,
      nextMessageTime(),
      nextMessageTime()
    );
  }

  function insertToolExchangeAt(
    taskId: string,
    sessionId: string,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    failed: boolean,
    options: { text: string },
    toolUseTimestamp: number,
    toolResultTimestamp: number
  ) {
    insertMessageAt(
      taskId,
      sessionId,
      'assistant',
      {
        type: 'assistant',
        uuid: `${toolUseId}-assistant`,
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
        },
      },
      toolUseTimestamp
    );
    insertMessageAt(
      taskId,
      sessionId,
      'user',
      {
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
      },
      toolResultTimestamp
    );
  }

  function insertTextMessage(
    taskId: string,
    sessionId: string,
    messageId: string,
    messageType: string,
    origin: string | null,
    text: string
  ) {
    insertMessageAt(
      taskId,
      sessionId,
      messageType,
      {
        type: messageType,
        uuid: messageId,
        session_id: sessionId,
        origin,
        message: {
          role: messageType === 'assistant' ? 'assistant' : 'user',
          content: [{ type: 'text', text }],
        },
      },
      nextMessageTime()
    );
  }

  function insertMessageAt(
    taskId: string,
    sessionId: string,
    messageType: string,
    message: Record<string, unknown>,
    timestamp: number
  ) {
    ensureSession(sessionId);
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
      new Date(timestamp).toISOString(),
      taskId
    );
  }

  function ensureSession(sessionId: string) {
    db.prepare(
      `INSERT OR IGNORE INTO sessions (
        id, title, workspace_path, created_at, last_active_at, status, config, metadata
      ) VALUES (?, ?, ?, ?, ?, 'active', '{}', '{}')`
    ).run(
      sessionId,
      `Session ${sessionId}`,
      '/workspace/forge-evidence-capture-test',
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T00:00:00.000Z'
    );
  }

  function nextMessageTime(): number {
    const count = db.prepare('SELECT COUNT(*) AS count FROM sdk_messages').get() as {
      count: number;
    };
    return 1_700_000_000_000 + (count.count + 1) * 1000;
  }
});
