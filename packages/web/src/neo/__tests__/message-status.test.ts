import {
  NEO_MESSAGE_STATUSES,
  type NeoConversationMessageStatus,
} from '@hyperneo/shared/types/neo-conversation-ask';
import { describe, expect, it } from 'vitest';
import {
  admitNeoMessageStatusLink,
  type NeoMessageStatusLink,
  projectNeoMessageStatuses,
} from '../message-status.ts';
import type { NeoPublicEntry } from '../public-conversation.ts';

const ask = (requestId: string, messageStatus?: NeoConversationMessageStatus, failed = false) =>
  ({
    kind: 'ask',
    key: requestId,
    ask: {
      requestId,
      askOrigin: { sessionId: 'neo', messageId: requestId },
      ...(messageStatus ? { messageStatus } : {}),
      ...(failed ? { delivery: { state: 'failed' } } : {}),
    },
  }) as unknown as NeoPublicEntry;
const reply = (requestId: string) =>
  ({
    kind: 'publication',
    key: `reply-${requestId}`,
    publication: {
      askOrigin: { sessionId: 'neo', messageId: requestId },
      replyTo: [requestId],
    },
  }) as unknown as NeoPublicEntry;
const live: NeoMessageStatusLink = { connected: true, status: 'ready' };
const read = (map: ReadonlyMap<string, string>) => Object.fromEntries(map);

describe('projectNeoMessageStatuses', () => {
  it('displays every status supplied by the daemon', () => {
    expect(
      read(
        projectNeoMessageStatuses(
          NEO_MESSAGE_STATUSES.map((status) => ask(status, status)),
          live
        )
      )
    ).toEqual(Object.fromEntries(NEO_MESSAGE_STATUSES.map((status) => [status, status])));
  });

  it('does not infer working or answered from order or publications', () => {
    expect(
      read(
        projectNeoMessageStatuses(
          [ask('A', 'read'), ask('B', 'queued'), reply('A'), ask('C')],
          live
        )
      )
    ).toEqual({ A: 'read', B: 'queued', C: 'received' });
  });

  it('keeps the legacy delivery failure visible when the optional status is absent', () => {
    expect(read(projectNeoMessageStatuses([ask('A', undefined, true)], live))).toEqual({
      A: 'failed',
    });
  });

  it.each([
    [{ connected: false, status: 'ready' }, 'disconnected'],
    [{ connected: true, status: 'unavailable' }, 'stale'],
  ] as const)('keeps freshness honest when the link is %j', (link, unavailable) => {
    expect(
      read(
        projectNeoMessageStatuses(
          NEO_MESSAGE_STATUSES.map((status) => ask(status, status)),
          link
        )
      )
    ).toEqual(
      Object.fromEntries(
        NEO_MESSAGE_STATUSES.map((status) => [
          status,
          status === 'answered' || status === 'failed' ? status : unavailable,
        ])
      )
    );
  });
});

describe('admitNeoMessageStatusLink', () => {
  it('rejects a dropped connection before a stale conversation', () => {
    expect(admitNeoMessageStatusLink({ connected: false, status: 'unavailable' })).toEqual({
      reason: 'disconnected',
    });
    expect(admitNeoMessageStatusLink(live)).toEqual({ value: live });
  });
});
