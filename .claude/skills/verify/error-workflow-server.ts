import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
const run = resolve(process.argv[2]), port = Number(process.argv[3]);
assert(process.env.NODE_ENV === 'test' && process.env.HOME === `${run}/home` && process.env.HYPERNEO_DATA_DIR === `${run}/data` && port !== 8399);
const mock = Bun.spawn(['bun', '.claude/skills/verify/mock-api.ts'], { stdout: Bun.file(`${run}/mock-api.log`), stderr: Bun.file(`${run}/mock-api.log`) });
writeFileSync(`${run}/mock-api.pid`, String(mock.pid));
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: `${run}/data/daemon.db` }), verbose: false });
const { worker } = JSON.parse(readFileSync(`${run}/evidence/error-workflow-seed.json`, 'utf8'));
const details = { category: 'system', code: 'SYNTHETIC', message: 'Synthetic technical detail. '.repeat(45), userMessage: 'Synthetic error report', recoverable: true, timestamp: new Date().toISOString(), metadata: { synthetic: true }, stack: 'Synthetic stack line\n'.repeat(20) };
await app.internalEventBus.publishAsync('session.error', { sessionId: worker, error: details.userMessage, details });
app.server.stop();
const root = resolve('packages/web/dist');
const server = Bun.serve({ hostname: '127.0.0.1', port, websocket: createWebSocketHandlers(app.transport, app.sessionManager), async fetch(req, server) {
  const path = new URL(req.url).pathname;
  app.observeRequest(req);
  if (path.startsWith('/ws')) {
    if (server.upgrade(req, { data: { connectionSessionId: 'global', device: await app.authenticateUpgrade(req, server.requestIP(req)?.address ?? null) } })) return;
    return new Response('Upgrade failed', { status: 500 });
  }
  const file = resolve(root, '.' + path);
  if (file.startsWith(root + '/') && await Bun.file(file).exists()) return new Response(Bun.file(file));
  return new Response(Bun.file(`${root}/index.html`));
} });
writeFileSync(`${run}/daemon.pid`, String(process.pid));
writeFileSync(`${run}/evidence/error-event.json`, JSON.stringify({ sessionId: worker, details, source: 'actual daemon internal event bus' }, null, 2));
console.log(`HyperNeo Test Server\nDatabase: ${run}/data/daemon.db\nready: http://127.0.0.1:${port}`);
const stop = async () => { server.stop(true); await app.cleanup(); mock.kill(); await mock.exited; process.exit(0); };
process.on('SIGTERM', stop);process.on('SIGINT', stop);
