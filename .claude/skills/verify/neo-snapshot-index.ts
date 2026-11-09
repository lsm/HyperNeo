import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';

const [mode, baseline, run] = process.argv.slice(2);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const app = await createDaemonApp({
  config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/index.db') }), disableWorktrees: true },
  verbose: false,
});
try {
  await app.jobProcessor.stop();
  await app.spaceRuntimeService.ready();
  const sessionId = 'neo:10000000-0000-4000-8000-000000000002';
  const raw = app.db.getDatabase();
  raw.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata)
    VALUES (?, 'Synthetic Neo', '/synthetic', '2026-01-01', '2026-01-01', 'active', '{}', '{}')`).run(sessionId);
  new NeoRepository(raw).reserveBinding({ sessionId, kind: 'neo', projectId: null });
  app.db.updateGlobalSettings({ neo: { standingRules: ['Synthetic index rule.'] } });
  raw.transaction(() => {
    for (let i = 0; i < 40; i++) {
      raw.prepare(`INSERT INTO neo_asks (id,session_id,title,request,status,created_at,updated_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?)`).run(`ask-${i}`, sessionId, 'Synthetic long title '.repeat(80), 'Synthetic long request '.repeat(200), i, i);
      raw.prepare(`INSERT INTO neo_todos (id,ask_id,position,title,done_when,instruction,report,created_at,updated_at)
        VALUES (?,?,0,?,?,?,?,?,?)`).run(`todo-${i}`, `ask-${i}`, 'Synthetic todo '.repeat(80), 'Synthetic completion '.repeat(80), 'Instruction '.repeat(400), 'Report '.repeat(400), i, i);
    }
  })();
  const handler = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId, role: 'neo' }));
  const snapshot = async (input: Record<string, unknown> = {}) => {
    await app.db.updateSession(sessionId, { title: 'Synthetic Neo' });
    const result = await handler({ name: 'neo.snapshot', input });
    assert.equal(result.isError ?? false, false);
    const block = result.content[0];
    assert.equal(block.type, 'text');
    if (block.type !== 'text') throw new Error('Expected text');
    const value = JSON.parse(block.text);
    assert.equal(value.ok, true);
    return value;
  };
  const rpc = await invokeOperation(app.sessionManager.getOperationRegistry(), 'neo.snapshot', {}, { source: 'rpc', principal: 'local' });
  assert.equal(rpc.kind, 'completed');
  if (rpc.kind !== 'completed') throw new Error('RPC snapshot failed');
  const normalizedRpc = JSON.parse(JSON.stringify(rpc.value, (key, value) => key === 'rev' ? undefined : key === 'setAt' ? 0 : value));
  mkdirSync(join(run, 'evidence'), { recursive: true });
  writeFileSync(join(run, 'evidence/rpc.json'), JSON.stringify(normalizedRpc, null, 2));
  if (baseline !== '-') {
    assert.deepEqual(normalizedRpc, JSON.parse(readFileSync(baseline, 'utf8')));
    console.log('RPC snapshot matches baseline: true');
  }
  const first = await snapshot();
  mkdirSync(join(run, 'evidence'), { recursive: true });
  writeFileSync(join(run, 'evidence/snapshot.json'), JSON.stringify(first, null, 2));
  console.log('Seeded open asks: 40');
  console.log(`MCP snapshot bytes: ${Buffer.byteLength(JSON.stringify(first))}`);
  console.log(`MCP asks listed: ${first.todoAsks.length}`);
  console.log(`MCP more: ${JSON.stringify(first.more ?? null)}`);
  console.log(`MCP standing rule text present: ${JSON.stringify(first).includes('Synthetic index rule.')}`);
  if (mode === 'verify') {
    assert.equal(first.todoAsks.length, 30);
    assert.equal(first.more.asks.count, 10);
    assert(!('standingRules' in first));
    assert(!('standingRuleSources' in first));
    const seen = first.todoAsks.map((entry: { ask: { id: string } }) => entry.ask.id);
    let page = first;
    while (page.more?.asks) {
      page = await snapshot({ cursor: page.more.asks.cursor });
      assert.equal(page.needsYou, first.needsYou);
      assert.equal(page.neoUnhandled, first.neoUnhandled);
      assert.deepEqual(page.omitted, first.omitted);
      seen.push(...page.todoAsks.map((entry: { ask: { id: string } }) => entry.ask.id));
    }
    assert.equal(seen.length, 40);
    assert.equal(new Set(seen).size, 40);
    console.log(`Cursor walk total asks: ${seen.length}`);
  } else {
    assert.equal(first.todoAsks.length, 30, 'Baseline must fail the new first-page contract');
  }
} finally {
  await app.cleanup();
}
console.log('Proof exit: 0');
