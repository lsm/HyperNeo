import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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
  // Two sessions share one workspace, so their SDK transcripts share one folder.
  const workspace = join(run, 'shared-workspace');
  mkdirSync(workspace);
  const dir = getSDKProjectDir(workspace);
  assert.ok(dir.startsWith(join(run, 'home')), dir);
  mkdirSync(dir, { recursive: true });
  const worker = crypto.randomUUID();
  const other = crypto.randomUUID();
  const sdk = { worker: crypto.randomUUID(), other: crypto.randomUUID() };
  const line = (sessionId: string, text: string) =>
    JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), sessionId,
      message: { role: 'user', content: [{ type: 'text', text }] } });
  writeFileSync(join(dir, `${sdk.worker}.jsonl`), `${line(sdk.worker, 'worker transcript')}\n`);
  // The other session's transcript talks about the worker, as a Neo session does.
  writeFileSync(join(dir, `${sdk.other}.jsonl`),
    `${line(sdk.other, `worker ${worker} opened a PR`)}\n${line(sdk.other, `archive ${worker}`)}\n`);
  const now = new Date().toISOString();
  for (const [id, sdkSessionId] of [[worker, sdk.worker], [other, sdk.other]])
    await app.db.createSession({ id, title: 'Transcript proof', workspacePath: workspace, sdkSessionId,
      createdAt: now, lastActiveAt: now, status: 'active', config: { queryMode: 'manual' },
      metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const reply = await rpc('session.archive', { sessionId: worker, confirmed: true });
  evidence.archive = reply;
  assert.ok(!reply.error, JSON.stringify(reply));
  const archive = join(run, 'data', 'claude-session-archives', worker);
  evidence.workerStatus = app.db.getSession(worker)?.status;
  evidence.projectFolder = readdirSync(dir).sort();
  evidence.archiveFolder = existsSync(archive) ? readdirSync(archive).sort() : null;
  evidence.otherTranscriptInPlace = existsSync(join(dir, `${sdk.other}.jsonl`));
  assert.equal(evidence.workerStatus, 'archived');
  assert.deepEqual(evidence.projectFolder, [`${sdk.other}.jsonl`]);
  assert.deepEqual(evidence.archiveFolder, [`${sdk.worker}.jsonl`, 'archive-metadata.json'].sort());
  console.log('PASS: archiving the worker moved only its own transcript; the other session\'s transcript that mentions the worker stayed in place.');
} finally {
  writeFileSync(join(run, 'evidence/archive-transcripts.json'), JSON.stringify(evidence, null, 2));
  await app?.cleanup();
}
