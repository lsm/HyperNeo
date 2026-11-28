import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { Result, WorkDelivery } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const run = process.argv.at(-1)!;
const home = join(run, 'home');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, home);
const desktop = 'antigravity-desktop';
const root = join(home, '.gemini', 'antigravity');
const token = 'synthetic-csrf-token-0123456789';
const calls: { method: string; token: unknown; body: Record<string, unknown> }[] = [];
const steps: Record<string, unknown>[] = [
  { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { userResponse: 'hi' } },
  { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' },
];
const fakeApp = createServer(async (request, response) => {
  let text = '';
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  const method = request.url!.split('/').at(-1)!;
  calls.push({ method, token: request.headers['x-codeium-csrf-token'], body });
  if (request.headers['x-codeium-csrf-token'] !== token) return void response.writeHead(401).end('{}');
  if (method === 'SendUserCascadeMessage')
    steps.push({ type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { userResponse: body.items[0].text } });
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(method === 'GetCascadeTrajectorySteps' ? { steps } : {}));
});
await new Promise<void>((resolve) => fakeApp.listen(0, '127.0.0.1', resolve));
const { port } = fakeApp.address() as AddressInfo;
mkdirSync(join(root, 'daemon'), { recursive: true });
const catalog = new Database(join(root, 'conversation_summaries.db'));
catalog.exec(`CREATE TABLE conversation_summaries (
  conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL,
  app_data_dir TEXT NOT NULL, workspace_uris TEXT NOT NULL,
  last_modified_time DATETIME NOT NULL, parent_conversation_id TEXT NOT NULL, nesting_depth INTEGER NOT NULL)`);
catalog.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  .run('desktop-proof', 'Desktop fixture', '', 'antigravity', '', '2026-06-02 12:00:00+00:00', '', 0);
catalog.close();
const advertisement = join(root, 'daemon', `hub_${port}.json`);

const app = await createDaemonApp({
  config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true, disableGoalProcessing: true },
  verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
let closed = Promise.resolve();
const socket = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket(url) {
    const connection = createLocalSocket(url);
    closed = new Promise<void>((resolve) => connection.addEventListener('close', () => resolve(), { once: true }));
    return connection;
  },
});
hub.registerTransport(socket);
const rpc = <T>(name: string, input: object) => hub.request<T>('operation.invoke', { name, input });
const capabilities = async () => {
  const result = await rpc<Result<{ id: string; capabilities: string[] }[]>>('work.adapters', {});
  assert(result.ok);
  return result.value.find(({ id }) => id === desktop)?.capabilities;
};
const send = (id: string, message: string) =>
  rpc<Result<WorkDelivery>>('work.send', { ref: { adapter: desktop, id }, message });
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await socket.connect();
  const closedApp = await capabilities();
  const refused = await send('desktop-proof', 'before the app opens');
  assert.deepEqual(closedApp, ['find']);
  assert(!refused.ok, JSON.stringify(refused));
  writeFileSync(advertisement, JSON.stringify({ pid: process.pid, httpPort: port, lsVersion: '2.35.2', csrfToken: token }));
  chmodSync(advertisement, 0o600);
  const openApp = await capabilities();
  assert.deepEqual(openApp, ['find', 'send']);
  const sent = await send('desktop-proof', 'Run the proof');
  assert(sent.ok && sent.value.delivered, JSON.stringify(sent));
  const request = calls.find((call) => call.method === 'SendUserCascadeMessage');
  assert.equal(request?.token, token);
  assert.deepEqual(request?.body.items, [{ text: 'Run the proof' }]);
  assert.equal(sent.value.receipt?.inputId, request?.body.clientMessageId);
  const unknown = await send('no-such-conversation', 'x');
  assert(!unknown.ok && unknown.reason === 'not_found', JSON.stringify(unknown));
  rmSync(advertisement);
  assert.deepEqual(await capabilities(), ['find']);
  const proof = {
    passed: true,
    closedApp,
    refusedBeforeOpen: refused.ok ? null : refused.reason,
    openApp,
    delivered: sent.value.delivered,
    receiptMatchesClientMessageId: true,
    unknown: unknown.ok ? null : unknown.reason,
    sendRequests: calls.filter((call) => call.method === 'SendUserCascadeMessage').length,
  };
  mkdirSync(join(run, 'evidence'), { recursive: true });
  writeFileSync(join(run, 'evidence', 'antigravity-desktop-send.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally {
  await socket.close();
  await closed;
  hub.cleanup();
  await app.cleanup();
  await new Promise<void>((resolve) => fakeApp.close(() => resolve()));
}
