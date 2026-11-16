process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';

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
  service.todos.openAsk({ id: 'stalled', sessionId: root, projectId: null, originMessageId: null,
    title: 'Synthetic stalled ask', request: 'Complete work', createdAt: now - 3 * 3_600_000 });
  const held = () => (app.db.getDatabase().prepare("SELECT status, json_extract(payload, '$.neoBatchUuid') AS batch, json_extract(payload, '$.message.message.content') AS text FROM job_queue WHERE queue = 'neo_notes' AND json_extract(payload, '$.to.sessionId') = ?").all(root) as { status: string; batch: string | null; text: string }[]);
  const realNow = Date.now;
  let clock = now;
  Date.now = () => clock;
  try {
    await service.refreshDriverWork();
    assert.deepEqual(held().map(note => [note.status, note.text]), [['pending', 'Ask: Synthetic stalled ask (stalled)\nThis ask has nothing in progress. Add the next todo, or settle it.']]);
    assert.equal(app.db.getSDKMessages(root).messages.length, 0, 'a held digest line is not in the session yet');
    clock += 16 * 60_000;
    await service.refreshDriverWork();
  } finally {
    Date.now = realNow;
  }
  const batch = held()[0]?.batch;
  assert(batch, 'the production flush released the digest');
  const queued = app.db.getMessageByStatusAndUuid(root, 'enqueued', batch);
  assert(queued, 'the released digest waits for the next turn');
  await app.db.updateMessageStatus([queued.dbId], 'consumed');
  const humanId = crypto.randomUUID();
  await app.db.saveUserMessage(root, { type: 'user', uuid: humanId, session_id: root, parent_tool_use_id: null,
    message: { role: 'user', content: 'An actual human input stays a human bubble.' }, inputKind: 'human' });
  const rows = app.db.getSDKMessages(root).messages;
  writeFileSync(join(run, 'evidence/messages.json'), JSON.stringify(rows, null, 2));
  const notices = rows.filter(row => row.type === 'user' && row.uuid === batch);
  assert.equal(notices.length, 1);
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
    await bubble.getByText('This ask has nothing in progress.', { exact: false }).waitFor();
    observed.push({ uuid: row.uuid, role: await bubble.getAttribute('data-message-role'), text: await bubble.innerText() });
  }
  await page.screenshot({ path: join(run, 'evidence/notices.png'), fullPage: true });
  writeFileSync(join(run, 'evidence/browser.json'), JSON.stringify(observed, null, 2));
  for (const notice of observed) assert.equal(notice.role, 'synthetic', notice.uuid);
  assert.equal(await page.locator(`[data-message-uuid="${humanId}"]`).getAttribute('data-message-role'), 'user');
  for (const row of notices) assert.equal((row as { isSynthetic?: boolean }).isSynthetic, true);
  await page.reload();
  await page.locator('[data-testid="synthetic-message"]').first().waitFor();
  assert.equal(await page.locator('[data-testid="synthetic-message"]').count(), 1);
  assert.equal(await page.locator(`[data-message-uuid="${humanId}"]`).getAttribute('data-message-role'), 'user');
  await page.screenshot({ path: join(run, 'evidence/notices-reloaded.png'), fullPage: true });
  console.log('PASS: the stalled-ask digest released by the production flush is a synthetic card in the served session UI, including after reload; human input stays human.');
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
