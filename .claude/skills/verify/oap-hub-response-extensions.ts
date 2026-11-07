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
let subscription, attempts=0, first, delay;
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,ok:true,result,wire_revision:2,metadata:{future:true}})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',text=>{
  const r=JSON.parse(text);
  if(r.op==='events'){subscription=r.id;return reply(r.id,null);}
  if(r.op==='stats')return reply(r.id,{attempts,delay});
  if(r.op!=='submit')return reply(r.id,null);
  attempts++;
  if(attempts===1){first=performance.now();return process.stdout.write(JSON.stringify({id:r.id,ok:false,wire_revision:2,error:{code:'busy',message:'synthetic busy'}})+'\\n');}
  delay=performance.now()-first;
  reply(r.id,{type:'session.message.submit.response',payload:{accepted:true,session_id:r.session_id,run_id:'synthetic-run'}});
  for(const envelope of [
    {type:'content.delta',payload:{part:{type:'text',text:'Recovered after busy'}}},
    {type:'run.completed',payload:{final_response:{content:'Recovered after busy'}}}
  ])process.stdout.write(JSON.stringify({id:subscription,event:'envelope',envelope:{...envelope,id:envelope.type,session_id:r.session_id,run_id:'synthetic-run'}})+'\\n');
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
try {
  await client.connect();
  app = await createDaemonApp({
    config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true },
    verbose: false,
  });
  assert.notEqual(app.server.port, 8399);
  assert.notEqual(app.server.port, 8499);
  const rpc = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false, createSocket: createLocalSocket });
  rpc.registerTransport(transport);
  await transport.initialize();
  await rpc.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Synthetic provider', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const { sessionId } = await rpc.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'workspace'), title: 'Synthetic busy recovery', config: { model: 'haiku', provider: 'anthropic', harness: 'codex' } });
  const agent = app.sessionManager.getSession(sessionId);
  assert(agent);
  (agent as unknown as { runtimeOptions: { oap: OapQueryRuntime } }).runtimeOptions.oap = { openDirectorySupported: true, hub: createOapQueryHub(client) };
  await rpc.request('message.send', { sessionId, content: 'Synthetic request' });
  const deadline = Date.now() + 10_000;
  while (!app.db.getSDKMessages(sessionId).messages.some((row) => row.type === 'result' && 'result' in row && row.result === 'Recovered after busy') || agent.queryPromise || agent.messageQueue.isRunning()) {
    assert(Date.now() < deadline, 'busy retry did not deliver the visible result');
    await new Promise((done) => setTimeout(done, 25));
  }
  const stats = await client.request('stats') as { attempts: number; delay: number };
  assert.equal(stats.attempts, 2);
  assert(stats.delay >= 45, `busy replay arrived after only ${stats.delay}ms`);
  evidence.port = app.server.port;
  evidence.attempts = stats.attempts;
  evidence.retryDelayMs = stats.delay;
  evidence.persistedResult = 'Recovered after busy';
  evidence.responseExtensionsAccepted = true;
  evidence.pass = true;
} finally {
  await transport?.close();
  await app?.cleanup();
  await client.close();
  evidence.cleaned = true;
  writeFileSync(join(run, 'evidence/oap-hub-response-extensions.json'), JSON.stringify(evidence, null, 2));
}
