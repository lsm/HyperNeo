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
const evidence: Record<string, unknown> = {};
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const sender = 'neo:10000000-0000-4000-8000-000000000003';
  const db = app.db.getDatabase();
  db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic Neo', '/tmp', '2026-11-07T00:00:00Z', '2026-11-07T00:00:00Z', 'active', '{}', '{}')").run(sender);
  new NeoRepository(db).reserveBinding({ sessionId: sender, kind: 'neo', projectId: null });
  const registry = () => app.sessionManager.getOperationRegistry();
  const handler = createOperationMcpHandler(registry, () => ({ sessionId: sender, role: 'neo' }));
  const reply = await handler({ name: 'neo.ask.open', input: { title: 'Synthetic proposal', request: 'Improve the synthetic workflow because it is confusing' } });
  evidence.open = reply;
  assert(!reply.isError);
  const opened = JSON.parse(reply.content[0].text);
  assert.equal(opened.ok, true);
  const snapshot = await invokeOperation(registry(), 'neo.snapshot', {}, { source: 'rpc', principal: 'local' });
  evidence.snapshot = snapshot;
  assert.equal(snapshot.kind, 'completed');
  const cards = (snapshot as { value: { todoAsks: { ask: { id: string }; questions?: { kind: string; state: string }[] }[] } }).value.todoAsks;
  const proposal = cards.find((entry) => entry.ask.id === opened.ask.id);
  assert(proposal, 'proposal appears in human snapshot');
  assert(proposal.questions?.some((question) => question.kind === 'yesno' && question.state === 'open'), 'proposal has an open human decision card');
  console.log('PASS: Neo proposal is visible with a human decision card.');
} finally {
  writeFileSync(join(run, 'evidence/new-work-source.json'), JSON.stringify(evidence, null, 2));
  await app.cleanup();
}
