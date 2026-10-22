import type { MessageHub, MessageImage } from '@hyperneo/shared';
import {
  NEO_MESSAGE_STATUSES,
  type NeoConversationAsk,
  type NeoConversationAskPageItem,
  type NeoConversationImageRef,
} from '@hyperneo/shared/types/neo-conversation-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { invokeOperation } from '../lib/operations.ts';
import { admitPublicationCursor, admitPublicationLifetime } from './publication-client.ts';

export type ConversationAskPage = {
  conversationId: string;
  after: number;
  limit?: number;
  before?: number;
};
type Cursor = Required<Omit<ConversationAskPage, 'before'>> & { before?: number };
type Unavailable = { state: 'unavailable' };
type Stale = { state: 'stale' };
export type ConversationAskRead =
  | { state: 'ready'; items: readonly NeoConversationAskPageItem[]; nextAfter: number }
  | Unavailable
  | Stale;
export type NeoAskItem = NeoConversationAsk | NeoConversationAskPageItem;
type AskContent = NeoConversationAskPageItem['content'];
type AskImage = Extract<AskContent[number], { type: 'image' }>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mediaTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const thumbnailTypes = ['image/png', 'image/jpeg', 'image/webp'];
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !!value.trim();
const counter = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const extent = (value: unknown): value is number | null =>
  value === null || (counter(value) && value > 0);

function imageRef(block: Record<string, unknown>): NeoConversationImageRef | null {
  const thumbnail = block.thumbnail === null ? null : object(block.thumbnail);
  if (
    typeof block.imageId !== 'string' ||
    block.imageId.length === 0 ||
    typeof block.mediaType !== 'string' ||
    !mediaTypes.includes(block.mediaType) ||
    !counter(block.bytes) ||
    !extent(block.width) ||
    !extent(block.height) ||
    (block.thumbnail !== null &&
      (!thumbnail ||
        typeof thumbnail.mediaType !== 'string' ||
        !thumbnailTypes.includes(thumbnail.mediaType) ||
        typeof thumbnail.data !== 'string' ||
        thumbnail.data.length === 0))
  )
    return null;
  return {
    type: 'image_ref',
    imageId: block.imageId,
    mediaType: block.mediaType,
    bytes: block.bytes,
    width: block.width,
    height: block.height,
    thumbnail: thumbnail
      ? { mediaType: thumbnail.mediaType as string, data: thumbnail.data as string }
      : null,
  };
}

function askBlock(value: unknown): AskContent[number] | null {
  const block = object(value);
  if (!block) return null;
  if (block.type === 'text')
    return typeof block.text === 'string' && block.text.length > 0
      ? { type: 'text', text: block.text }
      : null;
  if (block.type === 'image_ref') return imageRef(block);
  const source = object(block.source);
  if (
    block.type !== 'image' ||
    !source ||
    source.type !== 'base64' ||
    typeof source.media_type !== 'string' ||
    !mediaTypes.includes(source.media_type) ||
    typeof source.data !== 'string' ||
    source.data.length === 0
  )
    return null;
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: source.media_type as AskImage['source']['media_type'],
      data: source.data,
    },
  };
}

function askContent(value: unknown): AskContent | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const blocks: AskContent[number][] = [];
  for (const entry of value) {
    const block = askBlock(entry);
    if (!block) return null;
    blocks.push(block);
  }
  return blocks;
}

function ask(value: unknown, page: Cursor): NeoConversationAskPageItem | null {
  const row = object(value);
  const origin = object(row?.askOrigin);
  if (
    !row ||
    row.conversationId !== page.conversationId ||
    typeof row.requestId !== 'string' ||
    !uuid.test(row.requestId) ||
    !origin ||
    !text(origin.sessionId, 160) ||
    typeof origin.messageId !== 'string' ||
    !uuid.test(origin.messageId) ||
    row.requestId !== origin.messageId ||
    !counter(row.sequence) ||
    row.sequence < 1 ||
    row.sequence <= page.after ||
    !text(row.createdAt, 40) ||
    !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(row.createdAt) ||
    !Number.isFinite(Date.parse(row.createdAt))
  )
    return null;
  const content = askContent(row.content);
  if (!content) return null;
  const messageStatus = NEO_MESSAGE_STATUSES.find((status) => status === row.messageStatus);
  if (row.messageStatus !== undefined && !messageStatus) return null;
  const replyTo = object(row.replyTo);
  return {
    conversationId: page.conversationId,
    requestId: row.requestId,
    askOrigin: { sessionId: origin.sessionId, messageId: origin.messageId },
    sequence: row.sequence,
    createdAt: row.createdAt,
    content,
    ...(messageStatus ? { messageStatus } : {}),
    ...(object(row.delivery)?.state === 'failed' ? { delivery: { state: 'failed' as const } } : {}),
    ...(replyTo &&
    (replyTo.kind === 'question' || replyTo.kind === 'todo' || replyTo.kind === 'message') &&
    text(replyTo.id, 160)
      ? {
          replyTo: {
            kind: replyTo.kind,
            id: replyTo.id,
            ...(replyTo.author === 'neo' || replyTo.author === 'user'
              ? { author: replyTo.author }
              : {}),
            ...(text(replyTo.excerpt, 1200) ? { excerpt: replyTo.excerpt } : {}),
          },
        }
      : {}),
  };
}

export function presentConversationAskPage(
  response: unknown,
  page: Cursor
): { value: Extract<ConversationAskRead, { state: 'ready' }> } | { reason: Unavailable } {
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
  const items: NeoConversationAskPageItem[] = [];
  const ids = new Set<string>();
  for (const value of result.items) {
    const item = ask(value, page);
    if (
      !item ||
      item.sequence <= (items.at(-1)?.sequence ?? page.after) ||
      item.sequence >= (page.before ?? Number.POSITIVE_INFINITY) ||
      ids.has(item.requestId)
    )
      return denied;
    ids.add(item.requestId);
    items.push(item);
  }
  const nextAfter = items.at(-1)?.sequence ?? page.after;
  return result.nextAfter === nextAfter ? { value: { state: 'ready', items, nextAfter } } : denied;
}

const read = (superpipe({})('neo-conversation-ask-client') as PipelineAPI)
  .input(['page', 'getHub', 'current'])
  .pipe(admitPublicationCursor, 'page', 'result:read')
  .pipe((current: () => boolean) => current(), 'current', 'live')
  .pipe(admitPublicationLifetime, 'live', 'result:read')
  .pipe((getHub: () => Promise<MessageHub>) => getHub(), 'getHub', 'hub')
  .pipe((current: () => boolean) => current(), 'current', 'live')
  .pipe(admitPublicationLifetime, 'live', 'result:read')
  .pipe(
    (hub: MessageHub, page: Cursor) =>
      invokeOperation<unknown>(hub, 'neo.conversation.asks.read', { ...page, imageRefs: true }),
    ['hub', 'page'],
    'response'
  )
  .pipe((current: () => boolean) => current(), 'current', 'live')
  .pipe(admitPublicationLifetime, 'live', 'result:read')
  .pipe(presentConversationAskPage, ['response', 'page'], 'result:read')
  .endAsync('read') as (
  page: Cursor,
  getHub: () => Promise<MessageHub>,
  current: () => boolean
) => Promise<ConversationAskRead>;

export async function readNeoConversationAsks(
  page: ConversationAskPage,
  getHub: () => Promise<MessageHub>,
  current: () => boolean
): Promise<ConversationAskRead> {
  try {
    return await read({ ...page, limit: page.limit ?? 50 }, getHub, current);
  } catch {
    return current() ? { state: 'unavailable' } : { state: 'stale' };
  }
}

type ConversationImageRead = { state: 'ready'; image: MessageImage } | Unavailable;
type ImageRequest = { conversationId: string; imageId: string };

function admitConversationImageRequest(
  request: ImageRequest
): { value: ImageRequest } | { reason: Unavailable } {
  return uuid.test(request.conversationId) && request.imageId.length > 0
    ? { value: { conversationId: request.conversationId, imageId: request.imageId } }
    : { reason: { state: 'unavailable' } };
}

function presentConversationImage(response: unknown, request: ImageRequest): ConversationImageRead {
  const result = object(response);
  return result?.ok === true &&
    result.imageId === request.imageId &&
    typeof result.mediaType === 'string' &&
    mediaTypes.includes(result.mediaType) &&
    typeof result.data === 'string' &&
    result.data.length > 0
    ? {
        state: 'ready',
        image: { media_type: result.mediaType as MessageImage['media_type'], data: result.data },
      }
    : { state: 'unavailable' };
}

const readImage = (superpipe({})('neo-conversation-image-client') as PipelineAPI)
  .input(['request', 'getHub'])
  .pipe(admitConversationImageRequest, 'request', 'result:image')
  .pipe((getHub: () => Promise<MessageHub>) => getHub(), 'getHub', 'hub')
  .pipe(
    (hub: MessageHub, request: ImageRequest) =>
      invokeOperation<unknown>(hub, 'neo.conversation.image.read', request),
    ['hub', 'request'],
    'response'
  )
  .pipe(presentConversationImage, ['response', 'request'], 'image')
  .endAsync('image') as (
  request: ImageRequest,
  getHub: () => Promise<MessageHub>
) => Promise<ConversationImageRead>;

export async function readNeoConversationImage(
  request: ImageRequest,
  getHub: () => Promise<MessageHub>
): Promise<ConversationImageRead> {
  try {
    return await readImage(request, getHub);
  } catch {
    return { state: 'unavailable' };
  }
}

const resolveAskImages = (superpipe({})('neo-conversation-ask-images') as PipelineAPI)
  .input(['ask', 'getHub'])
  .pipe(
    (ask: NeoAskItem, getHub: () => Promise<MessageHub>) =>
      Promise.all(
        (Array.isArray(ask.content) ? ask.content : []).flatMap(
          (block: AskContent[number]): Promise<ConversationImageRead>[] => {
            if (block.type === 'image_ref')
              return [
                readNeoConversationImage(
                  { conversationId: ask.conversationId, imageId: block.imageId },
                  getHub
                ),
              ];
            return block.type === 'image' && block.source.type === 'base64'
              ? [
                  Promise.resolve({
                    state: 'ready',
                    image: { data: block.source.data, media_type: block.source.media_type },
                  }),
                ]
              : [];
          }
        )
      ),
    ['ask', 'getHub'],
    'reads'
  )
  .pipe(
    (reads: ConversationImageRead[]) =>
      reads.every((read) => read.state === 'ready')
        ? reads.map((read) => (read as Extract<ConversationImageRead, { state: 'ready' }>).image)
        : null,
    'reads',
    'images'
  )
  .endAsync('images') as (
  ask: NeoAskItem,
  getHub: () => Promise<MessageHub>
) => Promise<MessageImage[] | null>;

export function readNeoAskImages(
  ask: NeoAskItem,
  getHub: () => Promise<MessageHub>
): Promise<MessageImage[] | null> {
  return resolveAskImages(ask, getHub).then(
    (images) => images ?? null,
    () => null
  );
}
