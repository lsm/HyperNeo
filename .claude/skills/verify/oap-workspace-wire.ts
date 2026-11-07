import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { checkOapBinary } from '../../../packages/daemon/src/lib/oap/oap-binary.ts';
import { getSdkStartupGate } from '../../../packages/daemon/src/lib/agent/sdk-startup-gate.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const [binary, version, sha256, mode, runArgument] = process.argv.slice(2);
const run = resolve(runArgument);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.deepEqual(await checkOapBinary(binary, { version, sha256 }), { ok: true });
for (const name of ['workspace-a', 'workspace-b', 'codex-home', 'evidence']) {
  mkdirSync(join(run, name), { recursive: true });
}
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
chmodSync(join(run, 'bin/gh'), 0o700);
const peer = join(run, 'synthetic-codex');
writeFileSync(peer, `#!/usr/bin/python3
import json,os,sys
log=os.path.join(os.environ['CODEX_HOME'],'calls.jsonl')
marker=os.path.join(os.environ['CODEX_HOME'],'fail-first')
if os.path.exists(marker):
 os.unlink(marker)
 sys.exit(23)
def emit(value): print(json.dumps(value),flush=True)
for line in sys.stdin:
 request=json.loads(line)
 with open(log,'a') as output: output.write(json.dumps({'cwd':os.getcwd(),'codexHome':os.environ.get('CODEX_HOME'),'request':request})+'\\n')
 method=request.get('method')
 if 'id' not in request or not method: continue
 if method=='initialize': result={'userAgent':'synthetic','codexHome':'synthetic','platformFamily':'unix','platformOs':'synthetic'}
 elif method in ['thread/start','thread/resume']:
  thread=request.get('params',{}).get('threadId','native-'+os.path.basename(os.getcwd()))
  result={'thread':{'id':thread},'model':'synthetic-model','cwd':os.getcwd(),'approvalPolicy':'on-request','sandbox':{'type':'workspaceWrite','writableRoots':[],'networkAccess':False}}
 elif method=='turn/start': result={'turn':{'id':'turn-'+str(request['id']),'status':'inProgress'}}
 else: result={}
 emit({'id':request['id'],'result':result})
 if method=='turn/start':
  if 'Synthetic hold for crash' in json.dumps(request): continue
  thread=request['params']['threadId']; turn=result['turn']['id']
  emit({'method':'turn/started','params':{'threadId':thread,'turn':{'id':turn,'status':'inProgress'}}})
  if 'Synthetic free text question' in json.dumps(request):
   emit({'id':900,'method':'item/tool/requestUserInput','params':{'threadId':thread,'turnId':turn,'itemId':'synthetic-question','questions':[{'id':'explain','question':'Explain?','options':None}]}})
   continue
  for index in range(96):
   emit({'method':'item/agentMessage/delta','params':{'threadId':thread,'turnId':turn,'itemId':'text-'+turn,'delta':'synthetic reply' if index==0 else '.'}})
  emit({'method':'turn/completed','params':{'threadId':thread,'turn':{'id':turn,'status':'completed'}}})
 if method=='turn/interrupt':
  emit({'method':'turn/completed','params':{'threadId':request['params']['threadId'],'turn':{'id':request['params']['turnId'],'status':'interrupted'}}})
`);
chmodSync(peer, 0o700);
if (mode === 'retry') writeFileSync(join(run, 'codex-home/fail-first'), 'synthetic');
Object.assign(process.env, {
  HYPERNEO_OAP_BINARY_PATH: binary,
  HYPERNEO_OAP_VERSION: version,
  HYPERNEO_OAP_SHA256: mode === 'bad-pin' ? '0'.repeat(64) : sha256,
  HYPERNEO_OAP_CODEX_EXECUTABLE: peer,
  HYPERNEO_OAP_CODEX_HOME: join(run, 'codex-home'),
});
const config = getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace-a') });
assert(config.oap, 'daemon must read the explicit OAP binary configuration');
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
let releaseResult: (() => void) | undefined;
const evidence: Record<string, unknown> = { synthetic: true, mode, binaryVersion: version, binarySha256: sha256 };
const calls = () => existsSync(join(run, 'codex-home/calls.jsonl'))
  ? readFileSync(join(run, 'codex-home/calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { cwd: string; codexHome?: string; request: { method?: string; params?: { cwd?: string; approvalPolicy?: string; sandbox?: string; developerInstructions?: string; capabilities?: { experimentalApi?: boolean } } } })
  : [];
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert(Date.now() < deadline, `timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}
try {
  app = await createDaemonApp({ config: { ...config, disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
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
  }, { subscriberName: 'oap-workspace-wire-proof' });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false, createSocket: createLocalSocket });
  hub.registerTransport(transport);
  await transport.initialize();
  await hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Synthetic provider', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const makeSession = async (workspace: string) => hub.request<{ sessionId: string }>('session.create', { workspacePath: join(run, workspace), title: 'Synthetic OAP workspace', config: { model: 'haiku', provider: 'anthropic', harness: 'codex' } });
  const { sessionId: firstId } = await makeSession('workspace-a');
  const first = app.sessionManager.getSession(firstId);
  assert(first);
  if (mode === 'bad-pin') {
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic bad digest' });
    await waitFor(() => errors.some((error) => /sha256_mismatch/.test(error)), 'visible digest refusal');
    assert.equal(calls().length, 0);
    assert.equal(existsSync(join(run, 'data/oap/oap-serve.json')), false);
    Object.assign(evidence, { port: app.server.port, mismatchedDigestRefused: true, syntheticPeerStarts: 0, pass: true });
  } else if (mode === 'retry') {
    const failure = await Promise.resolve(first.oap!.hub).then(() => '', (error: Error) => error.message);
    assert(failure, 'the first synthetic app-server start must fail');
    const resumedHub = await first.oap!.hub;
    assert(resumedHub);
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic after open retry' });
    await waitFor(() => app!.db.getSDKMessages(firstId).messages.some((row) => row.type === 'result'), 'turn after open retry');
    const turns = calls().filter((call) => call.request.method === 'turn/start');
    assert.equal(turns.length, 1);
    assert(JSON.stringify(turns[0]).includes('Synthetic after open retry'));
    Object.assign(evidence, { port: app.server.port, firstOpenFailed: true, laterOpenSucceeded: true, submittedTurns: turns.length, pass: true });
  } else if (mode === 'question') {
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic free text question' });
    await waitFor(() => errors.some((error) => /unsupported text question/i.test(error)), 'visible unsupported text question');
    const interruptions = calls().filter((call) => call.request.method === 'turn/interrupt');
    assert.equal(interruptions.length, 1);
    const inputReplies = calls().map((call) => call.request as { id?: number; method?: string; result?: unknown; error?: { code?: number } }).filter((request) => request.id === 900 && !request.method);
    assert.equal(inputReplies.length, 1);
    assert.equal(inputReplies[0].error?.code, -32800);
    assert.equal(inputReplies[0].result, undefined);
    Object.assign(evidence, { port: app.server.port, freeTextQuestionCancelled: true, freeTextAutoAnswered: false, nativeDenialCode: inputReplies[0].error?.code, interruptRequests: interruptions.length, visibleReason: errors.find((error) => /unsupported text question/i.test(error)), pass: true });
  } else {
    const { sessionId: secondId } = await makeSession('workspace-b');
    const second = app.sessionManager.getSession(secondId);
    assert(second);
    let firstResults = 0;
    let secondResults = 0;
    let notifyResult!: () => void;
    const resultArrived = new Promise<void>((resolveResult) => { notifyResult = resolveResult; });
    const holdResult = new Promise<void>((resolveResult) => { releaseResult = resolveResult; });
    const firstHandler = first.onSDKMessage.bind(first);
    first.onSDKMessage = async (...args) => {
      await firstHandler(...args);
      if (args[0].type === 'result' && ++firstResults === 1) { notifyResult(); await holdResult; }
    };
    const secondHandler = second.onSDKMessage.bind(second);
    second.onSDKMessage = async (...args) => { await secondHandler(...args); if (args[0].type === 'result') secondResults++; };
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic first workspace prompt' });
    await Promise.race([resultArrived, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error(`first result timed out: ${JSON.stringify(errors)}`)), 20000); timer.unref(); })]);
    const secondSend = first.messageQueue.enqueueWithId('synthetic-window-message', 'Synthetic queued prompt', false, { durable: true });
    assert(first.messageQueue.hasQueuedMessages());
    await hub.request('message.send', { sessionId: secondId, content: 'Synthetic second workspace prompt' });
    assert(releaseResult);
    releaseResult();
    await secondSend;
    await waitFor(() => firstResults === 2 && !first.queryPromise && !first.messageQueue.isRunning(), 'queued first-session turn');
    await waitFor(() => secondResults === 1 && !second.queryPromise && !second.messageQueue.isRunning(), 'second workspace turn');
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic later prompt' });
    await waitFor(() => firstResults === 3 && !first.queryPromise && !first.messageQueue.isRunning(), 'later first-session turn');
    const firstHub = await first.oap!.hub;
    assert.equal(await first.oap!.hub, firstHub);
    assert.notEqual(await second.oap!.hub, firstHub);
    const engineHub = await app.oapEngine.getHub(config.oap);
    assert.equal(await app.oapEngine.getHub(config.oap), engineHub);
    const allCalls = calls();
    const starts = allCalls.filter((call) => call.request.method === 'thread/start');
    assert.equal(starts.length, 2);
    for (const name of ['workspace-a', 'workspace-b']) {
      const start = starts.find((call) => call.cwd === join(run, name));
      assert.equal(start?.request.params?.cwd, join(run, name));
      assert.equal(start?.request.params?.approvalPolicy, 'on-request');
      assert.equal(start?.request.params?.sandbox, 'workspace-write');
      assert.equal(start?.request.params?.developerInstructions, undefined);
    }
    assert(allCalls.every((call) => [join(run, 'workspace-a'), join(run, 'workspace-b')].includes(call.cwd)));
    assert(allCalls.every((call) => call.codexHome === join(run, 'codex-home')));
    assert(allCalls.filter((call) => call.request.method === 'initialize').every((call) => call.request.params?.capabilities?.experimentalApi !== true));
    assert.equal(firstResults, 3);
    assert.equal(secondResults, 1);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    await hub.request('session.delete', { sessionId: secondId });
    assert.equal(app.db.getSession(secondId), null);
    await assert.rejects(Promise.resolve(second.oap!.hub), /deleted/i);
    const live = await engineHub.request('sessions') as { sessions: Array<{ session_id: string }> };
    assert(live.sessions.some((entry) => entry.session_id === firstId));
    assert(!live.sessions.some((entry) => entry.session_id === secondId));
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic hold for crash' });
    await waitFor(() => calls().some((call) => call.request.method === 'turn/start' && JSON.stringify(call).includes('Synthetic hold for crash')), 'in-flight run before hub crash');
    const child = (engineHub as unknown as { child: { pid: number; kill(signal: string): boolean; once(event: string, callback: () => void): void } }).child;
    assert(child && child.pid > 0);
    const exited = new Promise<void>((resolveExit) => child.once('close', resolveExit));
    assert(child.kill('SIGKILL'));
    await exited;
    await waitFor(() => errors.some((error) => /OAP hub exited/.test(error)), 'visible hub failure');
    await new Promise((done) => setTimeout(done, 2500));
    const heldTurns = calls().filter((call) => call.request.method === 'turn/start' && JSON.stringify(call).includes('Synthetic hold for crash'));
    assert.equal(heldTurns.length, 1);
    assert.equal(calls().filter((call) => call.request.method === 'thread/start').length, 2);
    Object.assign(evidence, { port: app.server.port, runtimeInjected: false, distinctWorkspaceSessions: 2, queryHubsPerSession: true, sharedDaemonHub: true, deletedSessionReleased: true, remainingSessionKept: true, firstSessionCompletedTurns: firstResults, secondSessionCompletedTurns: secondResults, resultWindowQueued: true, queuedVia: 'messageQueue', textDeltasPerTurn: 96, isolatedCodexHome: true, approvalPolicy: 'on-request', sandbox: 'workspace-write', developerInstructionsSent: false, experimentalApiEnabled: false, crashedRunSubmissions: heldTurns.length, automaticResendsObserved: 0, pass: true });
  }
  assert.equal(gateCalls, 0);
  assert.deepEqual(app.sessionManager.getTrackedAgentRootPidsSplit().live, []);
} finally {
  releaseResult?.();
  if (existsSync(join(run, 'codex-home/calls.jsonl'))) copyFileSync(join(run, 'codex-home/calls.jsonl'), join(run, 'evidence/calls.jsonl'));
  await transport?.close();
  await app?.cleanup();
  evidence.cleaned = true;
  writeFileSync(join(run, 'evidence/oap-workspace-wire.json'), JSON.stringify(evidence, null, 2));
}
