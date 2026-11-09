import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { createOperationMcpServer } from '../../../packages/daemon/src/lib/operations/mcp-server.ts';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], undefined);
for (const dir of ['bin', 'evidence', 'workspace']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() ? [path] : [];
  });
const materialFiles = [
  ...['packages/daemon/src', 'packages/shared/src', 'packages/space/src',
    'packages/prompts/src', 'scripts', '.claude/skills/verify'].flatMap(sourceFiles),
  'package.json', 'bun.lock',
].sort();
const material = Object.fromEntries(materialFiles.map(path => [path,
  createHash('sha256').update(readFileSync(path)).digest('hex')]));
writeFileSync(join(run, 'evidence/source-material.json'), JSON.stringify({
  head: process.argv[3], headSource: process.argv[4],
  materialHash: createHash('sha256').update(JSON.stringify(material)).digest('hex'), files: material,
}, null, 2));
writeFileSync(join(run, 'evidence/head.txt'), `${process.argv[3]}\n`);

const root = `neo:${crypto.randomUUID()}`;
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, verbose: false });
const sdk = createOperationMcpServer(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: root, role: 'neo' }));
const client = new Client({ name: 'synthetic-ask-binding', version: '1.0' });
const [local, remote] = InMemoryTransport.createLinkedPair();
let ws: WebSocket | undefined;
let restorePrepare = () => {};
const evidence: Record<string, unknown> = { transports: ['human WebSocket RPC', 'Neo MCP JSON-RPC over linked SDK transports'] };
const call = async (name: string, input: Record<string, unknown>) => {
  const result = await client.callTool({ name: 'invoke', arguments: { name, input } });
  assert(!result.isError, JSON.stringify(result));
  return JSON.parse((result.content as { text: string }[])[0].text);
};
try {
  await app.jobProcessor.stop();
  assert(![8399, 8499].includes(app.server.port));
  await sdk.instance.connect(remote);
  await client.connect(local);
  await app.db.createSession({ id: root, title: 'Synthetic ask binding', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`, { headers: { authorization: `Bearer ${await readLocalCredential()}` } } as unknown as string[]);
  await new Promise((resolve, reject) => { ws!.onopen = resolve; ws!.onerror = reject; });
  const human = async (content: string) => {
    const id = crypto.randomUUID();
    const response = await new Promise<{ error?: unknown; data?: { ok: boolean } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Human input RPC timed out')), 10000);
      ws!.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.requestId === id) { clearTimeout(timer); resolve(message); } };
      ws!.send(JSON.stringify({ id, type: 'REQ', method: 'operation.invoke', data: { name: 'neo.message.send', input: { sessionId: root, requestId: id, content } }, sessionId: 'global', timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
    assert(!response.error, JSON.stringify(response));
    const ids = app.db.getDatabase().prepare('SELECT id FROM sdk_messages WHERE session_id=? AND sdk_uuid=?').all(root, id) as { id: string }[];
    assert.equal(ids.length, 1);
    await app.db.writeSDKMessage('updateMessageStatus', ids.map(row => row.id), 'consumed');
    return id;
  };
  const db = app.db.getDatabase();
  const prepare = db.prepare;
  let mainThreadBindingQueries = 0;
  db.prepare = ((sql: string) => {
    if (sql.includes('neo_ask_inputs')) mainThreadBindingQueries++;
    return prepare.call(db, sql);
  }) as typeof db.prepare;
  restorePrepare = () => { db.prepare = prepare; };
  const check = { pack: 'core', kind: 'evidence', params: { path: join(run, 'finished.md') } };
  const first = await call('neo.todo.add', { input: await human('Make the query faster'), title: 'Index the query', check });
  assert(first.ok, JSON.stringify(first));
  const follow = await human('Also check the count query');
  const bound = await call('neo.todo.add', { input: follow, askId: first.todo.askId, title: 'Index the count query', check });
  evidence.bound = bound;
  assert(bound.ok, JSON.stringify(bound));
  const reused = await call('neo.todo.add', { input: follow, title: 'Verify the count result', check });
  assert(reused.ok, JSON.stringify(reused));
  assert.equal(bound.todo.askId, first.todo.askId);
  assert.equal(reused.todo.askId, first.todo.askId);
  const store = new NeoAskTodoRepository(app.db.getDatabase());
  const count = store.listOpenAsks().length;
  assert.equal(count, 1);
  evidence.receipts = { first, bound, reused };
  evidence.askCount = count;
  evidence.todoAskIds = [bound.todo.askId, reused.todo.askId];
  const settled = await call('neo.ask.settle', { askId: first.todo.askId, status: 'dropped', outcome: 'Synthetic matter ended' });
  assert(settled.ok, JSON.stringify(settled));
  const afterSettlement = await call('neo.todo.add', { input: follow, title: 'Check the query again', check });
  assert(afterSettlement.ok && afterSettlement.todo, JSON.stringify(afterSettlement));
  assert.notEqual(afterSettlement.todo.askId, first.todo.askId);
  assert.equal(store.getAsk(first.todo.askId)?.status, 'dropped');
  const parallelInput = await human('Check another query');
  const parallel = await Promise.all([
    call('neo.todo.add', { input: parallelInput, title: 'Index another query', check }),
    call('neo.todo.add', { input: parallelInput, title: 'Verify another query', check }),
  ]);
  for (const receipt of parallel) assert(receipt.ok && receipt.todo, JSON.stringify(receipt));
  assert.equal(parallel[0].todo.askId, parallel[1].todo.askId);
  assert.equal(store.listOpenAsks().length, 2);
  evidence.afterSettlement = afterSettlement;
  evidence.parallel = parallel;
  console.log('PASS settled input opens a fresh ask; parallel input calls share one ask');
  const mixed = [];
  for (const firstClaim of ['open', 'bind']) {
    const input = await human(`Continue the query with ${firstClaim} submitted first`);
    const before = store.listOpenAsks().length;
    const open = { input, title: 'Check the query', check };
    const bind = { ...open, askId: afterSettlement.todo.askId };
    const receipts = await Promise.all((firstClaim === 'open' ? [open, bind] : [bind, open])
      .map(request => call('neo.todo.add', request)));
    const accepted = receipts.filter(receipt => receipt.ok);
    assert(accepted.length > 0, JSON.stringify(receipts));
    const winner = accepted[0].todo.askId;
    assert(accepted.every(receipt => receipt.todo.askId === winner), JSON.stringify(receipts));
    for (const receipt of receipts.filter(receipt => !receipt.ok)) {
      assert.match(receipt.reason, new RegExp(`ask_mismatch:.*belongs to ask ${winner}`));
    }
    const repeated = await call('neo.todo.add', { ...open, title: 'Verify the chosen owner' });
    assert(repeated.ok && repeated.todo.askId === winner, JSON.stringify(repeated));
    assert.equal(store.listOpenAsks().length, before + Number(winner !== bind.askId));
    mixed.push({ firstSubmitted: firstClaim, winner, receipts, repeated });
  }
  evidence.mixed = mixed;
  console.log('PASS mixed bind/open MCP calls select one owner in both submission orders');
  restorePrepare();
  evidence.mainThreadBindingQueries = mainThreadBindingQueries;
  assert.equal(mainThreadBindingQueries, 0, 'Input bindings must use the DB gateway worker');
  evidence.links = app.db.getDatabase().prepare('SELECT session_id, message_id, ask_id FROM neo_ask_inputs').all();
  assert.equal((evidence.links as unknown[]).length, 5);
  console.log(`PASS ask count=${count}; bound todo askId=${bound.todo.askId}; reused todo askId=${reused.todo.askId}`);
} finally {
  restorePrepare();
  ws?.close();
  await client.close();
  await sdk.instance.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/ask-binding.json'), JSON.stringify(evidence, null, 2));
}
