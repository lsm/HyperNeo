import { describe, test, expect, beforeEach } from 'bun:test';
import {
  clearAllRetryableHookActionTimers,
  QUEUED_RETRYABLE_ACTION_STATE_KEY,
  WorkflowHookEngine,
  wrapHandlerWithHooks,
  PR_READY_VALIDATED_IDENTITY_HOOK_ID,
  type HookActionMeta,
  type HookActionOutcome,
} from '../../../../src/lib/space/runtime/workflow-hook-engine';
import { HookExecutor } from '../../../../src/lib/space/runtime/hook-executor';
import { _setStartupEnvBaselineForTesting } from '../../../../src/lib/spawn-env';
import type {
  WorkflowHook,
  WorkflowHookResult,
  SpaceWorkflow,
  WorkflowRunStatus,
} from '@hyperneo/shared';
import type { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import type { WorkflowHookStateRepository } from '../../../../src/storage/repositories/workflow-hook-state-repository';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
import type { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository';
import type { ToolResult } from '../../../../src/lib/space/tools/tool-result';

class MockHookExecutor extends HookExecutor {
  private results = new Map<string, WorkflowHookResult>();

  constructor() {
    super({ workspacePath: '/tmp' });
  }

  setResult(hookId: string, result: WorkflowHookResult): void {
    this.results.set(hookId, result);
  }

  clear(): void {
    this.results.clear();
  }

  override async execute(hook: WorkflowHook): Promise<{ result: WorkflowHookResult }> {
    const result = this.results.get(hook.id);
    if (!result) {
      return { result: { type: 'allow' } };
    }
    return { result };
  }
}

function makeMockNodeExecutionRepo(): NodeExecutionRepository {
  return {
    listByWorkflowRun: () => [
      {
        id: 'ne-coder-1',
        workflowRunId: 'run-1',
        workflowNodeId: 'node-coding',
        agentName: 'coder',
        agentSessionId: 'session-coder',
        status: 'in_progress',
      },
    ],
  } as unknown as NodeExecutionRepository;
}

function makeMockHookStateRepo(
  states = new Map<
    string,
    {
      version: number;
      localState: Record<string, unknown>;
      lastResult?: WorkflowHookResult;
      retryCount: number;
      nextRetryAt: number | null;
    }
  >()
): WorkflowHookStateRepository {
  return {
    get: (runId: string, hookId: string) => {
      const key = `${runId}:${hookId}`;
      const s = states.get(key);
      if (s) {
        return {
          runId,
          hookId,
          version: s.version,
          localState: s.localState,
          lastResult: s.lastResult,
          retryCount: s.retryCount,
          nextRetryAt: s.nextRetryAt ?? undefined,
          voteMaps: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }
      return null;
    },
    ensure: (runId: string, hookId: string, defaults: Record<string, unknown> = {}) => {
      const key = `${runId}:${hookId}`;
      if (!states.has(key)) {
        states.set(key, {
          version: 0,
          localState: { ...defaults },
          retryCount: 0,
          nextRetryAt: null,
        });
      }
      const s = states.get(key)!;
      return {
        runId,
        hookId,
        version: s.version,
        localState: s.localState,
        lastResult: s.lastResult,
        retryCount: s.retryCount,
        nextRetryAt: s.nextRetryAt ?? undefined,
        voteMaps: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    },
    update: (
      runId: string,
      hookId: string,
      patch: {
        expectedVersion: number;
        localState?: Record<string, unknown>;
        lastResult?: WorkflowHookResult;
        retryCount?: number;
        nextRetryAt?: number | null;
      }
    ) => {
      const key = `${runId}:${hookId}`;
      const s = states.get(key);
      if (!s || s.version !== patch.expectedVersion) return null;
      s.version += 1;
      if (patch.localState) {
        s.localState = { ...s.localState, ...patch.localState };
      }
      if (patch.lastResult !== undefined) {
        s.lastResult = patch.lastResult;
      }
      if (patch.retryCount !== undefined) {
        s.retryCount = patch.retryCount;
      }
      if (patch.nextRetryAt !== undefined) {
        s.nextRetryAt = patch.nextRetryAt;
      }
      return {
        runId,
        hookId,
        version: s.version,
        localState: s.localState,
        lastResult: s.lastResult,
        retryCount: s.retryCount,
        nextRetryAt: s.nextRetryAt ?? undefined,
        voteMaps: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    },
  } as unknown as WorkflowHookStateRepository;
}

function makeMockArtifactRepo(): WorkflowRunArtifactRepository {
  return {
    listByRun: () => [],
  } as unknown as WorkflowRunArtifactRepository;
}

function makeWorkflow(hooks: WorkflowHook[]): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: 'space-1',
    name: 'Test Workflow',
    startNodeId: 'node-coding',
    endNodeId: 'node-review',
    nodes: [
      { id: 'node-coding', name: 'Coding', agents: [{ name: 'coder', agentId: 'agent-coder' }] },
      {
        id: 'node-review',
        name: 'Review',
        agents: [{ name: 'reviewer', agentId: 'agent-reviewer' }],
      },
    ],
    channels: [{ id: 'ch-1', from: 'Coding', to: 'Review' }],
    hooks,
  };
}

function makeHook(overrides: Partial<WorkflowHook> & { id: string }): WorkflowHook {
  return {
    enabled: true,
    sourceNode: 'Coding',
    method: 'send_message',
    classification: 'validation',
    order: 0,
    validator: { kind: 'script', interpreter: 'bash', source: 'echo \'{"type":"allow"}\'' },
    authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
    ...overrides,
  } as WorkflowHook;
}

function makeEngine(
  hooks: WorkflowHook[],
  options: {
    hookStateRepo?: WorkflowHookStateRepository;
    getWorkflowRunStatus?: (runId: string) => WorkflowRunStatus | undefined;
    getTaskStatus?: (taskId: string) => string | undefined;
    getSourceNodeExecutionStatus?: (meta: HookActionMeta) => string | undefined;
    notifySourceSession?: (sessionId: string, message: string) => Promise<void>;
  } = {}
): {
  engine: WorkflowHookEngine;
  mockExecutor: MockHookExecutor;
  hookStateRepo: WorkflowHookStateRepository;
} {
  const mockExecutor = new MockHookExecutor();
  const hookStateRepo = options.hookStateRepo ?? makeMockHookStateRepo();
  const engine = new WorkflowHookEngine({
    workflow: makeWorkflow(hooks),
    workflowRunId: 'run-1',
    nodeExecutionRepo: makeMockNodeExecutionRepo(),
    artifactRepo: makeMockArtifactRepo(),
    hookStateRepo,
    hookExecutor: mockExecutor,
    workspacePath: '/tmp',
    getWorkflowRunStatus: options.getWorkflowRunStatus,
    getTaskStatus: options.getTaskStatus,
    getSourceNodeExecutionStatus: options.getSourceNodeExecutionStatus,
    notifySourceSession: options.notifySourceSession,
  });
  return { engine, mockExecutor, hookStateRepo };
}

const defaultMeta: HookActionMeta = {
  sessionId: 'session-coder',
  agentName: 'coder',
  nodeId: 'node-coding',
  taskId: 'task-1',
};

describe('WorkflowHookEngine', () => {
  test('persistStateUpdate retries version conflicts', () => {
    let attempts = 0;
    const stateRepo = makeMockHookStateRepo();
    const originalUpdate = stateRepo.update.bind(stateRepo);
    stateRepo.update = ((...args: Parameters<WorkflowHookStateRepository['update']>) => {
      attempts += 1;
      if (attempts === 1) return null;
      return originalUpdate(...args);
    }) as WorkflowHookStateRepository['update'];
    const { engine } = makeEngine([makeHook({ id: 'hook-1' })], { hookStateRepo: stateRepo });

    expect(engine.persistStateUpdate('hook-1', { approvals: { architecture: 'approved' } })).toBe(
      true
    );
    expect(attempts).toBe(2);
  });

  test('allow: no hooks registered → allow silently', async () => {
    const { engine } = makeEngine([]);
    const outcome = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('allow');
    expect(outcome.executionLog).toHaveLength(0);
    expect(outcome.userState.status).toBe('allowed');
  });

  test('allow: hook returns allow → allow with debug record', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'validation' }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'allow', message: 'All good' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('allow');
    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('hook-1');
    expect(outcome.executionLog[0].result.type).toBe('allow');
    expect(outcome.userState.status).toBe('allowed');
  });

  test('block: validation hook returns block → action blocked', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'validation' }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'block', reason: 'PR not open' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('block');
    expect(outcome.blockedByHookId).toBe('hook-1');
    expect(outcome.userState.status).toBe('blocked_by_hook');
    expect(outcome.userState.reason).toBe('PR not open');
    expect(outcome.userState.hookId).toBe('hook-1');
    expect(outcome.userState.method).toBe('send_message');
  });

  test('retryable_block: validation hook returns retryable_block → retryable error', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'validation' }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'retryable_block',
      reason: 'CI pending',
      retryAfterMs: 5000,
    });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('retryable_block');
    expect(outcome.userState.status).toBe('waiting_on_hook_retry');
    expect(outcome.userState.reason).toBe('CI pending');
    expect(outcome.userState.retryAfterMs).toBe(5000);
  });

  test('block takes precedence over retryable_block', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'validation', order: 1 }),
      makeHook({ id: 'hook-2', classification: 'validation', order: 0 }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'block', reason: 'Hard block' });
    mockExecutor.setResult('hook-2', {
      type: 'retryable_block',
      reason: 'Soft block',
      retryAfterMs: 1000,
    });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('block');
    expect(outcome.userState.status).toBe('blocked_by_hook');
    expect(outcome.userState.reason).toBe('Hard block');
  });

  test('patch_params: single hook patches params', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'validation' }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'patch_params',
      patch: { target: 'Review', extra: true },
    });

    const params = { target: 'Review', message: 'hi' };
    const outcome = await engine.executeAction('send_message', params, defaultMeta);

    expect(outcome.decision).toBe('patch_params');
    expect(outcome.finalParams).toEqual({ target: 'Review', message: 'hi', extra: true });
    expect(outcome.userState.status).toBe('patched');
    expect(outcome.userState.patchedKeys).toContain('extra');
  });

  test('patch_params: multiple hooks apply sequentially', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'validation', order: 0 }),
      makeHook({ id: 'hook-2', classification: 'validation', order: 1 }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'patch_params', patch: { a: 1 } });
    mockExecutor.setResult('hook-2', { type: 'patch_params', patch: { b: 2 } });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.finalParams).toEqual({ target: 'Review', message: 'hi', a: 1, b: 2 });
  });

  test('validation hooks run before side-effect hooks', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-side', classification: 'side_effect', order: 0 }),
      makeHook({ id: 'hook-val', classification: 'validation', order: 1 }),
    ]);
    mockExecutor.setResult('hook-val', { type: 'allow' });
    mockExecutor.setResult('hook-side', { type: 'allow' });

    const outcome = await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    expect(outcome.executionLog[0].hookId).toBe('hook-val');
    expect(outcome.executionLog[1].hookId).toBe('hook-side');
  });

  test('validation block skips all later side effects', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-val', classification: 'validation', order: 0 }),
      makeHook({ id: 'hook-side', classification: 'side_effect', order: 1 }),
    ]);
    mockExecutor.setResult('hook-val', { type: 'block', reason: 'Stop' });
    mockExecutor.setResult('hook-side', { type: 'patch_params', patch: { should: 'not_apply' } });

    const outcome = await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    expect(outcome.decision).toBe('block');
    expect(outcome.executionLog).toHaveLength(1);
    expect(Object.keys(outcome.finalParams)).not.toContain('should');
  });

  test('side_effect block is recorded but does not stop action', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'side_effect' }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'block', reason: 'Side effect failed' });

    const outcome = await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    expect(outcome.decision).toBe('allow');
    expect(outcome.executionLog[0].result.type).toBe('block');
    expect(outcome.userState.status).toBe('allowed');
  });

  test('emit_follow_up: records follow-up request', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'side_effect' }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'emit_follow_up',
      targetNode: 'Review',
      message: 'Please review this',
    });

    const outcome = await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    expect(outcome.decision).toBe('emit_follow_up');
    expect(outcome.followUpRequests).toEqual([
      { targetNode: 'Review', message: 'Please review this' },
    ]);
    expect(outcome.userState.status).toBe('follow_up_emitted');
    expect(outcome.userState.emittedActionIds).toContain('Review');
  });

  test('record_state: records state update', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'side_effect' }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'record_state', state: { count: 1 } });

    const outcome = await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    expect(outcome.decision).toBe('record_state');
    expect(outcome.stateUpdates).toHaveLength(1);
    expect(outcome.stateUpdates[0].hookId).toBe('hook-1');
    expect(outcome.stateUpdates[0].state).toEqual({ count: 1 });
    expect(outcome.userState.status).toBe('state_recorded');
  });

  test('side_effect patch_params is ignored', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'side_effect' }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'patch_params',
      patch: { extra: 'value' },
    });

    const outcome = await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    expect(outcome.decision).toBe('allow');
    expect(outcome.finalParams).toEqual({ target: 'Review' });
  });

  test('hook matching respects method, sourceNode, and agentSlots', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({
        id: 'hook-1',
        method: 'send_message',
        sourceNode: 'Coding',
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      }),
      makeHook({
        id: 'hook-2',
        method: 'save_artifact',
        sourceNode: 'Coding',
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      }),
      makeHook({
        id: 'hook-3',
        method: 'send_message',
        sourceNode: 'Coding',
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['reviewer'] }],
      }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'block', reason: 'Blocked' });
    mockExecutor.setResult('hook-2', { type: 'block', reason: 'Wrong method' });
    mockExecutor.setResult('hook-3', { type: 'block', reason: 'Wrong slot' });

    const outcome = await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('hook-1');
  });

  test('disabled hooks are not executed', async () => {
    const { engine, mockExecutor } = makeEngine([makeHook({ id: 'hook-1', enabled: false })]);
    mockExecutor.setResult('hook-1', { type: 'block', reason: 'Should not run' });

    const outcome = await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    expect(outcome.decision).toBe('allow');
    expect(outcome.executionLog).toHaveLength(0);
  });

  test('deterministic ordering by classification, order, id', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-c', classification: 'side_effect', order: 0 }),
      makeHook({ id: 'hook-a', classification: 'validation', order: 1 }),
      makeHook({ id: 'hook-b', classification: 'validation', order: 0 }),
    ]);
    mockExecutor.setResult('hook-a', { type: 'allow' });
    mockExecutor.setResult('hook-b', { type: 'allow' });
    mockExecutor.setResult('hook-c', { type: 'allow' });

    const outcome = await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    const ids = outcome.executionLog.map((e) => e.hookId);
    expect(ids).toEqual(['hook-b', 'hook-a', 'hook-c']);
  });

  test('hook-local state is loaded into context', async () => {
    const hookStateRepo = makeMockHookStateRepo();
    const mockExecutor = new MockHookExecutor();

    hookStateRepo.ensure('run-1', 'hook-1', { counter: 5 });

    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([makeHook({ id: 'hook-1', classification: 'side_effect' })]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });

    let capturedContext: unknown;
    mockExecutor.execute = async (hook, context) => {
      capturedContext = context;
      return { result: { type: 'allow' } };
    };

    await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    expect(
      (capturedContext as { hookLocalState: Record<string, unknown> }).hookLocalState.counter
    ).toBe(5);
  });

  test('recentResultRef injects referenced hook result into local state', async () => {
    const hookStateRepo = makeMockHookStateRepo();
    const mockExecutor = new MockHookExecutor();

    hookStateRepo.ensure('run-1', 'ref-hook');
    hookStateRepo.update('run-1', 'ref-hook', {
      expectedVersion: 0,
      lastResult: { type: 'block', reason: 'Prior block' },
    });

    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([
        makeHook({
          id: 'hook-1',
          classification: 'side_effect',
          localState: {
            defaults: { foo: 'bar' },
            recentResultRef: { hookId: 'ref-hook', key: 'priorResult' },
          },
        }),
      ]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });

    let capturedContext: unknown;
    mockExecutor.execute = async (hook, context) => {
      capturedContext = context;
      return { result: { type: 'allow' } };
    };

    await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    const localState = (capturedContext as { hookLocalState: Record<string, unknown> })
      .hookLocalState;
    expect(localState.foo).toBe('bar');
    expect((localState.priorResult as WorkflowHookResult).type).toBe('block');
  });

  test('send_message target patch is ignored', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'validation' }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'patch_params',
      patch: { target: 'Deploy', extra: true },
    });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('patch_params');
    expect(outcome.finalParams).toEqual({ target: 'Review', message: 'hi', extra: true });
  });

  test('@worker address target is parsed to node name for hook matching', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', targetNode: 'Review', method: 'send_message' }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '@worker:run-1/Review/reviewer' },
      defaultMeta
    );

    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('hook-1');
  });

  test('@worker address with encoded node segment is decoded for hook matching', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', targetNode: 'Review/QA', method: 'send_message' }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '@worker:run-1/Review%2FQA/reviewer' },
      defaultMeta
    );

    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('hook-1');
  });

  test('@worker address with node ID segment resolves to node name for hook matching', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', targetNode: 'Review', method: 'send_message' }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '@worker:run-1/node-review/reviewer' },
      defaultMeta
    );

    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('hook-1');
  });

  test('@role:actor-role:<nodeId> target is decoded and resolved for hook matching', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', targetNode: 'Review', method: 'send_message' }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '@role:actor-role:node-review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('hook-1');
  });

  test('@role:actor-role:<slotName> target is decoded and resolved for hook matching', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', targetNode: 'Review', method: 'send_message' }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '@role:actor-role:reviewer', message: 'hi' },
      defaultMeta
    );

    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('hook-1');
  });

  test('@role:actor-role with URI-encoded node name is decoded for hook matching', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', targetNode: 'Review/QA', method: 'send_message' }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '@role:actor-role:Review%2FQA', message: 'hi' },
      defaultMeta
    );

    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('hook-1');
  });

  test('@role:Review skips target-specific hook matching', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', targetNode: 'Review', method: 'send_message' }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'block',
      reason: 'would record state for generic role target',
      data: { approvals: { architecture: 'approved' } },
    });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '@role:Review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.executionLog).toHaveLength(0);
    expect(outcome.decision).toBe('allow');
  });

  test('broadcast * resolves agent slot names to node names for hook matching', async () => {
    const workflow = makeWorkflow([
      makeHook({ id: 'hook-1', targetNode: 'Review', method: 'send_message' }),
    ]);
    workflow.channels = [{ id: 'ch-1', from: 'Coding', to: 'reviewer' }];

    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });
    mockExecutor.setResult('hook-1', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '*', message: 'hi' },
      defaultMeta
    );

    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('hook-1');
  });

  test('broadcast * resolves when channel from uses agent slot name', async () => {
    const workflow = makeWorkflow([
      makeHook({ id: 'hook-1', targetNode: 'Review', method: 'send_message' }),
    ]);
    workflow.channels = [{ id: 'ch-1', from: 'coder', to: 'Review' }];

    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });
    mockExecutor.setResult('hook-1', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '*', message: 'hi' },
      defaultMeta
    );

    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('hook-1');
  });

  test('mixed invalid multicast target skips target-specific hooks', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', targetNode: 'Review', method: 'send_message' }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'block',
      reason: 'would record state for undelivered multicast',
      data: { approvals: { architecture: 'approved' } },
    });

    const outcome = await engine.executeAction(
      'send_message',
      { target: ['Review', 'Task Disptcher'], message: 'hi' },
      defaultMeta
    );

    expect(outcome.executionLog).toHaveLength(0);
    expect(outcome.decision).toBe('allow');
  });

  test('space-agent multicast keeps workflow target hooks active', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', targetNode: 'Review', method: 'send_message' }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: ['Review', 'space-agent'], message: 'hi' },
      defaultMeta
    );

    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('hook-1');
  });

  test('invalid generic worker target skips target-specific hooks', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', targetNode: 'Review', method: 'send_message' }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'block',
      reason: 'would record state for undelivered worker target',
      data: { approvals: { architecture: 'approved' } },
    });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '@worker:other-run/node-review/reviewer', message: 'hi' },
      defaultMeta
    );

    expect(outcome.executionLog).toHaveLength(0);
    expect(outcome.decision).toBe('allow');
  });

  test('runless worker target is treated as current-run target for hooks', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', targetNode: 'Review', method: 'send_message' }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '@worker:node-review/reviewer', message: 'hi' },
      defaultMeta
    );

    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('hook-1');
  });

  test('bare target prefers exact node name over slot alias', async () => {
    const workflow = makeWorkflow([
      makeHook({ id: 'hook-1', targetNode: 'Review', method: 'send_message' }),
    ]);
    workflow.nodes = [
      {
        id: 'node-coding',
        name: 'Coding',
        agents: [{ name: 'coder', agentId: 'agent-coder' }],
      },
      {
        id: 'node-review',
        name: 'Review',
        agents: [{ name: 'reviewer', agentId: 'agent-reviewer' }],
      },
      {
        id: 'node-deploy',
        name: 'Deploy',
        agents: [{ name: 'Review', agentId: 'agent-review' }],
      },
    ];

    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });
    mockExecutor.setResult('hook-1', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('hook-1');
  });

  test('small data payloads are preserved in hook context', async () => {
    const hookStateRepo = makeMockHookStateRepo();
    const mockExecutor = new MockHookExecutor();

    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([makeHook({ id: 'hook-1', classification: 'side_effect' })]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });

    let capturedContext: unknown;
    mockExecutor.execute = async (hook, context) => {
      capturedContext = context;
      return { result: { type: 'allow' } };
    };

    await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi', data: { review_url: 'https://example.com/pr/1' } },
      defaultMeta
    );

    const params = (capturedContext as { params: Record<string, unknown> }).params;
    expect(params.data).toEqual({ review_url: 'https://example.com/pr/1' });
  });

  test('large data payloads are redacted in hook context', async () => {
    const hookStateRepo = makeMockHookStateRepo();
    const mockExecutor = new MockHookExecutor();

    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([makeHook({ id: 'hook-1', classification: 'side_effect' })]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });

    let capturedContext: unknown;
    mockExecutor.execute = async (hook, context) => {
      capturedContext = context;
      return { result: { type: 'allow' } };
    };

    const bigData = { summary: 'x'.repeat(10_000) };
    await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi', data: bigData },
      defaultMeta
    );

    const params = (capturedContext as { params: Record<string, unknown> }).params;
    expect(params.data).toContain('truncated');
  });

  test('large arrays in params are capped', async () => {
    const hookStateRepo = makeMockHookStateRepo();
    const mockExecutor = new MockHookExecutor();

    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([makeHook({ id: 'hook-1', classification: 'side_effect' })]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });

    let capturedContext: unknown;
    mockExecutor.execute = async (hook, context) => {
      capturedContext = context;
      return { result: { type: 'allow' } };
    };

    const bigArray = Array.from({ length: 150 }, (_, i) => `item-${i}`);
    await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi', items: bigArray },
      defaultMeta
    );

    const params = (capturedContext as { params: Record<string, unknown> }).params;
    expect(Array.isArray(params.items)).toBe(true);
    expect((params.items as unknown[]).length).toBe(101);
    expect((params.items as unknown[])[100]).toBe('[truncated: array exceeds 100 items]');
  });

  test('large objects in params are capped', async () => {
    const hookStateRepo = makeMockHookStateRepo();
    const mockExecutor = new MockHookExecutor();

    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([makeHook({ id: 'hook-1', classification: 'side_effect' })]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });

    let capturedContext: unknown;
    mockExecutor.execute = async (hook, context) => {
      capturedContext = context;
      return { result: { type: 'allow' } };
    };

    const bigObject: Record<string, string> = {};
    for (let i = 0; i < 60; i++) {
      bigObject[`key-${i}`] = `value-${i}`;
    }
    await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi', payload: bigObject },
      defaultMeta
    );

    const params = (capturedContext as { params: Record<string, unknown> }).params;
    const payload = params.payload as Record<string, unknown>;
    expect(Object.keys(payload).length).toBe(51);
    expect(payload._truncated).toBe('object exceeds 50 keys');
  });

  test('oversized total params are replaced with placeholder', async () => {
    const hookStateRepo = makeMockHookStateRepo();
    const mockExecutor = new MockHookExecutor();

    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([makeHook({ id: 'hook-1', classification: 'side_effect' })]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });

    let capturedContext: unknown;
    mockExecutor.execute = async (hook, context) => {
      capturedContext = context;
      return { result: { type: 'allow' } };
    };

    const hugeArray = Array.from({ length: 100 }, () => 'x'.repeat(400));
    await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi', huge: hugeArray },
      defaultMeta
    );

    const params = (capturedContext as { params: Record<string, unknown> }).params;
    expect(params._truncated).toContain('exceed');
  });

  test('retryCount is reset after a non-retryable hook result', async () => {
    const hookStateRepo = makeMockHookStateRepo();
    const mockExecutor = new MockHookExecutor();

    hookStateRepo.ensure('run-1', 'hook-1');
    hookStateRepo.update('run-1', 'hook-1', {
      expectedVersion: 0,
      retryCount: 2,
      nextRetryAt: Date.now() - 1,
    });

    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([
        makeHook({
          id: 'hook-1',
          classification: 'validation',
          retry: { maxAttempts: 3, delayMs: 1000 },
        }),
      ]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });

    mockExecutor.setResult('hook-1', { type: 'allow' });

    const outcome = await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    expect(outcome.decision).toBe('allow');
    const state = hookStateRepo.get('run-1', 'hook-1');
    expect(state?.retryCount).toBe(0);
    expect(state?.nextRetryAt).toBeUndefined();
  });

  test('retryable_block retries state update on version conflict', async () => {
    let failCount = 0;
    const hookStateRepo = makeMockHookStateRepo();
    const originalUpdate = hookStateRepo.update;
    hookStateRepo.update = (
      runId: string,
      hookId: string,
      patch: {
        expectedVersion: number;
        localState?: Record<string, unknown>;
        lastResult?: WorkflowHookResult;
        retryCount?: number;
        nextRetryAt?: number | null;
      }
    ) => {
      if (failCount < 2) {
        failCount++;
        return null;
      }
      return originalUpdate(runId, hookId, patch);
    };

    const mockExecutor = new MockHookExecutor();
    hookStateRepo.ensure('run-1', 'hook-1');

    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([
        makeHook({
          id: 'hook-1',
          classification: 'validation',
          retry: { maxAttempts: 3, delayMs: 1000 },
        }),
      ]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });

    mockExecutor.setResult('hook-1', { type: 'retryable_block', reason: 'Retry me' });

    const outcome = await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    expect(outcome.decision).toBe('retryable_block');
    const state = hookStateRepo.get('run-1', 'hook-1');
    expect(state?.retryCount).toBe(1);
    expect(failCount).toBe(2);
  });

  test('node id target is resolved to node name for hook matching', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', targetNode: 'Review', method: 'send_message' }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'node-review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('hook-1');
  });

  test('multiple emit_follow_up requests are collected', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'side_effect', order: 1 }),
      makeHook({ id: 'hook-2', classification: 'side_effect', order: 2 }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'emit_follow_up',
      targetNode: 'Review',
      message: 'msg1',
    });
    mockExecutor.setResult('hook-2', {
      type: 'emit_follow_up',
      targetNode: 'Deploy',
      message: 'msg2',
    });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('emit_follow_up');
    expect(outcome.followUpRequests).toHaveLength(2);
    expect(outcome.followUpRequests[0]).toEqual({ targetNode: 'Review', message: 'msg1' });
    expect(outcome.followUpRequests[1]).toEqual({ targetNode: 'Deploy', message: 'msg2' });
    expect(outcome.userState.emittedActionIds).toEqual(['Review', 'Deploy']);
  });

  test('retryable_block honors maxAttempts and converts to hard block', async () => {
    const hookStateRepo = makeMockHookStateRepo();
    const mockExecutor = new MockHookExecutor();

    hookStateRepo.ensure('run-1', 'hook-1');
    hookStateRepo.update('run-1', 'hook-1', {
      expectedVersion: 0,
      retryCount: 2,
    });

    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([
        makeHook({
          id: 'hook-1',
          classification: 'validation',
          retry: { maxAttempts: 2, delayMs: 1000 },
        }),
      ]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });

    mockExecutor.setResult('hook-1', { type: 'retryable_block', reason: 'Retry me' });

    const outcome = await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    expect(outcome.decision).toBe('block');
    expect(outcome.userState.status).toBe('blocked_by_hook');
  });

  test('retryable_block does not consume attempts before delay elapsed', async () => {
    const hookStateRepo = makeMockHookStateRepo();
    const mockExecutor = new MockHookExecutor();

    hookStateRepo.ensure('run-1', 'hook-1');
    hookStateRepo.update('run-1', 'hook-1', {
      expectedVersion: 0,
      retryCount: 1,
      nextRetryAt: Date.now() + 100_000,
    });

    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([
        makeHook({
          id: 'hook-1',
          classification: 'validation',
          retry: { maxAttempts: 3, delayMs: 1000 },
        }),
      ]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });

    mockExecutor.setResult('hook-1', { type: 'retryable_block', reason: 'Wait' });

    const outcome = await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    expect(outcome.decision).toBe('retryable_block');
    const state = hookStateRepo.get('run-1', 'hook-1');
    expect(state?.retryCount).toBe(1);
  });

  test('large artifact data is bounded before injection', async () => {
    const hookStateRepo = makeMockHookStateRepo();
    const mockExecutor = new MockHookExecutor();
    const artifactRepo = {
      listByRun: () => [
        {
          id: 'a1',
          runId: 'run-1',
          nodeId: 'node-coding',
          artifactType: 'progress',
          artifactKey: 'current',
          data: { summary: 'x'.repeat(20_000) },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    } as unknown as WorkflowRunArtifactRepository;

    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([makeHook({ id: 'hook-1', classification: 'side_effect' })]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo,
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });

    let capturedContext: unknown;
    mockExecutor.execute = async (hook, context) => {
      capturedContext = context;
      return { result: { type: 'allow' } };
    };

    await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    const artifacts = (capturedContext as { currentArtifacts: Array<{ data: unknown }> })
      .currentArtifacts;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].data).toContain('truncated');
  });

  test('artifacts array is capped by total serialized byte budget', async () => {
    const hookStateRepo = makeMockHookStateRepo();
    const mockExecutor = new MockHookExecutor();

    const bigArtifacts = Array.from({ length: 10 }, (_, i) => ({
      id: `a${i}`,
      runId: 'run-1',
      nodeId: 'node-coding',
      artifactType: 'progress',
      artifactKey: `key-${i}`,
      data: { payload: 'x'.repeat(8_000) },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    const artifactRepo = {
      listByRun: () => bigArtifacts,
    } as unknown as WorkflowRunArtifactRepository;

    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([makeHook({ id: 'hook-1', classification: 'side_effect' })]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo,
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });

    let capturedContext: unknown;
    mockExecutor.execute = async (hook, context) => {
      capturedContext = context;
      return { result: { type: 'allow' } };
    };

    await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    const artifacts = (capturedContext as { currentArtifacts: unknown[] }).currentArtifacts;
    expect(artifacts.length).toBeLessThan(10);
    expect(artifacts.length).toBeGreaterThanOrEqual(1);
  });

  test('patch_params that violate method schema block the action', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'validation', method: 'send_message' }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'patch_params', patch: { message: 123 } });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('block');
    expect(outcome.userState.reason).toContain('Patched params invalid');
  });

  test('retryable send_message persists queued action and rehydrates after restart', async () => {
    const args = { target: 'Review', message: 'hi' };
    const actionKey = JSON.stringify({
      runScopedTaskId: defaultMeta.taskId,
      nodeId: defaultMeta.nodeId,
      sessionId: defaultMeta.sessionId,
      agentName: defaultMeta.agentName,
      methodName: 'send_message',
      args,
    });
    const hookStateRepo = makeMockHookStateRepo();

    let replayCallCount = 0;
    const { engine, mockExecutor } = makeEngine(
      [makeHook({ id: 'hook-1', classification: 'validation', order: 0 })],
      { hookStateRepo }
    );
    hookStateRepo.ensure('run-1', 'hook-1');
    engine.persistQueuedRetryableAction({
      actionKey,
      hookId: 'hook-1',
      methodName: 'send_message',
      args,
      meta: defaultMeta,
      isFollowUp: false,
      nextRetryAt: Date.now() - 1,
      retryAfterMs: 5,
      queuedAt: Date.now() - 10,
    });
    mockExecutor.setResult('hook-1', { type: 'allow' });
    engine.scheduleQueuedRetryableActions(
      {
        send_message: async (replayedArgs: Record<string, unknown>) => {
          replayCallCount++;
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ success: true, target: replayedArgs.target }),
              },
            ],
          };
        },
      },
      defaultMeta
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(replayCallCount).toBe(1);
    expect(
      hookStateRepo.get('run-1', 'hook-1')?.localState[QUEUED_RETRYABLE_ACTION_STATE_KEY]
    ).toBeNull();
  });

  test.each([
    ['task is done', { getTaskStatus: () => 'done' }, false],
    [
      'source node execution is cancelled',
      { getSourceNodeExecutionStatus: () => 'cancelled' },
      false,
    ],
    ['source node execution is idle', { getSourceNodeExecutionStatus: () => 'idle' }, true],
  ] as const)('queued retry replay expectation when %s', async (_name, options, shouldReplay) => {
    const args = { target: 'Review', message: 'hi' };
    const actionKey = JSON.stringify({
      runScopedTaskId: defaultMeta.taskId,
      nodeId: defaultMeta.nodeId,
      sessionId: defaultMeta.sessionId,
      agentName: defaultMeta.agentName,
      methodName: 'send_message',
      args,
    });
    const hookStateRepo = makeMockHookStateRepo();
    const { engine } = makeEngine(
      [makeHook({ id: 'hook-1', classification: 'validation', order: 0 })],
      { hookStateRepo, ...options }
    );
    hookStateRepo.ensure('run-1', 'hook-1');
    engine.persistQueuedRetryableAction({
      actionKey,
      hookId: 'hook-1',
      methodName: 'send_message',
      args,
      meta: defaultMeta,
      isFollowUp: false,
      nextRetryAt: Date.now() - 1,
      retryAfterMs: 5,
      queuedAt: Date.now() - 10,
    });

    let handlerCallCount = 0;
    engine.scheduleQueuedRetryableActions(
      {
        send_message: async () => {
          handlerCallCount++;
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
          };
        },
      },
      defaultMeta
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(handlerCallCount).toBe(shouldReplay ? 1 : 0);
    expect(
      hookStateRepo.get('run-1', 'hook-1')?.localState[QUEUED_RETRYABLE_ACTION_STATE_KEY]
    ).toBeNull();
  });
});

describe('wrapHandlerWithHooks', () => {
  test('allows action when engine returns allow', async () => {
    const { engine } = makeEngine([]);
    const handler = async (args: { target: string }) => ({
      content: [
        { type: 'text' as const, text: JSON.stringify({ success: true, target: args.target }) },
      ],
    });

    const wrapped = wrapHandlerWithHooks('send_message', handler, engine, {}, defaultMeta);
    const result = await wrapped({ target: 'Review' });

    expect(JSON.parse(result.content[0].text).success).toBe(true);
    expect(JSON.parse(result.content[0].text).target).toBe('Review');
  });

  test('blocks action when engine returns block', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'validation' }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'block', reason: 'No go' });

    const handler = async (args: { target: string }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
    });

    const wrapped = wrapHandlerWithHooks('send_message', handler, engine, {}, defaultMeta);
    const result = await wrapped({ target: 'Review' });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(false);
    expect(data.error).toBe('No go');
    expect(data.hookStatus).toBe('blocked_by_hook');
  });

  test('patches params and re-enters handler', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'validation' }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'patch_params', patch: { extra: 'data' } });

    const handler = async (args: { target: string; message: string; extra?: string }) => ({
      content: [
        { type: 'text' as const, text: JSON.stringify({ success: true, extra: args.extra }) },
      ],
    });

    const wrapped = wrapHandlerWithHooks('send_message', handler, engine, {}, defaultMeta);
    const result = await wrapped({ target: 'Review', message: 'hi' });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.extra).toBe('data');
  });

  test('persists PR URL from an allowed pr_ready send_message hook to local state', async () => {
    const hookStateRepo = makeMockHookStateRepo();
    const mockExecutor = new MockHookExecutor();

    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([
        makeHook({
          id: 'hook-1',
          classification: 'validation',
          validator: { kind: 'built_in', id: 'pr_ready' },
        }),
      ]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });

    mockExecutor.setResult('hook-1', { type: 'allow' });

    const handler = async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
    });

    const wrapped = wrapHandlerWithHooks('send_message', handler, engine, {}, defaultMeta);
    await wrapped({
      target: 'Review',
      message: 'handoff',
      data: { pr_url: 'https://github.com/acme/corp/pull/42' },
    });

    expect(hookStateRepo.get('run-1', 'hook-1')?.localState.pr_url).toBe(
      'https://github.com/acme/corp/pull/42'
    );
    expect(hookStateRepo.get('run-1', PR_READY_VALIDATED_IDENTITY_HOOK_ID)?.localState.pr_url).toBe(
      'https://github.com/acme/corp/pull/42'
    );
  });

  test('does NOT persist PR URL for a non-pr_ready hook (PR-identity spoofing guard)', async () => {
    const hookStateRepo = makeMockHookStateRepo();
    const mockExecutor = new MockHookExecutor();

    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([makeHook({ id: 'hook-1', classification: 'validation' })]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });

    mockExecutor.setResult('hook-1', { type: 'allow' });

    const handler = async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
    });

    const wrapped = wrapHandlerWithHooks('send_message', handler, engine, {}, defaultMeta);
    await wrapped({
      target: 'Review',
      message: 'handoff',
      data: { pr_url: 'https://github.com/acme/corp/pull/42' },
    });

    expect(hookStateRepo.get('run-1', 'hook-1')?.localState.pr_url).toBeUndefined();
  });

  test('rejects hook stateForHook/record_state writes to the reserved pr_ready-identity key', async () => {
    const hookStateRepo = makeMockHookStateRepo();
    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([makeHook({ id: 'hook-1', classification: 'validation' })]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });
    mockExecutor.setResult('hook-1', {
      type: 'record_state',
      stateForHook: { [PR_READY_VALIDATED_IDENTITY_HOOK_ID]: { pr_url: 'https://spoof/pull/9' } },
    });
    const handler = async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
    });
    const wrapped = wrapHandlerWithHooks('send_message', handler, engine, {}, defaultMeta);
    await wrapped({ target: 'Review', message: 'spoof', data: {} });
    expect(
      hookStateRepo.get('run-1', PR_READY_VALIDATED_IDENTITY_HOOK_ID)?.localState.pr_url
    ).toBeUndefined();
  });

  test('persists hook results to state repo', async () => {
    const hookStateRepo = makeMockHookStateRepo();
    const mockExecutor = new MockHookExecutor();

    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([
        makeHook({ id: 'hook-1', classification: 'validation' }),
        makeHook({ id: 'hook-2', classification: 'side_effect' }),
      ]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });

    mockExecutor.setResult('hook-1', { type: 'allow' });
    mockExecutor.setResult('hook-2', { type: 'record_state', state: { count: 1 } });

    const handler = async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
    });

    const wrapped = wrapHandlerWithHooks('send_message', handler, engine, {}, defaultMeta);
    await wrapped({ target: 'Review' });

    const state1 = hookStateRepo.get('run-1', 'hook-1');
    expect(state1?.lastResult?.type).toBe('allow');

    const state2 = hookStateRepo.get('run-1', 'hook-2');
    expect(state2?.lastResult?.type).toBe('record_state');
    expect(state2?.localState).toEqual({ count: 1 });
  });

  test('dispatches follow-up through handler pipeline', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'side_effect' }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'emit_follow_up',
      targetNode: 'Review',
      message: 'Check this',
    });

    const followUpHandler = async (args: { target: string; message: string }) => ({
      content: [
        { type: 'text' as const, text: JSON.stringify({ followUp: true, target: args.target }) },
      ],
    });

    const mainHandler = async (args: { target: string }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
    });

    const handlers: Record<string, (args: unknown) => Promise<ToolResult>> = {
      send_message: followUpHandler,
    };

    const wrapped = wrapHandlerWithHooks(
      'send_message',
      mainHandler,
      engine,
      handlers,
      defaultMeta
    );
    const result = await wrapped({ target: 'Review' });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
  });

  test('suppresses nested follow-up emission but still calls handler', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'side_effect' }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'emit_follow_up',
      targetNode: 'Review',
      message: 'Check this',
    });

    const mainHandler = async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
    });

    const handlers: Record<string, (args: unknown) => Promise<ToolResult>> = {
      send_message: mainHandler,
    };

    const wrapped = wrapHandlerWithHooks(
      'send_message',
      mainHandler,
      engine,
      handlers,
      defaultMeta,
      true
    );
    const result = await wrapped({ target: 'Review' });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
  });

  test('retryable send_message queues the action and dispatches after retry delay', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'validation', order: 0 }),
      makeHook({ id: 'hook-side', classification: 'side_effect', order: 1 }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'retryable_block',
      reason: 'Retry me',
      retryAfterMs: 5,
    });

    let handlerCallCount = 0;
    let followUpCallCount = 0;
    const handler = async (args: { target: string; message: string }) => {
      handlerCallCount++;
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ success: true, target: args.target }) },
        ],
      };
    };
    const followUpHandler = async () => {
      followUpCallCount++;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
      };
    };

    const wrapped = wrapHandlerWithHooks(
      'send_message',
      handler,
      engine,
      { send_message: followUpHandler },
      defaultMeta
    );
    const result = await wrapped({ target: 'Review', message: 'hi' });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.queued).toBe(true);
    expect(data.retryable).toBe(true);
    expect(data.retryAfterMs).toBe(5);
    expect(data.hookStatus).toBe('waiting_on_hook_retry');
    expect(handlerCallCount).toBe(0);

    mockExecutor.setResult('hook-1', { type: 'allow' });
    mockExecutor.setResult('hook-side', {
      type: 'emit_follow_up',
      targetNode: 'Review',
      message: 'follow-up',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(followUpCallCount).toBe(1);
    expect(handlerCallCount).toBe(1);
  });

  test('superseded queued retry timer is cancelled before replay', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'validation', order: 0 }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'retryable_block',
      reason: 'Retry me',
      retryAfterMs: 10,
    });

    const deliveredMessages: string[] = [];
    const handler = async (args: { target: string; message: string }) => {
      deliveredMessages.push(args.message);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
      };
    };

    const wrapped = wrapHandlerWithHooks('send_message', handler, engine, {}, defaultMeta);
    await wrapped({ target: 'Review', message: 'first' });
    await wrapped({ target: 'Review', message: 'second' });

    mockExecutor.setResult('hook-1', { type: 'allow' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(deliveredMessages).toEqual(['second']);
  });

  test('hard-block resend clears superseded queued retry before replay', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'validation', order: 0 }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'retryable_block',
      reason: 'Retry me',
      retryAfterMs: 20,
    });

    const deliveredMessages: string[] = [];
    const handler = async (args: { target: string; message: string }) => {
      deliveredMessages.push(args.message);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
      };
    };

    const wrapped = wrapHandlerWithHooks('send_message', handler, engine, {}, defaultMeta);
    await wrapped({ target: 'Review', message: 'queued' });

    mockExecutor.setResult('hook-1', { type: 'block', reason: 'PR is not ready' });
    const blockedResult = await wrapped({ target: 'Review', message: 'blocked resend' });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(blockedResult.isError).toBe(true);
    expect(deliveredMessages).toEqual([]);
    expect(engine.getQueuedRetryableAction('hook-1')).toBeUndefined();
  });

  test('successful resend clears superseded queued retry before replay', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'validation', order: 0 }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'retryable_block',
      reason: 'Retry me',
      retryAfterMs: 20,
    });

    const deliveredMessages: string[] = [];
    const handler = async (args: { target: string; message: string }) => {
      deliveredMessages.push(args.message);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
      };
    };

    const wrapped = wrapHandlerWithHooks('send_message', handler, engine, {}, defaultMeta);
    await wrapped({ target: 'Review', message: 'queued' });

    mockExecutor.setResult('hook-1', { type: 'allow' });
    await wrapped({ target: 'Review', message: 'manual resend' });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(deliveredMessages).toEqual(['manual resend']);
  });

  test('cleanup helper cancels queued retry timer before replay', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'validation', order: 0 }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'retryable_block',
      reason: 'Retry me',
      retryAfterMs: 10,
    });

    const deliveredMessages: string[] = [];
    const handler = async (args: { target: string; message: string }) => {
      deliveredMessages.push(args.message);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
      };
    };

    const wrapped = wrapHandlerWithHooks('send_message', handler, engine, {}, defaultMeta);
    await wrapped({ target: 'Review', message: 'queued' });
    mockExecutor.setResult('hook-1', { type: 'allow' });

    clearAllRetryableHookActionTimers();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(deliveredMessages).toEqual([]);
    expect(engine.getQueuedRetryableAction('hook-1')?.args).toEqual({
      target: 'Review',
      message: 'queued',
    });
  });

  test('queued retry hard failure is reported to source session', async () => {
    const notifications: Array<{ sessionId: string; message: string }> = [];
    const { engine, mockExecutor } = makeEngine(
      [makeHook({ id: 'hook-1', classification: 'validation', order: 0 })],
      {
        notifySourceSession: async (sessionId, message) => {
          notifications.push({ sessionId, message });
        },
      }
    );
    mockExecutor.setResult('hook-1', {
      type: 'retryable_block',
      reason: 'Retry me',
      retryAfterMs: 5,
    });

    const handler = async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
    });

    const wrapped = wrapHandlerWithHooks('send_message', handler, engine, {}, defaultMeta);
    await wrapped({ target: 'Review', message: 'hi' });

    mockExecutor.setResult('hook-1', { type: 'block', reason: 'PR is not mergeable' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      sessionId: 'session-coder',
      message: 'Queued send_message retry failed: PR is not mergeable',
    });
  });

  test('non-message retryable block returns retryable error with metadata', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', method: 'save_artifact', classification: 'validation' }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'retryable_block',
      reason: 'Retry me',
      retryAfterMs: 3000,
    });

    const handler = async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
    });

    const wrapped = wrapHandlerWithHooks('save_artifact', handler, engine, {}, defaultMeta);
    const result = await wrapped({ type: 'progress' });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(false);
    expect(data.retryable).toBe(true);
    expect(data.retryAfterMs).toBe(3000);
    expect(data.hookStatus).toBe('waiting_on_hook_retry');
  });
});

describe.skipIf(!isBun)('HookExecutor script execution', () => {
  test('malformed script output returns block', async () => {
    const executor = new HookExecutor({ workspacePath: '/tmp' });
    const hook = makeHook({
      id: 'hook-script',
      classification: 'validation',
      validator: { kind: 'script', interpreter: 'bash', source: 'echo "not json"' },
    });

    const result = await executor.execute(hook, {
      workspacePath: '/tmp',
      runId: 'run-1',
      hookId: 'hook-script',
      methodName: 'send_message',
      params: {},
      nodeId: 'node-1',
      nodeName: 'Coding',
      sessionId: 'sess-1',
      taskId: 'task-1',
      hookLocalState: {},
      currentArtifacts: [],
      permittedExternalLookups: [],
    });

    expect(result.result.type).toBe('block');
    expect(result.result.reason).toContain('non-JSON stdout');
  });

  test('script timeout returns block', async () => {
    const executor = new HookExecutor({ workspacePath: '/tmp' });
    const hook = makeHook({
      id: 'hook-script',
      classification: 'validation',
      validator: { kind: 'script', interpreter: 'bash', source: 'sleep 10', timeoutMs: 50 },
    });

    const result = await executor.execute(hook, {
      workspacePath: '/tmp',
      runId: 'run-1',
      hookId: 'hook-script',
      methodName: 'send_message',
      params: {},
      nodeId: 'node-1',
      nodeName: 'Coding',
      sessionId: 'sess-1',
      taskId: 'task-1',
      hookLocalState: {},
      currentArtifacts: [],
      permittedExternalLookups: [],
    });

    expect(result.result.type).toBe('block');
    expect(result.result.reason).toContain('timed out');
  });

  test('valid script stdout returns parsed result', async () => {
    const executor = new HookExecutor({ workspacePath: '/tmp' });
    const hook = makeHook({
      id: 'hook-script',
      classification: 'validation',
      validator: {
        kind: 'script',
        interpreter: 'bash',
        source: 'echo \'{ "type": "allow", "message": "ok" }\'',
      },
    });

    const result = await executor.execute(hook, {
      workspacePath: '/tmp',
      runId: 'run-1',
      hookId: 'hook-script',
      methodName: 'send_message',
      params: {},
      nodeId: 'node-1',
      nodeName: 'Coding',
      sessionId: 'sess-1',
      taskId: 'task-1',
      hookLocalState: {},
      currentArtifacts: [],
      permittedExternalLookups: [],
    });

    expect(result.result.type).toBe('allow');
    expect(result.result.message).toBe('ok');
  });

  test('credential-bearing config path env vars are stripped', async () => {
    process.env.KUBECONFIG = '/secret/kubeconfig';
    process.env.DOCKER_CONFIG = '/secret/docker';

    const executor = new HookExecutor({ workspacePath: '/tmp' });
    const hook = makeHook({
      id: 'hook-script',
      classification: 'validation',
      validator: {
        kind: 'script',
        interpreter: 'bash',
        source:
          'echo "{ \\"type\\": \\"allow\\", \\"message\\": \\"${KUBECONFIG:-missing}|${DOCKER_CONFIG:-missing}\\" }"',
      },
    });

    const result = await executor.execute(hook, {
      workspacePath: '/tmp',
      runId: 'run-1',
      hookId: 'hook-script',
      methodName: 'send_message',
      params: {},
      nodeId: 'node-1',
      nodeName: 'Coding',
      sessionId: 'sess-1',
      taskId: 'task-1',
      hookLocalState: {},
      currentArtifacts: [],
      permittedExternalLookups: [],
    });

    delete process.env.KUBECONFIG;
    delete process.env.DOCKER_CONFIG;

    expect(result.result.type).toBe('allow');
    expect(result.result.message).toBe('missing|missing');
  });

  test('github connector auth keys inject only when github is permitted', async () => {
    _setStartupEnvBaselineForTesting({ ...process.env, GH_TOKEN: 'gh-secret' });
    const executor = new HookExecutor({ workspacePath: '/tmp' });
    const source = 'echo "{ \\"type\\": \\"allow\\", \\"message\\": \\"${GH_TOKEN:-missing}\\" }"';

    const baseContext = {
      workspacePath: '/tmp',
      runId: 'run-1',
      hookId: 'hook-script',
      methodName: 'send_message',
      params: {},
      nodeId: 'node-1',
      nodeName: 'Coding',
      sessionId: 'sess-1',
      taskId: 'task-1',
      hookLocalState: {},
      currentArtifacts: [],
    };

    const scriptValidator = {
      kind: 'script' as const,
      interpreter: 'bash' as const,
      source,
    };

    const permitted = await executor.execute(
      makeHook({ id: 'hook-script', classification: 'validation', validator: scriptValidator }),
      { ...baseContext, permittedExternalLookups: ['github'] }
    );
    const denied = await executor.execute(
      makeHook({ id: 'hook-script', classification: 'validation', validator: scriptValidator }),
      { ...baseContext, permittedExternalLookups: [] }
    );

    _setStartupEnvBaselineForTesting(process.env);

    expect(permitted.result.message).toBe('gh-secret');
    expect(denied.result.message).toBe('missing');
  });

  test('non-TOKEN connector keys (GH_HOST/GH_CONFIG_DIR) are denied unless permitted', async () => {
    _setStartupEnvBaselineForTesting({
      ...process.env,
      GH_HOST: 'gh.enterprise.example',
      GH_CONFIG_DIR: '/nonexistent/custom-gh',
    });
    const executor = new HookExecutor({ workspacePath: '/tmp' });
    const source =
      'echo "{ \\"type\\": \\"allow\\", \\"message\\": \\"${GH_HOST:-missing}|${GH_CONFIG_DIR:-missing}\\" }"';
    const scriptValidator = {
      kind: 'script' as const,
      interpreter: 'bash' as const,
      source,
    };
    const baseContext = {
      workspacePath: '/tmp',
      runId: 'run-1',
      hookId: 'hook-script',
      methodName: 'send_message',
      params: {},
      nodeId: 'node-1',
      nodeName: 'Coding',
      sessionId: 'sess-1',
      taskId: 'task-1',
      hookLocalState: {},
      currentArtifacts: [],
    };

    const denied = await executor.execute(
      makeHook({ id: 'hook-script', classification: 'validation', validator: scriptValidator }),
      { ...baseContext, permittedExternalLookups: [] }
    );
    const permitted = await executor.execute(
      makeHook({ id: 'hook-script', classification: 'validation', validator: scriptValidator }),
      { ...baseContext, permittedExternalLookups: ['github'] }
    );

    _setStartupEnvBaselineForTesting(process.env);

    expect(denied.result.message).toBe('missing|missing');
    expect(permitted.result.message).toContain('gh.enterprise.example');
  });

  test('proxy env vars inject only when external lookups are permitted', async () => {
    _setStartupEnvBaselineForTesting({
      ...process.env,
      HTTPS_PROXY: 'http://user:secret@proxy.corp.example:8080',
    });
    const executor = new HookExecutor({ workspacePath: '/tmp' });
    const source =
      'echo "{ \\"type\\": \\"allow\\", \\"message\\": \\"${HTTPS_PROXY:-missing}\\" }"';
    const scriptValidator = {
      kind: 'script' as const,
      interpreter: 'bash' as const,
      source,
    };
    const baseContext = {
      workspacePath: '/tmp',
      runId: 'run-1',
      hookId: 'hook-script',
      methodName: 'send_message',
      params: {},
      nodeId: 'node-1',
      nodeName: 'Coding',
      sessionId: 'sess-1',
      taskId: 'task-1',
      hookLocalState: {},
      currentArtifacts: [],
    };

    const denied = await executor.execute(
      makeHook({ id: 'hook-script', classification: 'validation', validator: scriptValidator }),
      { ...baseContext, permittedExternalLookups: [] }
    );
    const permitted = await executor.execute(
      makeHook({ id: 'hook-script', classification: 'validation', validator: scriptValidator }),
      { ...baseContext, permittedExternalLookups: ['github'] }
    );

    _setStartupEnvBaselineForTesting(process.env);

    expect(denied.result.message).toBe('missing');
    expect(permitted.result.message).toBe('http://user:secret@proxy.corp.example:8080');
  });

  test('windows runtime and locale variables stay available to hook scripts', async () => {
    _setStartupEnvBaselineForTesting({
      ...process.env,
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Users\\agent\\AppData\\Local\\Temp',
      USERPROFILE: 'C:\\Users\\agent',
      AppData: 'C:\\Users\\agent\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\agent\\AppData\\Local',
      LC_ALL: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
    });
    const executor = new HookExecutor({ workspacePath: '/tmp' });
    const result = await executor.execute(
      makeHook({
        id: 'hook-script',
        classification: 'validation',
        validator: {
          kind: 'script',
          interpreter: 'bash',
          source:
            'echo "{ \\"type\\": \\"allow\\", \\"message\\": \\"${SystemRoot:-missing}|${TEMP:-missing}|${USERPROFILE:-missing}|${AppData:-missing}|${LOCALAPPDATA:-missing}|${LC_ALL:-missing}|${LC_CTYPE:-missing}\\" }"',
        },
      }),
      {
        workspacePath: '/tmp',
        runId: 'run-1',
        hookId: 'hook-script',
        methodName: 'send_message',
        params: {},
        nodeId: 'node-1',
        nodeName: 'Coding',
        sessionId: 'sess-1',
        taskId: 'task-1',
        hookLocalState: {},
        currentArtifacts: [],
        permittedExternalLookups: [],
      }
    );

    _setStartupEnvBaselineForTesting(process.env);

    expect(result.result.type).toBe('allow');
    expect(result.result.message).toBe(
      'C:\\Windows|C:\\Users\\agent\\AppData\\Local\\Temp|C:\\Users\\agent|C:\\Users\\agent\\AppData\\Roaming|C:\\Users\\agent\\AppData\\Local|en_US.UTF-8|en_US.UTF-8'
    );
  });

  test('process group is killed after successful script exit', async () => {
    const originalKill = process.kill;
    const killCalls: Array<{ pid: number; signal: string | number }> = [];
    process.kill = (pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal: signal ?? 'SIGTERM' });
      return true;
    };

    const executor = new HookExecutor({ workspacePath: '/tmp' });
    const hook = makeHook({
      id: 'hook-script',
      classification: 'validation',
      validator: {
        kind: 'script',
        interpreter: 'bash',
        source: 'echo \'{ "type": "allow" }\'',
      },
    });

    try {
      await executor.execute(hook, {
        workspacePath: '/tmp',
        runId: 'run-1',
        hookId: 'hook-script',
        methodName: 'send_message',
        params: {},
        nodeId: 'node-1',
        nodeName: 'Coding',
        sessionId: 'sess-1',
        taskId: 'task-1',
        hookLocalState: {},
        currentArtifacts: [],
        permittedExternalLookups: [],
      });
    } finally {
      process.kill = originalKill;
    }

    expect(killCalls.some((c) => c.pid < 0 && c.signal === 'SIGKILL')).toBe(true);
  });
});
