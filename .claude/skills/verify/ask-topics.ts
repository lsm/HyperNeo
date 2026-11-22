import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const sender = 'neo:10000000-0000-4000-8000-000000000003';
const ids: Record<string, string> = {};
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP is disabled'); }) as typeof fetch;
try {
  for (const phase of ['initial', 'restart']) {
    const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    try {
      await app.jobProcessor.stop();
      assert.notEqual(app.server.port, 8399);
      const db = app.db.getDatabase();
      const registry = () => app.sessionManager.getOperationRegistry();
      const handler = createOperationMcpHandler(registry, () => ({ sessionId: sender, role: 'neo' }));
      const call = async (name: string, input: unknown) => {
        const reply = await handler({ name, input });
        const result = JSON.parse(reply.content[0].text);
        evidence.push({ phase, name, input, isError: reply.isError ?? false, result });
        return result;
      };
      const rpcTopics = async () => {
        const reply = await invokeOperation(registry(), 'neo.snapshot', {}, { source: 'rpc', principal: 'local' });
        assert.equal(reply.kind, 'completed');
        const view = (reply as { value: { todoAsks: { ask: { id: string; topic: string | null } }[] } }).value;
        const topics = Object.fromEntries(view.todoAsks.map((entry) => [entry.ask.id, entry.ask.topic]));
        evidence.push({ phase, name: 'rpc neo.snapshot', topics });
        return topics;
      };
      if (phase === 'initial') {
        const columns = db.prepare("SELECT name FROM pragma_table_info('neo_asks') WHERE name = 'topic'").all();
        assert.equal(columns.length, 1);
        db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic Neo', '/tmp', '2026-11-07T00:00:00Z', '2026-11-07T00:00:00Z', 'active', '{\"queryMode\":\"manual\"}', '{}')").run(sender);
        new NeoRepository(db).reserveBinding({ sessionId: sender, kind: 'neo', projectId: null });
        const labelled = await call('neo.ask.propose', { title: 'Synthetic screen time', request: 'Synthetic request', topic: ' 家长控制 ' });
        const plain = await call('neo.ask.propose', { title: 'Synthetic inbox', request: 'Synthetic request' });
        assert.equal(labelled.ask.topic, '家长控制');
        assert.equal(plain.ask.topic, null);
        const tooLong = await handler({ name: 'neo.ask.propose', input: { title: 'Synthetic long', request: 'Synthetic request', topic: 'Thirteen char' } });
        evidence.push({ phase, name: 'neo.ask.propose', refused: tooLong.content[0].text });
        assert.equal(tooLong.isError, true);
        const wide = await handler({ name: 'neo.ask.propose', input: { title: 'Synthetic wide topic', request: 'Synthetic request', topic: '甲乙丙丁戊己A' } });
        evidence.push({ phase, name: 'neo.ask.propose', wide: wide.content[0].text });
        assert.equal(wide.isError, true, 'reject a 13-cell pick even when it fits in 12 code units');
        assert.equal(db.prepare("SELECT id FROM neo_asks WHERE title = 'Synthetic wide topic'").get(), null);
        const addFromHuman = async (topic: string) => {
          const input = crypto.randomUUID();
          const reply = await invokeOperation(registry(), 'neo.message.send', {
            sessionId: sender, requestId: input, content: 'Synthetic direct request',
          }, { source: 'rpc', principal: 'local' });
          assert.equal(reply.kind, 'completed');
          const message = db.prepare('SELECT id FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?').get(sender, input) as { id: string };
          await app.db.writeSDKMessage('updateMessageStatus', [message.id], 'consumed');
          return handler({ name: 'neo.todo.add', input: {
            input, topic, after: [], title: 'Synthetic direct todo',
            check: { pack: 'core', kind: 'evidence', params: { path: join(run, 'finished.md') } },
          } });
        };
        for (const topic of ['HyperNeo', 'neo-ios', '支付', 'Twelve cells', '甲乙丙丁戊👨‍👩‍👧‍👦']) {
          const offered = await call('neo.ask.propose', { title: `Synthetic ${topic}`, request: 'Synthetic request', topic });
          assert.equal(offered.ask.topic, topic);
          assert.equal((await call('neo.ask.topic', { askId: plain.ask.id, topic })).ask.topic, topic);
          const added = await addFromHuman(topic);
          assert(!added.isError, added.content[0].text);
          const { todo } = JSON.parse(added.content[0].text);
          assert.deepEqual(db.prepare('SELECT topic FROM neo_asks WHERE id = ?').get(todo.askId), { topic });
          evidence.push({ name: 'neo.todo.add', topic, askId: todo.askId });
        }
        const before = db.prepare('SELECT id, topic FROM neo_asks ORDER BY id').all();
        const refusedEdit = await handler({ name: 'neo.ask.topic', input: { askId: plain.ask.id, topic: '甲乙丙丁戊己A' } });
        const refusedAdd = await addFromHuman('甲乙丙丁戊己A');
        assert.equal(refusedEdit.isError, true);
        assert.equal(refusedAdd.isError, true);
        assert.deepEqual(db.prepare('SELECT id, topic FROM neo_asks ORDER BY id').all(), before);
        assert.equal((await call('neo.ask.topic', { askId: plain.ask.id, topic: '邮件' })).ask.topic, '邮件');
        await call('neo.ask.settle', { askId: labelled.ask.id, status: 'dropped', outcome: 'Synthetic drop' });
        const settled = await call('neo.ask.topic', { askId: labelled.ask.id, topic: 'OAP' });
        assert.deepEqual(settled, { ok: false, reason: 'ask_settled: this ask is dropped.' });
        ids.labelled = labelled.ask.id;
        ids.plain = plain.ask.id;
      }
      const topics = await rpcTopics();
      assert.equal(topics[ids.labelled], '家长控制');
      assert.equal(topics[ids.plain], '邮件');
    } finally { await app.cleanup(); }
  }
  console.log(`PASS: neo.ask.propose topic trimmed and optional, 13 chars refused, neo.ask.topic sets open asks and refuses settled ones, RPC snapshot carries topic across restart. Evidence: ${run}/evidence/ask-topics.json`);
} finally { globalThis.fetch = network; writeFileSync(join(run, 'evidence/ask-topics.json'), JSON.stringify(evidence, null, 2)); }
