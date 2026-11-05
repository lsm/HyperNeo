import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { SPACE_SCHEMA } from '../../../packages/daemon/src/storage/schema/space-schema.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv.at(-1) ?? '');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const name of ['workspace', 'evidence', 'bin']) mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const dbPath = join(run, 'data/daemon.db');

const spaceTables = () => {
  const db = new Database(':memory:');
  try {
    for (const statement of SPACE_SCHEMA.baseline?.statements ?? []) db.exec(statement);
    SPACE_SCHEMA.tables?.(db);
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((row) => row.name);
  } finally {
    db.close();
  }
};
const snapshot = (names: string[]) => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return Object.fromEntries(names.map((name) => {
      const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { sql: string } | undefined;
      return [name, table ? { sql: table.sql, rows: (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n } : null];
    }));
  } finally {
    db.close();
  }
};

const freePort = () => {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  assert.notEqual(port, 8399);
  return port;
};

async function daemon(space: 'on' | null, use: (hub: MessageHub, port: number) => Promise<void>) {
  let log = '';
  let exited = false;
  const port = freePort();
  const child = spawn(process.execPath, [resolve('packages/cli/main.ts'), '--port', String(port), '--host', '127.0.0.1', '--db-path', dbPath], {
    env: {
      HOME: join(run, 'home'), TMPDIR: join(run, 'tmp'), PATH: `${join(run, 'bin')}:/usr/bin:/bin`, NODE_ENV: 'test',
      HYPERNEO_DATA_DIR: join(run, 'data'),
      HYPERNEO_WORKSPACE_PATH: join(run, 'workspace'), LOG_LEVEL: 'warn', ...(space ? { HYPERNEO_SPACE: space } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = new Promise<number | null>((settle) => child.once('close', (code) => { exited = true; settle(code); }));
  child.stdout.on('data', (data) => { log += data; });
  child.stderr.on('data', (data) => { log += data; });
  const transport = { current: null as WebSocketClientTransport | null };
  try {
    const end = Date.now() + 30_000;
    while (!(await fetch(`http://127.0.0.1:${port}/`).then((response) => response.ok, () => false)) && !exited) {
      assert(Date.now() < end, 'daemon did not start');
      await Bun.sleep(100);
    }
    assert(!exited, log.slice(-1500));
    const hub = new MessageHub({ defaultSessionId: 'global', timeout: 8000 });
    transport.current = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${port}/ws`, autoReconnect: false,
      createSocket: (address) => createLocalSocket(address, join(run, 'data/local-rpc.credential')),
    });
    hub.registerTransport(transport.current);
    await transport.current.initialize();
    await use(hub, port);
  } finally {
    await transport.current?.close();
    child.kill('SIGTERM');
    assert.equal(await done, 0, log.slice(-1500));
  }
  return log;
}

const names = spaceTables();
assert(names.length > 50);
const evidence: Record<string, unknown> = {};
await daemon('on', async (hub) => {
  const listed = await hub.request<{ extensions: { id: string }[] }>('operation.invoke', { name: 'daemon.extensions', input: {} });
  assert(listed.extensions.some((extension) => extension.id === 'space'));
  const created = await hub.request<{ id: string }>('space.create', { name: 'Old space', workspacePath: join(run, 'workspace') });
  assert(created.id);
});
const before = snapshot(names);
assert.equal((before.spaces as { rows: number }).rows, 1);

const offLog = await daemon(null, async (hub, port) => {
  const listed = await hub.request<{ extensions: { id: string }[] }>('operation.invoke', { name: 'daemon.extensions', input: {} });
  assert(!listed.extensions.some((extension) => extension.id === 'space'), JSON.stringify(listed));
  evidence.extensions = listed.extensions.map((extension) => extension.id);
  const refused = await hub.request('operation.invoke', { name: 'space.list', input: {} }).then(() => false, (error) => String(error));
  assert(refused, 'space.list must not be reachable');
  evidence.spaceListRefused = refused;
  const { OPERATION_NAMES } = await import('../../../packages/shared/src/types/operation-names.ts');
  const reachable: string[] = [];
  for (const name of Object.values(OPERATION_NAMES as Record<string, string>).flat() as string[]) {
    if (!/^(space|goal|workflow|agentMemory|task|schedule|evolution)/.test(name)) continue;
    const reply = await hub.request('operation.invoke', { name, input: {} }).then(() => 'ok', (error) => String(error));
    if (!reply.includes('Unknown operation')) reachable.push(name);
  }
  evidence.operationsReachable = reachable;
  assert.deepEqual(reachable.filter((name) => !name.startsWith('schedule.session.')), []);
  const directRpc = await hub.request('space.create', { name: 'No', workspacePath: join(run, 'workspace') }).then(() => false, (error) => String(error));
  assert(directRpc, 'space.create must have no handler');
  evidence.spaceCreateRefused = directRpc;
  if (!process.env.VERIFY_BROWSER) { evidence.browser = 'skipped: VERIFY_BROWSER not set'; return; }
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    await page.context().addCookies([{ name: 'hyperneo_device', value: readFileSync(join(run, 'data/local-rpc.credential'), 'utf8'), url: `http://127.0.0.1:${port}` }]);
    const errors: string[] = [];
    const chunks: string[] = [];
    page.on('pageerror', (error: unknown) => errors.push(String(error)));
    page.on('request', (request: { url(): string }) => { if (/\/assets\/(space-web-extension|SpaceIsland)-/.test(request.url())) chunks.push(request.url()); });
    await page.goto(`http://127.0.0.1:${port}/spaces`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await Bun.sleep(1500);
    await page.keyboard.press('Meta+k');
    await Bun.sleep(500);
    await page.keyboard.type('Space');
    await Bun.sleep(500);
    const text = await page.locator('body').innerText();
    assert(text.trim() !== 'Not found', 'the web app must load');
    await page.screenshot({ path: join(run, 'evidence/space-off-web.png') });
    evidence.browser = { errors, chunks, mentionsOldSpace: text.includes('Old space'), spaceCommands: /Space: (View tasks|Configure|Overview)/.test(text), text: text.slice(0, 300) };
    assert.deepEqual(errors, []);
    assert.deepEqual(chunks, []);
    assert(!text.includes('Old space'));
    assert(!/Space: (View tasks|Configure|Overview)/.test(text), 'Space commands must not be offered');
  } finally {
    await browser.close();
  }
});
assert.deepEqual(snapshot(names), before, 'Space tables must stay exactly as they were');
evidence.spaceTablesUnchanged = names.length;
assert.doesNotMatch(offLog, /no such table/);
const errorLines = offLog.split('\n').filter((line) => /\b(ERROR|Error:|error:|\[error\])/.test(line));
evidence.errorLines = errorLines.slice(0, 10);
assert.deepEqual(errorLines, []);
await daemon('on', async (hub) => {
  const spaces = await hub.request<{ id: string }[] | { spaces: { id: string }[] }>('operation.invoke', { name: 'space.list', input: {} });
  const list = Array.isArray(spaces) ? spaces : spaces.spaces;
  assert.equal(list.length, 1, 'turning Space back on must find the old row');
  evidence.spaceBackOnFindsOldRow = true;
});
evidence.pass = true;
writeFileSync(join(run, 'evidence/space-off-old-db.json'), JSON.stringify(evidence, null, 2));
console.log('PASS: Space stays off by default on an old database and leaves its tables alone.');
