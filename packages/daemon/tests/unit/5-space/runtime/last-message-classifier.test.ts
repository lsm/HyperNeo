import { describe, expect, it } from 'bun:test';
import { classifyLastMessageForIdleAgent } from '../../../../src/lib/space/runtime/last-message-classifier';
import type { SDKMessage } from '@hyperneo/shared/sdk';

describe('classifyLastMessageForIdleAgent', () => {
  it('treats an absent transcript as non-terminal (nothing recorded yet)', () => {
    expect(classifyLastMessageForIdleAgent(null)).toEqual(
      expect.objectContaining({ terminal: false })
    );
    expect(classifyLastMessageForIdleAgent(undefined)).toEqual(
      expect.objectContaining({ terminal: false })
    );
  });

  it('classifies a result message as terminal', () => {
    const message = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done',
    } as unknown as SDKMessage;
    expect(classifyLastMessageForIdleAgent(message)).toEqual(
      expect.objectContaining({ terminal: true })
    );
  });

  it('classifies a hollow task-notification-origin result as non-terminal', () => {
    const message = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      usage: { input_tokens: 0, output_tokens: 0 },
      origin: { kind: 'task-notification' },
    } as unknown as SDKMessage;
    expect(classifyLastMessageForIdleAgent(message)).toEqual({
      terminal: false,
      reason: 'task-notification result awaits follow-up turn',
    });
  });

  it('classifies a task-notification-origin result with non-empty text as terminal', () => {
    const message = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Background task output consumed; continuing.',
      usage: { input_tokens: 0, output_tokens: 0 },
      origin: { kind: 'task-notification' },
    } as unknown as SDKMessage;
    expect(classifyLastMessageForIdleAgent(message)).toEqual(
      expect.objectContaining({ terminal: true })
    );
  });

  it('classifies a task-notification-origin result with nonzero usage as terminal', () => {
    const message = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      usage: { input_tokens: 12, output_tokens: 34 },
      origin: { kind: 'task-notification' },
    } as unknown as SDKMessage;
    expect(classifyLastMessageForIdleAgent(message)).toEqual(
      expect.objectContaining({ terminal: true })
    );
  });

  it('classifies an error-flagged task-notification-origin result as terminal (part-3 territory)', () => {
    const message = {
      type: 'result',
      subtype: 'success',
      is_error: true,
      origin: { kind: 'task-notification' },
    } as unknown as SDKMessage;
    expect(classifyLastMessageForIdleAgent(message)).toEqual(
      expect.objectContaining({ terminal: true })
    );
  });

  it('classifies an api-error result (subtype success, is_error true) as terminal', () => {
    const message = {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'API Error: Connection refused (ConnectionRefused)',
    } as unknown as SDKMessage;
    expect(classifyLastMessageForIdleAgent(message)).toEqual(
      expect.objectContaining({ terminal: true })
    );
  });

  it('classifies a system task-progress signal as non-terminal (active work)', () => {
    for (const subtype of ['task_started', 'task_progress', 'task_updated']) {
      const message = {
        type: 'system',
        subtype,
        task_id: 'task-1',
      } as unknown as SDKMessage;
      expect(classifyLastMessageForIdleAgent(message)).toEqual(
        expect.objectContaining({ terminal: false })
      );
    }
  });

  it('classifies a plain user turn as non-terminal', () => {
    const message = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    } as unknown as SDKMessage;
    expect(classifyLastMessageForIdleAgent(message)).toEqual(
      expect.objectContaining({ terminal: false })
    );
  });

  it('classifies an assistant turn ending in end_turn (no pending tool_use) as terminal', () => {
    const message = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'All done' }],
        stop_reason: 'end_turn',
      },
    } as unknown as SDKMessage;
    expect(classifyLastMessageForIdleAgent(message)).toEqual(
      expect.objectContaining({ terminal: true })
    );
  });

  it('classifies an assistant turn with an unresolved tool_use as non-terminal', () => {
    const message = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running a tool' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
        ],
        stop_reason: 'tool_use',
      },
    } as unknown as SDKMessage;
    expect(classifyLastMessageForIdleAgent(message)).toEqual(
      expect.objectContaining({ terminal: false })
    );
  });

  it('classifies a thinking-only assistant turn as non-terminal', () => {
    const message = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'hmm' }],
        stop_reason: 'end_turn',
      },
    } as unknown as SDKMessage;
    expect(classifyLastMessageForIdleAgent(message)).toEqual(
      expect.objectContaining({ terminal: false })
    );
  });

  it('classifies an assistant error as terminal', () => {
    const message = {
      type: 'assistant',
      error: 'upstream failure',
      message: { role: 'assistant', content: [] },
    } as unknown as SDKMessage;
    expect(classifyLastMessageForIdleAgent(message)).toEqual(
      expect.objectContaining({ terminal: true })
    );
  });

  it('classifies an assistant turn with no terminal end_turn/result signal as non-terminal', () => {
    const message = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
        stop_reason: 'max_tokens',
      },
    } as unknown as SDKMessage;
    expect(classifyLastMessageForIdleAgent(message)).toEqual(
      expect.objectContaining({ terminal: false })
    );
  });
});
