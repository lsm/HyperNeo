import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHttpWsServer } from '../../../packages/daemon/src/lib/runtime-server/index.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { DevicePairingRepository } from '../../../packages/daemon/src/storage/repositories/device-pairing-repository.ts';
import { pairConfirmCode } from '../../../packages/daemon/src/lib/pairing/pair-confirm-code.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const { chromium } = createRequire(import.meta.url)('playwright');
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, verbose: false });
const port = app.server.port;
app.server.stop();
const dist = resolve(import.meta.dir, '../../../packages/web/dist');
const preview = await createHttpWsServer({
  hostname: '127.0.0.1', port,
  websocket: createWebSocketHandlers(app.transport, app.sessionManager),
  async fetch(request, upgrade, client) {
    const refusal = await app.guardRequest(request);
    if (refusal) return refusal;
    const path = new URL(request.url).pathname;
    if (path === '/pair' && request.method === 'POST') return app.handlePair(request);
    if (path === '/ws') {
      const device = await app.authenticateUpgrade(request, client?.remoteAddress ?? null);
      return device ? (upgrade(request, { connectionSessionId: 'global', device }) ?? new Response('Upgrade failed', { status: 500 })) : new Response('Pairing required', { status: 401 });
    }
    const asset = path.startsWith('/assets/');
    const file = resolve(dist, asset ? `.${path}` : path.startsWith('/neo') ? 'neo/index.html' : 'index.html');
    if (!file.startsWith(`${dist}/`)) return new Response('Forbidden', { status: 403 });
    const type = asset ? file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' : 'text/html';
    try { return new Response(await readFile(file), { headers: { 'content-type': type } }); }
    catch { return new Response('Not found', { status: 404 }); }
  },
});
const base = `http://127.0.0.1:${app.server.port}`;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let transport: WebSocketClientTransport | undefined;
const evidence: Record<string, unknown> = {};
try {
  assert(![8399, 8499].includes(app.server.port));
  await app.jobProcessor.stop();
  const repo = new DevicePairingRepository(app.db.getDatabase());
  const bootstrap = repo.createCode('human', 'Synthetic trusted client', true, Date.now());
  const paired = await fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: bootstrap.code, name: 'Synthetic trusted client' }) });
  assert.equal(paired.status, 200);
  const trusted = await paired.json() as { credential: string };
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `${base.replace('http:', 'ws:')}/ws`, autoReconnect: false, createSocket: (url) => new WebSocket(url, { headers: { authorization: `Bearer ${trusted.credential}` } }) });
  hub.registerTransport(transport); await transport.initialize();
  const invoke = <T>(name: string, input: unknown) => hub.request<T>('operation.invoke', { name, input });
  browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: 'light' });
  const browserCode = repo.createCode('human', 'Synthetic browser', true, Date.now());
  const cookie = await context.request.post(`${base}/pair`, { headers: { Origin: base }, data: { code: browserCode.code, name: 'Synthetic browser' } });
  assert.equal(cookie.status(), 200);
  const create = async () => {
    const made = await invoke<{ ok: boolean; code: string; codeId: string }>('device.pair.create', { kind: 'human', name: 'Synthetic phone', confirm: 'two-way' });
    assert(made.ok); return made;
  };
  const made = await create();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(`${base}/settings?tab=devices`);
  await page.getByText('Waiting for the phone to confirm.').waitFor().catch(async (error: Error) => {
    writeFileSync(join(run, 'evidence', 'page-debug.txt'), await page.locator('body').innerText());
    await page.screenshot({ path: join(run, 'evidence', 'page-debug.png'), fullPage: true, animations: 'disabled' });
    throw error;
  });
  assert(await page.getByRole('button', { name: 'Allow Synthetic phone', exact: true }).isDisabled());
  const requestId = '00112233445566778899aabbccddeeff';
  const phone = async (code: string) => fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, requestId, name: 'Synthetic phone' }) });
  assert.equal((await phone(made.code)).status, 403);
  const input = page.getByRole('textbox', { name: 'Code shown on Synthetic phone' });
  await input.waitFor({ timeout: 15_000 });
  await page.screenshot({ path: join(run, 'evidence', 'confirm-settings-1280-light.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.waitForFunction(() => {
    const close = document.querySelector('[aria-label="Close panel"]');
    return !close || close.getBoundingClientRect().right <= 0;
  });
  await input.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(run, 'evidence', 'confirm-settings-390-light.png'), fullPage: true, animations: 'disabled' });
  const fact = repo.pendingCode(made.codeId, Date.now())!;
  const expected = pairConfirmCode(fact.codeHash, fact.requestedBy!);
  const pending = await invoke<{ ok: boolean; pending: Record<string, unknown>[] }>('device.pair.pending', {});
  assert(pending.ok);
  const row = pending.pending.find((item) => item.id === made.codeId)!;
  assert.equal(row.phoneConfirmed, true); assert.equal(row.twoWay, true);
  assert(!('fingerprint' in row)); assert(!('confirmCode' in row));
  assert(!JSON.stringify(row).includes(expected));
  await assert.rejects(
    invoke('device.pair.approve', { codeId: made.codeId, lastGroup: 'abcd' }),
    /lastGroup/
  );
  assert(repo.pendingCode(made.codeId, Date.now()));
  evidence.legacySchemaRefusalPreservesRequest = true;
  await input.fill(` ${expected.toLowerCase().replace('-', ' - ')} `);
  await page.getByRole('button', { name: 'Allow Synthetic phone', exact: true }).click();
  await input.waitFor({ state: 'detached' });
  assert.equal((await phone(made.code)).status, 200);
  assert.equal((await phone(made.code)).status, 401);
  evidence.settingsApprovedNormalizedCode = true;
  const denied = await create();
  assert.equal((await phone(denied.code)).status, 403);
  await page.goto(`${base}/neo`);
  await page.getByRole('button', { name: 'Settings and connection', exact: true }).click();
  const drawerInput = page.getByRole('textbox', { name: 'Code shown on Synthetic phone' });
  await drawerInput.waitFor();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: join(run, 'evidence', 'confirm-drawer-390-dark.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: join(run, 'evidence', 'confirm-drawer-1280-dark.png'), fullPage: true, animations: 'disabled' });
  const deniedFact = repo.pendingCode(denied.codeId, Date.now())!;
  const correct = pairConfirmCode(deniedFact.codeHash, deniedFact.requestedBy!);
  await drawerInput.fill((correct[0] === 'B' ? 'C' : 'B') + correct.slice(1));
  await page.getByRole('button', { name: 'Allow Synthetic phone', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'the code is denied' }).waitFor();
  assert.equal((await phone(denied.code)).status, 401);
  const again = await invoke<{ ok: boolean; reason?: string }>('device.pair.approve', { codeId: denied.codeId, confirmCode: correct });
  assert(!again.ok && again.reason?.startsWith('not_pending'));
  await page.screenshot({ path: join(run, 'evidence', 'confirm-denied-1280-dark.png'), fullPage: true, animations: 'disabled' });
  evidence.drawerWrongCodeDeniedOnce = true;
  evidence.pendingLeaks = 0;
  evidence.screenshots = 5;
  evidence.pageErrors = errors;
  assert.deepEqual(errors, []);
  console.log('PASS: 2 real browser approval paths, pendingLeaks=0, screenshots=5');
} finally {
  writeFileSync(join(run, 'evidence', 'pair-confirm-code.json'), JSON.stringify(evidence, null, 2));
  await browser?.close(); await transport?.close(); preview.stop(true); await app.cleanup();
}
