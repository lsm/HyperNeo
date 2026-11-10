import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { OapQueryRuntime } from '../../../packages/daemon/src/lib/agent/query-runner.ts';
import { OapHubClient } from '../../../packages/daemon/src/lib/oap/oap-hub-client.ts';
import { createOapQueryHub } from '../../../packages/daemon/src/lib/oap/oap-query-hub.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'workspace'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const script = `
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,ok:true,result})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',text=>{
  const r=JSON.parse(text);
  if(r.op==='pid')return reply(r.id,process.pid);
  if(r.op==='submit')return process.stdout.write('x'.repeat(1048577));
  reply(r.id,null);
});`;
const client = new OapHubClient({
  command: process.execPath,
  args: ['-e', script],
  cwd: run,
  env: { NODE_ENV: 'test', HOME: join(run, 'home'), TMPDIR: join(run, 'tmp'), HYPERNEO_DATA_DIR: join(run, 'data') },
});
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
const evidence: Record<string, unknown> = { syntheticHub: true };
let pid: number | undefined;
try {
  await client.connect();
  pid = await client.request('pid') as number;
  app = await createDaemonApp({
    config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true },
    verbose: false,
  });
  assert.notEqual(app.server.port, 8399);
  assert.notEqual(app.server.port, 8499);
  const errors: string[] = [];
  app.internalEventBus.subscribe('session.errorObserved', ({ details }) => {
    const error = details as { userMessage?: string } | undefined;
    if (error?.userMessage) errors.push(error.userMessage);
  }, { subscriberName: 'oap-stdout-limit-proof' });
  const rpc = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false, createSocket: createLocalSocket });
  rpc.registerTransport(transport);
  await transport.initialize();
  await rpc.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Synthetic provider', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const { sessionId } = await rpc.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'workspace'), title: 'Synthetic busy recovery', config: { model: 'haiku', provider: 'anthropic', harness: 'codex' } });
  const agent = app.sessionManager.getSession(sessionId);
  assert(agent);
  (agent as unknown as { runtimeOptions: { oap: OapQueryRuntime } }).runtimeOptions.oap = { openDirectorySupported: true, hub: createOapQueryHub(client) };
  await rpc.request('message.send', { sessionId, content: 'Synthetic oversized output request' });
  const deadline = Date.now() + 10_000;
  while (!errors.some((message) => message.includes('stdout line exceeds 1048576 bytes')) || agent.queryPromise || agent.messageQueue.isRunning()) {
    assert(Date.now() < deadline, 'missing visible stdout line limit failure');
    await new Promise((done) => setTimeout(done, 25));
  }
  await assert.rejects(client.request('later'), /stdout line exceeds/);
  evidence.port = app.server.port;
  evidence.visibleLineLimitFailure = true;
  evidence.futureRequestsRejected = true;
  evidence.pass = true;
} finally {
  await transport?.close();
  await app?.cleanup();
  await client.close();
  if (pid) assert.throws(() => process.kill(pid!, 0));
  evidence.childExited = true;
  evidence.cleaned = true;
  writeFileSync(join(run, 'evidence/oap-hub-stdout-bound.json'), JSON.stringify(evidence, null, 2));
}
