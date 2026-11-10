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
let attempts=0,statusChecks=0,cancellations=0,target,subscription,mode='complete',status='running';
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,ok:true,result})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',text=>{
  const r=JSON.parse(text);
  if(r.op==='events'){subscription=r.id;return reply(r.id,null);}
  if(r.op==='scenario'){mode=r.mode;status=r.status;return reply(r.id,null);}
  if(r.op==='submit'){
    attempts++;target=r.session_id;if(mode==='timeout')return;
    const run_id='synthetic-run-'+attempts;
    reply(r.id,{type:'session.message.submit.response',payload:{accepted:true,session_id:target,run_id}});
    for(const e of [{type:'content.delta',payload:{part:{type:'text',text:'Recovered prompt'}}},{type:'run.completed',payload:{final_response:{content:'Recovered prompt'}}}])process.stdout.write(JSON.stringify({id:subscription,event:'envelope',envelope:{...e,id:e.type,session_id:target,run_id}})+'\\n');
    status='done';return;
  }
  if(r.op==='stats')return reply(r.id,{attempts,statusChecks,cancellations});
  if(r.op==='work.status'){statusChecks++;return reply(r.id,{ref:{session_id:target},...(status==='idle'?{}:{status}),...(status==='needs_you'?{run_id:'parked-run'}:{})});}
  if(r.op==='cancel'){cancellations++;status='stopped';return reply(r.id,{type:'run.cancel.response',payload:{accepted:true,session_id:target,run_id:r.request.payload.run_id}});}
  reply(r.id,null);
});`;
const client = new OapHubClient({
  command: process.execPath,
  args: ['-e', script],
  cwd: run,
  timeoutMs: 200,
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
  const errors: string[] = [];
  app.internalEventBus.subscribe('session.errorObserved', ({ details }) => {
    const error = details as { userMessage?: string } | undefined;
    if (error?.userMessage) errors.push(error.userMessage);
  }, { subscriberName: 'oap-submit-timeout-proof' });
  const rpc = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false, createSocket: createLocalSocket });
  rpc.registerTransport(transport);
  await transport.initialize();
  const create = async (harness?: 'codex') => {
    const { sessionId } = await rpc.request<{ sessionId: string }>('session.create', {
      workspacePath: join(run, 'workspace'),
      title: harness ?? 'SDK provider hold',
      config: { model: 'haiku', provider: 'anthropic', ...(harness ? { harness } : {}) },
    });
    return sessionId;
  };
  const codex = await create('codex');
  const agent = app.sessionManager.getSession(codex);
  assert(agent);
  (agent as unknown as { runtimeOptions: { oap: OapQueryRuntime } }).runtimeOptions.oap = {
    openDirectorySupported: true,
    hub: createOapQueryHub(client),
  };
  await rpc.request('message.send', { sessionId: codex, content: 'Hello from Codex' });
  const deadline = Date.now() + 15_000;
  while (app.db.getSDKMessages(codex).messages.filter((row) => row.type === 'result').length !== 1) {
    assert(Date.now() < deadline, 'Codex did not reach OAP without provider login');
    await new Promise((done) => setTimeout(done, 25));
  }
  const sdk = await create();
  await rpc.request('message.send', { sessionId: sdk, content: 'SDK must wait' });
  const sdkDeadline = Date.now() + 10_000;
  while (!JSON.stringify(app.db.getSDKMessages(sdk)).includes('No model service is logged in')) {
    assert(Date.now() < sdkDeadline, 'SDK did not show its provider-login hold');
    await new Promise((done) => setTimeout(done, 25));
  }
  const stats = await client.request('stats') as { attempts: number };
  assert.equal(stats.attempts, 1);
  assert.equal(app.db.getUserMessagesByStatus(sdk, 'enqueued', 10).total, 1);
  assert.equal(app.db.getSDKMessages(sdk).messages.filter((row) => row.type === 'result').length, 0);
  evidence.codexResults = 1;
  evidence.oapSubmissions = stats.attempts;
  evidence.sdkEnqueued = 1;
  evidence.sdkResults = 0;
  evidence.providerLoginConfigured = false;
  writeFileSync(join(run, 'evidence/result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, exitCode: 0 }));
} finally {
  await transport?.close();
  await app?.cleanup();
  await client.close();
}
