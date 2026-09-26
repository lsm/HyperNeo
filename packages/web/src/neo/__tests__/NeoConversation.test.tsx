import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@hyperneo/shared';
import { completedConversation, conversationText } from '../NeoConversation.tsx';

function user(uuid: string, text: string): ChatMessage {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'user', content: text },
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
  it('publishes completed replies and hides work deliveries', () => {
    const visible = completedConversation(
      [
        user('u1', 'Find a venue'),
        assistant('a1', 'A quiet library room is a possible free venue.'),
        result('success'),
        user('w1', 'A delegated session returned.'),
        result('success'),
      ],
      new Set(['w1'])
    );
    expect(visible.map((message) => conversationText(message))).toEqual([
      'Find a venue',
      'A quiet library room is a possible free venue.',
    ]);
  });

  it('keeps the partial reply of a turn that ended without success', () => {
    const visible = completedConversation(
      [
        user('u1', 'Find a venue'),
        assistant('a1', 'Here is what I found before running out of turns:'),
        result('error_max_turns'),
      ],
      new Set()
    );
    expect(visible.map((message) => conversationText(message))).toEqual([
      'Find a venue',
      'Here is what I found before running out of turns:',
    ]);
  });

  it('drops replies without text and replies before a later completed turn', () => {
    const visible = completedConversation(
      [
        assistant('a1', 'Superseded partial note.'),
        user('u1', 'Try again'),
        assistant('a2', 'Final.'),
      ],
      new Set()
    );
    expect(visible.map((message) => conversationText(message))).toEqual(['Try again']);
    expect(completedConversation([], new Set())).toEqual([]);
  });
});
