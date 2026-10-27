import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const name of ['workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
let front: ReturnType<typeof Bun.serve> | undefined;
try {
  await app.jobProcessor.stop();
  await app.spaceRuntimeService.ready();
  assert.notEqual(app.server.port, 8399);
  await app.db.createSession({ id: 'c0000000-0000-4000-8000-000000000054', title: 'Synthetic workspace', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, totalCost: 0 } });
  app.db.getDatabase().exec(`INSERT INTO message_search_content(kind,source_id,message_id,session_id,message_type,title,body,timestamp)
    VALUES ('message','cjk-old','cjk-old','c0000000-0000-4000-8000-000000000054','assistant','历史构建版本','Unrelated body',1),
      ('message','cjk-body-only','cjk-body-only','c0000000-0000-4000-8000-000000000054','assistant','Body only','历史构建版本',2)`);
  front = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === '/ws') return server.upgrade(request, { data: { connectionSessionId: 'global', device: await app.authenticateUpgrade(request, '127.0.0.1') } }) ? undefined : new Response('Upgrade failed', { status: 500 });
    const file = Bun.file(join(resolve('packages/web/dist'), path));
    return new Response(await file.exists() ? file : Bun.file(resolve('packages/web/dist/index.html')));
  }, websocket: createWebSocketHandlers(app.transport, app.sessionManager) });
  assert.notEqual(front.port, 8399);
  const child = Bun.spawn(['node', '.claude/skills/verify/cjk-search-web.mjs', String(front.port), run], { stdout: 'inherit', stderr: 'inherit' });
  try { assert.equal(await child.exited, 0); }
  finally { if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } }
} finally {
  front?.stop(true);
  await app.cleanup();
  writeFileSync(join(run, 'evidence/resources.json'), JSON.stringify({ resourcesStopped: true, phoneUI: 'unverified' }));
}
