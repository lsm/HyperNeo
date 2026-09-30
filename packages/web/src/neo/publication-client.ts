import type { MessageHub } from '@hyperneo/shared';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import { invokeOperation } from '../lib/operations.ts';

export type PublicationPage = { conversationId: string; after: number; limit?: number };
type Cursor = Required<PublicationPage>;
type Unavailable = { state: 'unavailable' };
type Stale = { state: 'stale' };
export type PublicationRead =
  | { state: 'ready'; items: readonly NeoPublication[]; nextAfter: number }
  | Unavailable
  | Stale;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !!value.trim();
const counter = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function admitPublicationCursor(page: Cursor): { value: Cursor } | { reason: Unavailable } {
  return uuid.test(page.conversationId) &&
    counter(page.after) &&
    counter(page.limit) &&
    page.limit >= 1 &&
    page.limit <= 100
    ? { value: page }
    : { reason: { state: 'unavailable' } };
}

export function admitPublicationLifetime(current: boolean): { value: true } | { reason: Stale } {
  return current ? { value: true } : { reason: { state: 'stale' } };
}

function publication(value: unknown, page: Cursor): NeoPublication | null {
  const row = object(value);
  if (!row) return null;
  const ask = object(row.askOrigin);
  const producer = object(row.producerInput);
  if (
    row.conversationId !== page.conversationId ||
    typeof row.publicationId !== 'string' ||
    !uuid.test(row.publicationId) ||
    !counter(row.sequence) ||
    row.sequence <= page.after ||
    !text(row.createdAt, 40) ||
    !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(row.createdAt) ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    !text(row.shortText, 2000) ||
    !text(row.fullText, 16000) ||
    !ask ||
    !text(ask.sessionId, 160) ||
    !text(ask.messageId, 160) ||
    !producer ||
    !text(producer.sessionId, 160) ||
    !text(producer.messageId, 160) ||
    !Array.isArray(row.links) ||
    row.links.length > 16
  )
    return null;
  const links: NeoPublication['links'][number][] = [];
  for (const value of row.links) {
    const link = object(value);
    if (
      !link ||
      !text(link.label, 120) ||
      !text(link.id, 160) ||
      typeof link.kind !== 'string' ||
      !['concern', 'work', 'consultation'].includes(link.kind)
    )
      return null;
    links.push({
      label: link.label,
      id: link.id,
      kind: link.kind as NeoPublication['links'][number]['kind'],
    });
  }
  return {
    conversationId: page.conversationId,
    publicationId: row.publicationId,
    sequence: row.sequence,
    createdAt: row.createdAt,
    shortText: row.shortText,
    fullText: row.fullText,
    askOrigin: { sessionId: ask.sessionId, messageId: ask.messageId },
    producerInput: { sessionId: producer.sessionId, messageId: producer.messageId },
    links,
  };
}

export function presentPublicationPage(
  response: unknown,
  page: Cursor
): { value: Extract<PublicationRead, { state: 'ready' }> } | { reason: Unavailable } {
  const result = object(response);
  const denied = { reason: { state: 'unavailable' as const } };
  if (
    !result ||
    result.ok !== true ||
    result.conversationId !== page.conversationId ||
    !Array.isArray(result.items) ||
    result.items.length > page.limit
  )
    return denied;
  const items: NeoPublication[] = [];
  const ids = new Set<string>();
  for (const value of result.items) {
    const item = publication(value, page);
    if (
      !item ||
      item.sequence <= (items.at(-1)?.sequence ?? page.after) ||
      ids.has(item.publicationId)
    )
      return denied;
    ids.add(item.publicationId);
    items.push(item);
  }
  const nextAfter = items.at(-1)?.sequence ?? page.after;
  return result.nextAfter === nextAfter ? { value: { state: 'ready', items, nextAfter } } : denied;
}

const read = (superpipe({})('neo-publication-client') as PipelineAPI)
  .input(['page', 'getHub', 'current'])
  .pipe(admitPublicationCursor, 'page', 'result:read')
  .pipe((current: () => boolean) => current(), 'current', 'live')
  .pipe(admitPublicationLifetime, 'live', 'result:read')
  .pipe((getHub: () => Promise<MessageHub>) => getHub(), 'getHub', 'hub')
  .pipe((current: () => boolean) => current(), 'current', 'live')
  .pipe(admitPublicationLifetime, 'live', 'result:read')
  .pipe(
    (hub: MessageHub, page: Cursor) => invokeOperation<unknown>(hub, 'neo.publication.read', page),
    ['hub', 'page'],
    'response'
  )
  .pipe((current: () => boolean) => current(), 'current', 'live')
  .pipe(admitPublicationLifetime, 'live', 'result:read')
  .pipe(presentPublicationPage, ['response', 'page'], 'result:read')
  .endAsync('read') as (
  page: Cursor,
  getHub: () => Promise<MessageHub>,
  current: () => boolean
) => Promise<PublicationRead>;

export async function readNeoPublications(
  page: PublicationPage,
  getHub: () => Promise<MessageHub>,
  current: () => boolean
): Promise<PublicationRead> {
  try {
    return await read({ ...page, limit: page.limit ?? 50 }, getHub, current);
  } catch {
    return current() ? { state: 'unavailable' } : { state: 'stale' };
  }
}
