import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MessageHub, MessageHubRouter } from '@hyperneo/shared';
import { NeoSpeech } from '../../../../src/lib/neo/speech.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';
import { runDbOpOn } from '../../helpers/run-db-op.ts';

const sessionId = 'neo:10000000-0000-4000-8000-000000000001';
const human: OperationCaller = { source: 'rpc', principal: 'local', clientId: 'phone' };
const neo: OperationCaller = { source: 'mcp', sessionId, role: 'neo' };

describe('spoken replies separate from publications', () => {
  let mailbox: MailboxTestDb;
  let hub: MessageHub;
  let router: MessageHubRouter;
  let registry: ReturnType<typeof createOperationRegistry>;
  let messages: { client: string; message: { data: Record<string, string> } }[];
  let speech: NeoSpeech;
  let disconnected: (id: string) => void;
  let audioController: ReadableStreamDefaultController<Uint8Array>;
  let audioSignal: AbortSignal | null | undefined;
  let synthesis: number;
  let writeGate: (() => Promise<void>) | undefined;
  const call = async (name: string, input: unknown, caller = human) => {
    const result = await invokeOperation(registry, 'neo.speech.' + name, input, caller);
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw Error('operation failed');
    return result.value as {
      ok: boolean;
      created?: boolean;
      id: string;
      reason?: string;
      state?: string;
    };
  };
  const listen = (enabled = true, caller = human) => call('listen', { sessionId, enabled }, caller);
  const say = (requestId = 'one', text = '好，我查一下。') => call('say', { requestId, text }, neo);

  beforeEach(() => {
    mailbox = createMailboxTestDb();
    mailbox.db.prepare('INSERT INTO sessions(id) VALUES (?)').run(sessionId);
    mailbox.db.exec(
      'CREATE TABLE operation_refusals(operation TEXT,reason TEXT,session_id TEXT,at INTEGER,accepted INTEGER)'
    );
    messages = [];
    hub = new MessageHub();
    router = new MessageHubRouter({ logger: { log() {}, warn() {}, error() {} } });
    hub.registerRouter(router);
    for (const id of ['phone', 'other'])
      router.registerConnection({
        id,
        isOpen: () => true,
        send: (data) => messages.push({ client: id, message: JSON.parse(data) }),
      });
    writeGate = undefined;
    synthesis = 0;
    hub.onClientDisconnect = (handler) => {
      disconnected = handler;
      return () => {};
    };
    speech = new NeoSpeech(
      hub,
      async (op, args) => {
        await writeGate?.();
        return runDbOpOn(mailbox.db)(op, args);
      },
      (id) => id.startsWith('neo:'),
      'http://127.0.0.1:18555',
      (async (_url, init) => {
        synthesis++;
        audioSignal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              audioController = controller;
              init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
            },
          }),
          { headers: { 'content-type': 'audio/pcm' } }
        );
      }) as typeof fetch
    );
    registry = createOperationRegistry(speech.operations);
  });
  afterEach(async () => {
    await speech.dispose();
    hub.cleanup();
    mailbox.close();
  });

  test('an unavailable failed-receipt write does not drop the next healthy synthesis', async () => {
    await call('listen', { sessionId, enabled: true, audio: true });
    const first = await say('broken-upstream');
    for (let i = 0; i < 100 && synthesis < 1; i++) await new Promise((done) => setTimeout(done, 1));
    let failedWrites = 0;
    writeGate = async () => {
      writeGate = undefined;
      failedWrites++;
      throw new Error('Public fixture receipt-write failure');
    };
    audioController.error(new Error('Public fixture upstream failure'));
    for (let i = 0; i < 100 && !failedWrites; i++) await new Promise((done) => setTimeout(done, 1));
    expect(failedWrites).toBe(1);
    expect(
      messages.some(
        (item) => item.message.data.id === first.id && item.message.data.type === 'failed'
      )
    ).toBe(true);
    const next = await say('healthy-after-write-failure');
    for (let i = 0; i < 100 && synthesis < 2; i++) await new Promise((done) => setTimeout(done, 1));
    expect(synthesis).toBe(2);
    expect(
      messages.some(
        (item) => item.message.data.id === next.id && item.message.data.type === 'failed'
      )
    ).toBe(false);
    if (synthesis !== 2) return;
    audioController.enqueue(new Uint8Array([1, 0, 2, 0]));
    audioController.close();
    for (
      let i = 0;
      i < 100 &&
      !messages.some(
        (item) => item.message.data.id === next.id && item.message.data.type === 'end'
      );
      i++
    )
      await new Promise((done) => setTimeout(done, 1));
    expect(
      messages.some(
        (item) => item.message.data.id === next.id && item.message.data.type === 'audio'
      )
    ).toBe(true);
    expect(
      messages.some((item) => item.message.data.id === next.id && item.message.data.type === 'end')
    ).toBe(true);
  });

  test.each([
    ['', 'speech_backend_not_configured'],
    ['http://127.0.0.1:18555', 'speech_backend_unavailable'],
    ['http://example.invalid', 'invalid_speech_backend'],
  ])('catalog returns a typed rejection for %s', async (base, reason) => {
    const catalog = new NeoSpeech(
      hub,
      runDbOpOn(mailbox.db),
      () => true,
      base,
      (async () => new Response('', { status: 503 })) as typeof fetch
    );
    try {
      const result = await invokeOperation(
        createOperationRegistry(catalog.operations),
        'neo.speech.catalog',
        {},
        human
      );
      expect(result).toMatchObject({ kind: 'completed', value: { ok: false, reason } });
    } finally {
      await catalog.dispose();
    }
  });

  test.each([
    new TypeError('fetch failed'),
    new DOMException('The operation timed out', 'TimeoutError'),
    new DOMException('The operation was aborted', 'AbortError'),
  ])('catalog returns backend unavailable when transport rejects with %s', async (error) => {
    const catalog = new NeoSpeech(
      hub,
      runDbOpOn(mailbox.db),
      () => true,
      'http://127.0.0.1:18555',
      (async () => {
        throw error;
      }) as typeof fetch
    );
    try {
      expect(
        await invokeOperation(
          createOperationRegistry(catalog.operations),
          'neo.speech.catalog',
          {},
          human
        )
      ).toMatchObject({
        kind: 'completed',
        value: { ok: false, reason: 'speech_backend_unavailable' },
      });
    } finally {
      await catalog.dispose();
    }
  });

  test('catalog still returns voices and keeps unexpected infrastructure errors as failures', async () => {
    for (const available of [true, false]) {
      const catalog = new NeoSpeech(
        hub,
        runDbOpOn(mailbox.db),
        () => true,
        'http://127.0.0.1:18555',
        (async () => {
          if (!available) throw new Error('Public fixture infrastructure fault');
          return Response.json({ data: [{ id: 'ryan' }] });
        }) as typeof fetch
      );
      try {
        const result = await invokeOperation(
          createOperationRegistry(catalog.operations),
          'neo.speech.catalog',
          {},
          human
        );
        if (available)
          expect(result).toMatchObject({
            kind: 'completed',
            value: { ok: true, catalog: { data: [{ id: 'ryan' }] } },
          });
        else expect(result.kind).toBe('failed');
      } finally {
        await catalog.dispose();
      }
    }
  });

  test('server sends audio before synthesis finishes without blocking MCP or replaying it', async () => {
    await call('listen', { sessionId, enabled: true, audio: true, voice: 'ryan' });
    const saved = await say();
    for (let i = 0; i < 100 && !synthesis; i++) await new Promise((done) => setTimeout(done, 1));
    expect(synthesis).toBe(1);
    audioController.enqueue(new Uint8Array([1, 0, 2, 0]));
    for (let i = 0; i < 100 && messages.length < 2; i++)
      await new Promise((done) => setTimeout(done, 1));
    expect(messages[0].message.data).toMatchObject({ type: 'say', format: 'pcm16' });
    expect(messages[1].message.data).toMatchObject({ type: 'audio', pcm: 'AQACAA==', seq: 0 });
    expect(messages.every((item) => item.client === 'phone')).toBe(true);
    expect(messages.some((item) => item.message.data.type === 'end')).toBe(false);
    expect(await say()).toMatchObject({ created: false });
    audioController.close();
    for (let i = 0; i < 100 && !messages.some((item) => item.message.data.type === 'end'); i++)
      await new Promise((done) => setTimeout(done, 1));
    expect(messages.at(-1)?.message.data).toMatchObject({ type: 'end', seq: 1 });
    expect(await call('ack', { sessionId, id: saved.id, state: 'played' })).toMatchObject({
      state: 'played',
    });
  });
  test('cancelling playback aborts server synthesis and the next request can run', async () => {
    await call('listen', { sessionId, enabled: true, audio: true });
    const saved = await say();
    for (let i = 0; i < 100 && !synthesis; i++) await new Promise((done) => setTimeout(done, 1));
    await call('ack', { sessionId, id: saved.id, state: 'cancelled' });
    expect(audioSignal?.aborted).toBe(true);
    await say('next');
    for (let i = 0; i < 100 && synthesis < 2; i++) await new Promise((done) => setTimeout(done, 1));
    expect(synthesis).toBe(2);
    await listen(false);
  });
  test('no opt-in means no spoken output or saved utterance', async () => {
    expect(await say()).toMatchObject({ ok: false, reason: 'voice_replies_off' });
    expect(messages).toHaveLength(0);
    expect(mailbox.db.prepare('SELECT * FROM operation_refusals').all()).toHaveLength(0);
  });
  test('only the opted-in phone receives speech; an identical retry is not replayed', async () => {
    await listen();
    const saved = await say();
    expect(saved).toMatchObject({ ok: true, created: true, state: 'queued' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      client: 'phone',
      message: { data: { type: 'say', text: '好，我查一下。' } },
    });
    expect(await say()).toMatchObject({ ok: true, created: false });
    expect(await say('one', 'Changed')).toMatchObject({ ok: false });
    expect(messages).toHaveLength(1);
    expect(mailbox.sdkRows()).toHaveLength(0);
    expect(mailbox.rowCount()).toBe(0);
  });
  test('delivery is distinct from actual playback and only the receiving client may acknowledge it', async () => {
    await listen();
    const saved = await say();
    const input = { sessionId, id: saved.id, state: 'played' };
    expect(await call('ack', input, { ...human, clientId: 'other' })).toMatchObject({ ok: false });
    expect(await call('ack', { ...input, state: 'playing' })).toMatchObject({ state: 'playing' });
    expect(await call('ack', input)).toMatchObject({ state: 'played' });
    expect(await call('ack', { ...input, state: 'playing' })).toMatchObject({ state: 'played' });
    expect(
      JSON.parse(
        (
          mailbox.db
            .prepare('SELECT reason FROM operation_refusals ORDER BY rowid DESC LIMIT 1')
            .get() as { reason: string }
        ).reason
      )
    ).toMatchObject({
      text: '好，我查一下。',
      state: 'played',
    });
  });
  test('disable cancels pending speech and reconnect does not replay it', async () => {
    await listen();
    const saved = await say();
    await listen(false);
    expect(await say('two')).toMatchObject({ ok: false });
    await listen();
    expect(await say()).toMatchObject({ created: false, state: 'cancelled' });
    expect(messages.filter((m) => m.message.data.type === 'say')).toHaveLength(1);
    expect(
      JSON.parse(
        (
          mailbox.db
            .prepare('SELECT reason FROM operation_refusals ORDER BY rowid DESC LIMIT 1')
            .get() as { reason: string }
        ).reason
      )
    ).toMatchObject({ id: saved.id, state: 'cancelled' });
  });
  test('a second listener replaces the first; a different client cannot turn it off', async () => {
    await listen();
    await listen(true, { ...human, clientId: 'other' });
    await listen(false);
    await say();
    expect(messages.at(-1)?.client).toBe('other');
  });
  test('parallel speech requests respect the bounded playback queue', async () => {
    await listen();
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => say(String(i))));
    expect(results.filter((r) => r.ok)).toHaveLength(4);
    expect(results[4]).toMatchObject({ reason: 'speech_queue_full' });
  });
  test('retrying queued speech remains idempotent when the queue is full', async () => {
    await listen();
    const first = await say('first');
    for (let i = 0; i < 3; i++) await say('fill-' + i);
    expect(await say('first')).toMatchObject({ ok: true, id: first.id, created: false });
    expect(messages.filter((item) => item.message.data.type === 'say')).toHaveLength(4);
  });
  test('disabling one session preserves another session on the same phone', async () => {
    const second = 'neo:10000000-0000-4000-8000-000000000002';
    mailbox.db.prepare('INSERT INTO sessions(id) VALUES (?)').run(second);
    await listen();
    await call('listen', { sessionId: second, enabled: true });
    const queued = await call(
      'say',
      { requestId: 'second', text: 'Second session.' },
      { ...neo, sessionId: second }
    );
    await listen(false);
    expect(await call('ack', { sessionId: second, id: queued.id, state: 'playing' })).toMatchObject(
      { state: 'playing' }
    );
    expect(
      await call(
        'say',
        { requestId: 'next', text: 'Still opted in.' },
        { ...neo, sessionId: second }
      )
    ).toMatchObject({ ok: true });
    expect(
      messages
        .filter((item) => item.message.data.type === 'stop')
        .map((item) => item.message.data.sessionId)
    ).toEqual([sessionId]);
  });
  test('disconnect after an in-flight playing acknowledgment leaves a cancelled receipt', async () => {
    await listen();
    const queued = await say();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    writeGate = () => {
      writeGate = undefined;
      entered();
      return blocked;
    };
    const playing = call('ack', { sessionId, id: queued.id, state: 'playing' });
    await started;
    disconnected('phone');
    await new Promise((done) => setTimeout(done, 20));
    release();
    await playing;
    await say('after-disconnect');
    const rows = mailbox.db
      .prepare('SELECT reason FROM operation_refusals ORDER BY rowid')
      .all() as { reason: string }[];
    expect(
      rows
        .map((row) => JSON.parse(row.reason))
        .filter((row) => row.id === queued.id)
        .at(-1)
    ).toMatchObject({ state: 'cancelled' });
  });
  test('a worker cannot speak as Neo, and an agent cannot enable a phone', async () => {
    await listen();
    expect(
      await call(
        'say',
        { requestId: 'worker', text: 'hello' },
        { ...neo, role: 'direct_task_worker' }
      )
    ).toMatchObject({ ok: false });
    expect(
      await invokeOperation(registry, 'neo.speech.listen', { sessionId, enabled: true }, neo)
    ).toMatchObject({ kind: 'failed', code: 'forbidden' });
  });
});
