import assert from 'node:assert/strict';
import { mkdir, writeFile, chmod, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

const run = process.argv.at(-1)!;
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
await mkdir(join(run, 'evidence'), { recursive: true });
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
let front: ReturnType<typeof Bun.serve> | undefined;
const observed: Record<string, unknown> = {};
try {
  app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), disableWorktrees: true }, standalone: false, verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399); assert.notEqual(app.server.port, 8499);
  const root = `neo:${crypto.randomUUID()}`;
  for (const id of [root, 'worker']) await app.db.createSession({ id, title: 'Synthetic', workspacePath: run, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: {}, metadata: {} } as never);
  const db = app.db.getDatabase();
  const neo = new NeoRepository(db); neo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const store = new NeoAskTodoRepository(db);
  store.openAsk({ id: 'ask', projectId: null, sessionId: root, originMessageId: 'input', title: 'Synthetic', request: 'Synthetic', createdAt: 1 });
  store.askQuestion('question', 'ask', { text: 'Read the report?', kind: 'reply', options: null, multiple: false, noLabel: null, yesLabel: null, startTodos: null }, 1);
  const drafts = join(run, 'data/handoffs/worker/drafts'); await mkdir(drafts, { recursive: true });
  await writeFile(join(drafts, 'report.html'), '<h1>Safe card report</h1><script>window.bad=1</script>');
  const worker = createOperationMcpHandler(() => app!.sessionManager.getOperationRegistry(), () => ({ sessionId: 'worker' }));
  const publication = JSON.parse((await worker({ name: 'handoff.publish', input: { name: 'report.html' } })).content[0].text);
  assert.equal(publication.kind, 'published');
  const reference = publication.publicReference;
  assert(!JSON.stringify(reference).includes(run));
  db.prepare('UPDATE neo_questions SET artifacts_json = ? WHERE id = ?').run(JSON.stringify([reference]), 'question');
  const neoCall = createOperationMcpHandler(() => app!.sessionManager.getOperationRegistry(), () => ({ sessionId: root, role: 'neo' }));
  const created = JSON.parse((await neoCall({ name: 'neo.publication.publish', input: { requestId: crypto.randomUUID(), shortText: 'Synthetic report', fullText: 'Synthetic report is ready.' } })).content[0].text);
  assert(created.accepted);
  const id = created.publication.publicationId, conversation = created.publication.conversationId;
  const row = db.prepare('SELECT payload_json AS payload FROM neo_publications WHERE conversation_id = ? AND publication_id = ?').get(conversation, id) as {payload:string};
  db.prepare('UPDATE neo_publications SET payload_json = ? WHERE conversation_id = ? AND publication_id = ?').run(JSON.stringify({ ...JSON.parse(row.payload), artifacts: [reference] }), conversation, id);
  ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = reject; });
  const read = (source: {kind:string;id:string}, ref = reference) => new Promise<Record<string, any>>((resolve, reject) => {
    const id = crypto.randomUUID(); const timeout = setTimeout(() => reject(new Error('RPC timeout')), 10000);
    ws!.onmessage = event => { const reply = JSON.parse(String(event.data)); if ((reply.requestId ?? reply.id) !== id) return; clearTimeout(timeout); reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name: 'file.handoff.read', input: { source, reference: ref } }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  for (const source of [{ kind: 'question', id: 'question' }, { kind: 'publication', id }]) {
    const result = await read(source); assert(result.accepted); assert.equal(result.kind, 'html');
    const html = Buffer.from(result.data, 'base64').toString(); assert(html.includes('Safe card report')); assert(!html.includes('<script>')); assert(!JSON.stringify(result).includes(run));
  }
  assert.equal((await read({ kind: 'question', id: 'question' }, { ...reference, name: 'forged.html' })).reason, 'forbidden');
  assert.equal((await read({ kind: 'question', id: 'missing' })).reason, 'forbidden');
  const ask = JSON.parse((await neoCall({ name: 'neo.ask.read', input: { askId: 'ask' } })).content[0].text);
  assert(ask.ok); assert.deepEqual(ask.entry.questions[0].artifacts, [reference]);
  const browserAt = process.argv.indexOf('--browser');
  if (browserAt >= 0) {
    db.prepare('UPDATE neo_publications SET payload_json = ? WHERE conversation_id = ? AND publication_id = ?').run(row.payload, conversation, id);
    const control = resolve(process.argv[browserAt + 1]);
    const dist = resolve('packages/web/dist');
    front = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request, server) {
      const refusal = await app!.guardRequest(request); if (refusal) return refusal;
      const route = new URL(request.url).pathname;
      if (route === '/proof-entry') return new Response(null, { status: 302, headers: { location: '/neo', 'set-cookie': `hyperneo_device=${readLocalCredential()}; HttpOnly; SameSite=Strict; Path=/` } });
      if (route === '/ws') {
        if (server.upgrade(request, { data: { connectionSessionId: 'global', device: await app!.authenticateUpgrade(request, '127.0.0.1') } })) return;
        return new Response('Upgrade failed', { status: 500 });
      }
      const file = Bun.file(join(dist, route === '/neo' ? 'neo/index.html' : route));
      return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
    }, websocket: createWebSocketHandlers(app.transport, app.sessionManager) });
    assert.notEqual(front.port, 8399); assert.notEqual(front.port, 8499);
    await mkdir(control, { recursive: true });
    await writeFile(join(control, 'browser.json'), JSON.stringify({ url: `http://127.0.0.1:${front.port}/proof-entry`, evidence: join(run, 'evidence'), doneFile: join(control, 'done') }));
    const end = Date.now() + 15 * 60_000;
    while (Date.now() < end) { try { await access(join(control, 'done')); break; } catch { await Bun.sleep(250); } }
    assert.equal(JSON.parse(await readFile(join(run, 'evidence/browser.json'), 'utf8')).passed, true);
  }
  await chmod(publication.reference.path, 0o600); await writeFile(publication.reference.path, 'modified');
  assert.equal((await read({ kind: 'question', id: 'question' })).reason, 'file_changed');
  Object.assign(observed, { passed: true, realMcpPublish: true, questionRpc: true, publicationRpc: true, htmlSanitized: true, tamperRefused: true, sourceBound: true, noPathExposed: true });
} finally { ws?.close(); await front?.stop(true); await app?.cleanup(); }
observed.resourcesClosed = true;
await writeFile(join(run, 'evidence/card-handoff.json'), JSON.stringify(observed, null, 2));
console.log(JSON.stringify(observed));
