import assert from 'node:assert/strict';
import { existsSync, fstatSync, read } from 'node:fs';
import { mkdir, writeFile, unlink, symlink, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createLiveFileRead } from '../../../packages/daemon/src/lib/artifacts/live-file-read.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = process.argv.at(-1)!;
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
await mkdir(join(run, 'evidence'), { recursive: true });
const workspace = join(run, 'workspace');
await mkdir(workspace);
await writeFile(join(run, 'bin/gh'), '#!/bin/sh\nexit 73\n', { mode: 0o755 });
function movie(brand: string, length = 600007) {
  const bytes = Buffer.alloc(length, 0x55);
  bytes.writeUInt32BE(24, 0);
  bytes.write('ftyp', 4);
  bytes.write(brand, 8);
  bytes.writeUInt32BE(0, 12);
  bytes.write(brand, 16);
  bytes.write(brand, 20);
  return bytes;
}
const original = movie('mp42');
const paths = [
  'clip.mp4',
  'clip.mov',
  'bad.mp4',
  'wrong.mov',
  'short.mp4',
  'large.mp4',
  'limit.mp4',
  '.env.mp4',
  'linked.mp4',
  '../outside.mp4',
];
for (const [name, bytes] of Object.entries({
  'clip.mp4': original,
  'clip.mov': movie('qt  '),
  'bad.mp4': Buffer.from('not video'),
  'wrong.mov': original,
  'short.mp4': original.subarray(0, 20),
  '.env.mp4': original,
  'limit.mp4': movie('mp42', 16 * 1024 * 1024),
}))
  await writeFile(join(workspace, name), bytes);
await writeFile(join(workspace, 'large.mp4'), original.subarray(0, 24));
await truncate(join(workspace, 'large.mp4'), 16 * 1024 * 1024 + 1);
await symlink(join(workspace, 'clip.mp4'), join(workspace, 'linked.mp4'));
await writeFile(join(run, 'outside.mp4'), original);
const app = await createDaemonApp({
  config: {
    ...getConfig({
      port: 0,
      host: '127.0.0.1',
      dbPath: join(run, 'data/daemon.db'),
      workspaceRoot: run,
    }),
    disableWorktrees: true,
  },
  standalone: false,
  verbose: false,
});
await app.jobProcessor.stop();
assert(![8399, 8499].includes(app.server.port));
let ws: WebSocket | undefined;
type Result = {
  accepted: boolean;
  reason?: string;
  kind?: string;
  data?: string;
  version?: string;
  mediaType?: string;
  nextOffset?: number;
  byteLength?: number;
  complete?: boolean;
};
try {
  await app.db.createSession({
    id: 'worker',
    title: 'Synthetic video',
    workspacePath: workspace,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: {},
    metadata: {},
  } as never);
  const db = app.db.getDatabase();
  const uuid = crypto.randomUUID();
  const text = paths.map((path) => `\`${path}\``).join('\n');
  app.db.getSDKMessageRepo().saveSDKMessage('worker', {
    type: 'assistant',
    uuid,
    session_id: 'worker',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as never);
  const source = db
    .prepare('SELECT id FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?')
    .get('worker', uuid) as { id: string };
  await waitForSdkBodyCopy(db);
  const counts = () => [
    db.prepare('SELECT COUNT(*) AS n FROM artifact_files').get(),
    db.prepare('SELECT COUNT(*) AS n FROM artifact_file_identity').get(),
  ];
  const before = counts();
  ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise((resolve, reject) => {
    ws!.onopen = resolve;
    ws!.onerror = reject;
  });
  const input = (reference = 'clip.mp4', extra = {}) => ({
    sourceMessageOrCard: { kind: 'message', id: source.id },
    reference,
    ...extra,
  });
  const call = (input: object) =>
    new Promise<Result>((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => reject(new Error('RPC timeout')), 10000);
      ws!.onmessage = (event) => {
        const reply = JSON.parse(String(event.data));
        if ((reply.requestId ?? reply.id) !== id) return;
        clearTimeout(timeout);
        reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.data);
      };
      ws!.send(
        JSON.stringify({
          id,
          type: 'REQ',
          sessionId: 'global',
          method: 'operation.invoke',
          data: { name: 'file.reference.read', input },
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );
    });
  const first = await call(input());
  assert.equal(first.accepted, true, JSON.stringify(first));
  assert.equal(first.kind, 'video');
  assert.equal(first.mediaType, 'video/mp4');
  const chunks: Buffer[] = [];
  for (let offset = 0; ; ) {
    const chunk = await call(
      input('clip.mp4', { offset, version: first.version, maxBytes: 262144 })
    );
    assert(chunk.accepted);
    assert.equal(chunk.version, first.version);
    const bytes = Buffer.from(chunk.data!, 'base64');
    assert(bytes.length <= 262144);
    assert.equal(chunk.nextOffset, offset + bytes.length);
    chunks.push(bytes);
    offset = chunk.nextOffset!;
    if (chunk.complete) break;
  }
  assert(Buffer.concat(chunks).equals(original));
  assert.equal(chunks.length, 3);
  const qt = await call(input('clip.mov'));
  assert(qt.accepted);
  assert.equal(qt.kind, 'video');
  assert.equal(qt.mediaType, 'video/quicktime');
  const eof = await call(input('clip.mp4', { offset: original.length, version: first.version }));
  assert.equal(eof.data, '');
  assert.equal(eof.complete, true);
  assert.equal(
    (await call(input('clip.mp4', { offset: original.length + 1, version: first.version }))).reason,
    'invalid_offset'
  );
  for (const path of ['bad.mp4', 'wrong.mov', 'short.mp4'])
    assert.equal((await call(input(path))).reason, 'unsupported_type');
  assert.equal((await call(input('large.mp4'))).reason, 'size_limit');
  assert.equal((await call(input('limit.mp4', { maxBytes: 1 }))).accepted, true);
  for (const path of ['.env.mp4', 'linked.mp4', '../outside.mp4'])
    assert.equal((await call(input(path))).reason, 'forbidden');
  assert.equal((await call(input('unmentioned.mp4'))).reason, 'forbidden');
  const work = new NeoAskTodoRepository(db);
  work.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'worker',
    originMessageId: null,
    title: 'Synthetic video',
    request: '',
    createdAt: 1,
  });
  work.addTodo(
    'remote',
    'ask',
    { title: 'Read `clip.mp4`', instruction: null, doneWhen: '', named: null, check: null },
    2
  );
  const sessions = new NeoTodoSessionRepository(db);
  sessions.create('remote', {
    verb: 'start',
    adapter: 'hyperneo',
    place: { machine: 'local', name: 'Synthetic', folder: workspace },
  });
  sessions.recordRef('remote', { adapter: 'hyperneo', id: 'worker', daemon: 'remote' });
  assert.equal(
    (await call({ sourceMessageOrCard: { kind: 'todo', id: 'remote' }, reference: 'clip.mp4' }))
      .reason,
    'owner_unavailable'
  );
  const nativeRead = promisify(read);
  const reads: { fd: number; position: number; bytes: number; inode: number }[] = [];
  const tracked = createLiveFileRead(
    () => db,
    process.env.HOME,
    async (...args) => {
      const result = await nativeRead(...args);
      reads.push({
        fd: args[0],
        position: Number(args[4]),
        bytes: result.bytesRead,
        inode: fstatSync(args[0]).ino,
      });
      return result;
    }
  );
  const human = { source: 'rpc' as const, principal: 'local' as const };
  async function invoke(operation: ReturnType<typeof createLiveFileRead>, value: object) {
    const result = await invokeOperation(
      createOperationRegistry([operation]),
      operation.name,
      value,
      human
    );
    assert.equal(result.kind, 'completed', JSON.stringify(result));
    return (result as { kind: 'completed'; value: Result }).value;
  }
  const ranged = await invoke(
    tracked,
    input('clip.mp4', { offset: 300000, version: first.version, maxBytes: 31 })
  );
  assert(ranged.accepted);
  assert(Buffer.from(ranged.data!, 'base64').equals(original.subarray(300000, 300031)));
  assert.equal(new Set(reads.map((read) => read.fd)).size, 1);
  assert.equal(new Set(reads.map((read) => read.inode)).size, 1);
  assert.equal(
    reads.reduce((sum, read) => sum + read.bytes, 0),
    1024 + 31
  );
  assert.deepEqual(
    reads.map((read) => read.position),
    [0, 300000]
  );
  reads.length = 0;
  assert.equal((await invoke(tracked, input('large.mp4'))).reason, 'size_limit');
  assert.equal(reads.length, 0);
  const changed = Buffer.from(original);
  changed[500000] ^= 1;
  await writeFile(join(workspace, 'clip.mp4'), changed);
  assert.equal(
    (await call(input('clip.mp4', { offset: 1, version: first.version }))).reason,
    'file_changed'
  );
  const fresh = await call(input());
  assert(fresh.accepted);
  assert.notEqual(fresh.version, first.version);
  const changing = createLiveFileRead(
    () => db,
    process.env.HOME,
    async (...args) => {
      const result = await nativeRead(...args);
      await writeFile(join(workspace, 'clip.mp4'), original);
      return result;
    }
  );
  assert.equal((await invoke(changing, input())).reason, 'file_changed');
  await unlink(join(workspace, 'clip.mov'));
  assert.equal((await call(input('clip.mov'))).reason, 'missing');
  const revoking = createLiveFileRead(
    () => db,
    process.env.HOME,
    async (...args) => {
      const result = await nativeRead(...args);
      db.prepare(
        'UPDATE sdk_message_bodies SET sdk_message = ? WHERE seq=(SELECT rowid FROM sdk_messages WHERE id=?)'
      ).run(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Reference removed' }] },
        }),
        source.id
      );
      return result;
    }
  );
  assert.equal((await invoke(revoking, input())).reason, 'forbidden');
  assert.deepEqual(counts(), before);
  assert.equal(existsSync(join(run, 'data/artifacts')), false);
  const evidence = {
    passed: true,
    mp4: true,
    quickTime: true,
    exactBytes: true,
    chunks: chunks.length,
    anchoredRange: true,
    readBytes: 1055,
    byteLimit: 16777216,
    sourceChangeRefused: true,
    authorityRechecked: true,
    privatePathsRefused: true,
    foreignOwnerRefused: true,
    noRowsOrBlobs: true,
    port: app.server.port,
  };
  await writeFile(join(run, 'evidence/live-file-video.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  ws?.close();
  await app.cleanup();
}
