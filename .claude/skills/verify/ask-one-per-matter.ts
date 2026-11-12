import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const sender = 'neo:10000000-0000-4000-8000-000000000007';
const pull = 'https://github.com/synthetic/proof/pull/7';
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP is disabled'); }) as typeof fetch;
try {
  const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  try {
    await app.jobProcessor.stop();
    const db = app.db.getDatabase();
    db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic matter proof', '/tmp', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z', 'active', '{}', '{}')").run(sender);
    new NeoRepository(db).reserveBinding({ sessionId: sender, kind: 'neo', projectId: null });
    const handler = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: sender, role: 'neo' }));
    const invoke = async (step: string, name: string, input: unknown) => {
      const reply = await handler({ name, input });
      const result = JSON.parse(reply.content[0].text);
      evidence.push({ step, name, input, result });
      console.log(`${step}: ${result.ok ? `ok ask=${result.ask?.id}` : `refused ${result.reason}`}`);
      return result;
    };
    const open = () => db.prepare("SELECT id FROM neo_asks WHERE status = 'open' ORDER BY created_at").all().map((row) => (row as { id: string }).id);

    const first = await invoke('first ask for the pull request', 'neo.ask.open', { title: 'Review the fix', request: `Review ${pull} and merge it` });
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = await invoke('second ask for the same pull request', 'neo.ask.open', { title: 'Deploy the fix', request: 'Deploy synthetic/proof#7 once it is merged' });
    assert.equal(second.ok, false);
    assert(second.reason.startsWith('ask_open:'), second.reason);
    assert(second.reason.includes(`(${first.ask.id})`), second.reason);
    assert.deepEqual(open(), [first.ask.id]);
    const retry = await invoke('retry with the first title', 'neo.ask.open', { title: 'Review the fix', request: `Review ${pull} and merge it` });
    assert.equal(retry.ask.id, first.ask.id);
    const other = await invoke('ask for another pull request', 'neo.ask.open', { title: 'Review the next', request: 'Review synthetic/proof#8' });
    assert.equal(other.ok, true, JSON.stringify(other));
    const plain = await invoke('ask that names no pull request', 'neo.ask.open', { title: 'Tidy the notes', request: 'No reference here' });
    assert.equal(plain.ok, true, JSON.stringify(plain));
    assert.deepEqual(open(), [first.ask.id, other.ask.id, plain.ask.id]);
    const settled = await invoke('settle the first ask', 'neo.ask.settle', { askId: first.ask.id, status: 'dropped', outcome: 'Synthetic: not needed' });
    assert.equal(settled.ok, true, JSON.stringify(settled));
    const again = await invoke('ask for the pull request after the first is settled', 'neo.ask.open', { title: 'Deploy the fix', request: 'Deploy synthetic/proof#7 once it is merged' });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.notEqual(again.ask.id, first.ask.id);
  } finally { await app.cleanup(); }
  console.log('PASS: the real daemon refuses a second open ask for the same pull request with the first ask’s id, and opens it once the first is settled.');
} finally { globalThis.fetch = network; writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2)); }
