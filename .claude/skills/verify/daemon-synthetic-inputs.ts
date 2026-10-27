import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { wakeStalledAsks } from '../../../packages/daemon/src/lib/neo/stalled-asks.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'home') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
await app.spaceRuntimeService.ready();
await app.jobProcessor.stop();
const service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
const root = `neo:${crypto.randomUUID()}`;
const now = Date.now();
const web = Bun.serve({ hostname: '127.0.0.1', port: 0,
  websocket: createWebSocketHandlers(app.transport, app.sessionManager),
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === '/ws') {
      if (server.upgrade(request, { data: { connectionSessionId: 'global', device: await app.authenticateUpgrade(request, '127.0.0.1') } })) return;
      return new Response('Upgrade failed', { status: 500 });
    }
    const file = Bun.file(join(resolve('packages/web/dist'), path.startsWith('/session/') || path === '/' ? 'index.html' : path));
    return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
  },
});
let browser;
let page;
try {
  assert.notEqual(web.port, 8399);
  await app.db.createSession({ id: root, title: 'Synthetic input provenance', workspacePath: run,
    createdAt: new Date(now).toISOString(), lastActiveAt: new Date(now).toISOString(), status: 'active',
    config: { model: 'claude-sonnet-4-5-20250929', maxTokens: 8192, temperature: 1 },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
  });
  service.repo.reserveBinding({ sessionId: root, projectId: null, kind: 'neo' });
  const ask = service.todos.openAsk({ id: 'stalled', sessionId: root, projectId: null, originMessageId: null,
    title: 'Synthetic stalled ask', request: 'Complete work', createdAt: now - 3 * 3_600_000 });
  await wakeStalledAsks(service.todos, service.deliverForward.bind(service), now);
  service.installedPacks = () => [{ id: 'synthetic-proof', describe: 'Fixture completion check', todos: {
    schema: () => {}, check: async () => ({ done: true, evidence: 'Observed' }), statusLine: () => null,
  } }];
  service.todos.addTodo('completed', ask.id, { title: 'Synthetic task', doneWhen: 'Observed', instruction: null,
    named: null, check: { pack: 'synthetic-proof', kind: 'observed', params: {} } }, now);
  await service.todoRunner.refresh((message, error) => { throw new Error(message, { cause: error }); });
  const humanId = crypto.randomUUID();
  await app.db.saveUserMessage(root, { type: 'user', uuid: humanId, session_id: root, parent_tool_use_id: null,
    message: { role: 'user', content: 'An actual human input stays a human bubble.' }, inputKind: 'human' });
  const rows = app.db.getSDKMessages(root).messages;
  writeFileSync(join(run, 'evidence/messages.json'), JSON.stringify(rows, null, 2));
  const notices = rows.filter(row => row.type === 'user' && /^neo-(stalled-ask|todo):/.test(row.uuid ?? ''));
  assert.equal(notices.length, 2);
  const { chromium } = createRequire(import.meta.url)('playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const origin = `http://127.0.0.1:${web.port}`;
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page = await context.newPage();
  page.on('pageerror', error => console.log('PAGE ERROR', String(error)));
  page.on('console', message => console.log('BROWSER', message.text()));
  await page.goto(`${origin}/session/${root}`);
  await page.locator(`[data-message-uuid="${humanId}"]`).waitFor({ timeout: 30000 });
  const observed = [];
  for (const row of notices) {
    const bubble = page.locator(`[data-message-uuid="${row.uuid}"]`);
    await bubble.waitFor();
    await bubble.getByText(row.uuid?.startsWith('neo-stalled-ask:') ? 'This ask has nothing in progress.' : 'Todo "Synthetic task" is done:', { exact: false }).waitFor();
    observed.push({ uuid: row.uuid, role: await bubble.getAttribute('data-message-role'), text: await bubble.innerText() });
  }
  await page.screenshot({ path: join(run, 'evidence/notices.png'), fullPage: true });
  writeFileSync(join(run, 'evidence/browser.json'), JSON.stringify(observed, null, 2));
  for (const notice of observed) assert.equal(notice.role, 'synthetic', notice.uuid);
  assert.equal(await page.locator(`[data-message-uuid="${humanId}"]`).getAttribute('data-message-role'), 'user');
  for (const row of notices) assert.equal((row as { isSynthetic?: boolean }).isSynthetic, true);
  await page.reload();
  await page.locator('[data-testid="synthetic-message"]').first().waitFor();
  assert.equal(await page.locator('[data-testid="synthetic-message"]').count(), 2);
  assert.equal(await page.locator(`[data-message-uuid="${humanId}"]`).getAttribute('data-message-role'), 'user');
  await page.screenshot({ path: join(run, 'evidence/notices-reloaded.png'), fullPage: true });
  console.log('PASS: actual stalled-ask and completed-todo notices have synthetic cards in the served session UI, including after reload; human input stays human.');
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(run, 'evidence/failure.png'), fullPage: true });
    writeFileSync(join(run, 'evidence/failure.txt'), await page.locator('body').innerText());
  }
  throw error;
} finally {
  await browser?.close();
  web.stop(true);
  await service.dispose();
  await app.cleanup();
}
