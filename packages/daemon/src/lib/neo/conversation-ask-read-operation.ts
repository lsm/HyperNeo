import type { Database } from '../../storage/sqlite-compat.ts';
import { NeoPreviewReferenceSchema } from './preview-context-schema.ts';
import { presentNeoPreviewAsk } from './preview-context.ts';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type {
  NeoConversationAsk,
  NeoConversationAskPageItem,
  NeoConversationImageRef,
} from '@hyperneo/shared/types/neo-conversation-ask';
import { NEO_MESSAGE_STATUSES } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoMessageStatusPresenter } from './message-status.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import type {
  NeoConversationAskImageRow,
  NeoConversationAskRepository,
} from '../../storage/repositories/neo-conversation-ask-repository.ts';
import { isLocalUser } from '../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { NeoConversationAskSchema, NeoReplyToSchema } from './conversation-ask.ts';
import { neoImageSize } from './image-size.ts';
import {
  NeoConversationPageInput,
  NeoConversationPageShape,
  isNeoConversationSession,
  neoConversationPageCursorValid,
  readNeoConversationPage,
  requirePublicationConversation,
  requirePublicationReader,
} from './publication-read-operation.ts';

type Page = z.infer<typeof NeoConversationPageInput>;
const AskPageInput = NeoConversationPageShape.extend({
  imageRefs: z.boolean().optional(),
}).refine(neoConversationPageCursorValid);
type AskPage = z.infer<typeof AskPageInput>;
type Result =
  | { ok: false; reason: 'human_only' | 'conversation_not_found' }
  | {
      ok: true;
      conversationId: string;
      items: Array<NeoConversationAsk | NeoConversationAskPageItem>;
      nextAfter: number;
    };

const StoredAsk = z
  .preprocess(
    (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const { sequence, createdAt, delivery, messageStatus, ...ask } = value as Record<
        string,
        unknown
      >;
      return { sequence, createdAt, delivery, messageStatus, ask };
    },
    z.object({
      sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      createdAt: z.iso.datetime(),
      messageStatus: z.enum(NEO_MESSAGE_STATUSES).optional(),
      delivery: z
        .object({ state: z.literal('failed') })
        .strict()
        .optional(),
      ask: NeoConversationAskSchema,
    })
  )
  .transform(({ sequence, createdAt, delivery, messageStatus, ask }) => ({
    ...ask,
    sequence,
    createdAt,
    ...(delivery ? { delivery } : {}),
    ...(messageStatus ? { messageStatus } : {}),
  }));

const ImageRefSchema = z
  .object({
    type: z.literal('image_ref'),
    imageId: z.string(),
    mediaType: z.string(),
    bytes: z.number().int().nonnegative(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    thumbnail: z.object({ mediaType: z.string(), data: z.string() }).nullable(),
  })
  .strict();

export const NeoConversationAskPageSchema = z.object({
  conversationId: z.uuid(),
  requestId: z.uuid(),
  askOrigin: z.object({ sessionId: z.string(), messageId: z.uuid() }),
  content: z.array(z.union([ImageRefSchema, z.record(z.string(), z.unknown())])),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.iso.datetime(),
  replyTo: NeoReplyToSchema.optional(),
  previewContext: NeoPreviewReferenceSchema.optional(),
  delivery: z.object({ state: z.literal('failed') }).optional(),
  messageStatus: z.enum(NEO_MESSAGE_STATUSES).optional(),
});

async function readAskStatus(
  result: Result,
  presentStatus: NeoMessageStatusPresenter,
  database: Database | undefined,
  caller: OperationCaller
): Promise<Result> {
  if (!result.ok) return result;
  const items = await presentStatus(result.items);
  return {
    ...result,
    items: database
      ? await Promise.all(items.map((ask) => presentNeoPreviewAsk(ask, database, caller)))
      : items,
  };
}

export function neoConversationImageId(sequence: number, index: number): string {
  return `${sequence}:${index}`;
}

type AskBlock = Exclude<NeoConversationAsk['content'], string>[number];
type PageBlock = NeoConversationAskPageItem['content'][number];

function neoAskBlocks(item: NeoConversationAsk): AskBlock[] {
  return typeof item.content === 'string'
    ? [{ type: 'text', text: item.content }]
    : [...item.content];
}

export function presentNeoAskImageRefs(
  items: readonly NeoConversationAsk[],
  rows: readonly NeoConversationAskImageRow[]
): NeoConversationAskPageItem[] {
  const stored = new Map(rows.map((row) => [`${row.requestId}:${row.index}`, row]));
  return items.map((item) => ({
    ...item,
    content: neoAskBlocks(item).map((block: AskBlock, index: number): PageBlock => {
      if (block.type !== 'image' || block.source.type !== 'base64') return block;
      const row = stored.get(`${item.requestId}:${index}`);
      const read = row?.width && row.height ? null : neoImageSize(block.source.data);
      const ref: NeoConversationImageRef = {
        type: 'image_ref',
        imageId: neoConversationImageId(item.sequence, index),
        mediaType: block.source.media_type,
        bytes: Math.floor((block.source.data.length * 3) / 4),
        width: row?.width ?? read?.width ?? null,
        height: row?.height ?? read?.height ?? null,
        thumbnail: row?.thumbnail ?? null,
      };
      return ref;
    }),
  }));
}

function readAskImageRefs(
  request: AskPage,
  result: Result,
  ledger: NeoConversationAskRepository
): Result {
  if (!result.ok || !request.imageRefs) return result;
  const asks = result.items as NeoConversationAsk[];
  return {
    ...result,
    items: presentNeoAskImageRefs(
      asks,
      ledger.images(
        result.conversationId,
        asks.map((item) => item.requestId)
      )
    ),
  };
}

const read = (superpipe({})('neo-conversation-ask-read') as PipelineAPI)
  .input(['request', 'caller', 'repo', 'ledger', 'presentStatus', 'database'])
  .pipe((request: AskPage): Page => request, 'request', 'page')
  .pipe(
    (caller: OperationCaller, repo: NeoRepository) =>
      caller.source === 'mcp' && caller.sessionId
        ? repo.getBindingBySession(caller.sessionId)
        : null,
    ['caller', 'repo'],
    'binding'
  )
  .pipe(requirePublicationReader, ['page', 'caller', 'binding'], 'result:page')
  .pipe((repo: NeoRepository) => repo.conversationId(), 'repo', 'conversation')
  .pipe(requirePublicationConversation, ['page', 'conversation'], 'result:page')
  .pipe(
    (page: Page, ledger: NeoConversationAskRepository) =>
      readNeoConversationPage(page, ledger, 'ask'),
    ['page', 'ledger'],
    'page'
  )
  .pipe(readAskStatus, ['page', 'presentStatus', 'database', 'caller'], 'page')
  .pipe(readAskImageRefs, ['request', 'page', 'ledger'], 'page')
  .endAsync('page') as (
  request: AskPage,
  caller: OperationCaller,
  repo: NeoRepository,
  ledger: NeoConversationAskRepository,
  presentStatus: NeoMessageStatusPresenter,
  database: Database | undefined
) => Promise<Result>;

export function createNeoConversationAskReadOperation(
  repo: NeoRepository,
  ledger: NeoConversationAskRepository,
  presentStatus: NeoMessageStatusPresenter = (items) => [...items],
  database?: Database
) {
  return defineOperation({
    name: 'neo.conversation.asks.read',
    description:
      'Read one bounded ascending page of durably accepted human asks for the current public conversation. Original request identities and content are preserved; this never reads execution transcripts or starts a query. messageStatus is computed by the daemon: received, queued, working, read, answered or failed. Only a publication explicitly citing a consumed input in replyTo marks it answered; read without a reply stays read. Use nextAfter for later pages, or pass before (for example Number.MAX_SAFE_INTEGER for the newest page) to read the page that ends just before that sequence. An ask that could not be delivered also carries delivery: { state: "failed" }. With imageRefs: true, each photo comes back as { type: "image_ref", imageId, mediaType, bytes, width, height, thumbnail } instead of its full data; read the full photo with neo.conversation.image.read.',
    policy: { safetyClass: 'read', roles: ['neo'] },
    inputSchema: AskPageInput,
    resultSchema: z.union([
      z.object({ ok: z.literal(false), reason: z.enum(['human_only', 'conversation_not_found']) }),
      z.object({
        ok: z.literal(true),
        conversationId: z.uuid(),
        items: z.array(z.union([StoredAsk, NeoConversationAskPageSchema])).max(100),
        nextAfter: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      }),
    ]),
    execute: async (page, caller) => read(page, caller, repo, ledger, presentStatus, database),
  });
}

type ImageInput = { conversationId: string; imageId: string };
type ImageFailure = {
  ok: false;
  reason: 'human_only' | 'conversation_not_found' | 'image_not_found';
};
type ImageResult = ImageFailure | { ok: true; imageId: string; mediaType: string; data: string };

export function requireNeoImageReader(
  input: ImageInput,
  caller: OperationCaller,
  binding: NeoBinding | null
): { value: ImageInput } | { reason: ImageFailure } {
  return isLocalUser(caller) || isNeoConversationSession(caller, binding)
    ? { value: input }
    : { reason: { ok: false, reason: 'human_only' } };
}

export function requireNeoImageConversation(
  input: ImageInput,
  repo: NeoRepository
): { value: ImageInput } | { reason: ImageFailure } {
  return repo.conversationId() === input.conversationId
    ? { value: input }
    : { reason: { ok: false, reason: 'conversation_not_found' } };
}

export function readNeoConversationImage(
  input: ImageInput,
  ask: NeoConversationAsk | null
): ImageResult {
  const index = Number(input.imageId.split(':')[1]);
  const block = Array.isArray(ask?.content) ? ask.content[index] : undefined;
  return block?.type === 'image' && block.source.type === 'base64'
    ? {
        ok: true,
        imageId: input.imageId,
        mediaType: block.source.media_type,
        data: block.source.data,
      }
    : { ok: false, reason: 'image_not_found' };
}

const readImage = (superpipe({})('neo-conversation-image-read') as PipelineAPI)
  .input(['input', 'caller', 'repo', 'ledger'])
  .pipe(
    (caller: OperationCaller, repo: NeoRepository) =>
      caller.source === 'mcp' && caller.sessionId
        ? repo.getBindingBySession(caller.sessionId)
        : null,
    ['caller', 'repo'],
    'binding'
  )
  .pipe(requireNeoImageReader, ['input', 'caller', 'binding'], 'result:image')
  .pipe(requireNeoImageConversation, ['input', 'repo'], 'result:image')
  .pipe(
    (input: ImageInput, ledger: NeoConversationAskRepository) =>
      ledger.findBySequence(input.conversationId, Number(input.imageId.split(':')[0])),
    ['input', 'ledger'],
    'ask'
  )
  .pipe(readNeoConversationImage, ['input', 'ask'], 'image')
  .end('image') as (
  input: ImageInput,
  caller: OperationCaller,
  repo: NeoRepository,
  ledger: NeoConversationAskRepository
) => ImageResult;

export function createNeoConversationImageReadOperation(
  repo: NeoRepository,
  ledger: NeoConversationAskRepository
) {
  return defineOperation({
    name: 'neo.conversation.image.read',
    description:
      'Read one full photo from a human ask in the current public conversation, by the imageId that neo.conversation.asks.read returns with imageRefs: true.',
    policy: { safetyClass: 'read', roles: ['neo'] },
    inputSchema: z
      .object({
        conversationId: z.uuid(),
        imageId: z
          .string()
          .regex(/^[1-9]\d{0,15}:\d{1,6}$/)
          .meta({ examples: ['1:0'] }),
      })
      .strict(),
    resultSchema: z.union([
      z.object({
        ok: z.literal(false),
        reason: z.enum(['human_only', 'conversation_not_found', 'image_not_found']),
      }),
      z.object({
        ok: z.literal(true),
        imageId: z.string(),
        mediaType: z.string(),
        data: z.string(),
      }),
    ]),
    execute: async (input, caller) => readImage(input, caller, repo, ledger),
  });
}
