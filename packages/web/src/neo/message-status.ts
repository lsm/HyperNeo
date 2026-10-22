import type { NeoConversationMessageStatus } from '@hyperneo/shared/types/neo-conversation-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoPublicConversation, NeoPublicEntry } from './public-conversation.ts';

export type NeoMessageStatus = NeoConversationMessageStatus | 'disconnected' | 'stale';

export const NEO_MESSAGE_STATUS_LABELS: Record<NeoMessageStatus, string> = {
  received: 'Received',
  queued: 'Queued',
  working: 'Working',
  read: 'Read',
  answered: 'Answered',
  failed: 'Failed',
  disconnected: 'Disconnected',
  stale: 'Status may be out of date',
};

export const NEO_MESSAGE_STATUS_TITLES: Record<NeoMessageStatus, string> = {
  received: 'Neo accepted this message. No reply yet.',
  queued: 'Neo will start on this after what it is doing now.',
  working: 'Neo is working on this message now.',
  read: 'Neo read this message but has not answered it.',
  answered: 'Neo replied to this message. A reply is not finished work.',
  failed: 'This message did not reach Neo.',
  disconnected: 'Not connected to the daemon, so this status is not current.',
  stale: 'The saved conversation could not be refreshed, so this status may be out of date.',
};

type Ask = Extract<NeoPublicEntry, { kind: 'ask' }>;
export type NeoMessageStatusLink = { connected: boolean; status: NeoPublicConversation['status'] };

export function admitNeoMessageStatusLink(
  link: NeoMessageStatusLink
): { value: NeoMessageStatusLink } | { reason: 'disconnected' | 'stale' } {
  if (!link.connected) return { reason: 'disconnected' };
  return link.status === 'unavailable' ? { reason: 'stale' } : { value: link };
}

export function describeNeoMessageStatus(
  ask: Ask['ask'],
  link: { value: NeoMessageStatusLink } | { reason: 'disconnected' | 'stale' }
): NeoMessageStatus {
  const status = ask.messageStatus ?? (ask.delivery?.state === 'failed' ? 'failed' : 'received');
  if (status === 'failed' || status === 'answered') return status;
  return 'reason' in link ? link.reason : status;
}

export function describeNeoMessageStatuses(
  entries: readonly NeoPublicEntry[],
  link: { value: NeoMessageStatusLink } | { reason: 'disconnected' | 'stale' }
): ReadonlyMap<string, NeoMessageStatus> {
  return new Map(
    entries.flatMap((entry) =>
      entry.kind === 'ask' ? [[entry.ask.requestId, describeNeoMessageStatus(entry.ask, link)]] : []
    )
  );
}

export const projectNeoMessageStatuses = (superpipe({})('neo-message-statuses') as PipelineAPI)
  .input(['entries', 'link'])
  .pipe(admitNeoMessageStatusLink, 'link', 'admitted')
  .pipe(describeNeoMessageStatuses, ['entries', 'admitted'], 'statuses')
  .end('statuses') as (
  entries: readonly NeoPublicEntry[],
  link: NeoMessageStatusLink
) => ReadonlyMap<string, NeoMessageStatus>;
