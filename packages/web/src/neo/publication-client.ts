import type { MessageHub } from '@hyperneo/shared';
import type { NeoPublication, NeoCardReply } from '@hyperneo/shared/types/neo-publication';
import { ARTIFACT_KINDS, type ArtifactRef } from '@hyperneo/shared/types/artifact-file';
import superpipe, { type PipelineAPI } from 'superpipe';
import { invokeOperation } from '../lib/operations.ts';

export type PublicationPage = {
  conversationId: string;
  after: number;
  limit?: number;
  before?: number;
};
type Cursor = Required<Omit<PublicationPage, 'before'>> & { before?: number };
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

function artifactRefs(value: unknown): ArtifactRef[] | null {
  if (!Array.isArray(value) || value.length > 16) return null;
  const refs: ArtifactRef[] = [];
  for (const entry of value) {
    const ref = object(entry);
    if (
      !ref ||
      !text(ref.daemonId, 200) ||
      !text(ref.artifactId, 200) ||
      !text(ref.title, 300) ||
      !ARTIFACT_KINDS.includes(ref.kind as ArtifactRef['kind']) ||
      !counter(ref.byteLength)
    )
      return null;
    refs.push({
      daemonId: ref.daemonId,
      artifactId: ref.artifactId,
      title: ref.title,
      kind: ref.kind as ArtifactRef['kind'],
      byteLength: ref.byteLength,
    });
  }
  return refs;
}

export function admitPublicationCursor(page: Cursor): { value: Cursor } | { reason: Unavailable } {
  return uuid.test(page.conversationId) &&
    counter(page.after) &&
    counter(page.limit) &&
    page.limit >= 1 &&
    page.limit <= 100 &&
    (page.before === undefined || (counter(page.before) && page.before >= 1 && page.after === 0))
    ? { value: page }
    : { reason: { state: 'unavailable' } };
}

export function admitPublicationLifetime(current: boolean): { value: true } | { reason: Stale } {
  return current ? { value: true } : { reason: { state: 'stale' } };
}

function optionalOrigin(value: unknown): NeoPublication['askOrigin'] | null | undefined {
  if (value === undefined) return undefined;
  const row = object(value);
  return row && text(row.sessionId, 160) && text(row.messageId, 160)
    ? { sessionId: row.sessionId, messageId: row.messageId }
    : null;
}

function revision(value: unknown): NonNullable<NeoPublication['revisions']>[number] | null {
  const row = object(value);
  const producer = optionalOrigin(row?.producerInput);
  const ask = optionalOrigin(row?.askOrigin);
  if (
    !row ||
    ask === null ||
    typeof row.revisionId !== 'string' ||
    !uuid.test(row.revisionId) ||
    !text(row.shortText, 2000) ||
    !text(row.fullText, 16000) ||
    !text(row.createdAt, 40) ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    producer === null ||
    (row.awaiting !== undefined && !text(row.awaiting, 500))
  )
    return null;
  return {
    revisionId: row.revisionId,
    shortText: row.shortText,
    fullText: row.fullText,
    createdAt: row.createdAt,
    ...(producer ? { producerInput: producer } : {}),
    ...(ask ? { askOrigin: ask } : {}),
    ...(typeof row.awaiting === 'string' ? { awaiting: row.awaiting } : {}),
  };
}

function publication(value: unknown, page: Cursor): NeoPublication | null {
  const row = object(value);
  if (!row) return null;
  const ask = optionalOrigin(row.askOrigin);
  const producer = optionalOrigin(row.producerInput);
  const answer = optionalOrigin(row.answerInput);
  const answerOrigin = optionalOrigin(row.answerOrigin);
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
    ask === null ||
    producer === null ||
    !Array.isArray(row.links) ||
    row.links.length > 16 ||
    (row.editedAt !== undefined &&
      (!text(row.editedAt, 40) || !Number.isFinite(Date.parse(row.editedAt)))) ||
    (row.editedBy !== undefined && !text(row.editedBy, 160)) ||
    answer === null ||
    answerOrigin === null ||
    (row.revisionId !== undefined &&
      (typeof row.revisionId !== 'string' || !uuid.test(row.revisionId))) ||
    (row.revisions !== undefined && !Array.isArray(row.revisions)) ||
    (row.replyTo !== undefined &&
      (!Array.isArray(row.replyTo) ||
        row.replyTo.length > 100 ||
        !row.replyTo.every((id) => typeof id === 'string' && uuid.test(id))))
  )
    return null;
  const cardReply = object(row.cardReply);
  if (
    row.cardReply !== undefined &&
    (!cardReply ||
      !Array.isArray(cardReply.sourceMessageIds) ||
      !cardReply.sourceMessageIds.length ||
      cardReply.sourceMessageIds.length > 100 ||
      !cardReply.sourceMessageIds.every((id) => typeof id === 'string' && uuid.test(id)) ||
      !text(cardReply.askId, 160) ||
      !text(cardReply.questionId, 160) ||
      typeof cardReply.mutationId !== 'string' ||
      !uuid.test(cardReply.mutationId))
  )
    return null;
  const artifacts = row.artifacts === undefined ? undefined : artifactRefs(row.artifacts);
  if (artifacts === null) return null;
  const revisions: NonNullable<NeoPublication['revisions']>[number][] = [];
  const revisionIds = new Set([row.revisionId ?? row.publicationId]);
  for (const value of (row.revisions ?? []) as unknown[]) {
    const saved = revision(value);
    if (!saved || revisionIds.has(saved.revisionId)) return null;
    revisionIds.add(saved.revisionId);
    revisions.push(saved);
  }
  const links: NeoPublication['links'][number][] = [];
  for (const value of row.links) {
    const link = object(value);
    if (
      !link ||
      !text(link.label, 120) ||
      !text(link.id, 160) ||
      typeof link.kind !== 'string' ||
      !['project', 'work', 'consultation'].includes(link.kind)
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
    ...(ask ? { askOrigin: ask } : {}),
    ...(producer ? { producerInput: producer } : {}),
    links,
    ...(cardReply ? { cardReply: cardReply as unknown as NeoCardReply } : {}),
    ...(row.replyTo !== undefined ? { replyTo: row.replyTo as string[] } : {}),
    ...(typeof row.editedAt === 'string' ? { editedAt: row.editedAt } : {}),
    ...(typeof row.editedBy === 'string' ? { editedBy: row.editedBy } : {}),
    ...(answer ? { answerInput: answer } : {}),
    ...(answerOrigin ? { answerOrigin } : {}),
    ...(typeof row.revisionId === 'string' ? { revisionId: row.revisionId } : {}),
    ...(row.revisions !== undefined ? { revisions } : {}),
    ...(artifacts ? { artifacts } : {}),
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
      item.sequence >= (page.before ?? Number.POSITIVE_INFINITY) ||
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
