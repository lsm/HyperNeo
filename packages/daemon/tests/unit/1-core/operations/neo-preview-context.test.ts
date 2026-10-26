import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from '@hyperneo/shared';
import { createArtifactReadOperations } from '../../../../src/lib/artifacts/read-operations.ts';
import { createNeoConversationAskReadOperation } from '../../../../src/lib/neo/conversation-ask-read-operation.ts';
import { createNeoConversationReadOperation } from '../../../../src/lib/neo/conversation-read-operation.ts';
import { createNeoIntakeOperation } from '../../../../src/lib/neo/intake.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { Database as AppDatabase } from '../../../../src/storage/database.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoConversationAskRepository } from '../../../../src/storage/repositories/neo-conversation-ask-repository.ts';
import { NeoConversationReader } from '../../../../src/storage/repositories/neo-conversation-reader.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const sessionId = `neo:${conversationId}`;
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const previewContext = { artifactId: 'artifact-a', snapshot: 'a'.repeat(64) };
const reference = { ...previewContext, displayName: 'Synthetic report', state: 'available' };
const input = {
  sessionId,
  requestId: '20000000-0000-4000-8000-000000000001',
  content: 'Discuss this snapshot.',
};
let sql: Database;
let db: AppDatabase;
let neo: NeoRepository;
let asks: NeoConversationAskRepository;
let owners: NeoTodoSessionRepository;
const sdkRows = () =>
  sql.prepare('SELECT sdk_message FROM sdk_messages WHERE message_type = ?').all('user') as {
    sdk_message: string;
  }[];
const jobs = () => sql.prepare('SELECT * FROM job_queue').all();
const send = (value: unknown = { ...input, previewContext }, caller = human) =>
  invokeOperation(
    createOperationRegistry([createNeoIntakeOperation(db, neo)]),
    'neo.message.send',
    value,
    caller
  );
const read = (combined = false, imageRefs = false) =>
  invokeOperation(
    createOperationRegistry([
      createNeoConversationAskReadOperation(neo, asks, undefined, sql),
      createNeoConversationReadOperation(neo, new NeoConversationReader(sql), undefined, sql),
    ]),
    combined ? 'neo.conversation.read' : 'neo.conversation.asks.read',
    { conversationId, ...(combined ? {} : { imageRefs }) },
    human
  );
const revoke = () =>
  owners.recordRef('todo', { adapter: 'hyperneo', id: 'worker', daemon: 'remote' });

beforeEach(() => {
  sql = new Database(':memory:');
  runMigrations(sql, () => {});
  createTables(sql);
  runMigrations(sql, () => {});
  neo = new NeoRepository(sql);
  neo.reserveBinding({ sessionId, kind: 'neo', projectId: null });
  sql
    .prepare(
      "INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic', '/synthetic', 'now','now','active','{}','{}')"
    )
    .run(sessionId);
  const work = new NeoAskTodoRepository(sql);
  work.openAsk({
    id: 'ask',
    projectId: null,
    sessionId,
    originMessageId: 'm',
    title: 'Synthetic',
    request: 'Synthetic',
    createdAt: 1,
  });
  work.addTodo(
    'todo',
    'ask',
    { title: 'Report', doneWhen: '', check: null, instruction: '', named: null },
    1
  );
  owners = new NeoTodoSessionRepository(sql);
  owners.create('todo', {
    verb: 'start',
    adapter: 'hyperneo',
    place: { machine: 'synthetic', name: 'Synthetic', folder: '/synthetic' },
  });
  owners.recordRef('todo', { adapter: 'hyperneo', id: 'worker' });
  sql
    .prepare('INSERT INTO artifact_file_identity VALUES (1, ?)')
    .run('30000000-0000-4000-8000-000000000001');
  sql.prepare('INSERT INTO artifact_files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'artifact-a',
    'todo',
    'todo',
    'r',
    'f',
    previewContext.snapshot,
    10,
    JSON.stringify({
      artifact: {
        daemonId: '30000000-0000-4000-8000-000000000001',
        artifactId: 'artifact-a',
        title: 'Synthetic report',
        kind: 'markdown',
        byteLength: 10,
      },
    }),
    JSON.stringify({ adapter: 'hyperneo', id: 'worker' }),
    '/synthetic/private/report.md',
    1
  );
  asks = new NeoConversationAskRepository(sql);
  const sdk = new SDKMessageRepository(sql as never);
  const queue = new JobQueueRepository(sql);
  db = {
    getDatabase: () => sql,
    getSession: (id: string) =>
      id === sessionId
        ? ({ id, status: 'active', config: { queryMode: 'manual' } } as Session)
        : undefined,
    getSDKMessageRepo: () => sdk,
    getJobQueueRepo: () => queue,
  } as unknown as AppDatabase;
});
afterEach(() => sql.close());

describe('typed Neo Preview context', () => {
  test('records the authorized snapshot on receipt, immutable ask, prompt and both read projections', async () => {
    expect(await send()).toMatchObject({
      kind: 'completed',
      value: { ok: true, created: true, previewContext: reference },
    });
    expect(asks.find(conversationId, input.requestId)?.previewContext).toEqual(reference);
    const prompt = JSON.parse(sdkRows()[0].sdk_message);
    expect(prompt.previewContext).toEqual(reference);
    expect(JSON.stringify(prompt.message.content)).toContain(previewContext.artifactId);
    expect(JSON.stringify(prompt.message.content)).toContain(previewContext.snapshot);
    for (const combined of [false, true]) {
      const page = await read(combined, true);
      expect(page).toMatchObject({
        kind: 'completed',
        value: {
          ok: true,
          items: [
            combined
              ? { role: 'human', ask: { previewContext: reference } }
              : { previewContext: reference },
          ],
        },
      });
      expect(JSON.stringify(page)).not.toContain('sourcePath');
      expect(JSON.stringify(page)).not.toContain('/synthetic/private');
    }
    expect(jobs()).toHaveLength(1);
  });
  test.each([
    { ...previewContext, snapshot: 'b'.repeat(64) },
    { ...previewContext, artifactId: 'missing' },
  ])('rejects a missing or mismatched snapshot %o before writes', async (context) => {
    expect(await send({ ...input, previewContext: context })).toMatchObject({
      kind: 'completed',
      value: { ok: false },
    });
    expect(asks.list(conversationId)).toEqual([]);
    expect(sdkRows()).toEqual([]);
    expect(jobs()).toEqual([]);
  });
  test.each([
    { sourcePath: '/synthetic/private' },
    { displayName: 'Forged' },
    { state: 'available' },
    { snapshot: '../report.md' },
    { revision: { path: 'report.md' } },
  ])('rejects untyped or path-bearing context %o', async (extra) => {
    expect(await send({ ...input, previewContext: { ...previewContext, ...extra } })).toMatchObject(
      { kind: 'failed', code: 'invalid_input' }
    );
    expect(sdkRows()).toEqual([]);
  });
  test('replays accepted context after revocation without duplicating or rewriting the message', async () => {
    await send();
    const before = sdkRows()[0].sdk_message;
    revoke();
    expect(await send()).toMatchObject({
      value: { ok: true, created: false, previewContext: reference },
    });
    expect(sdkRows()).toHaveLength(1);
    expect(sdkRows()[0].sdk_message).toBe(before);
    expect(jobs()).toHaveLength(1);
    expect(asks.find(conversationId, input.requestId)?.previewContext).toEqual(reference);
    for (const combined of [false, true])
      expect(await read(combined)).toMatchObject({
        value: {
          ok: true,
          items: [
            combined
              ? { ask: { previewContext: { ...reference, state: 'unavailable' } } }
              : { previewContext: { ...reference, state: 'unavailable' } },
          ],
        },
      });
    const get = createArtifactReadOperations(() => sql)[0];
    expect(await get.execute({ artifactId: previewContext.artifactId }, human)).toEqual({
      accepted: false,
      reason: 'unavailable',
    });
    expect(
      await send({ ...input, requestId: '20000000-0000-4000-8000-000000000002', previewContext })
    ).toMatchObject({ value: { ok: false } });
  });
  test('refuses retry context replacement or removal while retaining one accepted ask', async () => {
    await send();
    for (const context of [
      undefined,
      { ...previewContext, snapshot: 'b'.repeat(64) },
      { ...previewContext, artifactId: 'other' },
    ])
      expect(await send({ ...input, previewContext: context })).toMatchObject({
        value: { ok: false },
      });
    expect(asks.list(conversationId)).toHaveLength(1);
    expect(sdkRows()).toHaveLength(1);
    expect(jobs()).toHaveLength(1);
  });
  test('keeps old unbound messages valid without adding context on a retry', async () => {
    expect(await send(input)).toMatchObject({ value: { ok: true } });
    expect(asks.find(conversationId, input.requestId)?.previewContext).toBeUndefined();
    expect(await send(input)).toMatchObject({ value: { ok: true, created: false } });
    expect(await send()).toMatchObject({ value: { ok: false } });
    expect(await read()).toMatchObject({ value: { ok: true } });
    expect(JSON.stringify(await read())).not.toContain('previewContext');
  });
});

test('Preview context survives the actual isolated RPC door and daemon restart', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'neo-preview-context-proof-')));
  mkdirSync(join(run, 'home'));
  mkdirSync(join(run, 'tmp'));
  try {
    const output = execFileSync(
      'bun',
      [
        fileURLToPath(new URL('../../../helpers/neo-preview-context-proof.ts', import.meta.url)),
        run,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: join(run, 'home'),
          HYPERNEO_DATA_DIR: join(run, 'data'),
          TMPDIR: join(run, 'tmp'),
          TMP: join(run, 'tmp'),
          TEMP: join(run, 'tmp'),
          NODE_ENV: 'test',
          LOG_LEVEL: 'error',
        },
        encoding: 'utf8',
        timeout: 60000,
      }
    );
    expect(JSON.parse(output.trim().split('\n').at(-1) ?? '')).toMatchObject({
      passed: true,
      exactSnapshot: true,
      openingReauthorizes: true,
      retryNoDuplicate: true,
      restartPreserved: true,
      ownedResourcesStopped: true,
    });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}, 60000);
