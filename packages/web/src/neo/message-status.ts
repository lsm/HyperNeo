import type { AgentProcessingState } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoProcessingActivity } from './processing-activity.ts';
import type { NeoPublicConversation, NeoPublicEntry } from './public-conversation.ts';

export type NeoMessageStatus =
  | 'received'
  | 'queued'
  | 'working'
  | 'answered'
  | 'failed'
  | 'disconnected'
  | 'stale';

export const NEO_MESSAGE_STATUS_LABELS: Record<NeoMessageStatus, string> = {
  received: 'Received',
  queued: 'Queued',
  working: 'Working',
  answered: 'Answered',
  failed: 'Failed',
  disconnected: 'Disconnected',
  stale: 'Status may be out of date',
};

export const NEO_MESSAGE_STATUS_TITLES: Record<NeoMessageStatus, string> = {
  received: 'Neo accepted this message. No reply yet.',
  queued: 'Neo will start on this after what it is doing now.',
  working: 'Neo is working on this message now.',
  answered: 'Neo replied to this message. A reply is not finished work.',
  failed: 'This message did not reach Neo.',
  disconnected: 'Not connected to the daemon, so this status is not current.',
  stale: 'The saved conversation could not be refreshed, so this status may be out of date.',
};

type Ask = Extract<NeoPublicEntry, { kind: 'ask' }>;
type Turn = { replied: ReadonlySet<string>; working: string | null; waiting: ReadonlySet<string> };
export type NeoMessageStatusLink = { connected: boolean; status: NeoPublicConversation['status'] };

export function neoRepliedAsks(entries: readonly NeoPublicEntry[]): ReadonlySet<string> {
  return new Set(
    entries.flatMap((entry) =>
      entry.kind === 'publication' && !entry.publication.interim && entry.replyTo
        ? [entry.replyTo.requestId]
        : []
    )
  );
}

export function placeNeoMessageTurn(
  entries: readonly NeoPublicEntry[],
  replied: ReadonlySet<string>,
  activity: NeoProcessingActivity
): Turn {
  const lastAnswered = entries.findLastIndex(
    (entry) => entry.kind === 'ask' && replied.has(entry.ask.requestId)
  );
  const open = entries
    .slice(lastAnswered + 1)
    .filter(
      (entry): entry is Ask =>
        entry.kind === 'ask' &&
        entry.ask.delivery?.state !== 'failed' &&
        !replied.has(entry.ask.requestId)
    )
    .map((entry) => entry.ask.requestId);
  if (activity === 'inactive') return { replied, working: null, waiting: new Set() };
  const working =
    activity.messageId && open.includes(activity.messageId)
      ? activity.messageId
      : (open[0] ?? null);
  return {
    replied,
    working,
    waiting: new Set(open.slice(working ? open.indexOf(working) + 1 : 0)),
  };
}

export function admitNeoMessageStatusLink(
  link: NeoMessageStatusLink
): { value: NeoMessageStatusLink } | { reason: 'disconnected' | 'stale' } {
  if (!link.connected) return { reason: 'disconnected' };
  return link.status === 'unavailable' ? { reason: 'stale' } : { value: link };
}

export function describeNeoMessageStatus(
  ask: Ask['ask'],
  turn: Turn,
  agentState: AgentProcessingState,
  link: { value: NeoMessageStatusLink } | { reason: 'disconnected' | 'stale' }
): NeoMessageStatus {
  if (ask.delivery?.state === 'failed') return 'failed';
  if (turn.replied.has(ask.requestId)) return 'answered';
  if ('reason' in link) return link.reason;
  if (turn.working === ask.requestId)
    return agentState.status === 'processing' && agentState.phase !== 'initializing'
      ? 'working'
      : 'queued';
  return turn.waiting.has(ask.requestId) ? 'queued' : 'received';
}

export function describeNeoMessageStatuses(
  entries: readonly NeoPublicEntry[],
  turn: Turn,
  agentState: AgentProcessingState,
  link: { value: NeoMessageStatusLink } | { reason: 'disconnected' | 'stale' }
): ReadonlyMap<string, NeoMessageStatus> {
  return new Map(
    entries.flatMap((entry) =>
      entry.kind === 'ask'
        ? [[entry.ask.requestId, describeNeoMessageStatus(entry.ask, turn, agentState, link)]]
        : []
    )
  );
}

export const projectNeoMessageStatuses = (superpipe({})('neo-message-statuses') as PipelineAPI)
  .input(['entries', 'activity', 'agentState', 'link'])
  .pipe(neoRepliedAsks, 'entries', 'replied')
  .pipe(placeNeoMessageTurn, ['entries', 'replied', 'activity'], 'turn')
  .pipe(admitNeoMessageStatusLink, 'link', 'admitted')
  .pipe(describeNeoMessageStatuses, ['entries', 'turn', 'agentState', 'admitted'], 'statuses')
  .end('statuses') as (
  entries: readonly NeoPublicEntry[],
  activity: NeoProcessingActivity,
  agentState: AgentProcessingState,
  link: NeoMessageStatusLink
) => ReadonlyMap<string, NeoMessageStatus>;
