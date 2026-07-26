/**
 * Unit tests for classifyLastMessageForIdleAgent — the pure-function core of
 * Space runtime idle detection.
 *
 * The hidden-subtype SQL filter in SDKMessageRepository.getLastSDKMessage()
 * deliberately RETAINS the task progress subtypes (task_started /
 * task_progress / task_updated) precisely so this classifier can observe them.
 * A system progress signal as the last message means the agent is actively
 * working and must NOT be treated as a safe idle stop.
 *
 * These tests pin the decision table the runtime depends on so future changes
 * to the classifier (or to the message shapes feeding it) keep idle-state
 * behavior stable.
 */
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

  it('classifies a system task-progress signal as non-terminal (active work)', () => {
    // This is the contract the hidden-subtype SQL filter exists to preserve:
    // task_started / task_progress / task_updated are render-hidden but must
    // remain observable as the last message, and they read as non-terminal.
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
