import type { ChatMessage } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import { buildChatTurns, liveTurnActivity } from '../chat-turns.ts';

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

  it('treats a compaction as a finished turn and keeps its synthetic summary inside it', () => {
    const turns = buildChatTurns([
      user('u1', 1),
      { type: 'system', subtype: 'compact_boundary', uuid: 'cb' } as unknown as ChatMessage,
      { ...user('summary', 2), isSynthetic: true } as unknown as ChatMessage,
    ]);
    expect(turns.map((turn) => [turn.key, turn.messages.length, turn.outcome])).toEqual([
      ['u1', 3, 'done'],
    ]);
  });

  it('keeps messages before the first prompt in their own turn', () => {
    const turns = buildChatTurns([assistant('a0', { type: 'text', text: 'hello' }), user('u1', 5)]);
    expect(turns.map((turn) => turn.key)).toEqual(['a0', 'u1']);
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
