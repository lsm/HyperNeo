/**
 * Unit tests for WorkflowHookEngine and wrapHandlerWithHooks.
 *
 * Covers all hook result types, chaining precedence, follow-up dispatch,
 * param patching with re-validation, local state updates, script execution
 * edge cases, and normalized user-state mapping.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  WorkflowHookEngine,
  wrapHandlerWithHooks,
  type HookActionMeta,
  type HookActionOutcome,
} from '../../../../src/lib/space/runtime/workflow-hook-engine';
import {
  HookExecutor,
  type HookExecutorContext,
} from '../../../../src/lib/space/runtime/hook-executor';
import type { WorkflowHook, WorkflowHookResult, SpaceWorkflow } from '@neokai/shared';
import type { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import type { WorkflowHookStateRepository } from '../../../../src/storage/repositories/workflow-hook-state-repository';
import type { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository';
import type { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import type { ToolResult } from '../../../../src/lib/space/tools/tool-result';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

function makeMockHookStateRepo(): WorkflowHookStateRepository {
  const states = new Map<
    string,
    {
      version: number;
      localState: Record<string, unknown>;
      lastResult?: WorkflowHookResult;
      retryCount: number;
      nextRetryAt: number | null;
    }
  >();

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

function makeMockWorkflowRunRepo(): SpaceWorkflowRunRepository {
  return {
    getRun: () =>
      ({
        id: 'run-1',
        createdAt: Date.now(),
      }) as unknown as import('@neokai/shared').SpaceWorkflowRun,
  } as unknown as SpaceWorkflowRunRepository;
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

function makeEngine(hooks: WorkflowHook[]): {
  engine: WorkflowHookEngine;
  mockExecutor: MockHookExecutor;
} {
  const mockExecutor = new MockHookExecutor();
  const engine = new WorkflowHookEngine({
    workflow: makeWorkflow(hooks),
    workflowRunId: 'run-1',
    nodeExecutionRepo: makeMockNodeExecutionRepo(),
    workflowRunRepo: makeMockWorkflowRunRepo(),
    artifactRepo: makeMockArtifactRepo(),
    hookStateRepo: makeMockHookStateRepo(),
    hookExecutor: mockExecutor,
    workspacePath: '/tmp',
  });
  return { engine, mockExecutor };
}

const defaultMeta: HookActionMeta = {
  sessionId: 'session-coder',
  agentName: 'coder',
  nodeId: 'node-coding',
  taskId: 'task-1',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowHookEngine', () => {
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

    // hook-2 runs first (order 0), returns retryable_block
    // hook-1 runs next (order 1), returns block
    // block takes precedence
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
      workflowRunRepo: makeMockWorkflowRunRepo(),
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
      workflowRunRepo: makeMockWorkflowRunRepo(),
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

  test('@role:Review resolves raw role to node name for hook matching', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', targetNode: 'Review', method: 'send_message' }),
    ]);
    mockExecutor.setResult('hook-1', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '@role:Review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('hook-1');
  });

  test('broadcast * resolves agent slot names to node names for hook matching', async () => {
    const workflow = makeWorkflow([
      makeHook({ id: 'hook-1', targetNode: 'Review', method: 'send_message' }),
    ]);
    // Channel uses agent slot name 'reviewer' instead of node name 'Review'
    workflow.channels = [{ id: 'ch-1', from: 'Coding', to: 'reviewer' }];

    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
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
    // Channel uses agent slot name 'coder' as source instead of node name 'Coding'
    workflow.channels = [{ id: 'ch-1', from: 'coder', to: 'Review' }];

    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
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

  test('bare target prefers exact node name over slot alias', async () => {
    // Node A is named 'Review'; Node B has an agent slot named 'Review'
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
      workflowRunRepo: makeMockWorkflowRunRepo(),
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
      workflowRunRepo: makeMockWorkflowRunRepo(),
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
      workflowRunRepo: makeMockWorkflowRunRepo(),
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
      workflowRunRepo: makeMockWorkflowRunRepo(),
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
      workflowRunRepo: makeMockWorkflowRunRepo(),
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
      workflowRunRepo: makeMockWorkflowRunRepo(),
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

    // 100 strings of 400 chars each → ~42 KB JSON, exceeding 32 KB budget
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
      workflowRunRepo: makeMockWorkflowRunRepo(),
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
        return null; // simulate version conflict
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
      workflowRunRepo: makeMockWorkflowRunRepo(),
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
      workflowRunRepo: makeMockWorkflowRunRepo(),
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
      workflowRunRepo: makeMockWorkflowRunRepo(),
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
      workflowRunRepo: makeMockWorkflowRunRepo(),
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

    // Create 10 artifacts each with ~8 KB of data → ~80 KB total, exceeding 64 KB budget
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
      workflowRunRepo: makeMockWorkflowRunRepo(),
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
    // 8 of 10 should fit under 64 KB; 9 would exceed
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

  test('slot-addressed channel with hookIds resolves when target is agent slot name', async () => {
    // Channel uses agent slot name 'reviewer' as to-address instead of node name 'Review'
    const workflow = makeWorkflow([
      makeHook({
        id: 'review-gate',
        sourceNode: 'Coding',
        method: 'send_message',
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      }),
    ]);
    workflow.channels = [{ id: 'ch-1', from: 'Coding', to: 'reviewer', hookIds: ['review-gate'] }];

    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });
    mockExecutor.setResult('review-gate', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'reviewer', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('allow');
    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('review-gate');
  });

  test('missing one of multiple declared hookIds fails closed', async () => {
    const workflow = makeWorkflow([
      makeHook({
        id: 'hook-a',
        sourceNode: 'Coding',
        method: 'send_message',
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      }),
    ]);
    workflow.channels = [
      { id: 'ch-1', from: 'Coding', to: 'Review', hookIds: ['hook-a', 'hook-b'] },
    ];

    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });
    mockExecutor.setResult('hook-a', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('block');
    expect(outcome.userState.status).toBe('blocked_by_hook');
    expect(outcome.userState.reason).toContain('not all declared hooks resolve');
  });

  test('mixed gateId and hookIds channel fails closed before hooks run', async () => {
    const workflow = makeWorkflow([
      makeHook({
        id: 'review-gate',
        sourceNode: 'Coding',
        method: 'send_message',
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      }),
    ]);
    workflow.channels = [
      { id: 'ch-1', from: 'Coding', to: 'Review', gateId: 'legacy-gate', hookIds: ['review-gate'] },
    ];

    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });
    mockExecutor.setResult('review-gate', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('block');
    expect(outcome.userState.status).toBe('blocked_by_hook');
    expect(outcome.userState.reason).toContain('mixed configuration');
    expect(outcome.executionLog).toHaveLength(0);
  });

  test('empty hooks array with hook-managed channel fails closed', async () => {
    const workflow = makeWorkflow([]);
    workflow.hooks = [];
    workflow.channels = [{ id: 'ch-1', from: 'Coding', to: 'Review', hookIds: ['missing-hook'] }];

    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: new MockHookExecutor(),
      workspacePath: '/tmp',
    });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('block');
    expect(outcome.userState.status).toBe('blocked_by_hook');
    expect(outcome.userState.reason).toContain('not all declared hooks resolve');
  });

  test('@worker address with agent slot matches slot-addressed channel', async () => {
    const workflow = makeWorkflow([
      makeHook({
        id: 'review-gate',
        sourceNode: 'Coding',
        method: 'send_message',
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      }),
    ]);
    workflow.channels = [{ id: 'ch-1', from: 'Coding', to: 'reviewer', hookIds: ['review-gate'] }];

    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });
    mockExecutor.setResult('review-gate', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '@worker:run-1/Review/reviewer', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('allow');
    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('review-gate');
  });

  test('@role address with agent slot matches slot-addressed channel', async () => {
    const workflow = makeWorkflow([
      makeHook({
        id: 'review-gate',
        sourceNode: 'Coding',
        method: 'send_message',
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      }),
    ]);
    workflow.channels = [{ id: 'ch-1', from: 'Coding', to: 'reviewer', hookIds: ['review-gate'] }];

    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });
    mockExecutor.setResult('review-gate', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '@role:reviewer', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('allow');
    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('review-gate');
  });

  test('broadcast * matches slot-addressed channels', async () => {
    const workflow = makeWorkflow([
      makeHook({
        id: 'review-gate',
        sourceNode: 'Coding',
        method: 'send_message',
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      }),
    ]);
    // Channel uses agent slot name 'reviewer' and wildcard permits all
    workflow.channels = [{ id: 'ch-1', from: 'Coding', to: 'reviewer', hookIds: ['review-gate'] }];

    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });
    mockExecutor.setResult('review-gate', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '*', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('allow');
    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('review-gate');
  });

  test('first-match channel semantics: specific channel governs over later wildcard', async () => {
    const workflow = makeWorkflow([
      makeHook({
        id: 'specific-gate',
        sourceNode: 'Coding',
        method: 'send_message',
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      }),
      makeHook({
        id: 'wildcard-gate',
        sourceNode: 'Coding',
        method: 'send_message',
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      }),
    ]);
    // Specific channel first, then wildcard — router would use the specific one
    workflow.channels = [
      { id: 'ch-1', from: 'Coding', to: 'Review', hookIds: ['specific-gate'] },
      { id: 'ch-2', from: 'Coding', to: '*', hookIds: ['wildcard-gate'] },
    ];

    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });
    mockExecutor.setResult('specific-gate', { type: 'allow' });
    // wildcard-gate is NOT set — if first-match fails, it would block

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi' },
      defaultMeta
    );

    // Only specific-gate should run because the specific channel matches first
    expect(outcome.decision).toBe('allow');
    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('specific-gate');
  });

  test('first-match channel with no hookIds allows action without channel-bound hooks', async () => {
    const workflow = makeWorkflow([
      makeHook({
        id: 'workflow-hook',
        sourceNode: 'Coding',
        method: 'send_message',
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      }),
    ]);
    // Open channel first, then wildcard hook-managed — router uses the open one
    workflow.channels = [
      { id: 'ch-1', from: 'Coding', to: 'Review' },
      { id: 'ch-2', from: 'Coding', to: '*', hookIds: ['wildcard-gate'] },
    ];

    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });
    mockExecutor.setResult('workflow-hook', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi' },
      defaultMeta
    );

    // workflow-hook runs because it's not channel-bound and matches on its own
    // criteria. The wildcard channel's hookIds are ignored because the first
    // matching channel (ch-1) has no hookIds.
    expect(outcome.decision).toBe('allow');
    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('workflow-hook');
  });

  test('@worker address first-matches slot-addressed channel', async () => {
    const workflow = makeWorkflow([
      makeHook({
        id: 'review-gate',
        sourceNode: 'Coding',
        method: 'send_message',
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      }),
    ]);
    workflow.channels = [{ id: 'ch-1', from: 'Coding', to: 'reviewer', hookIds: ['review-gate'] }];

    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });
    mockExecutor.setResult('review-gate', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '@worker:run-1/Review/reviewer', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('allow');
    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('review-gate');
  });

  test('side_effect channel-bound hook fails closed', async () => {
    const workflow = makeWorkflow([
      makeHook({
        id: 'side-hook',
        sourceNode: 'Coding',
        method: 'send_message',
        classification: 'side_effect',
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      }),
    ]);
    workflow.channels = [{ id: 'ch-1', from: 'Coding', to: 'Review', hookIds: ['side-hook'] }];

    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });
    mockExecutor.setResult('side-hook', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('block');
    expect(outcome.userState.status).toBe('blocked_by_hook');
    expect(outcome.userState.reason).toContain('not all declared hooks resolve');
  });

  test('PR_URL env var injected alongside NEOKAI_PR_URL', async () => {
    const hookStateRepo = makeMockHookStateRepo();
    const mockExecutor = new MockHookExecutor();

    const engine = new WorkflowHookEngine({
      workflow: makeWorkflow([makeHook({ id: 'hook-1', classification: 'side_effect' })]),
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo,
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
      prUrl: 'https://github.com/lsm/neokai/pull/42',
    });

    let capturedContext: unknown;
    mockExecutor.execute = async (hook, context) => {
      capturedContext = context;
      return { result: { type: 'allow' } };
    };

    await engine.executeAction('send_message', { target: 'Review' }, defaultMeta);

    const ctx = capturedContext as { prUrl?: string };
    expect(ctx.prUrl).toBe('https://github.com/lsm/neokai/pull/42');
  });

  test('node-id target first-matches channel by resolved node name', async () => {
    const workflow = makeWorkflow([
      makeHook({
        id: 'review-gate',
        sourceNode: 'Coding',
        method: 'send_message',
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      }),
    ]);
    workflow.channels = [{ id: 'ch-1', from: 'Coding', to: 'Review', hookIds: ['review-gate'] }];

    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });
    mockExecutor.setResult('review-gate', { type: 'allow' });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'node-review', message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('allow');
    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('review-gate');
  });

  test('array target uses first-match per element', async () => {
    const workflow = makeWorkflow([
      makeHook({
        id: 'specific-gate',
        sourceNode: 'Coding',
        method: 'send_message',
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      }),
      makeHook({
        id: 'wildcard-gate',
        sourceNode: 'Coding',
        method: 'send_message',
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      }),
    ]);
    workflow.channels = [
      { id: 'ch-1', from: 'Coding', to: 'Review', hookIds: ['specific-gate'] },
      { id: 'ch-2', from: 'Coding', to: '*', hookIds: ['wildcard-gate'] },
    ];

    const mockExecutor = new MockHookExecutor();
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: mockExecutor,
      workspacePath: '/tmp',
    });
    mockExecutor.setResult('specific-gate', { type: 'allow' });
    // wildcard-gate not set — would block if union behavior still applied

    const outcome = await engine.executeAction(
      'send_message',
      { target: ['Review'], message: 'hi' },
      defaultMeta
    );

    expect(outcome.decision).toBe('allow');
    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('specific-gate');
  });

  test('space-agent target skips channel hook binding', async () => {
    // No hooks in workflow.hooks — channel only references a missing hook.
    const workflow = makeWorkflow([]);
    workflow.channels = [{ id: 'ch-1', from: 'Coding', to: '*', hookIds: ['missing-gate'] }];

    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: new MockHookExecutor(),
      workspacePath: '/tmp',
    });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'space-agent', message: 'escalate' },
      defaultMeta
    );

    // Channel hook binding is skipped for space-agent, so missing-gate
    // does not trigger fail-closed.
    expect(outcome.decision).toBe('allow');
    expect(outcome.executionLog).toHaveLength(0);
  });

  test('@session: reply target skips channel hook binding', async () => {
    // Wildcard hook-managed channel should not bind @session: targets.
    const workflow = makeWorkflow([]);
    workflow.channels = [{ id: 'ch-1', from: 'Coding', to: '*', hookIds: ['missing-gate'] }];

    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: new MockHookExecutor(),
      workspacePath: '/tmp',
    });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '@session:abc-123', message: 'reply to human' },
      defaultMeta
    );

    // @session: targets route outside channel topology — no channel hook binding.
    expect(outcome.decision).toBe('allow');
    expect(outcome.executionLog).toHaveLength(0);
  });

  test('send_message data is merged into gate data context', async () => {
    const capturedContexts: HookExecutorContext[] = [];
    const capturingExecutor = new (class extends HookExecutor {
      constructor() {
        super({ workspacePath: '/tmp' });
      }
      override async execute(
        hook: WorkflowHook,
        context: HookExecutorContext
      ): Promise<{ result: WorkflowHookResult }> {
        capturedContexts.push(context);
        return { result: { type: 'allow' } };
      }
    })();

    const mockGateDataRepo = {
      listByRun: () => [{ gateId: 'g1', data: { existing_field: true }, runId: 'run-1' }],
      get: () => null,
    };

    const hook: WorkflowHook = {
      id: 'test-hook',
      method: 'send_message',
      sourceNode: 'Coding',
      enabled: true,
      classification: 'validation',
      authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      validator: { kind: 'built_in', id: 'pr_open' as const },
    };

    const workflow = makeWorkflow([hook]);
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: capturingExecutor,
      workspacePath: '/tmp',
      gateDataRepo: mockGateDataRepo as any,
    });

    const outcome = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'done', data: { pr_url: 'https://github.com/pull/1' } },
      defaultMeta
    );

    expect(outcome.decision).toBe('allow');
    expect(capturedContexts).toHaveLength(1);
    const gateData = JSON.parse(capturedContexts[0].gateDataJson ?? '{}');
    // Both persisted gate data and in-flight params.data should be present
    expect(gateData.existing_field).toBe(true);
    expect(gateData.pr_url).toBe('https://github.com/pull/1');
  });

  test('generic handle target skips channel hook binding', async () => {
    // @some-agent is a generic handle — routes through SpaceDeliveryFacade,
    // not channelRouter.deliverMessage, so channel hooks must not bind.
    const workflow = makeWorkflow([]);
    workflow.channels = [{ id: 'ch-1', from: 'Coding', to: '*', hookIds: ['missing-gate'] }];

    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: new MockHookExecutor(),
      workspacePath: '/tmp',
    });

    const outcome = await engine.executeAction(
      'send_message',
      { target: '@some-agent', message: 'hello' },
      defaultMeta
    );

    // Generic handle bypasses channel topology — no channel hook binding.
    expect(outcome.decision).toBe('allow');
    expect(outcome.executionLog).toHaveLength(0);
  });

  test('@worker address with URL-encoded agent name decodes for channel matching', async () => {
    // Agent slot name contains '/' which is URL-encoded in @worker addresses.
    const hook: WorkflowHook = {
      id: 'encoded-hook',
      method: 'send_message',
      sourceNode: 'Coding',
      enabled: true,
      classification: 'validation',
      authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      validator: { kind: 'built_in', id: 'pr_open' as const },
    };

    const workflow = makeWorkflow([hook]);
    workflow.nodes = [
      { id: 'node-coding', name: 'Coding', agents: [{ name: 'coder', agentId: 'agent-coder' }] },
      {
        id: 'node-review',
        name: 'Review',
        agents: [{ name: 'reviewer/lead', agentId: 'agent-reviewer' }],
      },
    ];
    // Channel targets the decoded agent slot name
    workflow.channels = [
      { id: 'ch-encoded', from: 'Coding', to: 'reviewer/lead', hookIds: ['encoded-hook'] },
    ];

    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: new MockHookExecutor(),
      workspacePath: '/tmp',
    });

    const outcome = await engine.executeAction(
      'send_message',
      // @worker:Review/reviewer%2Flead — encoded form of reviewer/lead
      { target: '@worker:Review/reviewer%2Flead', message: 'review please' },
      defaultMeta
    );

    // URL-encoded agent name is decoded to match the channel's to: 'reviewer/lead'
    expect(outcome.decision).toBe('allow');
    expect(outcome.executionLog).toHaveLength(1);
    expect(outcome.executionLog[0].hookId).toBe('encoded-hook');
  });

  test('array targets each resolve their own channel independently', async () => {
    // Two channels with different hookIds — each array element must match
    // its own channel, not the sibling's.
    const hookReview: WorkflowHook = {
      id: 'review-hook',
      method: 'send_message',
      sourceNode: 'Coding',
      enabled: true,
      classification: 'validation',
      authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      validator: { kind: 'built_in', id: 'pr_open' as const },
    };
    const hookQa: WorkflowHook = {
      id: 'qa-hook',
      method: 'send_message',
      sourceNode: 'Coding',
      enabled: true,
      classification: 'validation',
      authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      validator: { kind: 'built_in', id: 'pr_open' as const },
    };

    const workflow = makeWorkflow([hookReview, hookQa]);
    workflow.nodes = [
      { id: 'node-coding', name: 'Coding', agents: [{ name: 'coder', agentId: 'agent-coder' }] },
      {
        id: 'node-review',
        name: 'Review',
        agents: [{ name: 'reviewer', agentId: 'agent-reviewer' }],
      },
      { id: 'node-qa', name: 'QA', agents: [{ name: 'qa', agentId: 'agent-qa' }] },
    ];
    workflow.channels = [
      { id: 'ch-coder-reviewer', from: 'Coding', to: 'Review', hookIds: ['review-hook'] },
      { id: 'ch-coder-qa', from: 'Coding', to: 'QA', hookIds: ['qa-hook'] },
    ];

    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: makeMockNodeExecutionRepo(),
      workflowRunRepo: makeMockWorkflowRunRepo(),
      artifactRepo: makeMockArtifactRepo(),
      hookStateRepo: makeMockHookStateRepo(),
      hookExecutor: new MockHookExecutor(),
      workspacePath: '/tmp',
    });

    const outcome = await engine.executeAction(
      'send_message',
      // Node-id targets — each should resolve to its own node name
      { target: ['node-review', 'node-qa'], message: 'check both' },
      defaultMeta
    );

    // Both channels' hooks should be collected (not just Review's)
    expect(outcome.decision).toBe('allow');
    const hookIds = outcome.executionLog.map((r) => r.hookId).sort();
    expect(hookIds).toEqual(['qa-hook', 'review-hook']);
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
      workflowRunRepo: makeMockWorkflowRunRepo(),
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

    // Main handler should still succeed after follow-up dispatch
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

  test('retryable block returns retryable error with metadata', async () => {
    const { engine, mockExecutor } = makeEngine([
      makeHook({ id: 'hook-1', classification: 'validation' }),
    ]);
    mockExecutor.setResult('hook-1', {
      type: 'retryable_block',
      reason: 'Retry me',
      retryAfterMs: 3000,
    });

    const handler = async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
    });

    const wrapped = wrapHandlerWithHooks('send_message', handler, engine, {}, defaultMeta);
    const result = await wrapped({ target: 'Review' });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(false);
    expect(data.retryable).toBe(true);
    expect(data.retryAfterMs).toBe(3000);
    expect(data.hookStatus).toBe('waiting_on_hook_retry');
  });
});

describe('HookExecutor script execution', () => {
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
