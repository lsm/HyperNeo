import { renderHook } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@neokai/shared';
import { extractRunningToolUseIds, useRunningToolUseIds } from '../useRunningToolUseIds.ts';

function messagesWithTaskStatus(
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'killed'
) {
  return [
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-1',
      tool_use_id: 'tool-1',
      description: 'Run task',
    },
    {
      type: 'system',
      subtype: 'task_updated',
      task_id: 'task-1',
      patch: { status },
    },
  ] as unknown as ChatMessage[];
}

function messagesWithNotification(status: 'completed' | 'failed' | 'stopped') {
  return [
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-1',
      tool_use_id: 'tool-1',
      description: 'Run task',
    },
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      tool_use_id: 'tool-1',
      status,
    },
  ] as unknown as ChatMessage[];
}

describe('useRunningToolUseIds', () => {
  it('adds a tool_use_id from task_started', () => {
    const messages = [
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        description: 'Run task',
      },
    ] as unknown as ChatMessage[];

    expect([...extractRunningToolUseIds(messages)]).toEqual(['tool-1']);
  });

  it.each([
    'pending',
    'running',
    'paused',
  ] as const)('keeps the tool_use_id while status is %s', (status) => {
    expect([...extractRunningToolUseIds(messagesWithTaskStatus(status))]).toEqual(['tool-1']);
  });

  it('returns every in-flight tool_use_id without the SessionInfoPanel display limit', () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({
      type: 'system',
      subtype: 'task_started',
      task_id: `task-${index + 1}`,
      tool_use_id: `tool-${index + 1}`,
      description: `Run task ${index + 1}`,
    })) as unknown as ChatMessage[];

    expect([...extractRunningToolUseIds(messages)]).toEqual([
      'tool-1',
      'tool-2',
      'tool-3',
      'tool-4',
      'tool-5',
    ]);
  });

  it.each([
    'completed',
    'failed',
    'stopped',
  ] as const)('drops the tool_use_id after terminal task_notification %s', (status) => {
    expect(extractRunningToolUseIds(messagesWithNotification(status)).size).toBe(0);
  });

  it.each([
    'completed',
    'failed',
    'killed',
  ] as const)('drops the tool_use_id after terminal task_updated status %s', (status) => {
    expect(extractRunningToolUseIds(messagesWithTaskStatus(status)).size).toBe(0);
  });

  it('joins task_updated to task_started by task_id when task_updated has no tool_use_id', () => {
    const messages = [
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        description: 'Run task',
      },
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-1',
        patch: { status: 'paused' },
      },
    ] as unknown as ChatMessage[];

    expect([...extractRunningToolUseIds(messages)]).toEqual(['tool-1']);
  });

  it('ignores task_started messages without a tool_use_id', () => {
    const messages = [
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        description: 'Run task',
      },
    ] as unknown as ChatMessage[];

    expect(extractRunningToolUseIds(messages).size).toBe(0);
  });

  it('memoizes the running tool_use_ids set through the hook', () => {
    const messages = messagesWithTaskStatus('running');
    const { result, rerender } = renderHook(({ value }) => useRunningToolUseIds(value), {
      initialProps: { value: messages },
    });
    const first = result.current;

    rerender({ value: messages });

    expect(result.current).toBe(first);
    expect([...result.current]).toEqual(['tool-1']);
  });
});
