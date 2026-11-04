import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import vectors from '../../../packages/shared/tests/fixtures/file-path-boundaries.json' with { type: 'json' };
import { previewLinkedReferenceCandidates } from '../../../packages/shared/src/types/artifact-reference.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const workspace = join(run, 'workspace');
for (const part of ['workspace', 'evidence', 'bin']) mkdirSync(join(run, part), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, standalone: false, verbose: false });
let ws: WebSocket | undefined;
const observed: unknown[] = [];
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await waitForSdkBodyCopy(app.db.getDatabase());
  assert.notEqual(app.server.port, 8399);
  const root = `neo:${crypto.randomUUID()}`;
  await app.db.createSession({ id: root, title: 'Synthetic path owner', workspacePath: workspace, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: {} } as never);
  const db = app.db.getDatabase();
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const publish = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: root, role: 'neo' }));
  ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise((done, fail) => { ws!.onopen = done; ws!.onerror = fail; });
  const read = (source: string, reference: string) => new Promise<{ accepted: boolean; reason?: string; data?: string }>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
    ws!.onmessage = event => {
      const reply = JSON.parse(String(event.data));
      if ((reply.requestId ?? reply.id) !== id) return;
      clearTimeout(timer);
      reply.error ? fail(new Error(JSON.stringify(reply.error))) : done(reply.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name: 'file.reference.read', input: { sourceMessageOrCard: { kind: 'publication', id: source }, reference } }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const counts = () => ['artifact_files', 'artifact_file_identity'].map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get());
  const before = counts();
  for (const [index, vector] of vectors.entries()) {
    const translate = (text: string) => text.replaceAll('/Users/a/', `${workspace}/`);
    const text = translate(vector.text), paths = vector.paths.map(translate);
    const content = `# Boundary ${index}\n`;
    for (const reference of paths) {
      const path = reference.startsWith('~/') ? join(run, 'home', reference.slice(2)) : reference;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    const response = JSON.parse((await publish({ name: 'neo.publication.publish', input: { requestId: crypto.randomUUID(), shortText: text, fullText: text } })).content[0].text);
    assert(response.accepted, JSON.stringify(response));
    const source = response.publication.publicationId;
    const cards = previewLinkedReferenceCandidates(text).flatMap(item => item.kind === 'local' ? [item.path] : []);
    const replies = [];
    for (const reference of paths) {
      const reply = await read(source, reference);
      replies.push({ reference, accepted: reply.accepted, reason: reply.reason });
      observed.push({ index, text, cards, replies: [...replies] });
      assert(reply.accepted, JSON.stringify({ index, text, reference, reply }));
      assert.equal(Buffer.from(reply.data!, 'base64').toString(), content);
    }
    assert.deepEqual(cards, paths);
    assert.equal((await read(source, join(workspace, 'unmentioned.md'))).reason, 'forbidden');
  }
  assert.deepEqual(counts(), before);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ passed: true, cases: vectors.length, observed, noArtifactRowsAdded: true, unmentionedPathsForbidden: true }, null, 2));
} finally {
  ws?.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/receipts.json'), JSON.stringify(observed, null, 2));
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ resourcesClosed: true }));
}
