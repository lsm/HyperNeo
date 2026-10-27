import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SDKMessage } from '../../../packages/shared/src/sdk/index.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const name of ['workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const dbPath = join(run, 'data/daemon.db');
const phase = process.argv.includes('--phase') ? process.argv[process.argv.indexOf('--phase') + 1] : null;

if (phase) {
  const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
  const { getConfig } = await import('../../../packages/daemon/src/config.ts');
  const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
  let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
  let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
  try {
    app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath, workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
    assert.notEqual(app.server.port, 8399);
    await app.jobProcessor.stop();
    await app.spaceRuntimeService.ready();
    const db = app.db.getDatabase();
    if (phase === 'seed') {
      db.exec(`INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at)
        VALUES ('old-cjk','neo:upgrade','旧记录','历史构建版本已完成',1,1)`);
      await app.db.createSession({ id: 'cjk-session', title: '历史构建版本', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { model: 'claude-sonnet-4-5-20250929' }, metadata: { messageCount: 0, totalTokens: 0, totalCost: 0 } });
      const repo = app.db.getSDKMessageRepo();
      repo.saveSDKMessage('cjk-session', { type: 'user', uuid: 'old-cjk-message', message: { role: 'user', content: [{ type: 'text', text: '历史构建版本已完成' }] } } as SDKMessage);
      repo.flushMessageSearchIndex();
      writeFileSync(join(run, 'evidence/seed.json'), JSON.stringify({ cards: db.prepare('SELECT * FROM neo_card_search_content ORDER BY id').all(), messages: db.prepare('SELECT * FROM message_search_content ORDER BY id').all() }));
    } else {
      const hub = new MessageHub({ defaultSessionId: 'global' });
      transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
      hub.registerTransport(transport);
      await transport.initialize();
      const evidence: Record<string, unknown> = { phase, port: app.server.port };
      for (const query of ['构建版', '构建']) {
        const cards = await hub.request<{ ok: boolean; results: { askId: string }[] }>('operation.invoke', { name: 'neo.ask.search', input: { query } });
        const messages = await hub.request<{ results: { messageId: string }[] }>('message.search', { query });
        assert.equal(cards.ok, true);
        assert.deepEqual(cards.results.map((row) => row.askId), ['old-cjk']);
        assert.deepEqual(messages.results.map((row) => row.messageId), ['old-cjk-message']);
        evidence[query] = { cards, messages };
      }
      const snapshot = { cards: db.prepare('SELECT * FROM neo_card_search_content ORDER BY id').all(), messages: db.prepare('SELECT * FROM message_search_content ORDER BY id').all() };
      assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), JSON.parse(readFileSync(join(run, 'evidence/seed.json'), 'utf8')));
      const index = { schema: db.prepare("SELECT name,sql FROM sqlite_master WHERE name IN ('neo_card_search_fts','message_search_fts') ORDER BY name").all(), marker: db.prepare("SELECT * FROM migration_markers WHERE key='migration_462'").get() };
      assert(index.schema.every((row: { sql: string }) => row.sql.includes('trigram') && row.sql.includes('full')));
      assert(index.marker);
      for (const name of ['neo_card_search_fts', 'message_search_fts']) db.exec(`INSERT INTO ${name}(${name},rank) VALUES ('integrity-check',1)`);
      if (phase === 'restart') assert.deepEqual(JSON.parse(JSON.stringify(index)), JSON.parse(readFileSync(join(run, 'evidence/index.json'), 'utf8')));
      else writeFileSync(join(run, 'evidence/index.json'), JSON.stringify(index));
      writeFileSync(join(run, `evidence/${phase}.json`), JSON.stringify({ ...evidence, contentUnchanged: true, indexIntegrity: true, markerUnchanged: phase === 'restart' }, null, 2));
    }
  } finally {
    await transport?.close();
    await app?.cleanup();
  }
} else {
  assert(!existsSync(dbPath));
  const { Database } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
  const execute = async (name: string) => {
    const args = [...('Deno' in globalThis ? ['run', '-A'] : []), fileURLToPath(import.meta.url), '--phase', name, run];
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    try {
      await new Promise<void>((done, fail) => { child.once('error', fail); child.once('exit', (code, signal) => code === 0 ? done() : fail(new Error(`${name}: ${code}, ${signal}`))); });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((done) => child.once('exit', () => done()));
        child.kill('SIGKILL');
        await exited;
      }
    }
  };
  await execute('seed');
  const legacy = new Database(dbPath);
  try {
    legacy.transaction(() => {
      for (const [name, columns, content] of [['neo_card_search_fts','title,meta,body','neo_card_search_content'], ['message_search_fts','title,body','message_search_content']]) legacy.exec(`DROP TABLE ${name}; CREATE VIRTUAL TABLE ${name} USING fts5(${columns},content='${content}',content_rowid='id',detail=column,tokenize='unicode61'); INSERT INTO ${name}(${name}) VALUES ('rebuild')`);
      legacy.exec("DELETE FROM migration_markers WHERE key='migration_462'");
    })();
    assert.deepEqual(legacy.prepare("SELECT rowid FROM neo_card_search_fts WHERE neo_card_search_fts MATCH '\"构建版\"*'").all(), []);
  } finally { legacy.close(); }
  await execute('upgrade');
  await execute('restart');
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ pass: true, realDaemonStarts: 3, migratedLegacyIndexes: true, oldCardReadOnlyThroughSearch: true, messageSearchVerified: true, resourcesStopped: true, phoneUI: 'unverified' }));
  console.log('PASS: legacy indexes upgrade and restart with Chinese card and message results');
}
