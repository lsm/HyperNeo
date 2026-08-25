import { createHash } from 'node:crypto';
import { generateUUID } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { classifyExternalEventTier, externalEventTopicSuffix } from './event-tiers.ts';

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

export type DeferredExternalEventEntry =
  | { kind: 'event'; essence: ExternalEventEssenceEntry }
  | { kind: 'fold'; events: ExternalEventEssenceEntry[]; droppedCount?: number };

export type DeferredDeliveryRow = SDKUserMessage & { dbId: string; timestamp: number };

const ESSENCE_ENTRY_FIELDS = [
  'eventType',
  'action',
  'actor',
  'repo',
  'prNumber',
  'prUrl',
  'externalUrl',
  'occurredAt',
  'body',
  'title',
  'state',
  'environment',
  'description',
  'checkName',
  'conclusion',
  'commentId',
  'inReplyToId',
  'path',
  'line',
  'merged',
  'mergedAt',
  'draft',
  'reviewId',
  'context',
  'threadId',
  'ruleName',
  'adminEnforced',
  'requiredApprovingReviewCount',
  'requireCodeOwnerReview',
  'requiredConversationResolutionLevel',
  'strictRequiredStatusChecksPolicy',
  'receivedAt',
] as const;

const ESSENCE_STRUCTURED_FIELDS = ['requiredStatusChecks', 'changedFields'] as const;

const POLICY_VALUE_FIELDS = [
  'ruleName',
  'adminEnforced',
  'requiredApprovingReviewCount',
  'requireCodeOwnerReview',
  'requiredConversationResolutionLevel',
  'strictRequiredStatusChecksPolicy',
] as const;

function parseEssenceEntry(value: unknown): ExternalEventEssenceEntry | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.eventId !== 'string' || record.eventId.length === 0) return null;
  if (typeof record.topic !== 'string' || record.topic.length === 0) return null;
  const entry: Record<string, unknown> = { eventId: record.eventId, topic: record.topic };
  for (const field of ESSENCE_ENTRY_FIELDS) {
    const raw = record[field];
    if (typeof raw === 'string' && raw.length > 0) entry[field] = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) entry[field] = raw;
    else if (typeof raw === 'boolean') entry[field] = raw;
  }
  for (const field of ESSENCE_STRUCTURED_FIELDS) {
    const raw = record[field];
    if (raw !== null && typeof raw === 'object') entry[field] = raw;
  }
  const topicScope = scopeFromTopic(record.topic);
  for (const [field, value] of Object.entries(topicScope)) {
    if (entry[field] === undefined) entry[field] = value;
  }
  return entry as unknown as ExternalEventEssenceEntry;
}

export function parseDeferredExternalEventText(text: string): DeferredExternalEventEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return parseRateLimitDigestText(text);
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (record.type === 'external_event') {
    const essence = parseEssenceEntry(record);
    return essence ? { kind: 'event', essence } : null;
  }
  if (record.type === 'external_event_digest') {
    if (!Array.isArray(record.events)) return null;
    const events = record.events
      .map(parseEssenceEntry)
      .filter((entry): entry is ExternalEventEssenceEntry => entry !== null);
    if (events.length === 0) return null;
    const droppedRaw = record.droppedEventCount;
    const droppedCount =
      typeof droppedRaw === 'number' && Number.isFinite(droppedRaw) && droppedRaw > 0
        ? Math.floor(droppedRaw)
        : 0;
    return droppedCount > 0 ? { kind: 'fold', events, droppedCount } : { kind: 'fold', events };
  }
  return null;
}

const RATE_LIMIT_DIGEST_TOPIC = 'external_event.rate_limited';

const RATE_LIMIT_DIGEST_PATTERN =
  /^(\d+) events received for topics: (.+?) \(oldest: (.+?), newest: (.+?)\)\. Event IDs: (.+?)\. Use get_external_event\(eventId\) for full details\.$/s;

function scopeFromTopic(topic: string): { repo?: string; prNumber?: number; prUrl?: string } {
  const segments = topic.split('/');
  if (segments.length < 5 || segments[0] !== 'github') return {};
  const owner = segments[1]!;
  const repoName = segments[2]!;
  const resource = segments[3]!;
  const entity = (segments[4] ?? '').split('.')[0] ?? '';
  const prNumber = /^\d+$/.test(entity) ? Number(entity) : undefined;
  return {
    ...(owner && repoName ? { repo: `${owner}/${repoName}` } : {}),
    ...(resource === 'pull_request' && prNumber !== undefined
      ? { prNumber, prUrl: `https://github.com/${owner}/${repoName}/pull/${prNumber}` }
      : {}),
  };
}

function parseRateLimitDigestText(text: string): DeferredExternalEventEntry | null {
  const match = RATE_LIMIT_DIGEST_PATTERN.exec(text.trim());
  if (!match) return null;
  const topics = match[2]!
    .split(',')
    .map((topic) => topic.trim())
    .filter((topic) => topic.length > 0);
  const newestMs = Date.parse(match[4]!);
  const idEntries = parseRateLimitIdEntries(match[5]!, topics);
  if (idEntries.length === 0) return null;
  const events = idEntries.map(({ eventId, topic }) => {
    const occurredAt = idEntries.length === 1 && Number.isFinite(newestMs) ? newestMs : undefined;
    return {
      eventId,
      topic,
      ...scopeFromTopic(topic),
      ...(occurredAt !== undefined ? { occurredAt } : {}),
    };
  });
  return { kind: 'fold', events };
}

function parseRateLimitIdEntries(
  raw: string,
  topics: string[]
): Array<{ eventId: string; topic: string }> {
  if (raw.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const entries = parsed
          .map((item): { eventId: string; topic: string } | null => {
            if (!item || typeof item !== 'object') return null;
            const record = item as Record<string, unknown>;
            if (typeof record.id !== 'string' || record.id.length === 0) return null;
            if (typeof record.topic !== 'string' || record.topic.length === 0) return null;
            return { eventId: record.id, topic: record.topic };
          })
          .filter((entry): entry is { eventId: string; topic: string } => entry !== null);
        if (entries.length > 0) return entries;
      }
    } catch {
      return [];
    }
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const annotated = /^(\S+)\s+\((.+)\)$/.exec(entry);
      return {
        eventId: (annotated ? annotated[1] : entry).trim(),
        topic: annotated
          ? annotated[2]!
          : topics.length === 1
            ? topics[0]!
            : RATE_LIMIT_DIGEST_TOPIC,
      };
    });
}

export function deferredExternalEventEntryEvents(
  entry: DeferredExternalEventEntry
): ExternalEventEssenceEntry[] {
  return entry.kind === 'event' ? [entry.essence] : entry.events;
}

function rowText(row: SDKUserMessage): string {
  const content = row.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block && typeof block === 'object' && (block as { type?: string }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : ''
    )
    .join('\n');
}

export function isSystemInjectedRow(row: SDKUserMessage): boolean {
  const inputKind = (row as SDKUserMessage & { inputKind?: unknown }).inputKind;
  if (inputKind === 'system') return true;
  return inputKind === undefined && row.isSynthetic === true;
}

export function parseDeferredDeliveryRow(row: SDKUserMessage): DeferredExternalEventEntry | null {
  if (!isSystemInjectedRow(row)) return null;
  return parseDeferredExternalEventText(rowText(row));
}

export function isDigestTierEntry(entry: DeferredExternalEventEntry): boolean {
  if (entry.kind === 'fold') return true;
  return classifyExternalEventTier(entry.essence.topic) === 'digest';
}

export interface DeferredExternalEventPartition {
  digestRows: DeferredDeliveryRow[];
  digestEvents: ExternalEventEssenceEntry[];
  droppedCount: number;
  remainder: DeferredDeliveryRow[];
}

export function partitionDeferredExternalEventRows(
  rows: DeferredDeliveryRow[]
): DeferredExternalEventPartition {
  const digestRows: DeferredDeliveryRow[] = [];
  const digestEvents: ExternalEventEssenceEntry[] = [];
  const remainder: DeferredDeliveryRow[] = [];
  let droppedCount = 0;
  for (const row of rows) {
    const entry = parseDeferredDeliveryRow(row);
    if (!entry || !isDigestTierEntry(entry)) {
      remainder.push(row);
      continue;
    }
    digestRows.push(row);
    const stamped = deferredExternalEventEntryEvents(entry).map((event) =>
      Number.isNaN(essenceTime(event)) ? withReceiptHint(event, row.timestamp) : event
    );
    for (const event of stamped) {
      digestEvents.push(event);
    }
    if (entry.kind === 'fold') droppedCount += entry.droppedCount ?? 0;
  }
  dedupeInPlaceByEventId(digestEvents);
  if (digestEvents.length > DEFERRED_EVENT_ENVELOPE_MAX_EVENTS) {
    const overflow = digestEvents.length - DEFERRED_EVENT_ENVELOPE_MAX_EVENTS;
    digestEvents.splice(0, overflow);
    droppedCount += overflow;
  }
  return { digestRows, digestEvents, droppedCount, remainder };
}

export const DEFERRED_EXTERNAL_EVENT_ROW_CAP = 100;

export const DEFERRED_EVENT_ENVELOPE_MAX_EVENTS = 200;

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

function withReceiptHint(
  event: ExternalEventEssenceEntry,
  rowTimestamp: number
): ExternalEventEssenceEntry {
  if (typeof event.receivedAt === 'number' && !Number.isNaN(validEpochMs(event.receivedAt))) {
    return event;
  }
  return Number.isFinite(rowTimestamp) ? { ...event, receivedAt: rowTimestamp } : event;
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

function renderDigestGroup(
  group: DigestGroup,
  includeDate: boolean,
  options: DigestRenderOptions = {}
): string {
  const snippetMaxChars = options.snippetMaxChars ?? DIGEST_SNIPPET_MAX_CHARS;
  const events = group.events;
  const latest = events[events.length - 1];
  if (!latest) return '';
  const count = events.length;
  switch (group.kind) {
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
  const ordered = events
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const at = orderTime(a.entry);
      const bt = orderTime(b.entry);
      const av = Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
      const bv = Number.isNaN(bt) ? Number.NEGATIVE_INFINITY : bt;
      return av - bv || a.index - b.index;
    })
    .map((item) => item.entry);
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

export function buildDeferredEventDigestEnvelopeText(
  events: ExternalEventEssenceEntry[],
  options?: { carriedDroppedCount?: number }
): string {
  const truncated = Math.max(0, events.length - DEFERRED_EVENT_ENVELOPE_MAX_EVENTS);
  const kept =
    truncated > 0 ? events.slice(events.length - DEFERRED_EVENT_ENVELOPE_MAX_EVENTS) : events;
  const droppedEventCount = truncated + (options?.carriedDroppedCount ?? 0);
  return JSON.stringify({
    type: 'external_event_digest',
    events: kept,
    ...(droppedEventCount > 0 ? { droppedEventCount } : {}),
  });
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

export interface DeferredEventDigestRowOps {
  findByUuid(uuid: string): Promise<{ dbId: string } | null>;
  supersedeStaleFolds?(keepUuid: string): Promise<void>;
  saveRow(message: SDKUserMessage, sendStatus: 'enqueued' | 'deferred'): Promise<string>;
  markSuperseded(dbIds: string[]): Promise<void>;
}

function deterministicFoldUuid(sourceDbIds: string[]): string {
  const digest = createHash('sha256')
    .update([...sourceDbIds].sort().join('\u0000'))
    .digest('hex');
  return `fold-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(
    16,
    20
  )}-${digest.slice(20, 32)}`;
}

export const DEFERRED_FOLD_UUID_PREFIX = 'fold-';

async function saveFoldRowIdempotently(
  ops: DeferredEventDigestRowOps,
  sourceDbIds: string[],
  message: SDKUserMessage,
  sendStatus: 'enqueued' | 'deferred'
): Promise<{ dbId: string; message: SDKUserMessage }> {
  const uuid = deterministicFoldUuid(sourceDbIds);
  const existing = await ops.findByUuid(uuid);
  if (existing) {
    return { dbId: existing.dbId, message: { ...message, uuid: uuid as SDKUserMessage['uuid'] } };
  }
  const withUuid = { ...message, uuid: uuid as SDKUserMessage['uuid'] };
  return { dbId: await ops.saveRow(withUuid, sendStatus), message: withUuid };
}

export interface DeferredEventDigestFlushResult {
  digestRow: DeferredDeliveryRow | null;
  remainder: DeferredDeliveryRow[];
  foldedCount: number;
}

export async function foldDeferredExternalEventsAtFlush(args: {
  sessionId: string;
  rows: DeferredDeliveryRow[];
  ops: DeferredEventDigestRowOps;
}): Promise<DeferredEventDigestFlushResult> {
  const partition = partitionDeferredExternalEventRows(args.rows);
  if (partition.digestRows.length === 0) {
    return { digestRow: null, remainder: args.rows, foldedCount: 0 };
  }
  const digestText = buildExternalEventDigestMessage(partition.digestEvents, {
    droppedEventCount: partition.droppedCount,
  });
  const message = buildSyntheticExternalEventMessage(args.sessionId, digestText);
  const sourceDbIds = partition.digestRows.map((row) => row.dbId);
  const keepUuid = deterministicFoldUuid(sourceDbIds);
  await args.ops.supersedeStaleFolds?.(keepUuid);
  const saved = await saveFoldRowIdempotently(args.ops, sourceDbIds, message, 'enqueued');
  await args.ops.markSuperseded(sourceDbIds);
  const digestRow: DeferredDeliveryRow = {
    ...saved.message,
    dbId: saved.dbId,
    timestamp: Date.now(),
  } as DeferredDeliveryRow;
  return {
    digestRow,
    remainder: partition.remainder,
    foldedCount: partition.digestEvents.length + partition.droppedCount,
  };
}

export interface DeferredEventOverflowFold {
  overflowRows: DeferredDeliveryRow[];
  events: ExternalEventEssenceEntry[];
  droppedCount: number;
}

export function planDeferredExternalEventOverflow(
  rows: DeferredDeliveryRow[],
  cap: number
): DeferredEventOverflowFold | null {
  const raws: Array<{ row: DeferredDeliveryRow; entry: DeferredExternalEventEntry }> = [];
  const folds: Array<{ row: DeferredDeliveryRow; entry: DeferredExternalEventEntry }> = [];
  for (const row of rows) {
    const entry = parseDeferredDeliveryRow(row);
    if (!entry || !isDigestTierEntry(entry)) continue;
    if (entry.kind === 'fold') folds.push({ row, entry });
    else raws.push({ row, entry });
  }
  const total = raws.length + folds.length;
  if (total <= cap) return null;
  const take = total - cap + 1;
  const fromFolds = Math.min(folds.length, take);
  const overflow = [...folds.slice(0, fromFolds), ...raws.slice(0, take - fromFolds)];
  return {
    overflowRows: overflow.map((item) => item.row),
    events: dedupeEventsByEventId(
      overflow.flatMap((item) =>
        deferredExternalEventEntryEvents(item.entry).map((event) =>
          Number.isNaN(essenceTime(event)) ? withReceiptHint(event, item.row.timestamp) : event
        )
      )
    ),
    droppedCount: overflow.reduce(
      (sum, item) => sum + (item.entry.kind === 'fold' ? (item.entry.droppedCount ?? 0) : 0),
      0
    ),
  };
}

function dedupeEventsByEventId(events: ExternalEventEssenceEntry[]): ExternalEventEssenceEntry[] {
  const byId = new Map<string, ExternalEventEssenceEntry>();
  for (const event of events) byId.set(event.eventId, event);
  return [...byId.values()];
}

function dedupeInPlaceByEventId(events: ExternalEventEssenceEntry[]): void {
  const deduped = dedupeEventsByEventId(events);
  events.splice(0, events.length, ...deduped);
}

export interface DeferredEventOverflowFoldResult {
  foldedRows: number;
  supersededUuids: string[];
  envelopeMessage: SDKUserMessage;
  envelopeDbId: string;
  envelopeText: string;
}

export async function foldDeferredExternalEventOverflow(args: {
  sessionId: string;
  rows: DeferredDeliveryRow[];
  cap: number;
  ops: DeferredEventDigestRowOps;
}): Promise<DeferredEventOverflowFoldResult | null> {
  const plan = planDeferredExternalEventOverflow(args.rows, args.cap);
  if (!plan) return null;
  const envelopeText = buildDeferredEventDigestEnvelopeText(
    plan.events,
    plan.droppedCount > 0 ? { carriedDroppedCount: plan.droppedCount } : undefined
  );
  const message = buildSyntheticExternalEventMessage(args.sessionId, envelopeText);
  const sourceDbIds = plan.overflowRows.map((row) => row.dbId);
  const saved = await saveFoldRowIdempotently(args.ops, sourceDbIds, message, 'deferred');
  await args.ops.markSuperseded(sourceDbIds);
  return {
    foldedRows: plan.overflowRows.length,
    supersededUuids: plan.overflowRows.map((row) => String(row.uuid)),
    envelopeMessage: saved.message,
    envelopeDbId: saved.dbId,
    envelopeText,
  };
}
