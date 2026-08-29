import { generateUUID } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { externalEventTopicSuffix } from './event-tiers.ts';

export interface ExternalEventEssenceEntry {
  eventId: string;
  topic: string;
  eventType?: string;
  action?: string;
  actor?: string;
  repo?: string;
  prNumber?: number;
  prUrl?: string;
  externalUrl?: string;
  occurredAt?: string | number;
  body?: string;
  title?: string;
  state?: string;
  environment?: string;
  description?: string;
  merged?: boolean;
  mergedAt?: string;
  draft?: boolean;
  checkName?: string;
  conclusion?: string;
  commentId?: string;
  inReplyToId?: string;
  path?: string;
  line?: number;
  reviewId?: string;
  context?: string;
  threadId?: string;
  ruleName?: string;
  adminEnforced?: boolean;
  requiredApprovingReviewCount?: number;
  requireCodeOwnerReview?: boolean;
  requiredConversationResolutionLevel?: string;
  strictRequiredStatusChecksPolicy?: boolean;
  requiredStatusChecks?: unknown;
  changedFields?: unknown;
  receivedAt?: number;
}

const POLICY_VALUE_FIELDS = [
  'ruleName',
  'adminEnforced',
  'requiredApprovingReviewCount',
  'requireCodeOwnerReview',
  'requiredConversationResolutionLevel',
  'strictRequiredStatusChecksPolicy',
] as const;

const DIGEST_SNIPPET_MAX_CHARS = 160;

function validEpochMs(ms: number): number {
  if (!Number.isFinite(ms)) return Number.NaN;
  if (Number.isNaN(new Date(ms).getTime())) return Number.NaN;
  return ms;
}

function essenceTime(entry: ExternalEventEssenceEntry): number {
  const raw: unknown = entry.occurredAt;
  if (typeof raw === 'number') return validEpochMs(raw);
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return validEpochMs(parsed);
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return validEpochMs(numeric);
  }
  return Number.NaN;
}

function orderTime(entry: ExternalEventEssenceEntry): number {
  const eventTime = essenceTime(entry);
  if (!Number.isNaN(eventTime)) return eventTime;
  return typeof entry.receivedAt === 'number' ? validEpochMs(entry.receivedAt) : Number.NaN;
}

function digestTimestamp(entry: ExternalEventEssenceEntry, includeDate = false): string {
  const ms = essenceTime(entry);
  if (Number.isNaN(ms)) return 'unknown time';
  const iso = new Date(ms).toISOString();
  return `${includeDate ? `${iso.slice(5, 10)} ` : ''}${iso.slice(11, 16)} UTC`;
}

function digestSnippet(
  body: string | undefined,
  maxChars = DIGEST_SNIPPET_MAX_CHARS
): string | null {
  if (!body) return null;
  const flattened = body.replace(/\s+/g, ' ').trim();
  if (flattened.length === 0) return null;
  if (!Number.isFinite(maxChars)) return flattened;
  return flattened.length > maxChars ? `${flattened.slice(0, maxChars)}…` : flattened;
}

function digestLinkSuffix(entry: ExternalEventEssenceEntry): string {
  const url = entry.externalUrl ?? entry.prUrl;
  return url ? ` — ${url}` : '';
}

function digestDetailSuffix(entry: ExternalEventEssenceEntry): string {
  const parts: string[] = [];
  if (entry.commentId) parts.push(`commentId: ${entry.commentId}`);
  parts.push(`latest eventId: ${entry.eventId}`);
  return ` (${parts.join('; ')})`;
}

function essenceScopeLabel(entry: ExternalEventEssenceEntry): string {
  if (typeof entry.prNumber === 'number') return `PR #${entry.prNumber}`;
  if (entry.repo) return entry.repo;
  return 'PR';
}

type DigestGroupKind = 'check' | 'review' | 'pr_comment' | 'state' | 'reaction' | 'other';

interface DigestGroup {
  kind: DigestGroupKind;
  key: string;
  events: ExternalEventEssenceEntry[];
}

function digestGroupKind(entry: ExternalEventEssenceEntry): DigestGroupKind {
  const suffix = externalEventTopicSuffix(entry.topic);
  if (entry.eventType === 'pull_request_review_comment' || suffix === 'review_comment_polled') {
    return 'review';
  }
  if (entry.eventType === 'issue_comment' || suffix === 'comment_polled') return 'pr_comment';
  if (entry.eventType === 'check_run' || suffix === 'check_failed') return 'check';
  if (suffix === 'polled') return 'state';
  if (entry.eventType === 'pull_request') {
    return !entry.action || entry.action === 'polled' ? 'state' : 'other';
  }
  if (entry.eventType === 'reaction' || suffix === 'reaction_added') return 'reaction';
  return 'other';
}

function digestGroupKey(entry: ExternalEventEssenceEntry, kind: DigestGroupKind): string {
  const scope = `${entry.repo ?? ''}|${entry.prNumber ?? entry.prUrl ?? ''}`;
  switch (kind) {
    case 'check':
      return `check|${scope}|${entry.checkName ?? `event ${entry.eventId}`}`;
    case 'review':
      return `review|${scope}|${entry.inReplyToId ?? entry.commentId ?? entry.eventId}`;
    case 'pr_comment':
      return `pr_comment|${scope}|${entry.commentId ?? entry.eventId}`;
    case 'state':
      return `state|${scope}`;
    case 'reaction':
      if (!entry.body && !entry.actor) return `reaction|${scope}|event ${entry.eventId}`;
      return `reaction|${scope}|${entry.body ?? ''}|${entry.actor ?? ''}`;
    case 'other':
      return `other|${entry.topic}|${
        entry.reviewId ?? entry.context ?? entry.threadId ?? `event ${entry.eventId}`
      }`;
  }
}

const DIGEST_GROUP_ORDER: DigestGroupKind[] = [
  'check',
  'review',
  'pr_comment',
  'state',
  'reaction',
  'other',
];

function cancelledConclusion(conclusion: string | undefined): boolean {
  return conclusion === 'canceled' || conclusion === 'cancelled';
}

function digestStateMarkers(entry: ExternalEventEssenceEntry): string {
  return [
    entry.merged === true ? 'merged' : '',
    entry.merged === false && entry.state === 'closed' ? 'not merged' : '',
    entry.draft === true ? 'draft' : '',
  ]
    .filter((marker) => marker.length > 0)
    .join(', ');
}

function digestActionLabel(entry: ExternalEventEssenceEntry): string {
  if (!entry.action || entry.action === 'polled' || entry.action === 'created') return '';
  return ` (${entry.action})`;
}

interface DigestRenderOptions {
  snippetMaxChars?: number;
  renderAllReviewBodies?: boolean;
}

export interface RenderEventBlockOptions extends DigestRenderOptions {
  count?: number;
  events?: ExternalEventEssenceEntry[];
  includeDate?: boolean;
}

export function renderEventBlock(
  entry: ExternalEventEssenceEntry,
  options: RenderEventBlockOptions = {}
): string {
  const snippetMaxChars = options.snippetMaxChars ?? DIGEST_SNIPPET_MAX_CHARS;
  const includeDate = options.includeDate ?? false;
  const events = options.events ?? [entry];
  const latest = entry;
  const count = options.count ?? events.length;
  switch (digestGroupKind(entry)) {
    case 'check': {
      const cancelled = events.filter((entry) => cancelledConclusion(entry.conclusion)).length;
      const mostlyCancelled =
        cancelled > count / 2 ? ' (most cancelled, likely superseded by newer pushes)' : '';
      const byConclusion = new Map<string, number>();
      for (const entry of events) {
        const conclusion = entry.conclusion ?? 'unknown';
        byConclusion.set(conclusion, (byConclusion.get(conclusion) ?? 0) + 1);
      }
      const counts = [...byConclusion.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
      );
      const countText =
        counts.length === 1
          ? `${counts[0][0]} ×${counts[0][1]}`
          : `${count} runs (${counts.map(([conclusion, runs]) => `${conclusion} ×${runs}`).join(', ')})`;
      return (
        `- CI check "${latest.checkName ?? 'unknown check'}": ` +
        `${countText}, latest ${digestTimestamp(latest, includeDate)}${mostlyCancelled}` +
        `${digestLinkSuffix(latest)}${digestDetailSuffix(latest)}`
      );
    }
    case 'review': {
      if (options.renderAllReviewBodies && count > 1) {
        return events
          .map((event) => {
            const location = event.path
              ? ` on ${event.path}${typeof event.line === 'number' ? `:L${event.line}` : ''}`
              : '';
            const snippet = digestSnippet(event.body, snippetMaxChars);
            return (
              `- Review comment by ${event.actor ?? 'unknown'} at ${digestTimestamp(event, includeDate)}${location}` +
              `${snippet ? ` — "${snippet}"` : ''}${digestLinkSuffix(event)}${digestDetailSuffix(event)}`
            );
          })
          .join('\n');
      }
      const location = latest.path
        ? ` on ${latest.path}${typeof latest.line === 'number' ? `:L${latest.line}` : ''}`
        : '';
      const snippet = digestSnippet(latest.body, snippetMaxChars);
      return (
        `- Review comment${count > 1 ? 's' : ''}${digestActionLabel(latest)}${location}: ×${count}, ` +
        `latest by ${latest.actor ?? 'unknown'} at ${digestTimestamp(latest, includeDate)}` +
        `${snippet ? ` — "${snippet}"` : ''}${digestLinkSuffix(latest)}${digestDetailSuffix(latest)}`
      );
    }
    case 'pr_comment': {
      const snippet = digestSnippet(latest.body, snippetMaxChars);
      return (
        `- PR comment${count > 1 ? 's' : ''}${digestActionLabel(latest)}: ×${count}, ` +
        `latest by ${latest.actor ?? 'unknown'} at ${digestTimestamp(latest, includeDate)}` +
        `${snippet ? ` — "${snippet}"` : ''}${digestLinkSuffix(latest)}${digestDetailSuffix(latest)}`
      );
    }
    case 'state': {
      const markers = digestStateMarkers(latest);
      return (
        `- ${essenceScopeLabel(latest)} state: ${latest.state ?? 'updated'}` +
        `${markers ? ` (${markers})` : ''} ` +
        `(latest poll ${digestTimestamp(latest, includeDate)}, ×${count} polls folded)` +
        `${digestLinkSuffix(latest)}${digestDetailSuffix(latest)}`
      );
    }
    case 'reaction':
      return (
        `- Reactions on ${essenceScopeLabel(latest)}: ×${count}, ` +
        `latest ${latest.body ?? 'reaction'} by ${latest.actor ?? 'unknown'} at ` +
        `${digestTimestamp(latest, includeDate)}${digestLinkSuffix(latest)}${digestDetailSuffix(latest)}`
      );
    case 'other': {
      const parts = [`${latest.topic}: ×${count} (latest ${digestTimestamp(latest, includeDate)})`];
      if (latest.action && latest.action !== 'polled') {
        parts.push(`${latest.action} by ${latest.actor ?? 'unknown'}`);
      }
      if (latest.state) {
        const markers = digestStateMarkers(latest);
        parts.push(`state: ${latest.state}${markers ? ` (${markers})` : ''}`);
      }
      if (latest.environment) parts.push(`environment: ${latest.environment}`);
      const snippet = digestSnippet(latest.description ?? latest.body, snippetMaxChars);
      if (snippet) parts.push(`"${snippet}"`);
      const structured = [latest.changedFields, latest.requiredStatusChecks]
        .filter((field): field is object => !!field)
        .map((field) => digestSnippet(JSON.stringify(field)));
      for (const field of structured) {
        if (field) parts.push(field);
      }
      const policyValues: Record<string, unknown> = {};
      for (const field of POLICY_VALUE_FIELDS) {
        if (latest[field] !== undefined) policyValues[field] = latest[field];
      }
      if (Object.keys(policyValues).length > 0) {
        const policySnippet = digestSnippet(JSON.stringify(policyValues));
        if (policySnippet) parts.push(policySnippet);
      }
      const url = latest.externalUrl ?? latest.prUrl;
      if (url) parts.push(url);
      return `- ${parts.join(' — ')}${digestDetailSuffix(latest)}`;
    }
  }
}

function renderDigestGroup(
  group: DigestGroup,
  includeDate: boolean,
  options: DigestRenderOptions = {}
): string {
  const events = group.events;
  const latest = events[events.length - 1];
  if (!latest) return '';
  return renderEventBlock(latest, { ...options, includeDate, count: events.length, events });
}

function digestHeader(
  events: ExternalEventEssenceEntry[],
  droppedEventCount: number,
  title?: string
): string {
  const prNumbers = [
    ...new Set(
      events.map((entry) => entry.prNumber).filter((n): n is number => typeof n === 'number')
    ),
  ].sort((a, b) => a - b);
  const repos = [
    ...new Set(events.map((entry) => entry.repo).filter((r): r is string => !!r)),
  ].sort();
  let scope = '';
  if (prNumbers.length === 1) scope = `, PR #${prNumbers[0]}`;
  else if (prNumbers.length > 1) scope = `, PRs ${prNumbers.map((n) => `#${n}`).join(', ')}`;
  else if (repos.length === 1) scope = `, ${repos[0]}`;
  const total = events.length + droppedEventCount;
  const eventWord = total === 1 ? 'event' : 'events';
  return `${title ?? 'External events while you were working'} (${total} ${eventWord}${scope}):`;
}

export function orderEssencesByOccurrence(
  entries: ExternalEventEssenceEntry[]
): ExternalEventEssenceEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const at = orderTime(a.entry);
      const bt = orderTime(b.entry);
      const av = Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
      const bv = Number.isNaN(bt) ? Number.NEGATIVE_INFINITY : bt;
      return av - bv || a.index - b.index;
    })
    .map((item) => item.entry);
}

export function buildExternalEventDigestMessage(
  events: ExternalEventEssenceEntry[],
  options?: {
    droppedEventCount?: number;
    title?: string;
    snippetMaxChars?: number;
    renderAllReviewBodies?: boolean;
  }
): string {
  if (events.length === 0) return '';
  const droppedEventCount = options?.droppedEventCount ?? 0;
  const ordered = orderEssencesByOccurrence(events);
  const includeDate =
    new Set(
      ordered
        .map((entry) => essenceTime(entry))
        .filter((ms) => !Number.isNaN(ms))
        .map((ms) => new Date(ms).toISOString().slice(0, 10))
    ).size > 1;
  const groups = new Map<string, DigestGroup>();
  for (const entry of ordered) {
    const kind = digestGroupKind(entry);
    const key = digestGroupKey(entry, kind);
    const existing = groups.get(key);
    if (existing) existing.events.push(entry);
    else groups.set(key, { kind, key, events: [entry] });
  }
  const lines: string[] = [];
  for (const kind of DIGEST_GROUP_ORDER) {
    for (const group of groups.values()) {
      if (group.kind === kind) lines.push(renderDigestGroup(group, includeDate, { ...options }));
    }
  }
  const footer =
    droppedEventCount > 0
      ? [
          `${droppedEventCount} older events were omitted from this summary (over the event bound) and may still need attention.`,
        ]
      : [];
  return [digestHeader(ordered, droppedEventCount, options?.title), ...lines, ...footer].join('\n');
}

export function buildSyntheticExternalEventMessage(
  sessionId: string,
  text: string,
  uuid: string = generateUUID()
): SDKUserMessage {
  return {
    type: 'user',
    uuid: uuid as SDKUserMessage['uuid'],
    session_id: sessionId,
    parent_tool_use_id: null,
    isSynthetic: true,
    inputKind: 'system',
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as SDKUserMessage;
}
