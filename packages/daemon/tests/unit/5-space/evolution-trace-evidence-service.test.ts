import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { EvidenceRef } from '@neokai/shared';
import { EvolutionScopeService } from '../../../src/lib/space/evolution-scope-service';
import { EvolutionTraceEvidenceService } from '../../../src/lib/space/evolution-trace-evidence-service';
import { EvolutionRepository } from '../../../src/storage/repositories/evolution-repository';
import { GateOpenStateRepository } from '../../../src/storage/repositories/gate-open-state-repository';
import { SpaceGoalRepository } from '../../../src/storage/repositories/space-goal-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository';
import { createSpaceTables } from '../helpers/space-test-db';

describe('EvolutionTraceEvidenceService', () => {
  let db: Database;
  let evolutionRepo: EvolutionRepository;
  let goalRepo: SpaceGoalRepository;
  let taskRepo: SpaceTaskRepository;
  let scopeService: EvolutionScopeService;
  let spaceId: string;
  let sequence: number;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const spaceRepo = new SpaceRepository(db as never);
    evolutionRepo = new EvolutionRepository(db as never);
    goalRepo = new SpaceGoalRepository(db as never);
    taskRepo = new SpaceTaskRepository(db as never);
    const workflowRunRepo = new SpaceWorkflowRunRepository(
      db as never,
      new GateOpenStateRepository(db as never)
    );
    const traceEvidenceService = new EvolutionTraceEvidenceService({
      db: db as never,
      evolutionRepo,
      taskRepo,
    });
    scopeService = new EvolutionScopeService({
      evolutionRepo,
      spaceRepo,
      goalRepo,
      taskRepo,
      workflowRunRepo,
      traceEvidenceService,
    });
    spaceId = spaceRepo.createSpace({
      workspacePath: '/workspace/trace-evidence-test',
      slug: 'trace-evidence-test',
      name: 'Trace Evidence Test',
    }).id;
    sequence = 0;
  });

  afterEach(() => {
    db.close();
  });

  it('clusters repeated tool errors into one trace evidence item', () => {
    const { scope, task } = createScopedTask('Repeated errors');
    insertToolExchange(task.id, 'session-1', 'tool-1', 'Bash', { command: 'bun test' }, true, {
      text: 'Error: expected 1 to be 2\nlong stack should stay out of metadata',
    });
    insertToolExchange(task.id, 'session-1', 'tool-2', 'Bash', { command: 'bun test' }, true, {
      text: 'Error: expected 3 to be 4\ndifferent stack should cluster by normalized error',
    });

    scopeService.attachTaskEvidence({ taskId: task.id });

    const traceEvidence = listTraceEvidence(scope.id);
    expect(traceEvidence.filter((item) => item.kind === 'error_cluster')).toHaveLength(1);
    const cluster = traceEvidence.find((item) => item.kind === 'error_cluster') as EvidenceRef;
    expect(cluster.metadata.repeatedSameErrorCount).toBe(2);
    expect(cluster.metadata.toolCallCount).toBe(2);
    expect(cluster.metadata.failedToolCallCount).toBe(2);
    expect(cluster.metadata.rawTraceRefs).toMatchObject({
      sessionIds: ['session-1'],
      toolUseIds: ['tool-1', 'tool-2'],
    });
    expect(JSON.stringify(cluster.metadata)).not.toContain(
      'long stack should stay out of metadata'
    );
  });

  it('analyzes the latest trace window for long-running tasks', () => {
    const { scope, task } = createScopedTask('Long trace task');
    for (let index = 0; index < 260; index++) {
      insertToolExchange(
        task.id,
        'session-1',
        `early-${index}`,
        'Bash',
        { command: 'true' },
        false,
        {
          text: 'ok',
        }
      );
    }
    insertToolExchange(task.id, 'session-1', 'late-1', 'Bash', { command: 'bun test' }, true, {
      text: 'Late failure still matters',
    });

    scopeService.attachTaskEvidence({ taskId: task.id });

    const testFailure = listTraceEvidence(scope.id).find((item) => item.kind === 'test_failure');
    expect(testFailure).toBeTruthy();
    expect(testFailure?.metadata.rawTraceRefs).toMatchObject({ toolUseIds: ['late-1'] });
  });

  it('records retry-loop friction even when verification eventually passes', () => {
    const { scope, task } = createScopedTask('Retries before success');
    insertToolExchange(
      task.id,
      'session-1',
      'check-1',
      'Bash',
      { command: 'bun run check' },
      true,
      {
        text: 'Typecheck failed in foo.ts',
      }
    );
    insertToolExchange(
      task.id,
      'session-1',
      'check-2',
      'Bash',
      { command: 'bun run check' },
      true,
      {
        text: 'Lint failed in bar.ts',
      }
    );
    insertToolExchange(
      task.id,
      'session-1',
      'check-3',
      'Bash',
      { command: 'bun run check' },
      false,
      {
        text: 'All checks passed',
      }
    );
    taskRepo.updateTask(task.id, { reportedStatus: 'done', result: 'Task completed successfully' });

    scopeService.attachTaskEvidence({ taskId: task.id });

    const retryLoop = listTraceEvidence(scope.id).find((item) => item.kind === 'retry_loop');
    expect(retryLoop).toBeTruthy();
    expect(retryLoop?.metadata.retriesBeforeSuccess).toBe(2);
    expect(retryLoop?.metadata.messageCountBeforeFirstPassingVerification).toBe(6);
    expect(retryLoop?.metadata.timeBeforeFirstPassingVerificationMs).toBeGreaterThan(0);
  });

  it('detects retry loops after an initial success', () => {
    const { scope, task } = createScopedTask('Retries after success');
    insertToolExchange(
      task.id,
      'session-1',
      'check-pass-1',
      'Bash',
      { command: 'bun test' },
      false,
      {
        text: 'Initial pass',
      }
    );
    insertToolExchange(
      task.id,
      'session-1',
      'check-fail-1',
      'Bash',
      { command: 'bun test' },
      true,
      {
        text: 'Failure after edits',
      }
    );
    insertToolExchange(
      task.id,
      'session-1',
      'check-fail-2',
      'Bash',
      { command: 'bun test' },
      true,
      {
        text: 'Still failing after edits',
      }
    );
    insertToolExchange(
      task.id,
      'session-1',
      'check-pass-2',
      'Bash',
      { command: 'bun test' },
      false,
      {
        text: 'Recovered',
      }
    );

    scopeService.attachTaskEvidence({ taskId: task.id });

    const retryLoop = listTraceEvidence(scope.id).find((item) => item.kind === 'retry_loop');
    expect(retryLoop).toBeTruthy();
    expect(retryLoop?.metadata.retriesBeforeSuccess).toBe(2);
    expect(retryLoop?.metadata.rawTraceRefs).toMatchObject({
      toolUseIds: ['check-fail-1', 'check-fail-2', 'check-pass-2'],
    });
  });

  it('records every independent retry loop', () => {
    const { scope, task } = createScopedTask('Multiple retry loops');
    insertToolExchange(task.id, 'session-1', 'test-fail-1', 'Bash', { command: 'bun test' }, true, {
      text: 'Tests failed once',
    });
    insertToolExchange(task.id, 'session-1', 'test-fail-2', 'Bash', { command: 'bun test' }, true, {
      text: 'Tests failed twice',
    });
    insertToolExchange(task.id, 'session-1', 'test-pass', 'Bash', { command: 'bun test' }, false, {
      text: 'Tests passed',
    });
    insertToolExchange(
      task.id,
      'session-1',
      'check-fail-1',
      'Bash',
      { command: 'bun run check' },
      true,
      {
        text: 'Check failed once',
      }
    );
    insertToolExchange(
      task.id,
      'session-1',
      'check-fail-2',
      'Bash',
      { command: 'bun run check' },
      true,
      {
        text: 'Check failed twice',
      }
    );
    insertToolExchange(
      task.id,
      'session-1',
      'check-pass',
      'Bash',
      { command: 'bun run check' },
      false,
      {
        text: 'Check passed',
      }
    );

    scopeService.attachTaskEvidence({ taskId: task.id });

    const retryLoops = listTraceEvidence(scope.id).filter((item) => item.kind === 'retry_loop');
    expect(retryLoops).toHaveLength(2);
    expect(retryLoops.map((item) => item.metadata.retryKey).sort()).toEqual([
      'session-1:Bash:bun run check',
      'session-1:Bash:bun test',
    ]);
  });

  it('does not build retry loops from orphan tool results', () => {
    const { scope, task } = createScopedTask('Orphan tool results');
    insertToolResultOnly(task.id, 'session-1', 'missing-1', true, 'Orphan failure one');
    insertToolResultOnly(task.id, 'session-1', 'missing-2', true, 'Orphan failure two');
    insertToolResultOnly(task.id, 'session-1', 'missing-3', false, 'Orphan success');

    scopeService.attachTaskEvidence({ taskId: task.id });

    expect(listTraceEvidence(scope.id).some((item) => item.kind === 'retry_loop')).toBe(false);
  });

  it('refreshes existing trace evidence when counts change', () => {
    const { scope, task } = createScopedTask('Refresh trace evidence');
    insertToolExchange(task.id, 'session-1', 'test-1', 'Bash', { command: 'bun test' }, true, {
      text: 'One test failure',
    });
    scopeService.attachTaskEvidence({ taskId: task.id });
    const initial = listTraceEvidence(scope.id).find((item) => item.kind === 'test_failure');
    expect(initial?.metadata.testFailureCycles).toBe(1);

    insertToolExchange(task.id, 'session-1', 'test-2', 'Bash', { command: 'bun test' }, true, {
      text: 'Second test failure',
    });
    scopeService.attachTaskEvidence({ taskId: task.id });

    const testFailures = listTraceEvidence(scope.id).filter((item) => item.kind === 'test_failure');
    expect(testFailures).toHaveLength(1);
    expect(testFailures[0]?.id).toBe(initial?.id);
    expect(testFailures[0]?.metadata.testFailureCycles).toBe(2);
    expect(testFailures[0]?.metadata.rawTraceRefs).toMatchObject({
      toolUseIds: ['test-1', 'test-2'],
    });
  });

  it('does not merge retry loops across sessions for the same command', () => {
    const { scope, task } = createScopedTask('Independent retries');
    insertToolExchange(
      task.id,
      'session-1',
      'session-1-fail',
      'Bash',
      { command: 'bun test' },
      true,
      {
        text: 'Session 1 failed once',
      }
    );
    insertToolExchange(
      task.id,
      'session-2',
      'session-2-fail',
      'Bash',
      { command: 'bun test' },
      true,
      {
        text: 'Session 2 failed once',
      }
    );
    insertToolExchange(
      task.id,
      'session-3',
      'session-3-pass',
      'Bash',
      { command: 'bun test' },
      false,
      {
        text: 'Session 3 passed',
      }
    );

    scopeService.attachTaskEvidence({ taskId: task.id });

    expect(listTraceEvidence(scope.id).some((item) => item.kind === 'retry_loop')).toBe(false);
  });

  it('records test failure evidence for failing verification commands', () => {
    const { scope, task } = createScopedTask('Test failure task');
    insertToolExchange(task.id, 'session-1', 'test-1', 'Bash', { command: 'bun test' }, true, {
      text: '2 tests failed',
    });

    scopeService.attachTaskEvidence({ taskId: task.id });

    const testFailure = listTraceEvidence(scope.id).find((item) => item.kind === 'test_failure');
    expect(testFailure).toBeTruthy();
    expect(testFailure?.metadata.testFailureCycles).toBe(1);
    expect(testFailure?.metadata.rawTraceRefs).toMatchObject({
      sessionIds: ['session-1'],
      toolUseIds: ['test-1'],
    });
  });

  it('records permission block evidence for denied or blocked actions', () => {
    const { scope, task } = createScopedTask('Permission block task');
    insertToolExchange(
      task.id,
      'session-1',
      'blocked-1',
      'Bash',
      { command: 'rm -rf /tmp/x' },
      true,
      {
        text: 'Permission denied: operation not permitted',
      }
    );

    scopeService.attachTaskEvidence({ taskId: task.id });

    const permissionBlock = listTraceEvidence(scope.id).find(
      (item) => item.kind === 'permission_block'
    );
    expect(permissionBlock).toBeTruthy();
    expect(permissionBlock?.metadata.permissionBlockCount).toBe(1);
    expect(permissionBlock?.metadata.rawTraceRefs).toMatchObject({
      sessionIds: ['session-1'],
      toolUseIds: ['blocked-1'],
    });
  });

  it('does not create noisy trace evidence for clean short tasks', () => {
    const { scope, task } = createScopedTask('Clean task');
    insertToolExchange(task.id, 'session-1', 'check-1', 'Bash', { command: 'bun test' }, false, {
      text: '1 pass',
    });

    scopeService.attachTaskEvidence({ taskId: task.id });

    const traceEvidence = listTraceEvidence(scope.id);
    expect(traceEvidence).toEqual([]);
  });

  it('retains raw trace span references in metadata without storing transcript dumps', () => {
    const { scope, task } = createScopedTask('Raw refs');
    insertToolExchange(task.id, 'session-1', 'edit-1', 'Edit', { file_path: '/tmp/a.ts' }, true, {
      text: 'String to replace not found in file. Full transcript text should not be copied.',
    });

    scopeService.attachTaskEvidence({ taskId: task.id });

    const toolFailure = listTraceEvidence(scope.id).find((item) => item.kind === 'tool_failure');
    expect(toolFailure).toBeTruthy();
    expect(toolFailure?.metadata).toMatchObject({
      traceDerived: true,
      toolCallCount: 1,
      failedToolCallCount: 1,
    });
    const rawTraceRefs = toolFailure?.metadata.rawTraceRefs as Record<string, unknown>;
    expect(rawTraceRefs.sessionIds).toEqual(['session-1']);
    expect(rawTraceRefs.messageIds).toHaveLength(1);
    expect(JSON.stringify(toolFailure?.metadata)).not.toContain(
      'Full transcript text should not be copied'
    );
  });

  function createScopedTask(title: string) {
    const goal = goalRepo.create({ spaceId, title: `${title} goal`, type: 'recurring' });
    const scope = scopeService.createScopeFromGoal({ spaceGoalId: goal.id });
    const task = taskRepo.createTask({ spaceId, title, description: title, goalId: goal.id });
    return { scope, task };
  }

  function listTraceEvidence(scopeId: string): EvidenceRef[] {
    return evolutionRepo
      .listEvidence(scopeId)
      .filter((item) => item.metadata.traceDerived === true)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
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
    insertMessage(taskId, sessionId, 'assistant', {
      type: 'assistant',
      uuid: `${toolUseId}-assistant`,
      session_id: sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
      },
    });
    insertToolResultOnly(taskId, sessionId, toolUseId, failed, options.text);
  }

  function insertToolResultOnly(
    taskId: string,
    sessionId: string,
    toolUseId: string,
    failed: boolean,
    text: string
  ) {
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
            content: text,
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
    sequence += 1;
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
