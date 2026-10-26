import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createNeoConversationAskReadOperation,
  createNeoConversationImageReadOperation,
} from '../../../../src/lib/neo/conversation-ask-read-operation.ts';
import { neoImageSize } from '../../../../src/lib/neo/image-size.ts';
import { neoIntakeImages } from '../../../../src/lib/neo/intake.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoConversationAskRepository } from '../../../../src/storage/repositories/neo-conversation-ask-repository.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration289 } from '../../../../src/storage/schema/m289-neo-conversation-asks.ts';
import { runMigration349 } from '../../../../src/storage/schema/m349-neo-conversation-ask-images.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = { sessionId: `neo:${conversationId}`, kind: 'neo' as const, projectId: null };
const human: OperationCaller = { source: 'rpc', principal: 'local' };

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (width: number, height: number) =>
  b64([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0,
  ]);
const jpeg = (width: number, height: number) =>
  b64([
    0xff,
    0xd8,
    0xff,
    0xe1,
    0,
    4,
    0,
    0,
    0xff,
    0xc0,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    3,
    0,
    0,
    0,
  ]);

describe('neoImageSize', () => {
  test('reads width and height from PNG, JPEG and GIF headers', () => {
    expect(neoImageSize(png(1200, 800))).toEqual({ width: 1200, height: 800 });
    expect(neoImageSize(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 });
    expect(neoImageSize(b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 40, 0, 30, 0]))).toEqual({
      width: 40,
      height: 30,
    });
    expect(neoImageSize(b64([1, 2, 3]))).toBeNull();
  });
});

describe('neoIntakeImages', () => {
  test('records each photo with its size, and its thumbnail when the sender made one', () => {
    expect(
      neoIntakeImages({
        sessionId: root.sessionId,
        requestId: '20000000-0000-4000-8000-000000000001',
        content: [
          { type: 'text', text: 'Look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(10, 20) } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        ],
        thumbnails: [
          { index: 2, mediaType: 'image/jpeg', data: 'dGh1bWI=', width: 64, height: 48 },
        ],
      })
    ).toEqual([
      { index: 1, width: 10, height: 20, thumbnail: null },
      {
        index: 2,
        width: 64,
        height: 48,
        thumbnail: { mediaType: 'image/jpeg', data: 'dGh1bWI=' },
      },
    ]);
  });
});

describe('conversation photos as references', () => {
  let mailbox: MailboxTestDb;
  let repo: NeoRepository;
  let ledger: NeoConversationAskRepository;
  const registry = () =>
    createOperationRegistry([
      createNeoConversationAskReadOperation(repo, ledger),
      createNeoConversationImageReadOperation(repo, ledger),
    ]);
  const requestId = '20000000-0000-4000-8000-000000000001';
  const photo = png(1200, 800);
  const old = jpeg(640, 480);

  beforeEach(() => {
    mailbox = createMailboxTestDb();
    createNeoTables(mailbox.db);
    runMigration289(mailbox.db);
    runMigration349(mailbox.db);
    repo = new NeoRepository(mailbox.db);
    ledger = new NeoConversationAskRepository(mailbox.db);
    repo.reserveBinding(root);
    ledger.append({
      conversationId,
      requestId,
      askOrigin: { sessionId: root.sessionId, messageId: requestId },
      content: [
        { type: 'text', text: 'These two' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: photo } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: old } },
      ],
    });
    ledger.recordImages(conversationId, requestId, [
      { index: 1, width: 1200, height: 800, thumbnail: { mediaType: 'image/jpeg', data: 'dGg=' } },
    ]);
  });
  afterEach(() => mailbox.close());

  test('a page with imageRefs carries a reference, size and thumbnail instead of the photo', async () => {
    const result = await invokeOperation(
      registry(),
      'neo.conversation.asks.read',
      { conversationId, imageRefs: true },
      human
    );
    const content = (result as { value: { items: Array<{ content: unknown[] }> } }).value.items[0]
      .content;
    expect(content).toEqual([
      { type: 'text', text: 'These two' },
      {
        type: 'image_ref',
        imageId: '1:1',
        mediaType: 'image/png',
        bytes: Math.floor((photo.length * 3) / 4),
        width: 1200,
        height: 800,
        thumbnail: { mediaType: 'image/jpeg', data: 'dGg=' },
      },
      {
        type: 'image_ref',
        imageId: '1:2',
        mediaType: 'image/jpeg',
        bytes: Math.floor((old.length * 3) / 4),
        width: 640,
        height: 480,
        thumbnail: null,
      },
    ]);
    expect(JSON.stringify(content)).not.toContain(photo);
  });

  test('a page without imageRefs still carries the full photos', async () => {
    const result = await invokeOperation(
      registry(),
      'neo.conversation.asks.read',
      { conversationId },
      human
    );
    expect(JSON.stringify(result)).toContain(photo);
  });

  test('reads a photo that sits after more than a hundred content blocks', async () => {
    const late = '20000000-0000-4000-8000-000000000002';
    ledger.append({
      conversationId,
      requestId: late,
      askOrigin: { sessionId: root.sessionId, messageId: late },
      content: [
        ...Array.from({ length: 100 }, () => ({ type: 'text' as const, text: 'x' })),
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: photo } },
      ],
    });
    expect(
      await invokeOperation(
        registry(),
        'neo.conversation.image.read',
        { conversationId, imageId: '2:100' },
        human
      )
    ).toMatchObject({ value: { ok: true, imageId: '2:100', data: photo } });
  });

  test('reads one full photo by its id, and refuses a missing one or a non-human caller', async () => {
    const read = (imageId: string, caller = human) =>
      invokeOperation(
        registry(),
        'neo.conversation.image.read',
        { conversationId, imageId },
        caller
      );
    expect(await read('1:1')).toEqual({
      kind: 'completed',
      value: { ok: true, imageId: '1:1', mediaType: 'image/png', data: photo },
    });
    expect(await read('1:0')).toMatchObject({ value: { ok: false, reason: 'image_not_found' } });
    expect(await read('9:1')).toMatchObject({ value: { ok: false, reason: 'image_not_found' } });
    expect(
      await read('1:1', { source: 'mcp', role: 'neo', sessionId: root.sessionId })
    ).toMatchObject({ value: { ok: true, imageId: '1:1' } });
    expect(
      await read('1:1', { source: 'mcp', role: 'neo', sessionId: 'neo:unbound' })
    ).toMatchObject({ value: { ok: false, reason: 'human_only' } });
  });
});
