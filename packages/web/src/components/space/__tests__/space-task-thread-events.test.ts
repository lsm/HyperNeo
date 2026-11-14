import { describe, expect, it } from 'vitest';
import { parseThreadRow } from '../thread/space-task-thread-events';
import type { SpaceTaskThreadMessageRow } from '../useSpaceTaskMessages';

function makeRow(
  overrides: Partial<SpaceTaskThreadMessageRow> & { content: string }
): SpaceTaskThreadMessageRow {
  return {
    id: 'row-default',
    sessionId: 'session-1',
    kind: 'task_agent',
    role: 'task',
    label: 'Task Agent',
    taskId: 'task-1',
    taskTitle: 'Test Task',
    messageType: 'assistant',
    createdAt: 1_710_000_000_000,
    ...overrides,
  } as SpaceTaskThreadMessageRow;
}

function makeAssistantRow(
  id: string,
  label: string,
  kind: string,
  text: string,
  createdAt: number,
  sessionId = 'session-1'
): SpaceTaskThreadMessageRow {
  return makeRow({
    id,
    sessionId,
    kind: kind as 'task_agent' | 'node_agent',
    label,
    content: JSON.stringify({
      type: 'assistant',
      uuid: `uuid-${id}`,
      session_id: sessionId,
      message: {
        content: [{ type: 'text', text }],
      },
    }),
    createdAt,
  });
}

describe('parseThreadRow', () => {
  it('parses a valid JSON assistant message row', () => {
    const row = makeAssistantRow(
      'r1',
      'Task Agent',
      'task_agent',
      'Hello world',
      1_710_000_000_000
    );
    const parsed = parseThreadRow(row);
    expect(parsed.id).toBe('r1');
    expect(parsed.label).toBe('Task Agent');
    expect(parsed.taskId).toBe('task-1');
    expect(parsed.createdAt).toBe(1_710_000_000_000);
    expect(parsed.message).not.toBeNull();
    expect(parsed.fallbackText).toBeNull();
  });

  it('injects timestamp from createdAt into parsed message', () => {
    const row = makeAssistantRow('r1', 'Task Agent', 'task_agent', 'Hello', 1_710_000_999_000);
    const parsed = parseThreadRow(row);
    expect((parsed.message as Record<string, unknown>)?.timestamp).toBe(1_710_000_999_000);
  });

  it('injects DB origin from the row into the parsed message', () => {
    const row = makeRow({
      id: 'system-row',
      origin: 'system',
      content: JSON.stringify({
        type: 'user',
        uuid: 'u-system',
        session_id: 'session-1',
        message: { content: 'runtime notification' },
      }),
    });

    const parsed = parseThreadRow(row);

    expect((parsed.message as Record<string, unknown>)?.origin).toBe('system');
  });

  it('returns fallbackText when content is not valid JSON', () => {
    const invalidContent = 'not json {{{';
    const row = makeRow({ id: 'bad', content: invalidContent });
    const parsed = parseThreadRow(row);
    expect(parsed.message).toBeNull();
    expect(parsed.fallbackText).toBe(invalidContent);
  });

  it('preserves label and sessionId from the original row', () => {
    const row = makeAssistantRow(
      'r2',
      'Coder Agent',
      'node_agent',
      'coding',
      1_000,
      'session-coder'
    );
    const parsed = parseThreadRow(row);
    expect(parsed.label).toBe('Coder Agent');
    expect(parsed.sessionId).toBe('session-coder');
  });
});
