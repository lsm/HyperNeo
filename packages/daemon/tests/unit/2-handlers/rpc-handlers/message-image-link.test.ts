import { afterEach, describe, expect, test } from 'bun:test';
import { createTestDb, createTestSession } from '../../../helpers/database';
import type { Database } from '../../../../src/storage/database';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { singleMessageReads } from '../../../../src/storage/repositories/sdk-single-message-read.ts';
import { readMessageFeed } from '../../../../src/storage/sdk-message-feed-read.ts';
import {
  MESSAGE_IMAGE_INLINE_CHARS,
  linkMessageImages,
} from '../../../../src/lib/rpc-handlers/message-image-link.ts';
import { createMessageImageHandler } from '../../../../src/lib/rpc-handlers/message-image-route.ts';
import type { UpgradeIdentity } from '../../../../src/lib/pairing/upgrade-auth.ts';

const PNG_HEAD = Buffer.from('89504e470d0a1a0a0000000d49484452000000400000003008020000', 'hex');
const png = (bytes: number) => Buffer.concat([PNG_HEAD, Buffer.alloc(bytes, 7)]);
const SESSION = 'synthetic-image-session';
const image = (data: string, media_type = 'image/png') => ({
  type: 'image',
  source: { type: 'base64', media_type, data },
});
const message = (uuid: string, content: unknown[]) => ({
  type: 'user',
  uuid,
  session_id: 'sdk-session',
  parent_tool_use_id: null,
  message: { role: 'user', content },
});
const large = png(MESSAGE_IMAGE_INLINE_CHARS).toString('base64');
const blocksOf = (row: unknown) =>
  (row as { message: { content: Record<string, unknown>[] } }).message.content;

describe('linkMessageImages', () => {
  test('replaces a large top-level image with a placeholder and a link', () => {
    const stored = message('m-1', [{ type: 'text', text: 'Look' }, image(large)]);
    const [text, block] = blocksOf(linkMessageImages(stored, 'conv:a b'));
    expect(text).toEqual({ type: 'text', text: 'Look' });
    const source = block.source as { type: string; media_type: string; data: string };
    expect(source.type).toBe('base64');
    expect(source.media_type).toBe('image/png');
    expect(source.data.length).toBeLessThan(1024);
    expect(block.full).toEqual({
      url: '/api/sessions/conv%3Aa%20b/messages/m-1/images/1',
      mediaType: 'image/png',
      bytes: Buffer.from(large, 'base64').length,
      width: 64,
      height: 48,
    });
    expect(blocksOf(stored)[1]).toEqual(image(large));
  });

  test('keeps a small image inline', () => {
    const small = image(png(16).toString('base64'));
    expect(blocksOf(linkMessageImages(message('m-2', [small]), SESSION))[0]).toEqual(small);
  });

  test('leaves tool results to the output cap', () => {
    const result = { type: 'tool_result', tool_use_id: 't', content: [image(large)] };
    expect(blocksOf(linkMessageImages(message('m-3', [result]), SESSION))[0]).toEqual(result);
  });

  test('keeps an image it cannot link', () => {
    const { uuid: _uuid, ...unlinked } = message('m-4', [image(large)]);
    expect(blocksOf(linkMessageImages(unlinked, SESSION))[0]).toEqual(image(large));
    expect(blocksOf(linkMessageImages(message('m-4', [image(large)]), null))[0]).toEqual(
      image(large)
    );
  });
});

describe('message windows', () => {
  let db: Database;
  const photo = png(6 * 1024 * 1024).toString('base64');
  const seed = async () => {
    db = await createTestDb();
    await db.createSession(createTestSession(SESSION));
    for (let index = 0; index < 5; index++)
      await db.saveSDKMessage(SESSION, message(`photo-${index}`, [image(photo)]) as never);
  };
  afterEach(() => db?.close());

  test.each(['full', 'compact'] as const)('five large photos stay small in %s', async (feed) => {
    await seed();
    const { rows } = readMessageFeed(db.getDatabase(), { feed, sessionId: SESSION, limit: 50 });
    expect(rows).toHaveLength(5);
    expect(JSON.stringify(rows).length).toBeLessThan(16 * 1024);
    expect(blocksOf(rows[0])[0].full).toMatchObject({
      url: `/api/sessions/${SESSION}/messages/photo-0/images/0`,
    });
  });

  test('older pages carry the link too', async () => {
    await seed();
    const page = await db.getSDKMessagePageAsync(SESSION, { requireSession: true, limit: 50 });
    expect(page.sdkMessages).toHaveLength(5);
    expect(JSON.stringify(page).length).toBeLessThan(16 * 1024);
  });

  test('the stored row and an uncapped read stay whole', async () => {
    await seed();
    const { sdkMessage } = await gatewayFor(db.getDatabase()).call(
      singleMessageReads,
      'read',
      SESSION,
      'photo-0',
      false
    );
    expect(blocksOf(sdkMessage)[0]).toEqual(image(photo));
  });
});

describe('message image route', () => {
  let db: Database;
  const human: UpgradeIdentity = { deviceId: 'phone', kind: 'human' };
  const url = (path: string) => new Request(`http://127.0.0.1${path}`);
  const handler = (device: UpgradeIdentity | null) =>
    createMessageImageHandler(
      async () => device,
      () => gatewayFor(db.getDatabase())
    );
  const path = `/api/sessions/${SESSION}/messages/stored/images/1`;
  const seed = async () => {
    db = await createTestDb();
    await db.createSession(createTestSession(SESSION));
    await db.saveSDKMessage(
      SESSION,
      message('stored', [
        { type: 'text', text: 'Look' },
        image(large),
        image(large, 'image/svg+xml'),
      ]) as never
    );
  };
  afterEach(() => db?.close());

  test('a paired device gets the exact bytes', async () => {
    await seed();
    const response = (await handler(human)(url(path), null))!;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(Buffer.from(await response.arrayBuffer()).toString('base64')).toBe(large);
  });

  test('an unpaired caller gets 401 and no image', async () => {
    await seed();
    const response = (await handler(null)(url(path), null))!;
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(large.slice(0, 32));
  });

  test.each([
    ['a text block', `/api/sessions/${SESSION}/messages/stored/images/0`],
    ['a missing block', `/api/sessions/${SESSION}/messages/stored/images/9`],
    ['an unsafe image type', `/api/sessions/${SESSION}/messages/stored/images/2`],
    ['another message', `/api/sessions/${SESSION}/messages/nope/images/1`],
    ['another session', `/api/sessions/other/messages/stored/images/1`],
  ])('%s is not found', async (_name, target) => {
    await seed();
    expect((await handler(human)(url(target), null))!.status).toBe(404);
  });

  test('other paths and methods pass through', async () => {
    await seed();
    expect(await handler(human)(url('/api/other'), null)).toBeNull();
    expect(await handler(human)(new Request(url(path), { method: 'POST' }), null)).toBeNull();
  });
});
