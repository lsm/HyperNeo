import type { ChatMessage } from '@hyperneo/shared';
import { describe, expect, it, vi } from 'vitest';
import { conversationText } from '../NeoConversation.tsx';
import {
  matchNeoReplyInput,
  neoMessageAnchor,
  presentNeoReplyContext,
  projectNeoReplyContext,
  selectNeoReplyOrigin,
} from '../reply-context.ts';

function human(uuid = 'A', text = 'Project A — what is next?', extra = {}): ChatMessage {
  return {
    type: 'user',
    uuid,
    session_id: 'neo',
    parent_tool_use_id: null,
    inputKind: 'human',
    message: { role: 'user', content: text },
    ...extra,
  } as unknown as ChatMessage;
}
function reply(origin: unknown = { sessionId: 'neo', messageId: 'A' }, extra = {}): ChatMessage {
  return {
    type: 'assistant',
    uuid: 'reply-A',
    parent_tool_use_id: null,
    neoAskOrigin: origin,
    message: { role: 'assistant', content: 'The draft is ready.' },
    ...extra,
  } as unknown as ChatMessage;
}
const origin = { sessionId: 'neo', messageId: 'A', replyId: 'reply-A' };

describe('selectNeoReplyOrigin', () => {
  it('selects only explicit human lineage without interpreting the query-input UUID', () => {
    expect(
      selectNeoReplyOrigin(
        reply(undefined, {
          neoInputOrigin: { sessionId: 'neo', messageId: 'worker-report' },
        }),
        'neo'
      )
    ).toEqual({ value: origin });
  });
  it.each([
    null,
    false,
    'A',
    [],
    {},
    { messageId: 'A' },
    { sessionId: 'other', messageId: 'A' },
    { sessionId: 'neo', messageId: '' },
    { sessionId: 'neo', messageId: ' ' },
    { sessionId: 'neo', messageId: 123 },
  ])('rejects unknown or malformed lineage %j', (metadata) => {
    expect(selectNeoReplyOrigin(reply(metadata), 'neo')).toEqual({ reason: 'unknown_origin' });
  });
  it.each([
    human(),
    reply(undefined, { parent_tool_use_id: 'child' }),
    reply(undefined, { uuid: undefined }),
    reply(undefined, { neoAskOrigin: undefined }),
  ])('does not turn other message kinds or missing provenance into an origin', (message) => {
    expect(selectNeoReplyOrigin(message, 'neo')).toEqual({ reason: 'unknown_origin' });
  });
  it('requires a nonempty exact view identity', () => {
    expect(selectNeoReplyOrigin(reply(), ' ')).toEqual({ reason: 'unknown_origin' });
    expect(selectNeoReplyOrigin(reply(), ' neo ')).toEqual({ reason: 'unknown_origin' });
  });
});

describe('matchNeoReplyInput', () => {
  it('finds the exact original ask when unrelated asks precede a delayed reply', () => {
    const ask = human();
    expect(matchNeoReplyInput(origin, [ask, human('B'), reply()])).toEqual({
      value: { ...origin, ask },
    });
  });
  it.each(
    [
      [],
      [human('B'), reply()],
      [human(), human(), reply()],
      [human(), human('B'), reply(), reply()],
      [reply(), human()],
      [human('A', 'Internal', { inputKind: 'system' }), human('B'), reply()],
      [human('A', 'Child', { parent_tool_use_id: 'tool' }), human('B'), reply()],
      [human('A', 'Other view', { session_id: 'other' }), human('B'), reply()],
      [human(), human('B'), human('reply-A')],
      [human(), human('B'), reply(undefined, { parent_tool_use_id: 'child' })],
      [human(), human('A', 'Internal duplicate', { inputKind: 'system' }), human('B'), reply()],
    ].map((messages) => ({ messages }))
  )('refuses unavailable, duplicate, internal or future inputs', ({ messages }) => {
    expect(matchNeoReplyInput(origin, messages)).toEqual({ reason: 'unavailable_ask' });
  });
  it('uses the human immediately preceding this reply, not the newest ask in all history', () => {
    expect(matchNeoReplyInput(origin, [human(), reply(), human('B')])).toEqual({
      reason: 'direct_reply',
    });
  });
  it('tool and internal inputs do not make a direct reply look delayed', () => {
    expect(
      matchNeoReplyInput(origin, [
        human(),
        human('system', 'Internal', { inputKind: 'system' }),
        human('child', 'Tool result', { parent_tool_use_id: 'tool' }),
        reply(),
      ])
    ).toEqual({ reason: 'direct_reply' });
  });
});

describe('presentNeoReplyContext', () => {
  it('presents bounded literal text without mutating or rendering the source', () => {
    const ask = human('A', '  **Review**\n\t<script>literal</script>  ');
    expect(presentNeoReplyContext({ ...origin, ask }, conversationText)).toEqual({
      value: { messageId: 'A', excerpt: '**Review** <script>literal</script>' },
    });
    expect(conversationText(ask)).toBe('  **Review**\n\t<script>literal</script>  ');
  });
  it('caps long request references at 120 characters', () => {
    expect(
      presentNeoReplyContext({ ...origin, ask: human('A', 'a'.repeat(300)) }, conversationText)
    ).toEqual({
      value: { messageId: 'A', excerpt: `${'a'.repeat(119)}…` },
    });
  });
  it.each(['', ' \n\t '])('does not invent an excerpt for empty ask %j', (text) => {
    expect(presentNeoReplyContext({ ...origin, ask: human('A', text) }, conversationText)).toEqual({
      reason: 'empty_ask',
    });
  });
});

describe('projectNeoReplyContext', () => {
  it('projects A after B independently while direct B stays uncluttered and order is unchanged', () => {
    const a = human();
    const b = human('B', 'Family B — what time?');
    const answerB = reply({ sessionId: 'neo', messageId: 'B' }, { uuid: 'reply-B' });
    const answerA = reply();
    const messages = Object.freeze([a, b, answerB, answerA]);
    expect(projectNeoReplyContext(answerB, 'neo', messages, conversationText)).toBe('direct_reply');
    const context = projectNeoReplyContext(answerA, 'neo', messages, conversationText);
    expect(context).toEqual({ messageId: 'A', excerpt: 'Project A — what is next?' });
    expect(context).not.toBeInstanceOf(Promise);
    expect(messages).toEqual([a, b, answerB, answerA]);
  });
  it('preserves stage precedence and never calls text projection for unknown lineage', () => {
    const readText = vi.fn(() => 'Wrong borrowed answer');
    expect(projectNeoReplyContext(reply(null), 'neo', [], readText)).toBe('unknown_origin');
    expect(readText).not.toHaveBeenCalled();
  });
  it('works independently in a holder view with exact holder-human provenance', () => {
    const a = human('A', 'Research', { session_id: 'holder' });
    const b = human('B', 'Correction', { session_id: 'holder' });
    const answer = reply({ sessionId: 'holder', messageId: 'A' });
    expect(projectNeoReplyContext(answer, 'holder', [a, b, answer], conversationText)).toEqual({
      messageId: 'A',
      excerpt: 'Research',
    });
    expect(projectNeoReplyContext(answer, 'neo', [a, b, answer], conversationText)).toBe(
      'unknown_origin'
    );
  });
});

describe('neoMessageAnchor', () => {
  it('encodes exact DOM anchors without session navigation or UUID collisions', () => {
    expect(neoMessageAnchor('neo:/one', 'ask:A')).toBe('neo-message-neo%3A%2Fone-ask%3AA');
    expect(neoMessageAnchor('neo:/one', 'ask:A')).not.toBe(neoMessageAnchor('neo', '/one-ask:A'));
  });
});
