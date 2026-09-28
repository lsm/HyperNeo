import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  completedActivities,
  completedConversation,
  completedWorkReplies,
  conversationText,
} from '../NeoConversation.tsx';

function user(uuid: string, text: string, inputKind?: string): ChatMessage {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'user', content: text },
    ...(inputKind ? { inputKind } : {}),
  } as unknown as ChatMessage;
}
function assistant(uuid: string, text: string): ChatMessage {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'assistant', content: text },
  } as unknown as ChatMessage;
}
function result(subtype: string): ChatMessage {
  return { type: 'result', subtype } as unknown as ChatMessage;
}

describe('completedConversation', () => {
  it('publishes completed replies and hides system deliveries', () => {
    const visible = completedConversation([
      user('u1', 'Find a venue'),
      assistant('a1', 'A quiet library room is a possible free venue.'),
      result('success'),
      user('w1', 'A delegated session returned. {"workId":"old-work"}', 'system'),
      result('success'),
    ]);
    expect(visible.map((message) => conversationText(message))).toEqual([
      'Find a venue',
      'A quiet library room is a possible free venue.',
    ]);
  });

  it('keeps the partial reply of a turn that ended without success', () => {
    const visible = completedConversation([
      user('u1', 'Find a venue'),
      assistant('a1', 'Here is what I found before running out of turns:'),
      result('error_max_turns'),
    ]);
    expect(visible.map((message) => conversationText(message))).toEqual([
      'Find a venue',
      'Here is what I found before running out of turns:',
    ]);
  });

  it('drops replies without text and replies before a later completed turn', () => {
    const visible = completedConversation([
      assistant('a1', 'Superseded partial note.'),
      user('u1', 'Try again'),
      assistant('a2', 'Final.'),
    ]);
    expect(visible.map((message) => conversationText(message))).toEqual(['Try again']);
    expect(completedConversation([])).toEqual([]);
  });
});

describe('completedActivities', () => {
  it('keeps a concise, turn-specific activity trail without showing tool output', () => {
    const tool = {
      type: 'assistant',
      uuid: 'tool',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'mcp__hyperneo-operations__invoke',
            input: { name: 'neo.snapshot', input: {} },
          },
        ],
      },
    } as unknown as ChatMessage;
    const activities = completedActivities([
      user('u1', 'Brief'),
      tool,
      assistant('a1', 'Nothing underway.'),
      result('success'),
      user('u2', 'Thanks'),
      assistant('a2', 'Of course.'),
      result('success'),
    ]);
    expect(activities.get('a1')).toEqual(['Checked what Neo knows']);
    expect(activities.has('a2')).toBe(false);
  });
});

describe('completedWorkReplies', () => {
  const work = {
    id: 'work-one',
    report: 'Here is the draft.',
  } as NeoWork;

  it('uses the actual completed query after interleaved human and top-level SDK tool results', () => {
    const reported = { ...work, status: 'reported' as const };
    const bind = (message: ChatMessage, messageId: string): ChatMessage =>
      ({ ...message, neoInputOrigin: { sessionId: 'neo', messageId } }) as unknown as ChatMessage;
    const messages = [
      user('work-one', 'A returned', 'system'),
      user('human-B', 'Unrelated B'),
      bind(assistant('reply-A', 'Draft A is ready'), 'work-one'),
      {
        type: 'user',
        uuid: 'tool-result',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Result' }] },
      } as unknown as ChatMessage,
      result('success'),
      bind(assistant('reply-B', 'Answer B'), 'human-B'),
      result('success'),
    ];
    expect([...completedWorkReplies(messages, [reported], 'neo')]).toEqual([['reply-A', reported]]);
  });

  it.each([
    null,
    { sessionId: 'other', messageId: 'work-one' },
    { sessionId: 'neo', messageId: 'human-B' },
  ])('explicit origin %j suppresses an accidental chronological match', (neoInputOrigin) => {
    const answer = {
      ...assistant('reply', 'Unrelated answer'),
      neoInputOrigin,
    } as unknown as ChatMessage;
    expect(
      completedWorkReplies(
        [user('work-one', 'A returned', 'system'), answer, result('success')],
        [{ ...work, status: 'reported' }],
        'neo'
      ).size
    ).toBe(0);
  });

  it('never attaches a completed report to an unfinished reply', () => {
    const answer = {
      ...assistant('reply', 'Partial'),
      neoInputOrigin: { sessionId: 'neo', messageId: 'work-one' },
    } as unknown as ChatMessage;
    expect(completedWorkReplies([answer], [{ ...work, status: 'reported' }], 'neo').size).toBe(0);
  });

  it('attaches a one-off execution to its completed Neo reply only', () => {
    const replies = completedWorkReplies(
      [
        user('u1', 'Draft an invitation'),
        assistant('a1', 'I can set that up.'),
        result('success'),
        user('work-one', 'A delegated session returned.', 'system'),
        assistant('a2', 'The draft is ready.'),
        result('success'),
        user('u2', 'Thanks'),
        assistant('a3', 'You are welcome.'),
        result('success'),
      ],
      [work]
    );
    expect([...replies.entries()]).toEqual([['a2', work]]);
  });

  it('attaches a holder-reviewed execution to the returned root reply', () => {
    const replies = completedWorkReplies(
      [
        user('neo-consult:neo-work:work-one:review:reply', 'A consultation settled.', 'system'),
        assistant('a1', 'The holder checked the result.'),
        result('success'),
      ],
      [work]
    );
    expect(replies.get('a1')).toBe(work);
  });

  it('does not attach a work response without a matching completed receipt', () => {
    const replies = completedWorkReplies(
      [
        user('work-one', 'A delegated session returned.', 'system'),
        user('u1', 'New question'),
        assistant('a1', 'Different answer.'),
        result('success'),
        user('work-one', 'A delegated session returned.', 'system'),
        assistant('a2', 'Interrupted reply.'),
      ],
      [work]
    );
    expect(replies.size).toBe(0);
  });
});
