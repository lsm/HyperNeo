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

function makeRawMessage(content: unknown) {
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content },
  };
}

function makeErrorBlock(toolUseId: string | undefined, content: unknown) {
  return {
    type: 'tool_result' as const,
    tool_use_id: toolUseId,
    is_error: true as const,
    content,
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

  describe('counting rules', () => {
    it('uses a default threshold of 2 when none is configured', async () => {
      const { guardrail, deps } = makeGuardrail({ threshold: undefined });

      guardrail.recordToolUse('tool-1', 'Read');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-1', 'file not found')
      );

      expect(triggered).toBe(true);
      expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(1);
    });

    it('matches errors case- and whitespace-insensitively', async () => {
      const { guardrail, deps } = makeGuardrail();

      guardrail.recordToolUse('tool-1', 'Read');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', '  File   NOT\nfound '));
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-1', 'file not found')
      );

      expect(triggered).toBe(true);
      expect(deps.emitEvidence).toHaveBeenCalledWith({
        scopeId: 'scope-1',
        summary: 'Repeated tool error: Read failed 2 consecutive times with the same error',
        metadata: { tool: 'Read', error: 'file not found', count: 2 },
      });
    });

    it('treats errors differing only past the fingerprint length as identical', async () => {
      const { guardrail, deps } = makeGuardrail({ errorFingerprintLength: 10 });

      guardrail.recordToolUse('tool-1', 'Read');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'aaaaaaaaaa-first'));
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-1', 'aaaaaaaaaa-second')
      );

      expect(triggered).toBe(true);
      expect(deps.emitEvidence).toHaveBeenCalledWith({
        scopeId: 'scope-1',
        summary: 'Repeated tool error: Read failed 2 consecutive times with the same error',
        metadata: { tool: 'Read', error: 'aaaaaaaaaa', count: 2 },
      });
    });

    it('uses a default fingerprint length of 160 when none is configured', async () => {
      const { guardrail, deps } = makeGuardrail({ errorFingerprintLength: undefined });

      guardrail.recordToolUse('tool-1', 'Read');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', `${'a'.repeat(160)}X`));
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-1', `${'a'.repeat(160)}Y`)
      );

      expect(triggered).toBe(true);
      expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(1);
    });

    it('counts errors from unrecorded tool_use_ids under the tool name unknown', async () => {
      const { guardrail, deps } = makeGuardrail();

      await guardrail.observeToolResultErrors(makeErrorResult('unrecorded-1', 'boom'));
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('unrecorded-2', 'boom')
      );

      expect(triggered).toBe(true);
      expect(deps.emitEvidence).toHaveBeenCalledWith({
        scopeId: 'scope-1',
        summary: 'Repeated tool error: unknown failed 2 consecutive times with the same error',
        metadata: { tool: 'unknown', error: 'boom', count: 2 },
      });
    });

    it('records an empty tool name as unknown', async () => {
      const { guardrail, deps } = makeGuardrail();

      guardrail.recordToolUse('tool-1', '');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'boom'));
      const triggered = await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'boom'));

      expect(triggered).toBe(true);
      expect(deps.emitEvidence).toHaveBeenCalledWith({
        scopeId: 'scope-1',
        summary: 'Repeated tool error: unknown failed 2 consecutive times with the same error',
        metadata: { tool: 'unknown', error: 'boom', count: 2 },
      });
    });

    it('counts a tool_use_id evicted from the lookup map under the tool name unknown', async () => {
      const { guardrail, deps } = makeGuardrail({ maxTrackedToolUseIds: 1 });

      guardrail.recordToolUse('tool-1', 'Read');
      guardrail.recordToolUse('tool-2', 'Glob');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'boom'));
      const triggered = await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'boom'));

      expect(triggered).toBe(true);
      expect(deps.emitEvidence).toHaveBeenCalledWith({
        scopeId: 'scope-1',
        summary: 'Repeated tool error: unknown failed 2 consecutive times with the same error',
        metadata: { tool: 'unknown', error: 'boom', count: 2 },
      });
    });

    it('counts each distinct error in a batched message once and tracks the last one', async () => {
      const { guardrail, deps } = makeGuardrail();

      guardrail.recordToolUse('tool-1', 'Read');
      await guardrail.observeToolResultErrors(
        makeRawMessage([makeErrorBlock('tool-1', 'error A'), makeErrorBlock('tool-1', 'error B')])
      );
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-1', 'error B')
      );

      expect(triggered).toBe(true);
      expect(deps.emitEvidence).toHaveBeenCalledWith({
        scopeId: 'scope-1',
        summary: 'Repeated tool error: Read failed 2 consecutive times with the same error',
        metadata: { tool: 'Read', error: 'error b', count: 2 },
      });
    });

    it('does not continue the streak for an earlier error from a batch', async () => {
      const { guardrail, deps } = makeGuardrail();

      guardrail.recordToolUse('tool-1', 'Read');
      await guardrail.observeToolResultErrors(
        makeRawMessage([makeErrorBlock('tool-1', 'error A'), makeErrorBlock('tool-1', 'error B')])
      );
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-1', 'error A')
      );

      expect(triggered).toBe(false);
      expect(deps.routeRecoveryMessage).not.toHaveBeenCalled();
    });

    it('dedupes errors within a message by normalized fingerprint', async () => {
      const { guardrail, deps } = makeGuardrail();

      guardrail.recordToolUse('tool-1', 'Read');
      guardrail.recordToolUse('tool-2', 'Read');
      const triggered = await guardrail.observeToolResultErrors(
        makeRawMessage([
          makeErrorBlock('tool-1', 'File Not Found'),
          makeErrorBlock('tool-2', 'file not found'),
        ])
      );

      expect(triggered).toBe(false);
      expect(deps.routeRecoveryMessage).not.toHaveBeenCalled();
    });

    it('triggers on the first error when the threshold is 1', async () => {
      const { guardrail, deps } = makeGuardrail({ threshold: 1 });

      guardrail.recordToolUse('tool-1', 'Read');
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-1', 'file not found')
      );

      expect(triggered).toBe(true);
      expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(1);
      expect(deps.emitEvidence).toHaveBeenCalledWith({
        scopeId: 'scope-1',
        summary: 'Repeated tool error: Read failed 1 consecutive times with the same error',
        metadata: { tool: 'Read', error: 'file not found', count: 1 },
      });
    });

    it('intervenes once per distinct error key in a message when the threshold is 1', async () => {
      const { guardrail, deps } = makeGuardrail({ threshold: 1 });

      guardrail.recordToolUse('tool-1', 'Read');
      const triggered = await guardrail.observeToolResultErrors(
        makeRawMessage([
          makeErrorBlock('tool-1', 'error A'),
          makeErrorBlock('tool-1', 'error B'),
          makeErrorBlock('tool-1', 'error A'),
        ])
      );

      expect(triggered).toBe(true);
      expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(2);
      expect(deps.emitEvidence).toHaveBeenCalledTimes(2);
    });

    it('reports the full streak length at higher thresholds', async () => {
      const { guardrail, deps } = makeGuardrail({ threshold: 3 });

      guardrail.recordToolUse('tool-1', 'Read');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-1', 'file not found')
      );

      expect(triggered).toBe(true);
      expect(deps.emitEvidence).toHaveBeenCalledWith({
        scopeId: 'scope-1',
        summary: 'Repeated tool error: Read failed 3 consecutive times with the same error',
        metadata: { tool: 'Read', error: 'file not found', count: 3 },
      });
    });
  });

  describe('streak resets', () => {
    it('preserves the streak across a message whose content is not an array or string', async () => {
      const { guardrail, deps } = makeGuardrail();

      guardrail.recordToolUse('tool-1', 'Read');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
      await guardrail.observeToolResultErrors(makeRawMessage(undefined));
      await guardrail.observeToolResultErrors(makeRawMessage({ role: 'user' }));
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-1', 'file not found')
      );

      expect(triggered).toBe(true);
      expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(1);
    });

    it('resets the streak on an error tool_result without a tool_use_id', async () => {
      const { guardrail, deps } = makeGuardrail();

      guardrail.recordToolUse('tool-1', 'Read');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
      await guardrail.observeToolResultErrors(
        makeRawMessage([makeErrorBlock(undefined, 'file not found')])
      );
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-1', 'file not found')
      );

      expect(triggered).toBe(false);
      expect(deps.routeRecoveryMessage).not.toHaveBeenCalled();
    });

    it('resets the streak on an error tool_result whose text content is empty', async () => {
      const { guardrail, deps } = makeGuardrail();

      guardrail.recordToolUse('tool-1', 'Read');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
      await guardrail.observeToolResultErrors(makeRawMessage([makeErrorBlock('tool-1', [])]));
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-1', 'file not found')
      );

      expect(triggered).toBe(false);
      expect(deps.routeRecoveryMessage).not.toHaveBeenCalled();
    });

    it('extracts error text from structured content blocks', async () => {
      const { guardrail, deps } = makeGuardrail();

      guardrail.recordToolUse('tool-1', 'Read');
      await guardrail.observeToolResultErrors(
        makeRawMessage([
          makeErrorBlock('tool-1', [{ type: 'text', text: 'file not found' }, 'extra']),
        ])
      );
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-1', 'file not found extra')
      );

      expect(triggered).toBe(true);
      expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('intervention cooldown', () => {
    it('applies the cooldown per tool+error key, not globally', async () => {
      const { guardrail, deps } = makeGuardrail();

      guardrail.recordToolUse('tool-1', 'Read');
      guardrail.recordToolUse('tool-2', 'Glob');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
      expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(1);

      await guardrail.observeToolResultErrors(makeErrorResult('tool-2', 'file not found'));
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-2', 'file not found')
      );

      expect(triggered).toBe(true);
      expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(2);
    });

    it('suppresses repeats of a cooled-down key and resets an in-progress streak', async () => {
      const { guardrail, deps } = makeGuardrail();

      guardrail.recordToolUse('tool-1', 'Read');
      guardrail.recordToolUse('tool-2', 'Glob');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
      expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(1);

      await guardrail.observeToolResultErrors(makeErrorResult('tool-2', 'glob failed'));
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-2', 'glob failed')
      );

      expect(triggered).toBe(false);
      expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(1);
    });

    it('allows the same key to trigger again after the cooldown expires', async () => {
      const { guardrail, deps } = makeGuardrail();

      const originalNow = Date.now;
      try {
        let now = originalNow();
        Date.now = () => now;

        guardrail.recordToolUse('tool-1', 'Read');
        await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
        await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
        expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(1);

        now += 61_000;

        await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
        expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(1);
        const triggered = await guardrail.observeToolResultErrors(
          makeErrorResult('tool-1', 'file not found')
        );

        expect(triggered).toBe(true);
        expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(2);
      } finally {
        Date.now = originalNow;
      }
    });

    it('restarts the streak at 1 after an intervention when the cooldown is disabled', async () => {
      const { guardrail, deps } = makeGuardrail({ interventionCooldownMs: 0 });

      guardrail.recordToolUse('tool-1', 'Read');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
      expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(1);

      const single = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-1', 'file not found')
      );
      expect(single).toBe(false);
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-1', 'file not found')
      );

      expect(triggered).toBe(true);
      expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('intervention actions', () => {
    it('routes a recovery message describing the tool, count, and error', async () => {
      const { guardrail, deps } = makeGuardrail();

      guardrail.recordToolUse('tool-1', 'Read');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));

      expect(deps.routeRecoveryMessage).toHaveBeenCalledWith(
        '⚠️ Repeated tool error detected: `Read` failed 2 consecutive times with the same error.\n\nError: file not found\n\nStop retrying this operation. Re-validate the arguments, try an alternative path, or ask the operator for help.'
      );
    });

    it('truncates the error text in the recovery message at 200 characters', async () => {
      const { guardrail, deps } = makeGuardrail();

      const longError = 'x'.repeat(250);
      guardrail.recordToolUse('tool-1', 'Read');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', longError));
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', longError));

      expect(deps.routeRecoveryMessage).toHaveBeenCalledWith(
        `⚠️ Repeated tool error detected: \`Read\` failed 2 consecutive times with the same error.\n\nError: ${'x'.repeat(200)}…\n\nStop retrying this operation. Re-validate the arguments, try an alternative path, or ask the operator for help.`
      );
      expect(deps.emitEvidence).toHaveBeenCalledWith({
        scopeId: 'scope-1',
        summary: 'Repeated tool error: Read failed 2 consecutive times with the same error',
        metadata: { tool: 'Read', error: 'x'.repeat(80), count: 2 },
      });
    });

    it('emits evidence before routing the recovery message', async () => {
      const calls: string[] = [];
      const { guardrail } = makeGuardrail({
        emitEvidence: mock(() => {
          calls.push('evidence');
          return { id: 'evidence-1' };
        }),
        routeRecoveryMessage: mock(async () => {
          calls.push('route');
        }),
      });

      guardrail.recordToolUse('tool-1', 'Read');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));

      expect(calls).toEqual(['evidence', 'route']);
    });

    it('still routes the recovery message when evidence emission throws', async () => {
      const { guardrail, deps } = makeGuardrail({
        emitEvidence: mock(() => {
          throw new Error('db down');
        }),
      });

      guardrail.recordToolUse('tool-1', 'Read');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-1', 'file not found')
      );

      expect(triggered).toBe(true);
      expect(deps.routeRecoveryMessage).toHaveBeenCalledTimes(1);
    });

    it('still reports the intervention when routing the recovery message fails', async () => {
      const { guardrail, deps } = makeGuardrail({
        routeRecoveryMessage: mock(async () => {
          throw new Error('delivery failed');
        }),
      });

      guardrail.recordToolUse('tool-1', 'Read');
      await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
      const triggered = await guardrail.observeToolResultErrors(
        makeErrorResult('tool-1', 'file not found')
      );

      expect(triggered).toBe(true);
      expect(deps.emitEvidence).toHaveBeenCalledTimes(1);
    });
  });
});
