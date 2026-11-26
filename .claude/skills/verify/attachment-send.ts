import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import NodeWebSocket from 'ws';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { DevicePairingRepository } from '../../../packages/daemon/src/storage/repositories/device-pairing-repository.ts';
import { NeoConversationAskRepository } from '../../../packages/daemon/src/storage/repositories/neo-conversation-ask-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
const data = join(run, 'data');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, data);
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'])
  assert.equal(process.env[key], undefined);
for (const dir of ['workspace', 'evidence', 'bin']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==',
  'base64'
);
const image = (n: number) => Buffer.concat([png, Buffer.from([n])]);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const upload = (bytes: Buffer) => ({
  type: 'image',
  source: { type: 'upload', media_type: 'image/png', sha256: sha(bytes) },
});
const inline = (bytes: Buffer) => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') },
});
const thumb = (index: number) => ({ index, mediaType: 'image/png', data: png.toString('base64') });
const CAP = 'A message can include at most 6 images.';
const MISSING = 'An attached image is missing or invalid. Upload it again.';
const [a, b, c, d, never] = [1, 2, 3, 4, 9].map(image);

const conversationId = '10000000-0000-4000-8000-0000000000a7';
const root = `neo:${conversationId}`;
const chat = 'attachment-send-chat';
const app = await createDaemonApp({
  config: {
    ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(data, 'daemon.db'), workspaceRoot: join(run, 'workspace') }),
    disableWorktrees: true,
  },
  verbose: false,
});
const receipt: Record<string, unknown> = { head: process.argv[2] };
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
try {
  await app.jobProcessor.stop();
  assert(![8399, 8499].includes(app.server.port));
  const base = `http://127.0.0.1:${app.server.port}`;
  const now = new Date().toISOString();
  const metadata = { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 };
  for (const [id, title] of [[root, 'Neo'], [chat, 'Work chat']])
    await app.db.createSession({ id, title, workspacePath: join(run, 'workspace'), createdAt: now, lastActiveAt: now, status: 'active', config: { queryMode: 'manual' }, metadata } as never);
  const db = app.db.getDatabase();
  await waitForSdkBodyCopy(db);
  new NeoRepository(db).reserveBinding({ sessionId: root, projectId: null, kind: 'neo' });
  const ledger = new NeoConversationAskRepository(db);

  const pairing = new DevicePairingRepository(db);
  const { code } = pairing.createCode('human', 'Synthetic phone', true, Date.now());
  const paired = await fetch(`${base}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: 'Synthetic phone' }),
  });
  assert.equal(paired.status, 200);
  const { credential } = (await paired.json()) as { credential: string };
  const stage = async (bytes: Buffer) => {
    const response = await fetch(`${base}/api/attachments/${sha(bytes)}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'image/png' },
      body: bytes,
    });
    assert.equal(response.status, 204);
  };
  for (const bytes of [a, b, c, d]) await stage(bytes);

  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({
    url: `ws://127.0.0.1:${app.server.port}/ws`,
    autoReconnect: false,
    createSocket: (url) => new NodeWebSocket(url, { headers: { authorization: `Bearer ${credential}` } }) as unknown as WebSocket,
  });
  hub.registerTransport(transport);
  await transport.initialize();
  type Receipt = { ok: boolean; created?: boolean; reason?: string };
  const neo = (content: unknown, requestId = crypto.randomUUID(), thumbnails?: unknown[]) =>
    hub
      .request<Receipt>('operation.invoke', { name: 'neo.message.send', input: { sessionId: root, requestId, content, ...(thumbnails ? { thumbnails } : {}) } })
      .then((result) => ({ ...result, requestId }));
  const order = (value: unknown, images: Buffer[]) => {
    const text = JSON.stringify(value);
    const at = images.map((bytes) => text.indexOf(bytes.toString('base64')));
    assert(at.every((position, index) => position >= 0 && (index === 0 || position > at[index - 1])), 'images keep their order');
    assert(!text.includes('"upload"'), 'no upload reference is persisted');
  };
  const asks = () => (ledger.list(conversationId, 0, 1000) ?? []).length;

  const photos = await neo([upload(a), upload(b)], undefined, [thumb(0), thumb(1)]);
  assert(photos.ok, photos.reason);
  const photoAsk = ledger.find(conversationId, photos.requestId);
  order(photoAsk?.content, [a, b]);
  const thumbs = ledger.images(conversationId, [photos.requestId]).map((row) => [row.index, !!row.thumbnail, row.width]);
  assert.deepEqual(thumbs.sort(), [[0, true, 1], [1, true, 1]]);
  receipt.neoPhotoOnly = { ok: true, thumbnails: thumbs };

  const mixed = await neo([{ type: 'text', text: 'look' }, upload(b), inline(c), upload(a)], undefined, [thumb(2)]);
  assert(mixed.ok, mixed.reason);
  const mixedAsk = ledger.find(conversationId, mixed.requestId);
  order(mixedAsk?.content, [b, c, a]);
  assert.deepEqual(ledger.images(conversationId, [mixed.requestId]).filter((row) => row.thumbnail).map((row) => row.index), [2]);
  receipt.neoOrderAndThumbnail = true;

  let before = asks();
  const missing = await neo([upload(never)]);
  assert.deepEqual([missing.ok, missing.reason, asks()], [false, MISSING, before]);
  receipt.neoMissingRefused = missing.reason;

  const plain = await neo([{ type: 'text', text: 'inline' }, inline(d)]);
  assert(plain.ok, plain.reason);
  order(ledger.find(conversationId, plain.requestId)?.content, [d]);
  receipt.neoInlineAccepted = true;

  const replayId = crypto.randomUUID();
  const first = await neo([{ type: 'text', text: 'replay' }, upload(c)], replayId);
  assert(first.ok && first.created, first.reason);
  rmSync(join(data, 'staged-attachments', sha(c)));
  const replay = await neo([{ type: 'text', text: 'replay' }, upload(c)], replayId);
  assert.deepEqual([replay.ok, replay.created], [true, false]);
  const fresh = await neo([upload(c)]);
  assert.deepEqual([fresh.ok, fresh.reason], [false, MISSING]);
  await stage(c);
  receipt.neoReplayAfterStagingGone = { ok: replay.ok, created: replay.created, freshSendRefused: fresh.reason };

  const six = await neo([inline(a), upload(b), upload(b), inline(c), upload(d), upload(a)]);
  assert(six.ok, six.reason);
  before = asks();
  const seven = await neo([inline(a), upload(b), upload(b), inline(c), upload(d), upload(a), upload(a)]);
  const sevenUnread = await neo(Array.from({ length: 7 }, () => upload(never)));
  assert.deepEqual([seven.ok, seven.reason, sevenUnread.reason, asks()], [false, CAP, CAP, before]);
  receipt.neoCap = { sixAccepted: true, seventhRefused: seven.reason, unreadSevenRefused: sevenUnread.reason };

  const queued = db.prepare("SELECT payload FROM job_queue WHERE payload LIKE ? ORDER BY rowid");
  const chatRows = () => queued.all(`%${chat}%`) as { payload: string }[];
  const chatImages = (messageId: string) => {
    const rows = chatRows().filter((row) => row.payload.includes(messageId));
    assert.equal(rows.length, 1);
    return rows[0].payload;
  };
  const send = (images: unknown[], content = '') =>
    hub.request<{ messageId: string }>('message.send', { sessionId: chat, content, images }).then(
      (result) => ({ ok: true as const, messageId: result.messageId }),
      (error: Error) => ({ ok: false as const, reason: error.message })
    );
  const legacyCount = () => chatRows().length;

  const legacyPhotos = await send([upload(a), upload(b)]);
  assert(legacyPhotos.ok, 'reason' in legacyPhotos ? legacyPhotos.reason : '');
  order(chatImages(legacyPhotos.messageId), [a, b]);
  receipt.chatPhotoOnly = true;

  before = legacyCount();
  const legacyMissing = await send([inline(a), upload(never)], 'missing');
  assert.deepEqual([legacyMissing.ok, 'reason' in legacyMissing && legacyMissing.reason, legacyCount()], [false, MISSING, before]);
  receipt.chatMissingRefused = MISSING;

  const legacySix = await send([inline(a), upload(b), upload(b), inline(c), upload(d), upload(a)], 'six');
  assert(legacySix.ok);
  order(chatImages(legacySix.messageId), [a, b, c, d]);
  before = legacyCount();
  const legacySeven = await send([inline(a), upload(b), upload(b), inline(c), upload(d), upload(a), upload(a)], 'seven');
  const legacyUnread = await send(Array.from({ length: 7 }, () => upload(never)), 'unread');
  assert.deepEqual(
    [legacySeven.ok, 'reason' in legacySeven && legacySeven.reason, 'reason' in legacyUnread && legacyUnread.reason, legacyCount()],
    [false, CAP, CAP, before]
  );
  const sevenInline = await send([a, b, c, d, a, b, c].map(inline), 'seven inline');
  assert(sevenInline.ok);
  order(chatImages(sevenInline.messageId), [a, b, c, d]);
  receipt.chatCap = { sixAccepted: true, seventhRefused: CAP, unreadSevenRefused: CAP, sevenInlineAccepted: true };
  receipt.passed = true;
  console.log('PASS upload image blocks resolve in Neo and work-chat sends');
} finally {
  await transport?.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/attachment-send.json'), JSON.stringify(receipt, null, 2));
}
