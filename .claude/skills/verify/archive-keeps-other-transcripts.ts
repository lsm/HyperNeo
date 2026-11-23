import { strict as assert } from 'node:assert';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { getSDKProjectDir } from '../../../packages/daemon/src/lib/sdk-session-file-manager.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: Record<string, unknown> = {};
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;

async function rpc(method: string, data: unknown) {
  const ws = new WebSocket(`ws://127.0.0.1:${app!.server.port}/ws`, {
    headers: { authorization: `Bearer ${readLocalCredential(join(run, 'data/local-rpc.credential'))}` },
  } as unknown as string[]);
  await new Promise<void>((done, fail) => {
    ws.onopen = () => done();
    ws.onerror = () => fail(new Error('connection failed'));
  });
  try {
    return await new Promise<Record<string, unknown>>((done, fail) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => fail(new Error(`${method} timed out`)), 30000);
      ws.onmessage = (event) => {
        const response = JSON.parse(String(event.data));
        if (response.id !== id && response.requestId !== id) return;
        clearTimeout(timer);
        done(response);
      };
      ws.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data,
        timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
  } finally {
    ws.close();
  }
}

try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1',
    dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const workspace = join(run, 'shared-workspace');
  mkdirSync(workspace);
  const dir = getSDKProjectDir(workspace);
  assert.ok(dir.startsWith(join(run, 'home')), dir);
  mkdirSync(dir, { recursive: true });
  const worker = crypto.randomUUID();
  const other = crypto.randomUUID();
  const sdk = { worker: crypto.randomUUID(), retired: crypto.randomUUID(), other: crypto.randomUUID() };
  const file = (id: string) => join(dir, `${id}.jsonl`);
  const line = (sessionId: string, text: string) =>
    JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), sessionId, timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text }] } });
  writeFileSync(file(sdk.worker), `${line(sdk.worker, 'worker transcript')}\n`);
  writeFileSync(file(sdk.retired), `${line(sdk.retired, 'worker transcript before a reset')}\n`);
  writeFileSync(file(sdk.other),
    `${line(sdk.other, `worker ${worker} (${sdk.worker}) opened a PR`)}\n${line(worker, `archive ${worker}`)}\n`);
  const otherBefore = readFileSync(file(sdk.other));
  const now = new Date().toISOString();
  const metadata = { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 };
  await app.db.createSession({ id: worker, title: 'Transcript proof', workspacePath: workspace, sdkSessionId: sdk.worker,
    createdAt: now, lastActiveAt: now, status: 'active', config: { queryMode: 'manual' },
    metadata: { ...metadata, pastSdkSessionIds: [sdk.retired] } });
  await app.db.createSession({ id: other, title: 'Transcript proof', workspacePath: workspace, sdkSessionId: sdk.other,
    createdAt: now, lastActiveAt: now, status: 'active', config: { queryMode: 'manual' }, metadata });
  const archived = await rpc('session.archive', { sessionId: worker, confirmed: true });
  evidence.archive = archived;
  assert.ok(!archived.error, JSON.stringify(archived));
  evidence.workerStatus = app.db.getSession(worker)?.status;
  evidence.afterArchive = readdirSync(dir, { recursive: true }).map(String).sort();
  evidence.otherUnchangedAfterArchive = readFileSync(file(sdk.other)).equals(otherBefore);
  assert.equal(evidence.workerStatus, 'archived');
  assert.deepEqual(evidence.afterArchive, [
    `${sdk.worker}`, `${sdk.worker}.jsonl`, `${sdk.worker}/archived.json`,
    `${sdk.retired}`, `${sdk.retired}.jsonl`, `${sdk.retired}/archived.json`, `${sdk.other}.jsonl`,
  ].sort());
  assert.equal(evidence.otherUnchangedAfterArchive, true);
  const restored = await rpc('session.unarchive', { sessionId: worker });
  evidence.restore = restored;
  assert.deepEqual(restored.data, { success: true });
  const afterRestore = readdirSync(dir, { recursive: true }).map(String).sort();
  evidence.afterRestore = afterRestore;
  evidence.otherUnchangedAfterRestore = readFileSync(file(sdk.other)).equals(otherBefore);
  assert.equal(app.db.getSession(worker)?.status, 'active');
  for (const id of [sdk.worker, sdk.retired]) {
    assert.ok(afterRestore.includes(`${id}.jsonl`));
    assert.ok(!afterRestore.includes(`${id}/archived.json`), 'SDK archive marker remained after restore');
  }
  assert.equal(evidence.otherUnchangedAfterRestore, true);
  const rearchived = await rpc('session.archive', { sessionId: worker, confirmed: true });
  assert.ok(!rearchived.error, JSON.stringify(rearchived));
  const deleted = await rpc('session.delete', { sessionId: worker });
  evidence.delete = deleted;
  assert.ok(!deleted.error, JSON.stringify(deleted));
  evidence.afterDelete = readdirSync(dir, { recursive: true }).map(String).sort();
  evidence.otherUnchangedAfterDelete = readFileSync(file(sdk.other)).equals(otherBefore);
  assert.deepEqual(evidence.afterDelete, [`${sdk.other}.jsonl`]);
  assert.equal(evidence.otherUnchangedAfterDelete, true);
  console.log('PASS: archiving the worker marked its current and retired transcripts archived in place; restoring cleared both archive markers; deleting it removed only those; the other session transcript that mentions the worker stayed byte-identical.');
} finally {
  writeFileSync(join(run, 'evidence/archive-transcripts.json'), JSON.stringify(evidence, null, 2));
  await app?.cleanup();
}
