import type { ChatMessage } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { describe, expect, it } from 'vitest';
import {
  matchNeoWorkReplyReceipt,
  projectNeoWorkReply,
  selectNeoWorkReplyInput,
} from '../work-reply.ts';

const work = { id: 'work-A', report: 'Draft evidence A', status: 'reported' } as NeoWork;
const reviewed = 'neo-consult:neo-work:work-A:review:reply';
const receipts = new Map([
  [work.id, work],
  [reviewed, work],
]);
function response(
  neoInputOrigin: unknown = { sessionId: 'neo', messageId: work.id },
  extra = {}
): ChatMessage {
  return {
    type: 'assistant',
    uuid: 'reply-A',
    parent_tool_use_id: null,
    neoInputOrigin,
    message: { role: 'assistant', content: 'The draft is ready.' },
    ...extra,
  } as unknown as ChatMessage;
}

describe('selectNeoWorkReplyInput', () => {
  it('selects the actual query input, not the human lineage or prose', () => {
    expect(
      selectNeoWorkReplyInput(
        response(undefined, { neoAskOrigin: { sessionId: 'neo', messageId: 'ask-A' } }),
        'neo'
      )
    ).toEqual({ value: { messageId: work.id, replyId: 'reply-A' } });
  });
  it.each([
    null,
    undefined,
    [],
    {},
    false,
    'work-A',
    { sessionId: 'other', messageId: work.id },
    { sessionId: 'neo', messageId: '' },
    { sessionId: 'neo', messageId: ' ' },
    { sessionId: 'neo', messageId: 123 },
  ])('explicit unusable metadata %j never downgrades to legacy guessing', (origin) => {
    expect(selectNeoWorkReplyInput(response(origin, { neoInputOrigin: origin }), 'neo')).toEqual({
      reason: 'unknown_origin',
    });
  });
  it('keeps metadata-absent history as legacy instead of backfilling it', () => {
    const { neoInputOrigin: _removed, ...legacy } = response() as ChatMessage & {
      neoInputOrigin: unknown;
    };
    expect(selectNeoWorkReplyInput(legacy as ChatMessage, 'neo')).toEqual({ reason: 'legacy' });
  });
  it('other message kinds do not gain work detail from a guessed origin', () => {
    expect(selectNeoWorkReplyInput(response(undefined, { type: 'user' }), 'neo')).toEqual({
      reason: 'legacy',
    });
    expect(
      selectNeoWorkReplyInput(response(undefined, { parent_tool_use_id: 'child' }), 'neo')
    ).toEqual({ reason: 'unknown_origin' });
    expect(selectNeoWorkReplyInput(response(undefined, { uuid: undefined }), 'neo')).toEqual({
      reason: 'unknown_origin',
    });
  });
  it.each(['', ' ', ' neo '])('requires the exact known view %j', (view) => {
    expect(selectNeoWorkReplyInput(response(), view)).toEqual({ reason: 'unknown_origin' });
  });
});

describe('matchNeoWorkReplyReceipt', () => {
  it.each([work.id, reviewed])('matches the exact raw or reviewed receipt %s', (messageId) => {
    expect(matchNeoWorkReplyReceipt({ messageId, replyId: 'reply-A' }, receipts)).toEqual({
      value: { replyId: 'reply-A', work },
    });
  });
  it.each(['proposed', 'queued', 'cancelled'])(
    'never calls a %s work a returned response',
    (status) => {
      expect(
        matchNeoWorkReplyReceipt(
          { messageId: work.id, replyId: 'reply-A' },
          new Map([[work.id, { ...work, status } as NeoWork]])
        )
      ).toEqual({ reason: 'no_report' });
    }
  );
  it('accepts scoped failure evidence without changing the reported status', () => {
    const failed = { ...work, status: 'failed' as const };
    expect(
      matchNeoWorkReplyReceipt(
        { messageId: work.id, replyId: 'reply-A' },
        new Map([[work.id, failed]])
      )
    ).toEqual({ value: { replyId: 'reply-A', work: failed } });
  });
  it('does not invent a missing report or trust a receipt map alias for another work', () => {
    for (const map of [
      new Map(),
      new Map([[work.id, { ...work, report: null }]]),
      new Map([[work.id, { ...work, id: 'work-B' }]]),
    ])
      expect(matchNeoWorkReplyReceipt({ messageId: work.id, replyId: 'reply-A' }, map)).toEqual({
        reason: 'no_report',
      });
  });
});

describe('projectNeoWorkReply', () => {
  it('is synchronous and preserves the actual reported work object', () => {
    const input = Object.freeze(response());
    const output = projectNeoWorkReply(input, 'neo', receipts);
    expect(output).toEqual({ replyId: 'reply-A', work });
    expect(output).not.toBeInstanceOf(Promise);
    expect(typeof output === 'object' && output.work).toBe(work);
    expect(receipts.size).toBe(2);
  });
  it('preserves metadata-rejection precedence over a coincidental work-map entry', () => {
    expect(projectNeoWorkReply(response(null), 'neo', receipts)).toBe('unknown_origin');
    expect(
      projectNeoWorkReply(response({ sessionId: 'neo', messageId: 'ask-B' }), 'neo', receipts)
    ).toBe('no_report');
  });
});
