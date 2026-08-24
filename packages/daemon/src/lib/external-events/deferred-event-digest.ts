import { generateUUID } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { classifyExternalEventTier, externalEventTopicSuffix } from './event-tiers';

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
  /^(\d+) events received for topics: (.+?) \(oldest: (.+?), newest: (.+?)\)\. Event IDs: (.+?)\. Use get_external_event\(eventId\) for full details\.$/;

function parseRateLimitDigestText(text: string): DeferredExternalEventEntry | null {
  const match = RATE_LIMIT_DIGEST_PATTERN.exec(text.trim());
  if (!match) return null;
  const topics = match[2]!
    .split(',')
    .map((topic) => topic.trim())
    .filter((topic) => topic.length > 0);
  const oldestMs = Date.parse(match[3]!);
  const newestMs = Date.parse(match[4]!);
  const idEntries = match[5]!
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (idEntries.length === 0) return null;
  const events = idEntries.map((entry, index) => {
    const annotated = /^(\S+)\s+\((.+)\)$/.exec(entry);
    const eventId = (annotated ? annotated[1] : entry).trim();
    const topic = annotated
      ? annotated[2]!
      : topics.length === 1
        ? topics[0]!
        : RATE_LIMIT_DIGEST_TOPIC;
    let occurredAt: number | undefined;
    if (Number.isFinite(oldestMs) && Number.isFinite(newestMs)) {
      const span = newestMs - oldestMs;
      occurredAt =
        idEntries.length > 1
          ? oldestMs + Math.round((span * index) / (idEntries.length - 1))
          : newestMs;
    }
    return { eventId, topic, ...(occurredAt !== undefined ? { occurredAt } : {}) };
  });
  return { kind: 'fold', events };
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
    digestEvents.push(...deferredExternalEventEntryEvents(entry));
    if (entry.kind === 'fold') droppedCount += entry.droppedCount ?? 0;
  }
  return { digestRows, digestEvents, droppedCount, remainder };
}

export const DEFERRED_EXTERNAL_EVENT_ROW_CAP = 100;

export const DEFERRED_EVENT_ENVELOPE_MAX_EVENTS = 200;

const DIGEST_SNIPPET_MAX_CHARS = 160;

function essenceTime(entry: ExternalEventEssenceEntry): number {
  const raw: unknown = entry.occurredAt;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : Number.NaN;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric;
  }
  return Number.NaN;
}

function digestTimestamp(entry: ExternalEventEssenceEntry, includeDate = false): string {
  const ms = essenceTime(entry);
  if (!Number.isFinite(ms)) return 'unknown time';
  const iso = new Date(ms).toISOString();
  return `${includeDate ? `${iso.slice(5, 10)} ` : ''}${iso.slice(11, 16)} UTC`;
}

function digestSnippet(body: string | undefined): string | null {
  if (!body) return null;
  const flattened = body.replace(/\s+/g, ' ').trim();
  if (flattened.length === 0) return null;
  return flattened.length > DIGEST_SNIPPET_MAX_CHARS
    ? `${flattened.slice(0, DIGEST_SNIPPET_MAX_CHARS)}…`
    : flattened;
}

function digestLinkSuffix(entry: ExternalEventEssenceEntry): string {
  return entry.externalUrl ? ` — ${entry.externalUrl}` : '';
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
  if (entry.eventType === 'pull_request' || suffix === 'polled') return 'state';
  if (entry.eventType === 'reaction' || suffix === 'reaction_added') return 'reaction';
  return 'other';
}

function digestGroupKey(entry: ExternalEventEssenceEntry, kind: DigestGroupKind): string {
  const scope = `${entry.repo ?? ''}|${entry.prNumber ?? entry.prUrl ?? ''}`;
  switch (kind) {
    case 'check':
      return `check|${scope}|${entry.checkName ?? 'unknown check'}`;
    case 'review':
      return `review|${scope}|${entry.inReplyToId ?? entry.commentId ?? entry.eventId}`;
    case 'pr_comment':
      return `pr_comment|${scope}|${entry.commentId ?? entry.eventId}`;
    case 'state':
      return `state|${scope}`;
    case 'reaction':
      return `reaction|${scope}`;
    case 'other':
      return `other|${entry.topic}`;
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

function renderDigestGroup(group: DigestGroup, includeDate: boolean): string {
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
      const location = latest.path
        ? ` on ${latest.path}${typeof latest.line === 'number' ? `:L${latest.line}` : ''}`
        : '';
      const snippet = digestSnippet(latest.body);
      return (
        `- Review comment${count > 1 ? 's' : ''}${location}: ×${count}, ` +
        `latest by ${latest.actor ?? 'unknown'} at ${digestTimestamp(latest, includeDate)}` +
        `${snippet ? ` — "${snippet}"` : ''}${digestLinkSuffix(latest)}${digestDetailSuffix(latest)}`
      );
    }
    case 'pr_comment': {
      const snippet = digestSnippet(latest.body);
      return (
        `- PR comment${count > 1 ? 's' : ''}: ×${count}, ` +
        `latest by ${latest.actor ?? 'unknown'} at ${digestTimestamp(latest, includeDate)}` +
        `${snippet ? ` — "${snippet}"` : ''}${digestLinkSuffix(latest)}${digestDetailSuffix(latest)}`
      );
    }
    case 'state': {
      const markers = [
        latest.merged === true ? 'merged' : '',
        latest.merged === false && latest.state === 'closed' ? 'not merged' : '',
        latest.draft === true ? 'draft' : '',
      ]
        .filter((marker) => marker.length > 0)
        .join(', ');
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
      if (latest.state) parts.push(`state: ${latest.state}`);
      if (latest.environment) parts.push(`environment: ${latest.environment}`);
      const snippet = digestSnippet(latest.description ?? latest.body);
      if (snippet) parts.push(`"${snippet}"`);
      if (latest.externalUrl) parts.push(latest.externalUrl);
      return `- ${parts.join(' — ')}${digestDetailSuffix(latest)}`;
    }
  }
}

function digestHeader(events: ExternalEventEssenceEntry[], droppedEventCount: number): string {
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
  return `External events while you were working (${total} ${eventWord}${scope}):`;
}

export function buildExternalEventDigestMessage(
  events: ExternalEventEssenceEntry[],
  options?: { droppedEventCount?: number }
): string {
  if (events.length === 0) return '';
  const droppedEventCount = options?.droppedEventCount ?? 0;
  const ordered = events
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const at = essenceTime(a.entry);
      const bt = essenceTime(b.entry);
      const av = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
      const bv = Number.isFinite(bt) ? bt : Number.NEGATIVE_INFINITY;
      return av - bv || a.index - b.index;
    })
    .map((item) => item.entry);
  const includeDate =
    new Set(
      ordered
        .map((entry) => essenceTime(entry))
        .filter((ms) => Number.isFinite(ms))
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
      if (group.kind === kind) lines.push(renderDigestGroup(group, includeDate));
    }
  }
  const footer =
    droppedEventCount > 0
      ? [
          `${droppedEventCount} older events were folded out of earlier overflow envelopes and are superseded.`,
        ]
      : [];
  return [digestHeader(ordered, droppedEventCount), ...lines, ...footer].join('\n');
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
  saveRow(message: SDKUserMessage, sendStatus: 'enqueued' | 'deferred'): Promise<string>;
  markSuperseded(dbIds: string[]): Promise<void>;
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
  const dbId = await args.ops.saveRow(message, 'enqueued');
  await args.ops.markSuperseded(partition.digestRows.map((row) => row.dbId));
  const digestRow: DeferredDeliveryRow = {
    ...message,
    dbId,
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
  const external: Array<{ row: DeferredDeliveryRow; entry: DeferredExternalEventEntry }> = [];
  for (const row of rows) {
    const entry = parseDeferredDeliveryRow(row);
    if (entry && isDigestTierEntry(entry)) external.push({ row, entry });
  }
  if (external.length <= cap) return null;
  const overflowCount = external.length - cap + 1;
  const overflow = external.slice(0, overflowCount);
  return {
    overflowRows: overflow.map((item) => item.row),
    events: overflow.flatMap((item) => deferredExternalEventEntryEvents(item.entry)),
    droppedCount: overflow.reduce(
      (sum, item) => sum + (item.entry.kind === 'fold' ? (item.entry.droppedCount ?? 0) : 0),
      0
    ),
  };
}

export async function foldDeferredExternalEventOverflow(args: {
  sessionId: string;
  rows: DeferredDeliveryRow[];
  cap: number;
  ops: DeferredEventDigestRowOps;
}): Promise<number> {
  const plan = planDeferredExternalEventOverflow(args.rows, args.cap);
  if (!plan) return 0;
  const envelopeText = buildDeferredEventDigestEnvelopeText(
    plan.events,
    plan.droppedCount > 0 ? { carriedDroppedCount: plan.droppedCount } : undefined
  );
  const message = buildSyntheticExternalEventMessage(args.sessionId, envelopeText);
  await args.ops.saveRow(message, 'deferred');
  await args.ops.markSuperseded(plan.overflowRows.map((row) => row.dbId));
  return plan.overflowRows.length;
}
