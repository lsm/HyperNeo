/**
 * RepeatedToolErrorGuardrail tests
 */

import { describe, expect, it, mock } from 'bun:test';
import { RepeatedToolErrorGuardrail } from '../../../../src/lib/agent/repeated-tool-error-guardrail';
import type { SpaceTask } from '@neokai/shared';

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
    displayRecoveryMessage: mock(async () => {}),
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
    expect(deps.displayRecoveryMessage).not.toHaveBeenCalled();
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
    expect(deps.displayRecoveryMessage).toHaveBeenCalledTimes(1);
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
    expect(deps.displayRecoveryMessage).not.toHaveBeenCalled();
  });

  it('resets the streak when the error message changes', async () => {
    const { guardrail, deps } = makeGuardrail();

    guardrail.recordToolUse('tool-1', 'Read');
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'permission denied'));
    const triggered = await guardrail.observeToolResultErrors(
      makeErrorResult('tool-1', 'permission denied')
    );

    expect(triggered).toBe(false);
    expect(deps.displayRecoveryMessage).not.toHaveBeenCalled();
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
    expect(deps.displayRecoveryMessage).not.toHaveBeenCalled();
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

  it('does not emit evidence when the session is not linked to a Forge scope', async () => {
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

    expect(triggered).toBe(true);
    expect(deps.displayRecoveryMessage).toHaveBeenCalledTimes(1);
    expect(deps.emitEvidence).not.toHaveBeenCalled();
  });

  it('does not trigger when the threshold is configured higher', async () => {
    const { guardrail, deps } = makeGuardrail({ threshold: 3 });

    guardrail.recordToolUse('tool-1', 'Read');
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));
    await guardrail.observeToolResultErrors(makeErrorResult('tool-1', 'file not found'));

    expect(deps.displayRecoveryMessage).not.toHaveBeenCalled();
    expect(deps.emitEvidence).not.toHaveBeenCalled();
  });
});
