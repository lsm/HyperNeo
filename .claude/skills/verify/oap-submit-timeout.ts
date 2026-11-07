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
let attempts=0,statusChecks=0,cancellations=0,target,subscription,mode='timeout',status='running';
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
  await rpc.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Synthetic provider', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const { sessionId } = await rpc.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'workspace'), title: 'Synthetic busy recovery', config: { model: 'haiku', provider: 'anthropic', harness: 'codex' } });
  const agent = app.sessionManager.getSession(sessionId);
  assert(agent);
  (agent as unknown as { runtimeOptions: { oap: OapQueryRuntime } }).runtimeOptions.oap = { openDirectorySupported: true, hub: createOapQueryHub(client) };
  for (const [content, expected] of [['First synthetic prompt', /timed out/], ['New synthetic prompt', /outcome|unfinished/]] as const) {
    await rpc.request('message.send', { sessionId, content });
    const deadline = Date.now() + 10_000;
    while (!errors.some((error) => expected.test(error)) || agent.queryPromise || agent.messageQueue.isRunning()) {
      assert(Date.now() < deadline, `missing visible timeout reconciliation error: ${JSON.stringify(errors)}`);
      await new Promise((done) => setTimeout(done, 25));
    }
    if (expected.test('timed out')) {
      assert.equal(app.db.getUserMessagesByStatus(sessionId, 'submitted', 10).total, 1);
      evidence.submittedImmediatelyAfterTimeout = true;
    }
  }
  const stats = await client.request('stats') as { attempts: number; statusChecks: number };
  assert.equal(stats.attempts, 1);
  assert.equal(stats.statusChecks, 1);
  assert.equal(app.db.getUserMessagesByStatus(sessionId, 'failed', 10).total, 2);
  assert(errors.some((error) => /submitted before recovery/.test(error)));
  evidence.port = app.server.port;
  evidence.submitAttempts = stats.attempts;
  evidence.statusChecks = stats.statusChecks;
  evidence.recoveryReportedUnknownOutcome = true;
  evidence.unsentNewPromptMarkedFailed = true;
  evidence.visibleUnfinishedWork = true;
  for (const [state, expectedResults] of [['idle', 1], ['needs_you', 2]] as const) {
    if (state === 'needs_you') {
      const priorErrors = errors.length;
      await client.request('scenario', { mode: 'timeout', status: state });
      await rpc.request('message.send', { sessionId, content: 'Another uncertain prompt' });
      const deadline = Date.now() + 10_000;
      while (!errors.slice(priorErrors).some((error) => /timed out/.test(error)) || agent.queryPromise || agent.messageQueue.isRunning()) {
        assert(Date.now() < deadline, 'missing second submit timeout');
        await new Promise((done) => setTimeout(done, 25));
      }
    }
    await client.request('scenario', { mode: 'complete', status: state });
    await rpc.request('message.send', { sessionId, content: `Recover from ${state}` });
    const deadline = Date.now() + 10_000;
    while (app.db.getSDKMessages(sessionId).messages.filter((row) => row.type === 'result').length < expectedResults || agent.queryPromise || agent.messageQueue.isRunning()) {
      assert(Date.now() < deadline, `could not recover from ${state}`);
      await new Promise((done) => setTimeout(done, 25));
    }
  }
  const recovered = await client.request('stats') as { attempts: number; statusChecks: number; cancellations: number };
  assert.equal(recovered.attempts, 4);
  assert.equal(recovered.statusChecks, 4);
  assert.equal(recovered.cancellations, 1);
  evidence.idleRecoveryDelivered = true;
  evidence.parkedRunCancelledBeforeResubmit = true;
  evidence.finalSubmitAttempts = recovered.attempts;
  evidence.finalStatusChecks = recovered.statusChecks;
  evidence.pass = true;
} finally {
  await transport?.close();
  await app?.cleanup();
  await client.close();
  evidence.cleaned = true;
  writeFileSync(join(run, 'evidence/oap-submit-timeout.json'), JSON.stringify(evidence, null, 2));
}
