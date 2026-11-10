process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import vectors from '../../../packages/shared/tests/fixtures/file-path-boundaries.json' with { type: 'json' };
import { previewLinkedReferenceCandidates } from '../../../packages/shared/src/types/artifact-reference.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
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
let front: ReturnType<typeof Bun.serve> | undefined;
const observed: unknown[] = [];
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await waitForSdkBodyCopy(app.db.getDatabase());
  assert.notEqual(app.server.port, 8399);
  assert.notEqual(app.server.port, 8499);
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
    const reads = vector.read ? [translate(vector.read)] : paths;
    const content = `# Boundary ${index}\n`;
    for (const reference of reads) {
      const path = reference.startsWith('~/') ? join(run, 'home', reference.slice(2)) : reference;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    const response = JSON.parse((await publish({ name: 'neo.publication.publish', input: { requestId: crypto.randomUUID(), shortText: text, fullText: text } })).content[0].text);
    assert(response.accepted, JSON.stringify(response));
    const source = response.publication.publicationId;
    const cards = previewLinkedReferenceCandidates(text).flatMap(item => item.kind === 'local' ? [item.path] : []);
    const replies = [];
    for (const reference of reads) {
      const reply = await read(source, reference);
      replies.push({ reference, accepted: reply.accepted, reason: reply.reason });
      observed.push({ index, text, cards, replies: [...replies] });
      if (vector.readReason) assert.equal(reply.reason, vector.readReason);
      else {
        assert(reply.accepted, JSON.stringify({ index, text, reference, reply }));
        assert.equal(Buffer.from(reply.data!, 'base64').toString(), content);
      }
    }
    assert.deepEqual(cards, paths);
    assert.equal((await read(source, join(workspace, 'unmentioned.md'))).reason, 'forbidden');
  }
  const browserAt = process.argv.indexOf('--browser');
  if (browserAt >= 0) {
    const control = resolve(process.argv[browserAt + 1]);
    const path = join(workspace, '可读报告.md');
    writeFileSync(path, '# Chinese boundary report\n\nCurrent bytes from the source owner.');
    const text = `报告：${path}。 Saved to ${path}.`;
    const result = JSON.parse((await publish({ name: 'neo.publication.publish', input: { requestId: crypto.randomUUID(), shortText: text, fullText: text } })).content[0].text);
    assert(result.accepted);
    const dist = resolve('packages/web/dist');
    front = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request, server) {
      const refusal = await app.guardRequest(request);
      if (refusal) return refusal;
      const route = new URL(request.url).pathname;
      if (route === '/proof-entry') return new Response(null, { status: 302, headers: { location: '/neo', 'set-cookie': `hyperneo_device=${readLocalCredential()}; HttpOnly; SameSite=Strict; Path=/` } });
      if (route === '/ws') {
        if (server.upgrade(request, { data: { connectionSessionId: 'global', device: await app.authenticateUpgrade(request, '127.0.0.1') } })) return;
        return new Response('Upgrade failed', { status: 500 });
      }
      const file = Bun.file(join(dist, route === '/neo' ? 'neo/index.html' : route));
      return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
    }, websocket: createWebSocketHandlers(app.transport, app.sessionManager) });
    assert.notEqual(front.port, 8399);
    assert.notEqual(front.port, 8499);
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, 'browser.json'), JSON.stringify({ url: `http://127.0.0.1:${front.port}/proof-entry`, evidence: join(run, 'evidence'), doneFile: join(control, 'done') }));
    const until = Date.now() + 15 * 60_000;
    while (!existsSync(join(control, 'done')) && Date.now() < until) await Bun.sleep(250);
    assert(existsSync(join(control, 'done')), 'Complete the real browser observation.');
    assert.equal(JSON.parse(readFileSync(join(run, 'evidence/browser.json'), 'utf8')).passed, true);
  }
  assert.deepEqual(counts(), before);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ passed: true, cases: vectors.length, observed, noArtifactRowsAdded: true, unmentionedPathsForbidden: true }, null, 2));
} finally {
  ws?.close();
  await front?.stop(true);
  await app.cleanup();
  writeFileSync(join(run, 'evidence/receipts.json'), JSON.stringify(observed, null, 2));
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ resourcesClosed: true }));
}
