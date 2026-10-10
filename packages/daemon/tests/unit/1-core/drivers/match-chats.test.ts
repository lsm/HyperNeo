import { describe, expect, test } from 'bun:test';
import type { WorkChatMatch } from '../../../../src/storage/work-chat-search';
import { matchChatsBy } from '../../../../src/lib/drivers/match-chats';

const chat = (sessionId: string | null, taskId: string | null) =>
  ({
    kind: 'message',
    sessionId,
    taskId,
    hits: 1,
    lastHitAt: 0,
    score: 1,
    snippets: [],
  }) as unknown as WorkChatMatch;

describe('matchChatsBy', () => {
  test('keys chats by the chosen id and skips chats without one', () => {
    const a = chat('s1', null);
    const b = chat(null, 't1');
    const matched = matchChatsBy([a, b], (item) => item.sessionId);
    expect([...matched.entries()]).toEqual([['s1', a]]);
    expect([...matchChatsBy([a, b], (item) => item.taskId ?? item.sessionId).keys()]).toEqual([
      's1',
      't1',
    ]);
  });
});
