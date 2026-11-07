import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { checkOapBinary } from '../../../packages/daemon/src/lib/oap/oap-binary.ts';
import { OapHubClient } from '../../../packages/daemon/src/lib/oap/oap-hub-client.ts';
import type { OapQueryRuntime } from '../../../packages/daemon/src/lib/agent/query-runner.ts';
import { getSdkStartupGate } from '../../../packages/daemon/src/lib/agent/sdk-startup-gate.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const [binary, version, sha256, runArgument] = process.argv.slice(2);
const run = resolve(runArgument);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.deepEqual(await checkOapBinary(binary, { version, sha256 }), { ok: true });
for (const name of ['workspace', 'codex-home', 'hub', 'evidence']) {
  mkdirSync(join(run, name), { recursive: true });
}
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
chmodSync(join(run, 'bin/gh'), 0o700);
const peer = join(run, 'synthetic-codex');
writeFileSync(
  peer,
  `#!/usr/bin/python3
import json,os,sys
log=os.path.join(os.environ['CODEX_HOME'],'calls.jsonl')
def emit(value): print(json.dumps(value),flush=True)
for line in sys.stdin:
 request=json.loads(line)
 with open(log,'a') as output: output.write(json.dumps({'cwd':os.getcwd(),'request':request})+'\\n')
 method=request.get('method')
 if 'id' not in request: continue
 if method=='initialize': result={'userAgent':'synthetic','codexHome':'synthetic','platformFamily':'unix','platformOs':'synthetic'}
 elif method in ['thread/start','thread/resume']:
  thread=request.get('params',{}).get('threadId','native-synthetic')
  result={'thread':{'id':thread},'model':'synthetic-model','cwd':os.getcwd(),'approvalPolicy':'on-request','sandbox':{'type':'workspaceWrite','writableRoots':[],'networkAccess':False}}
 elif method=='turn/start': result={'turn':{'id':'turn-'+str(request['id']),'status':'inProgress'}}
 else: result={}
 emit({'id':request['id'],'result':result})
 if method=='turn/start':
  thread=request['params']['threadId']; turn=result['turn']['id']
  emit({'method':'turn/started','params':{'threadId':thread,'turn':{'id':turn,'status':'inProgress'}}})
  for index in range(96):
   emit({'method':'item/agentMessage/delta','params':{'threadId':thread,'turnId':turn,'itemId':'text-'+turn,'delta':'synthetic reply' if index==0 else '.'}})
  emit({'method':'turn/completed','params':{'threadId':thread,'turn':{'id':turn,'status':'completed'}}})
`
);
chmodSync(peer, 0o700);
const config = join(run, 'hub/config.json');
writeFileSync(config, JSON.stringify({ adapters: { codex: { type: 'codex', executable: peer, environment: ['CODEX_HOME'], any_directory: true, approval_policy: 'on-request', sandbox: 'workspace-write' } } }));
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
let client: OapHubClient | undefined;
let releaseResult: (() => void) | undefined;
const evidence: Record<string, unknown> = { synthetic: true, binaryVersion: version, binarySha256: sha256 };
try {
  app = await createDaemonApp({
    config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true },
    verbose: false,
  });
  assert.notEqual(app.server.port, 8399);
  assert.notEqual(app.server.port, 8499);
  const gate = getSdkStartupGate();
  const acquire = gate.acquire.bind(gate);
  let gateCalls = 0;
  gate.acquire = (...args) => { gateCalls++; return acquire(...args); };
  const errors: string[] = [];
  app.internalEventBus.subscribe('session.errorObserved', ({ details }) => {
    const error = details as { userMessage?: string } | undefined;
    if (error?.userMessage) errors.push(error.userMessage);
  }, { subscriberName: 'oap-hub-transport-proof' });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false, createSocket: createLocalSocket });
  hub.registerTransport(transport);
  await transport.initialize();
  await hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Synthetic provider', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'workspace'), title: 'Synthetic OAP transport', config: { model: 'haiku', provider: 'anthropic', harness: 'codex' } });
  client = new OapHubClient({ command: binary, args: ['serve', '--stdio', '--config', config, '--session-history', join(run, 'hub/history.jsonl')], cwd: join(run, 'hub'), env: { HOME: join(run, 'hub'), CODEX_HOME: join(run, 'codex-home') } });
  await client.connect();
  const opened = await client.request('open', { adapter: 'codex', directory: join(run, 'workspace'), request: { protocol: 'open-agent-protocol', version: '0.1', profile: 'open-agent-protocol.agent-control-core', type: 'session.open.request', id: 'synthetic-open', payload: { session_id: sessionId } } }) as { payload?: { session_id?: string } };
  assert.equal(opened.payload?.session_id, sessionId);
  const agent = app.sessionManager.getSession(sessionId);
  assert(agent);
  (agent as unknown as { runtimeOptions: { oap: OapQueryRuntime } }).runtimeOptions.oap = { openDirectorySupported: true, hub: app.oapEngine.createQueryHub(client) };
  let resultCount = 0;
  let notifyResult!: () => void;
  const resultArrived = new Promise<void>((resolveResult) => { notifyResult = resolveResult; });
  const holdResult = new Promise<void>((resolveResult) => { releaseResult = resolveResult; });
  const handleMessage = agent.onSDKMessage.bind(agent);
  agent.onSDKMessage = async (...args) => {
    await handleMessage(...args);
    if (args[0].type === 'result' && ++resultCount === 1) {
      notifyResult();
      await holdResult;
    }
  };
  await hub.request('message.send', { sessionId, content: 'Synthetic prompt one' });
  let resultTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([resultArrived, new Promise<never>((_, reject) => { resultTimer = setTimeout(() => reject(new Error('synthetic OAP proof timed out')), 15000); })]);
  } finally {
    if (resultTimer) clearTimeout(resultTimer);
  }
  const secondSend = agent.messageQueue.enqueueWithId('synthetic-window-message', 'Synthetic prompt two', false, { durable: true });
  const deadline = Date.now() + 15000;
  while (!agent.messageQueue.hasQueuedMessages()) {
    assert(Date.now() < deadline, `second prompt did not queue: ${JSON.stringify(errors)}`);
    await new Promise((done) => setTimeout(done, 20));
  }
  assert(releaseResult);
  releaseResult();
  await secondSend;
  while (agent.queryPromise || agent.messageQueue.isRunning() || resultCount !== 2) {
    assert(Date.now() < deadline, `OAP turns did not settle: ${JSON.stringify(errors)}`);
    await new Promise((done) => setTimeout(done, 20));
  }
  await hub.request('message.send', { sessionId, content: 'Synthetic prompt three' });
  const thirdDeadline = Date.now() + 30000;
  while (agent.queryPromise || agent.messageQueue.isRunning() || resultCount !== 3) {
    assert(Date.now() < thirdDeadline, `separate query did not settle: ${JSON.stringify(errors)}`);
    await new Promise((done) => setTimeout(done, 20));
  }
  const rows = app.db.getSDKMessages(sessionId, 10000).messages;
  assert.equal(rows.filter((row) => row.type === 'result').length, 3);
  assert(rows.some((row) => row.type === 'assistant' && JSON.stringify(row).includes('synthetic reply')));
  const calls = readFileSync(join(run, 'codex-home/calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { cwd: string; request: { method?: string; params?: { cwd?: string } } });
  const turns = calls.filter((call) => call.request.method === 'turn/start');
  assert.equal(turns.length, 3);
  assert(JSON.stringify(turns[0]).includes('Synthetic prompt one'));
  assert(JSON.stringify(turns[1]).includes('Synthetic prompt two'));
  assert(JSON.stringify(turns[2]).includes('Synthetic prompt three'));
  const initialization = calls.find((call) => call.request.method === 'initialize');
  assert.notEqual((initialization?.request.params as { capabilities?: { experimentalApi?: boolean } } | undefined)?.capabilities?.experimentalApi, true);
  assert(calls.every((call) => call.cwd === join(run, 'workspace')));
  assert.equal(calls.find((call) => call.request.method === 'thread/start')?.request.params?.cwd, join(run, 'workspace'));
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(gateCalls, 0);
  assert.deepEqual(app.sessionManager.getTrackedAgentRootPidsSplit().live, []);
  Object.assign(evidence, { port: app.server.port, turns: 3, separateQueryAfterClose: true, textDeltasPerTurn: 96, resultWindowQueued: true, queuedVia: 'messageQueue', runtimeInjected: true, workspaceConfirmed: true, experimentalApiEnabled: false, sdkStartupGateCalls: gateCalls, trackedAgentProcesses: 0, pass: true });
} finally {
  releaseResult?.();
  if (existsSync(join(run, 'codex-home/calls.jsonl'))) copyFileSync(join(run, 'codex-home/calls.jsonl'), join(run, 'evidence/calls.jsonl'));
  await client?.close();
  await transport?.close();
  await app?.cleanup();
  evidence.cleaned = true;
  writeFileSync(join(run, 'evidence/oap-hub-transport.json'), JSON.stringify(evidence, null, 2));
}
