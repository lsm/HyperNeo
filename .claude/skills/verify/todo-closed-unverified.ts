import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const sender = 'neo:10000000-0000-4000-8000-000000000002';
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP is disabled'); }) as typeof fetch;
let id = '';
try {
  for (const phase of ['initial', 'restart']) {
    const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    try {
      await app.jobProcessor.stop();
      const db = app.db.getDatabase(), store = new NeoAskTodoRepository(db);
      const registry = app.sessionManager.getOperationRegistry();
      const handler = createOperationMcpHandler(() => registry, () => ({ sessionId: sender, role: 'neo' }));
      const invoke = async (name: string, input: unknown) => {
        const reply = await handler({ name, input });
        const result = JSON.parse(reply.content[0].text);
        evidence.push({ phase, name, input, result });
        assert.equal(reply.isError ?? false, false, JSON.stringify(result));
        assert.equal(result.ok, true, JSON.stringify(result));
        return result;
      };
      if (phase === 'initial') {
        db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic close proof', '/tmp', '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z', 'active', '{}', '{}')").run(sender);
        new NeoRepository(db).reserveBinding({ sessionId: sender, kind: 'neo', projectId: null });
        const opened = await invoke('neo.ask.open', { title: 'Synthetic close proof', request: 'Close without claiming verified delivery', todos: [{ title: 'Unverified delivery', doneWhen: 'Result checked', check: { pack: 'coding', kind: 'pr_merged', params: { urls: ['https://github.com/synthetic/proof/pull/1'] } } }] });
        id = opened.todos[0].id;
        const closed = await invoke('neo.todo.close', { todoId: id, reason: 'Stopping before delivery is verified' });
        assert.equal(closed.todo.state, 'closed_unverified');
      }
      assert.equal(store.getTodo(id)?.state, 'closed_unverified');
      const snapshot = await invoke('neo.ask.list', {});
      const text = JSON.stringify(snapshot);
      assert(text.includes('Closed unverified'), text);
      assert(!text.includes('"doneCount":1'), text);
    } finally { await app.cleanup(); }
  }
  console.log('PASS: real daemon MCP closes without claiming Done; reads show Closed unverified across restart.');
} finally { globalThis.fetch = network; writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2)); }
