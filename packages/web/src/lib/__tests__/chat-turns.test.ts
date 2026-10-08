import type { ChatMessage } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import {
  backgroundTasksLabel,
  buildChatTurns,
  countTopLevelTasks,
  liveTurnActivity,
} from '../chat-turns.ts';

const user = (uuid: string, timestamp: number) =>
  ({
    type: 'user',
    uuid,
    timestamp,
    message: { role: 'user', content: 'go' },
  }) as unknown as ChatMessage;
const assistant = (uuid: string, ...content: unknown[]) =>
  ({ type: 'assistant', uuid, message: { content } }) as unknown as ChatMessage;
const toolResult = (uuid: string, isError: boolean) =>
  ({
    type: 'user',
    uuid,
    message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: isError }] },
  }) as unknown as ChatMessage;
const result = (uuid: string, subtype: string, durationMs: number) =>
  ({
    type: 'result',
    uuid,
    subtype,
    is_error: subtype !== 'success',
    duration_ms: durationMs,
  }) as unknown as ChatMessage;

describe('buildChatTurns', () => {
  it('groups each prompt with its work and counts tools and failures', () => {
    const turns = buildChatTurns([
      user('u1', 1000),
      assistant('a1', { type: 'tool_use', id: 't1' }, { type: 'tool_use', id: 't2' }),
      toolResult('r1', false),
      toolResult('r2', true),
      assistant('a2', { type: 'text', text: 'done' }),
      result('res1', 'success', 41_000),
      user('u2', 50_000),
    ]);

    expect(turns.map((turn) => [turn.key, turn.messages.length, turn.outcome])).toEqual([
      ['u1', 6, 'done'],
      ['u2', 1, 'running'],
    ]);
    expect(turns[0]).toMatchObject({
      toolCount: 2,
      errorCount: 1,
      durationMs: 41_000,
      startedAt: 1000,
    });
  });

  it('marks failed results, and turns without a result before the last as stopped', () => {
    const turns = buildChatTurns([
      user('u1', 1),
      result('res1', 'error_during_execution', 5),
      user('u2', 10),
      assistant('a1', { type: 'text', text: 'partial' }),
      user('u3', 20),
    ]);
    expect(turns.map((turn) => turn.outcome)).toEqual(['failed', 'stopped', 'running']);
  });

  it('keeps a turn running while a follow-up waits in the queue', () => {
    const queued = { ...user('u2', 30), deliveryStatus: 'queued' } as unknown as ChatMessage;
    const turns = buildChatTurns([
      user('u1', 1),
      assistant('a1', { type: 'tool_use', id: 't' }),
      queued,
    ]);
    expect(turns.map((turn) => [turn.key, turn.messages.length, turn.outcome])).toEqual([
      ['u1', 3, 'running'],
    ]);
  });

  it('adds up the work of follow-up turns that ran without a new prompt', () => {
    const [turn] = buildChatTurns([
      user('u1', 1),
      result('res1', 'success', 13_000),
      assistant('a2', { type: 'text', text: 'Agent A finished' }),
      result('res2', 'success', 4_000),
      result('res3', 'success', 9_000),
    ]);
    expect(turn.durationMs).toBe(26_000);
    expect(turn.outcome).toBe('done');
  });

  it('keeps messages before the first prompt in their own turn', () => {
    const turns = buildChatTurns([assistant('a0', { type: 'text', text: 'hello' }), user('u1', 5)]);
    expect(turns.map((turn) => turn.key)).toEqual(['a0', 'u1']);
  });
});

describe('countTopLevelTasks', () => {
  it('counts only tasks launched by top-level tool calls in the given messages', () => {
    const nestedBash = {
      ...assistant('sub', { type: 'tool_use', id: 'bash-in-agent', name: 'Bash' }),
      parent_tool_use_id: 'agent-a',
    } as unknown as ChatMessage;
    const messages = [
      user('u1', 1),
      assistant('a1', { type: 'tool_use', id: 'agent-a', name: 'Agent' }),
      nestedBash,
    ];
    const running = new Set(['agent-a', 'bash-in-agent', 'scrolled-out']);
    expect(countTopLevelTasks(running, messages)).toBe(1);
    expect(countTopLevelTasks(running, [user('u2', 2)])).toBe(0);
  });
});

describe('backgroundTasksLabel', () => {
  it('names the count for the status line', () => {
    expect(backgroundTasksLabel(0)).toBeUndefined();
    expect(backgroundTasksLabel(1)).toBe('1 background task running');
    expect(backgroundTasksLabel(3)).toBe('3 background tasks running');
  });
});

describe('liveTurnActivity', () => {
  it('keeps a turn running while it waits for an answer or a retry', () => {
    expect(liveTurnActivity('waiting_for_input', undefined)).toEqual({
      active: true,
      action: 'Waiting for your answer',
    });
    expect(liveTurnActivity('rate_limit_cooldown', 'Reading...')).toEqual({
      active: true,
      action: 'Waiting to retry',
    });
    expect(liveTurnActivity('processing', 'Reading...')).toEqual({
      active: true,
      action: 'Reading...',
    });
    expect(liveTurnActivity('idle', undefined)).toEqual({ active: false, action: undefined });
  });
});
