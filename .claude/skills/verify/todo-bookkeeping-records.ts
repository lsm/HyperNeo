import { seedHistoricalAsk } from './accepted-ask-fixtures.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { recordOperationRefusal } from '../../../packages/daemon/src/storage/repositories/operation-refusal-repository.ts';
import { gatewayFor } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const sender = 'neo:10000000-0000-4000-8000-000000000002';
const url = 'https://github.com/synthetic/proof/pull/1';
const check = { pack: 'coding', kind: 'pr_merged', params: { urls: [url] } };
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP is disabled'); }) as typeof fetch;
try {
  for (const phase of ['initial', 'restart']) {
    const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    try {
      await app.jobProcessor.stop();
      const db = app.db.getDatabase();
      const handler = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: sender, role: 'neo' }), refusal => gatewayFor(db).run(recordOperationRefusal, { refusal, sessionId: sender, at: Date.now() }));
      const described = await handler({ name: 'operations.describe', input: { name: 'neo.todo.add' } });
      const description = JSON.parse(described.content[0].text);
      evidence.push({ phase, description });
      assert.equal(described.isError ?? false, false);
      assert.equal(description.found, true);
      assert(description.description.includes('another live merge todo in the same ask is refused'));
      const invoke = async (name: string, input: unknown, refusal?: RegExp) => {
        const reply = await handler({ name, input });
        const result = JSON.parse(reply.content[0].text);
        evidence.push({ phase, name, input, result });
        assert.equal(reply.isError ?? false, false, JSON.stringify(result));
        assert.equal(result.ok, !refusal, JSON.stringify(result));
        if (refusal) assert.match(result.reason, refusal);
        return result;
      };
      if (phase === 'initial') {
        db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic bookkeeping proof', '/tmp', '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z', 'active', '{}', '{}')").run(sender);
        new NeoRepository(db).reserveBinding({ sessionId: sender, kind: 'neo', projectId: null });
        const store = new NeoAskTodoRepository(db);
        const ask = seedHistoricalAsk(store, sender, { title: 'PR admissions', request: 'Track the PR once' });
        const draft = { after: [], askId: ask.id, title: 'Original', check };
        const emptyCheck = { ...check, params: {} };
        await invoke('neo.todo.add', { ...draft, check: emptyCheck }, /pr_merged_needs_urls:/);
        const first = await invoke('neo.todo.add', draft);
        const duplicate = /pr_already_tracked:.*core\.evidence.*review comment/;
        await invoke('neo.todo.add', { ...draft, title: 'Follow-up' }, duplicate);
        const comment = `${url}#discussion_r100`;
        const plain = await invoke('neo.todo.add', { ...draft, title: 'Review', check: { pack: 'core', kind: 'evidence', params: { url: comment } } });
        await invoke('neo.todo.edit', { todoId: plain.todo.id, check: emptyCheck }, /pr_merged_needs_urls:/);
        await invoke('neo.todo.edit', { todoId: plain.todo.id, check, title: 'Duplicate edit' }, duplicate);
        const unsupported = await invoke('neo.todo.edit', { todoId: plain.todo.id, addUrls: [url], title: 'URL recorded' });
        assert(unsupported.records[0].startsWith('check_urls_unsupported:'));
        assert(unsupported.records[0].includes(url));
        assert.equal(unsupported.todo.title, 'URL recorded');
        assert.deepEqual(unsupported.todo.check, plain.todo.check);
        assert.equal(store.listTodos(ask.id).length, 2);
        const malformed = await handler({ name: 'neo.todo.add', input: { after: [], askId: first.todo.askId, title: 'Malformed', doneWhen: 'Merged', check: { ...check, params: { urls: ['not-a-pr'] } } } });
        const rejected = JSON.parse(malformed.content[0].text);
        evidence.push({ phase, malformed: rejected });
        assert.equal(rejected.ok, false);
        assert(rejected.reason.includes('pr_merged_invalid_urls:'));
      }
      const records = db.prepare('SELECT operation, reason, accepted FROM operation_refusals ORDER BY id').all() as { reason: string; accepted: number }[];
      evidence.push({ phase, records });
      assert.equal(records.length, 6);
      assert.equal(records.filter(row => row.accepted === 1).length, 1);
      assert(records.some(row => row.accepted === 0 && row.reason.includes('pr_merged_invalid_urls:')));
    } finally { await app.cleanup(); }
  }
  console.log('PASS: real daemon MCP refuses duplicate and empty merge checks, accepts review links, and retains audit records across restart.');
} finally { globalThis.fetch = network; writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2)); }
