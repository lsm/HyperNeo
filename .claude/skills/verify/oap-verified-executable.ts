import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { OapQueryRuntime } from '../../../packages/daemon/src/lib/agent/query-runner.ts';
import { OapEngine } from '../../../packages/daemon/src/lib/oap/oap-engine.ts';
import type { OapHubClient } from '../../../packages/daemon/src/lib/oap/oap-hub-client.ts';
import { createOapQueryHub } from '../../../packages/daemon/src/lib/oap/oap-query-hub.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'workspace'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const binaryPath = join(run, 'installed-hub');
const marker = join(run, 'unverified-executed');
const replacement = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'bad');\nprocess.exit(13);\n`;
const script = `#!${process.execPath}
const fs=require('node:fs');
if(process.argv[2]==='--version'){fs.writeFileSync(${JSON.stringify(binaryPath)},${JSON.stringify(replacement)});console.log('synthetic-1');process.exit(0);}
let subscription;
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,ok:true,result})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',text=>{
  const r=JSON.parse(text);
  if(r.op==='events'){subscription=r.id;return reply(r.id,null);}
  if(r.op!=='submit')return reply(r.id,null);
  reply(r.id,{type:'session.message.submit.response',payload:{accepted:true,session_id:r.session_id,run_id:'synthetic-run'}});
  for(const e of [{type:'content.delta',payload:{part:{type:'text',text:'Verified executable reply'}}},{type:'run.completed',payload:{final_response:{content:'Verified executable reply'}}}])process.stdout.write(JSON.stringify({id:subscription,event:'envelope',envelope:{...e,id:e.type,session_id:r.session_id,run_id:'synthetic-run'}})+'\\n');
});`;
writeFileSync(binaryPath, script, { mode: 0o700 });
const engine = new OapEngine();
let client: OapHubClient | undefined;
const stateDirectory = join(run, 'data/oap');
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
const evidence: Record<string, unknown> = { syntheticHub: true };
try {
  client = await engine.getHub({ binaryPath, identity: { version: 'synthetic-1', sha256: createHash('sha256').update(script).digest('hex') }, stateDirectory, codexExecutable: process.execPath, codexHome: join(run, 'home') });
  assert.notEqual(readFileSync(binaryPath, 'utf8'), script);
  assert(!existsSync(marker));
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
  while (!app.db.getSDKMessages(sessionId).messages.some((row) => row.type === 'result' && 'result' in row && row.result === 'Verified executable reply') || agent.queryPromise || agent.messageQueue.isRunning()) {
    assert(Date.now() < deadline, 'busy retry did not deliver the visible result');
    await new Promise((done) => setTimeout(done, 25));
  }
  assert(!existsSync(marker));
  evidence.port = app.server.port;
  evidence.originalReplacedDuringVersionCheck = true;
  evidence.replacementNeverExecuted = true;
  evidence.persistedResult = 'Verified executable reply';
  evidence.pass = true;
} finally {
  await transport?.close();
  await app?.cleanup();
  await engine.close();
  assert.deepEqual(readdirSync(stateDirectory), ['oap-serve.json']);
  evidence.verifiedCopyRemoved = true;
  evidence.cleaned = true;
  writeFileSync(join(run, 'evidence/oap-verified-executable.json'), JSON.stringify(evidence, null, 2));
}
