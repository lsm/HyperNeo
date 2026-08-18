import { describe, expect, it, mock } from 'bun:test';
import { RepeatedToolErrorGuardrail } from '../../../../src/lib/agent/repeated-tool-error-guardrail';
import type { SpaceTask } from '@hyperneo/shared';

function makeGuardrail(
  overrides: Partial<ConstructorParameters<typeof RepeatedToolErrorGuardrail>[0]> = {}
) {
  const task: SpaceTask = {
    id: 'task-1',
    spaceId: 'space-1',
    taskNumber: 1,
    title: 'Test task',
    description: '',
    status: 'in_progress',
    priority: 'normal',
    labels: [],
    evolutionScopeId: 'scope-1',
  } as SpaceTask;

  const deps = {
    getTaskForSession: mock(() => task),
    emitEvidence: mock(() => ({ id: 'evidence-1' })),
    routeRecoveryMessage: mock(async () => {}),
    threshold: 2,
    errorFingerprintLength: 80,
    ...overrides,
  };

  const guardrail = new RepeatedToolErrorGuardrail(deps);
  return { guardrail, deps, task };
}

function makeAssistantMessage(toolUseId: string, toolName: string) {
  return {
    type: 'assistant' as const,
    message: {
      role: 'assistant' as const,
      content: [{ type: 'tool_use' as const, id: toolUseId, name: toolName, input: {} }],
    },
  };
}

function makeErrorResult(toolUseId: string, errorText: string) {
  return {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: toolUseId,
          is_error: true,
          content: errorText,
        },
      ],
    },
  };
}

describe('RepeatedToolErrorGuardrail', () => {
  it('does nothing for a single tool error', async () => {
    const { guardrail, deps } = makeGuardrail();

    guardrail.recordToolUse('tool-1', 'Read');
    const triggered = await guardrail.observeToolResultErrors(
      makeErrorResult('tool-1', 'file not found')
    );

    expect(triggered).toBe(false);
    expect(deps.routeRecoveryMessage).not.toHaveBeenCalled();
    expect(deps.emitEvidence).not.toHaveBeenCalled();
  });

  it('triggers an intervention after two identical tool errors', async () => {
    const { guardrail, deps } = makeGuardrail();

    guardrail.recordToolUse('tool-1', 'Read');
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
    const triggered = await guardrail.observeToolResultErrors(
      makeErrorResult('tool-1', 'file not found')
    );

    expect(triggered).toBe(true);
    expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(1);
    expect(deps.emitEvidence).toHaveBeenCalledTimes(1);
  });

  it('resets the streak when a different tool errors', async () => {
    const { guardrail, deps } = makeGuardrail();

    guardrail.recordToolUse('tool-1', 'Read');
    guardrail.recordToolUse('tool-2', 'Glob');
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
    const triggered = await guardrail.observeToolResultErrors(
      makeErrorResult('tool-2', 'file not found')
    );

    expect(triggered).toBe(false);
    expect(deps.routeRecoveryMessage).not.toHaveBeenCalled();
  });

  it('resets the streak when the error message changes', async () => {
    const { guardrail, deps } = makeGuardrail();

    guardrail.recordToolUse('tool-1', 'Read');
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'permission denied'));
    const triggered = await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'timeout'));

    expect(triggered).toBe(false);
    expect(deps.routeRecoveryMessage).not.toHaveBeenCalled();
  });

  it('resets the streak after a successful tool result', async () => {
    const { guardrail, deps } = makeGuardrail();

    guardrail.recordToolUse('tool-1', 'Read');
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
    await guardrail.observeToolResultErrors({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: false, content: 'ok' }],
      },
    } as unknown as ReturnType<typeof makeErrorResult>);
    const triggered = await guardrail.observeToolResultErrors(
      makeErrorResult('tool-1', 'file not found')
    );

    expect(triggered).toBe(false);
    expect(deps.routeRecoveryMessage).not.toHaveBeenCalled();
  });

  it('emits conversation_friction evidence with the expected metadata', async () => {
    const { guardrail, deps } = makeGuardrail();

    guardrail.recordToolUse('tool-1', 'Read');
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));

    expect(deps.emitEvidence).toHaveBeenCalledWith({
      scopeId: 'scope-1',
      summary: 'Repeated tool error: Read failed 2 consecutive times with the same error',
      metadata: {
        tool: 'Read',
        error: 'file not found',
        count: 2,
      },
    });
  });

  it('does not trigger when the session has no Forge task', async () => {
    const { guardrail, deps } = makeGuardrail({
      getTaskForSession: mock(() => null),
    });

    guardrail.recordToolUse('tool-1', 'Read');
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
    const triggered = await guardrail.observeToolResultErrors(
      makeErrorResult('tool-1', 'file not found')
    );

    expect(triggered).toBe(false);
    expect(deps.routeRecoveryMessage).not.toHaveBeenCalled();
    expect(deps.emitEvidence).not.toHaveBeenCalled();
  });

  it('does not trigger when the task has no evolution scope', async () => {
    const taskWithoutScope = {
      id: 'task-2',
      spaceId: 'space-1',
      taskNumber: 2,
      title: 'Unscoped task',
      description: '',
      status: 'in_progress',
      priority: 'normal',
      labels: [],
      evolutionScopeId: null,
    } as SpaceTask;

    const { guardrail, deps } = makeGuardrail({
      getTaskForSession: mock(() => taskWithoutScope),
    });

    guardrail.recordToolUse('tool-1', 'Read');
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
    const triggered = await guardrail.observeToolResultErrors(
      makeErrorResult('tool-1', 'file not found')
    );

    expect(triggered).toBe(false);
    expect(deps.routeRecoveryMessage).not.toHaveBeenCalled();
    expect(deps.emitEvidence).not.toHaveBeenCalled();
  });

  it('caps the tool-use lookup map to avoid unbounded growth', async () => {
    const { guardrail } = makeGuardrail({ maxTrackedToolUseIds: 3 });

    guardrail.recordToolUse('t1', 'Read');
    guardrail.recordToolUse('t2', 'Glob');
    guardrail.recordToolUse('t3', 'Write');
    guardrail.recordToolUse('t4', 'Edit');

    const triggered = await guardrail.observeToolResultErrors(
      makeErrorResult('t1', 'file not found')
    );
    expect(triggered).toBe(false);
  });

  it('counts batched identical errors only once per user message', async () => {
    const { guardrail, deps } = makeGuardrail();

    guardrail.recordToolUse('tool-1', 'Read');
    guardrail.recordToolUse('tool-2', 'Read');
    const triggered = await guardrail.observeToolResultErrors({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: 'file not found' },
          { type: 'tool_result', tool_use_id: 'tool-2', is_error: true, content: 'file not found' },
        ],
      },
    } as unknown as ReturnType<typeof makeErrorResult>);

    expect(triggered).toBe(false);
    expect(deps.routeRecoveryMessage).not.toHaveBeenCalled();
  });

  it('defers recovery when a batched message also contains a successful tool result', async () => {
    const { guardrail, deps } = makeGuardrail();

    guardrail.recordToolUse('tool-1', 'Read');
    guardrail.recordToolUse('tool-2', 'Glob');
    await guardrail.observeToolResultErrors({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: 'file not found' },
          { type: 'tool_result', tool_use_id: 'tool-2', is_error: false, content: 'ok' },
        ],
      },
    } as unknown as ReturnType<typeof makeErrorResult>);

    const triggered = await guardrail.observeToolResultErrors(
      makeErrorResult('tool-1', 'file not found')
    );

    expect(triggered).toBe(false);
    expect(deps.routeRecoveryMessage).not.toHaveBeenCalled();
  });

  it('does not immediately re-trigger for the same tool+error after an intervention', async () => {
    const { guardrail, deps } = makeGuardrail();

    guardrail.recordToolUse('tool-1', 'Read');
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));

    expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(1);
    deps.routeRecoveryMessage.mockClear();

    const retriggered = await guardrail.observeToolResultErrors(
      makeErrorResult('tool-1', 'file not found')
    );

    expect(retriggered).toBe(false);
    expect(deps.routeRecoveryMessage).not.toHaveBeenCalled();
  });

  it('resets the streak on a plain-text user message', async () => {
    const { guardrail, deps } = makeGuardrail();

    guardrail.recordToolUse('tool-1', 'Read');
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
    await guardrail.observeToolResultErrors({
      type: 'user',
      message: { role: 'user', content: 'Let me try something else.' },
    } as unknown as ReturnType<typeof makeErrorResult>);
    const triggered = await guardrail.observeToolResultErrors(
      makeErrorResult('tool-1', 'file not found')
    );

    expect(triggered).toBe(false);
    expect(deps.routeRecoveryMessage).not.toHaveBeenCalled();
  });

  it('resets the streak when a later user message has no error tool results', async () => {
    const { guardrail, deps } = makeGuardrail();

    guardrail.recordToolUse('tool-1', 'Read');
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
    await guardrail.observeToolResultErrors({
      type: 'user',
      message: { role: 'user', content: [] },
    } as unknown as ReturnType<typeof makeErrorResult>);
    const triggered = await guardrail.observeToolResultErrors(
      makeErrorResult('tool-1', 'file not found')
    );

    expect(triggered).toBe(false);
    expect(deps.routeRecoveryMessage).not.toHaveBeenCalled();
  });

  it('does not trigger when the threshold is configured higher', async () => {
    const { guardrail, deps } = makeGuardrail({ threshold: 3 });

    guardrail.recordToolUse('tool-1', 'Read');
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));

    expect(deps.routeRecoveryMessage).not.toHaveBeenCalled();
    expect(deps.emitEvidence).not.toHaveBeenCalled();
  });
});
