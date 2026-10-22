import { expect, test } from 'bun:test';
import { createTestDb, createTestSession } from '../../../helpers/database';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { capSdkMessage } from '../../../../src/lib/rpc-handlers/message-output-cap';
import {
  SDKStatusReader,
  sdkReadLogMetadata,
  type SDKStatusReply,
  type SDKReadResult,
  type SDKStatusRequest,
} from '../../../../src/storage/sdk-status-reader';
import type { WorkChatMatch } from '../../../../src/storage/work-chat-search';

class TestWorker {
  onmessage: ((event: MessageEvent<SDKStatusReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: SDKStatusRequest[] = [];
  stopped = false;
  postMessage(request: SDKStatusRequest) {
    this.requests.push(request);
    if (!request.args) queueMicrotask(() => this.reply(request, null));
  }
  terminate() {
    this.stopped = true;
  }
  reply(request: SDKStatusRequest, result: SDKReadResult | null) {
    this.onmessage?.({
      data: {
        id: request.id,
        epoch: request.epoch,
        result,
        finishedAt: Date.now(),
        workerMs: 0,
        queueMs: 0,
      },
    } as MessageEvent<SDKStatusReply>);
  }
  crash() {
    this.onerror?.({ message: 'synthetic failure', preventDefault() {} } as ErrorEvent);
  }
}
const args = { sessionId: 'synthetic-session', status: 'consumed' as const, limit: 20 };
const page = {
  messages: [
    {
      dbId: 'db-1',
      uuid: 'm-1',
      timestamp: 1,
      status: 'consumed' as const,
      text: 'Complete text 🦊\n',
    },
  ],
  total: 31,
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(timeoutMs = 1000) {
  const workers: TestWorker[] = [];
  const reader = new SDKStatusReader(
    '/synthetic.db',
    () => {
      const worker = new TestWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    timeoutMs
  );
  return { reader, workers };
}

test('serial status pages retain complete output and drain before close', async () => {
  const { reader, workers } = fixture();
  const first = reader.read(args),
    second = reader.read(args);
  await tick();
  const worker = workers[0];
  worker.reply(worker.requests[0], page);
  expect(await first).toEqual(page);
  await tick();
  worker.reply(worker.requests[1], page);
  expect(await second).toEqual(page);
  const closed = reader.close();
  await expect(reader.read(args)).rejects.toThrow('closed');
  await closed;
  expect(workers).toHaveLength(1);
  expect(worker.stopped).toBe(true);
});

test('worker crash rejects accepted reads; only a new request can open a replacement', async () => {
  const { reader, workers } = fixture();
  const results = Promise.allSettled([reader.read(args), reader.read(args)]);
  await tick();
  workers[0].crash();
  expect((await results).map((r) => r.status)).toEqual(['rejected', 'rejected']);
  const later = reader.read(args);
  await tick();
  workers[0].crash();
  workers[1].reply(workers[1].requests[0], page);
  expect(await later).toEqual(page);
  await reader.close();
});

test('stale response IDs cannot answer the current status request', async () => {
  const { reader, workers } = fixture();
  let answered = false;
  const result = reader.read(args).then((value) => {
    answered = true;
    return value;
  });
  await tick();
  const request = workers[0].requests[0];
  workers[0].reply({ ...request, epoch: request.epoch - 1 }, page);
  await tick();
  expect(answered).toBe(false);
  workers[0].reply(request, page);
  expect(await result).toEqual(page);
  await reader.close();
});

test('timeout rejects without a synchronous fallback and releases queued reads', async () => {
  const { reader } = fixture(5);
  const results = await Promise.allSettled([reader.read(args), reader.read(args)]);
  expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  await reader.close();
});

test('backpressure refuses excess requests instead of accumulating unbounded work', async () => {
  const { reader, workers } = fixture();
  const accepted = Promise.allSettled(Array.from({ length: 16 }, () => reader.read(args)));
  await expect(reader.read(args)).rejects.toThrow('queue full');
  await tick();
  workers[0].crash();
  expect((await accepted).every((r) => r.status === 'rejected')).toBe(true);
  await reader.close();
});

test('supported memory DB keeps complete status text without opening a file worker', async () => {
  const db = await createTestDb();
  try {
    db.createSession(createTestSession('memory-status'));
    const text = 'Complete memory text 🦊\n'.repeat(2000);
    const message = {
      type: 'user',
      uuid: 'memory-user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'text', text }, { type: 'image' }, { type: 'text', text: 'Second' }],
      },
    } as SDKMessage;
    db.saveUserMessage('memory-status', message, 'consumed');
    const stored = db.getDatabase().prepare('SELECT sdk_message FROM sdk_message_bodies').all();
    const page = await db.getUserMessagesByStatusAsync('memory-status', 'consumed', 20);
    expect(page.total).toBe(1);
    expect(page.messages[0].text).toBe(text + '\nSecond');
    expect(page.messages[0].uuid).toBe('memory-user');
    expect(page.messages[0].status).toBe('consumed');
    expect(db.getDatabase().prepare('SELECT sdk_message FROM sdk_message_bodies').all()).toEqual(
      stored
    );
  } finally {
    await db.close();
  }
});

test('paged memory read retains child/background projection and complete stored tool output', async () => {
  const db = await createTestDb();
  try {
    db.createSession(createTestSession('memory-page'));
    db.saveSDKMessage('memory-page', {
      type: 'assistant',
      uuid: 'parent',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'child-tool', name: 'Bash', input: {} }],
      },
    } as SDKMessage);
    const full = 'complete tool result\n'.repeat(2000);
    db.saveUserMessage(
      'memory-page',
      {
        type: 'user',
        uuid: 'child',
        parent_tool_use_id: 'child-tool',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'child-result', content: full }],
        },
      } as SDKMessage,
      'consumed'
    );
    db.saveSDKMessage('memory-page', {
      type: 'system',
      subtype: 'task_started',
      uuid: 'background',
      task_id: 'memory-task',
    } as SDKMessage);
    const stored = db
      .getDatabase()
      .prepare('SELECT sdk_message FROM sdk_message_bodies ORDER BY seq')
      .all();
    const page = await db.getSDKMessagePageAsync('memory-page', { limit: 1 });
    expect(page.sdkMessages.map((m) => m.uuid)).toEqual(['parent', 'child']);
    expect(page.hasMore).toBe(true);
    expect(page.backgroundTaskMessages.map((m) => m.uuid)).toContain('background');
    const child = page.sdkMessages[1] as {
      output_capped?: boolean;
      message: { content: { content: string; output_capped: unknown }[] };
    };
    expect(child.output_capped).toBe(true);
    expect(child.message.content[0].content).toHaveLength(16 * 1024);
    expect(child.message.content[0].output_capped).toEqual({ chars: full.length });
    expect(
      db.getDatabase().prepare('SELECT sdk_message FROM sdk_message_bodies ORDER BY seq').all()
    ).toEqual(stored);
  } finally {
    await db.close();
  }
});

test('reader projections change only returned pages, never original or full-output bodies', async () => {
  const db = await createTestDb();
  try {
    db.createSession(createTestSession('projected-page'));
    const full = 'complete output 🦊\n'.repeat(4000);
    db.saveUserMessage(
      'projected-page',
      {
        type: 'user',
        uuid: 'projected-user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Visible text' },
            { type: 'tool_result', tool_use_id: 'tool', content: full },
          ],
        },
      } as SDKMessage,
      'consumed'
    );
    const repo = db.getSDKMessageRepo();
    const original = repo.getSDKMessages('projected-page', 1);
    const projected = repo.getSDKMessages(
      'projected-page',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      capSdkMessage
    );
    expect(projected.messages).toEqual(original.messages.map(capSdkMessage));
    expect(projected.messages[0]).toMatchObject({ output_capped: true });
    expect(
      repo.getSDKMessages(
        'projected-page',
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        capSdkMessage
      )
    ).toEqual(projected);
    const status = repo.getUserMessagesByStatus('projected-page', 'consumed', 1, 'asc', (m) => ({
      ...m,
      message: { ...m.message, content: 'Projected text' },
    }));
    expect(status.messages[0].message.content).toBe('Projected text');
    expect(repo.getSDKMessages('projected-page', 1)).toEqual(original);
    expect(repo.getMessageByUuid('projected-page', 'projected-user')).toMatchObject({
      message: { content: [{ text: 'Visible text' }, { content: full }] },
    });
  } finally {
    await db.close();
  }
});

test('status and paged reads share the serial reader and retain full projected replies', async () => {
  const { reader, workers } = fixture();
  const first = reader.read(args);
  const second = reader.readMessages({
    sessionId: args.sessionId,
    page: { limit: 2, before: 100, beforeRowid: 4 },
  });
  await tick();
  workers[0].reply(workers[0].requests[0], page);
  expect(await first).toEqual(page);
  await tick();
  expect(workers[0].requests[1].args).toEqual({
    sessionId: args.sessionId,
    page: { limit: 2, before: 100, beforeRowid: 4 },
  });
  const result = {
    sdkMessages: [
      {
        type: 'user',
        uuid: 'child',
        timestamp: 1,
        message: { role: 'user', content: '完整 projected reply' },
      },
    ],
    hasMore: true,
    backgroundTaskMessages: [],
  } as SDKReadResult;
  workers[0].reply(workers[0].requests[1], result);
  expect(await second).toEqual(result);
  expect(workers).toHaveLength(1);
  await reader.close();
});

test('mixed SQL summaries cannot be attributed to the last page or status request', () => {
  const summary = {
    event: 'summary',
    executionCount: 2,
    queries: [{ fingerprint: 'status-sql' }, { fingerprint: 'page-sql' }],
  };
  for (const operation of ['sdk-page', 'sdk-status', 'close']) {
    const emitted = sdkReadLogMetadata(summary, operation);
    expect(emitted).toEqual(summary);
    expect(emitted).not.toHaveProperty('workerOperation');
  }
  const slow = { event: 'slow', fingerprint: 'page-sql', durationMs: 280 };
  expect(sdkReadLogMetadata(slow, 'sdk-page')).toEqual({
    ...slow,
    workerOperation: 'sdk-page',
  });
  expect(summary).not.toHaveProperty('workerOperation');
});

test('status and work search return their own complete output on the same reader', async () => {
  const { reader, workers } = fixture();
  const chats: WorkChatMatch[] = [
    {
      kind: 'message',
      sessionId: 'session',
      taskId: null,
      hits: 1,
      lastHitAt: 42,
      score: 1,
      snippets: [
        {
          match: 'semantic',
          messageId: 'message',
          sessionId: 'session',
          role: 'assistant',
          at: 42,
          text: 'Retained semantic text 🦊',
        },
      ],
    },
  ];
  const status = reader.read(args);
  const search = reader.readWorkChats({
    query: 'meaning',
    limit: 20,
    semantic: { model: 'fixture', vector: [1, 0] },
    kinds: ['message'],
  });
  await tick();
  workers[0].reply(workers[0].requests[0], page);
  expect(await status).toEqual(page);
  await tick();
  workers[0].reply(workers[0].requests[1], chats);
  expect(await search).toEqual(chats);
  await reader.close();
});

test('memory work search retains semantic output and every stored body', async () => {
  const db = await createTestDb();
  try {
    db.createSession(createTestSession('memory-search'));
    const text = 'Complete retained memory history 🦊 '.repeat(200);
    db.saveUserMessage(
      'memory-search',
      {
        type: 'user',
        uuid: 'memory-search-message',
        parent_tool_use_id: null,
        message: { role: 'user', content: text },
      } as SDKMessage,
      'consumed'
    );
    db.getSDKMessageRepo().flushMessageSearchIndex();
    const raw = db.getDatabase();
    raw
      .prepare(`INSERT INTO message_search_vectors(content_id,model,dimensions,embedding,embedded_at)
      SELECT id,'fixture',2,?,1 FROM message_search_content WHERE session_id='memory-search'`)
      .run(new Uint8Array(new Float32Array([1, 0]).buffer));
    const stored = raw.prepare('SELECT body FROM message_search_content').all();
    const semantic = { model: 'fixture', vector: new Float32Array([1, 0]) };
    const expected = db.getSDKMessageRepo().searchWorkChats('salmon', 20, semantic, ['message']);
    const found = await db.searchWorkChatsAsync('salmon', 20, semantic, ['message']);
    expect(found).toEqual(expected);
    expect(found[0].sessionId).toBe('memory-search');
    expect(found[0].snippets[0].match).toBe('semantic');
    expect(found[0].snippets[0].text).toBe(text.slice(0, 240) + '…');
    expect(raw.prepare('SELECT body FROM message_search_content').all()).toEqual(stored);
  } finally {
    await db.close();
  }
});

test('search backpressure preserves SDK admission and queued SDK reads finish first', async () => {
  const { reader, workers } = fixture();
  const first = reader.readWorkChats({ query: 'first', limit: 1 });
  const second = reader.readWorkChats({ query: 'second', limit: 1 });
  const third = reader.readWorkChats({ query: 'third', limit: 1 });
  await expect(reader.readWorkChats({ query: 'excess', limit: 1 })).rejects.toThrow('queue full');
  const statuses = Array.from({ length: 16 }, () => reader.read(args));
  workers[0].reply(workers[0].requests[0], []);
  await first;
  for (let i = 0; i < statuses.length; i++) {
    await tick();
    workers[0].reply(workers[0].requests[i + 1], page);
    expect(await statuses[i]).toEqual(page);
  }
  await tick();
  workers[0].reply(workers[0].requests[17], []);
  expect(await second).toEqual([]);
  await tick();
  workers[0].reply(workers[0].requests[18], []);
  expect(await third).toEqual([]);
  await reader.close();
});

test('live feeds share status admission and keep explicit error recovery', async () => {
  const { reader, workers } = fixture();
  const feed = { feed: 'full' as const, sessionId: 'synthetic-session', limit: 20 };
  const result = {
    rows: [{ id: 'complete', message: { content: 'retained text' } }],
    hashes: { hash: 17, rowHashes: [['complete', 12] as [unknown, number]] },
  };
  const first = reader.readMessageFeed(feed),
    status = reader.read(args);
  await tick();
  expect(workers[0].requests[0].args).toEqual(feed);
  workers[0].reply(workers[0].requests[0], result);
  expect(await first).toEqual(result);
  await tick();
  workers[0].reply(workers[0].requests[1], page);
  expect(await status).toEqual(page);
  const failed = reader.readMessageFeed(feed).catch((error) => String(error));
  await tick();
  workers[0].crash();
  expect(await failed).toContain('synthetic failure');
  const next = reader.readMessageFeed({ ...feed, feed: 'compact' });
  await tick();
  workers[1].reply(workers[1].requests[0], result);
  expect(await next).toEqual(result);
  await reader.close();
});

test('Neo status facts share the serial metadata reader without transferring ask content', async () => {
  const { reader, workers } = fixture();
  const refs = [
    {
      conversationId: 'synthetic-conversation',
      requestId: 'request-1',
      askOrigin: { sessionId: args.sessionId, messageId: 'message-1' },
    },
  ];
  const facts = [{ sendStatus: 'consumed', processing: null, answered: true }];
  const first = reader.read(args),
    next = reader.readNeoMessageStatusFacts(refs);
  await tick();
  expect(workers[0].requests).toHaveLength(1);
  workers[0].reply(workers[0].requests[0], page);
  expect(await first).toEqual(page);
  await tick();
  expect(workers).toHaveLength(1);
  expect(workers[0].requests[1].args).toEqual({ neoMessageStatus: refs });
  workers[0].reply(workers[0].requests[1], facts);
  expect(await next).toEqual(facts);
  await reader.close();
});

test('a failed Neo fact request rejects and a fresh request uses a replacement reader', async () => {
  const { reader, workers } = fixture();
  const failed = reader.readNeoMessageStatusFacts([]);
  const rejected = expect(failed).rejects.toThrow('synthetic failure');
  await tick();
  workers[0].crash();
  await rejected;
  const next = reader.readNeoMessageStatusFacts([]);
  await tick();
  expect(workers).toHaveLength(2);
  workers[1].reply(workers[1].requests[0], []);
  expect(await next).toEqual([]);
  await reader.close();
});

test('turn ranges and counts share metadata admission and preserve zero counts', async () => {
  const { reader, workers } = fixture();
  const first = reader.read(args);
  const pending = reader.readPendingTurns('synthetic-model', 3, 32);
  const count = reader.countPendingTurns('synthetic-model', 3);
  await tick();
  workers[0].reply(workers[0].requests[0], page);
  await first;
  await tick();
  const turns = [{ id: 9, text: 'Retained Unicode 🦊', bodyLength: 4000 }];
  expect(workers[0].requests[1].args).toEqual({
    turnVectors: { model: 'synthetic-model', dimensions: 3, limit: 32 },
  });
  workers[0].reply(workers[0].requests[1], turns);
  expect(await pending).toEqual(turns);
  await tick();
  expect(workers[0].requests[2].args).toEqual({
    turnVectors: { model: 'synthetic-model', dimensions: 3, limit: null },
  });
  workers[0].reply(workers[0].requests[2], 0);
  expect(await count).toBe(0);
  expect(workers).toHaveLength(1);
  await reader.close();
  await expect(reader.readPendingTurns('synthetic-model', 3, 32)).rejects.toThrow('closed');
});

test('an in-memory database keeps turn-range semantics without opening a worker', async () => {
  const db = await createTestDb();
  try {
    const raw = db.getDatabase();
    raw.exec(
      "INSERT INTO message_search_content(kind,source_id,message_id,session_id,message_type,title,body,timestamp) VALUES ('message','synthetic','synthetic','synthetic','user','Retained','Complete synthetic turn body',1)"
    );
    expect(await db.readPendingTurnsAsync('synthetic-model', 3, 32)).toEqual([
      { id: 1, text: 'Complete synthetic turn body', bodyLength: 28 },
    ]);
    expect(await db.countPendingTurnsAsync('synthetic-model', 3)).toBe(1);
  } finally {
    await db.close();
  }
});

test('a cold reader waits for its handler before sending the accepted turn-range read', async () => {
  const worker = new TestWorker();
  const reader = new SDKStatusReader('/synthetic.db', () => worker as unknown as Worker);
  const pending = reader.readPendingTurns('synthetic-model', 3, 32);
  try {
    expect(worker.requests).toHaveLength(0);
    worker.onmessage?.({ data: { ready: true } } as unknown as MessageEvent<SDKStatusReply>);
    await tick();
    expect(worker.requests).toHaveLength(1);
    const turns = [{ id: 1, text: 'Complete synthetic turn', bodyLength: 23 }];
    worker.reply(worker.requests[0], turns);
    expect(await pending).toEqual(turns);
    worker.onmessage?.({ data: { ready: true } } as unknown as MessageEvent<SDKStatusReply>);
    expect(worker.requests).toHaveLength(1);
  } finally {
    for (const request of worker.requests) worker.reply(request, []);
    await pending.catch(() => {});
    await reader.close();
  }
});
