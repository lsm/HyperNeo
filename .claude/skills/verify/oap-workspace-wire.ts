import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { checkOapBinary } from '../../../packages/daemon/src/lib/oap/oap-binary.ts';
import { OapHubRequestError } from '../../../packages/daemon/src/lib/oap/oap-hub-client.ts';
import { decideReopenFailure } from '../../../packages/daemon/src/lib/oap/oap-session-open.ts';
import { getSdkStartupGate } from '../../../packages/daemon/src/lib/agent/sdk-startup-gate.ts';
import { deliverAgentMessageToTarget, type AgentMessageDeliveryDeps } from '../../../packages/daemon/src/lib/messaging/delivery-pipeline.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { resolveNeoEntry } from '../../../packages/shared/src/web-entry.ts';

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
import json,os,sys,time
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
  name=os.path.basename(os.getcwd())
  countfile=os.path.join(os.environ['CODEX_HOME'],'thread-count-'+name)
  if method=='thread/start':
   count=int(open(countfile).read())+1 if os.path.exists(countfile) else 1
   with open(countfile,'w') as counter: counter.write(str(count))
   thread='native-'+name+('-'+str(count) if count>1 else '')
  else: thread=request['params']['threadId']
  result={'thread':{'id':thread},'model':'synthetic-model','cwd':os.getcwd(),'approvalPolicy':'on-request','sandbox':{'type':'workspaceWrite','writableRoots':[],'networkAccess':False}}
 elif method=='turn/start': result={'turn':{'id':'turn-'+str(request['id']),'status':'inProgress'}}
 else: result={}
 if method=='turn/start' and 'Synthetic gated admission' in json.dumps(request):
  open(os.path.join(os.environ['CODEX_HOME'],'admission-waiting'),'w').close()
  while not os.path.exists(os.path.join(os.environ['CODEX_HOME'],'admission-release')): time.sleep(0.01)
 if method=='turn/start' and 'Synthetic crash during admission' in json.dumps(request): sys.exit(23)
 emit({'id':request['id'],'result':result})
 if method=='turn/start':
  if 'Synthetic native crash' in json.dumps(request): sys.exit(23)
  if 'Synthetic gated admission' in json.dumps(request):
   open(os.path.join(os.environ['CODEX_HOME'],'terminal-waiting'),'w').close()
   while not os.path.exists(os.path.join(os.environ['CODEX_HOME'],'terminal-release')): time.sleep(0.01)
  if 'Synthetic hold for crash' in json.dumps(request): continue
  thread=request['params']['threadId']; turn=result['turn']['id']
  emit({'method':'turn/started','params':{'threadId':thread,'turn':{'id':turn,'status':'inProgress'}}})
  if 'Synthetic free text question' in json.dumps(request):
   emit({'id':900,'method':'item/tool/requestUserInput','params':{'threadId':thread,'turnId':turn,'itemId':'synthetic-question','questions':[{'id':'explain','question':'Explain?','options':None}]}})
   continue
  for index in range(${mode === 'recovery-claim' ? 1 : 96}):
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
async function verifyNoticeInBrowser(currentApp: NonNullable<typeof app>, sessionId: string, text: string): Promise<void> {
  assert(process.env.VERIFY_BROWSER);
  const root = resolve('packages/web/dist');
  assert(existsSync(join(root, 'index.html')), 'build the web bundle before the browser proof');
  const web = Bun.serve({ hostname: '127.0.0.1', port: 0,
    websocket: createWebSocketHandlers(currentApp.transport, currentApp.sessionManager),
    async fetch(req, server) {
      const refused = await currentApp.guardRequest(req);
      if (refused) return refused;
      const path = new URL(req.url).pathname;
      if (path === '/ws') {
        const device = await currentApp.authenticateUpgrade(req, server.requestIP(req)?.address ?? null);
        if (!device) return new Response('Device pairing required', { status: 401 });
        if (server.upgrade(req, { data: { connectionSessionId: 'global', device } })) return;
        return new Response('Upgrade failed', { status: 500 });
      }
      const file = resolve(root, `.${path}`);
      if (file.startsWith(`${root}/`) && await Bun.file(file).exists()) return new Response(Bun.file(file));
      const neo = resolveNeoEntry(new URL(req.url));
      if (neo?.kind === 'redirect') return Response.redirect(new URL(neo.location, req.url));
      return new Response(Bun.file(`${root}${neo?.kind === 'entry' ? neo.path : '/index.html'}`));
    },
  });
  assert.notEqual(web.port, 8399);
  assert.notEqual(web.port, 8499);
  try {
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
      const base = `http://127.0.0.1:${web.port}`;
      await context.route('**/*', (route: { request(): { url(): string }; continue(): void; abort(): void }) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await context.addCookies([{ name: 'hyperneo_device', value: readFileSync(join(run, 'data/local-rpc.credential'), 'utf8'), url: base }]);
      const page = await context.newPage();
      await page.goto(`${base}/session/${sessionId}`);
      const notice = page.getByText(text, { exact: true }).last();
      try {
        await notice.waitFor({ timeout: 20000 });
      } catch (error) {
        writeFileSync(join(run, 'evidence/oap-browser.txt'), await page.locator('body').innerText());
        await page.screenshot({ path: join(run, 'evidence/oap-browser-failure.png'), animations: 'disabled' });
        throw error;
      }
      await notice.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(run, 'evidence/oap-reopen-session.png'), animations: 'disabled' });
      await page.goto(`${base}/neo`);
      await page.locator('.neo-shell').waitFor({ timeout: 20000 });
      await page.screenshot({ path: join(run, 'evidence/oap-reopen-neo.png'), animations: 'disabled' });
      Object.assign(evidence, { browserPort: web.port, ...(mode === 'recovery-claim' ? { visibleUserMessageRendered: true } : { visibleNoticeRendered: true }) });
      await context.close();
    } finally { await browser.close(); }
  } finally { web.stop(true); }
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
  let hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false, createSocket: createLocalSocket });
  hub.registerTransport(transport);
  await transport.initialize();
  await hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Synthetic provider', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const makeSession = async (workspace: string) => hub.request<{ sessionId: string }>('session.create', { workspacePath: join(run, workspace), title: 'Synthetic OAP workspace', config: { model: 'haiku', provider: 'anthropic', harness: 'codex' } });
  const { sessionId: firstId } = await makeSession('workspace-a');
  const first = app.sessionManager.getSession(firstId);
  assert(first);
  if (mode === 'feature-refusal') {
    await first.oap!.hub;
    const engineHub = await app.oapEngine.getHub(config.oap);
    const refusal = await engineHub.request('settings', {
      session_id: firstId,
      request: {
        protocol: 'open-agent-protocol', version: '0.1', profile: 'open-agent-protocol.agent-control-core',
        type: 'session.settings.update.request', id: 'synthetic-settings', session_id: firstId,
        payload: { session_id: firstId, compaction_policy: { kind: 'off' } },
      },
    }).then(() => null, (error: Error) => error);
    assert(refusal instanceof OapHubRequestError);
    assert.equal(refusal.code, 'unsupported_feature');
    assert.equal(refusal.feature, 'session.compaction.policy');
    assert.equal(decideReopenFailure(refusal).mode, 'error');
    Object.assign(evidence, { port: app.server.port, refusedFeature: refusal.feature, unrelatedRefusalPreserved: true, pass: true });
  } else if (mode === 'bad-pin') {
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic bad digest' });
    await waitFor(() => errors.some((error) => /sha256_mismatch/.test(error)), 'visible digest refusal');
    assert.equal(calls().length, 0);
    assert.equal(existsSync(join(run, 'data/oap/oap-serve.json')), false);
    Object.assign(evidence, { port: app.server.port, mismatchedDigestRefused: true, syntheticPeerStarts: 0, pass: true });
  } else if (mode === 'recovery-claim') {
    await first.oap!.hub;
    const metadata = { ...first.session.metadata, oapRecovery: { previous: 'synthetic-old-thread', text: 'Synthetic saved conversation excerpt', pendingOpen: false } };
    assert.equal(await app.db.updateSession(firstId, { metadata }), 'written');
    first.session.metadata = metadata;
    const engineHub = await app.oapEngine.getHub(config.oap);
    const request = engineHub.request.bind(engineHub);
    let claimObservedBeforeSubmit = false;
    engineHub.request = async (op, params) => {
      if (op === 'submit') {
        assert(app!.db.getSession(firstId)?.metadata.oapRecovery?.claim);
        claimObservedBeforeSubmit = true;
      }
      return request(op, params);
    };
    const db = app.db;
    const updateSession = db.updateSession.bind(db);
    let cleanupFailed = false;
    db.updateSession = async (id, update) => {
      if (id === firstId && update.metadata && 'oapRecovery' in update.metadata && !update.metadata.oapRecovery) {
        if (!cleanupFailed) {
          cleanupFailed = true;
          throw new Error('synthetic recovery marker cleanup failure');
        }
        const retained = db.getSession(firstId)?.metadata.oapRecovery;
        return updateSession(id, { ...update, metadata: { ...update.metadata, oapRecovery: retained } });
      }
      return updateSession(id, update);
    };
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic first explicit request' });
    await waitFor(() => app!.db.getSDKMessages(firstId, 1000).messages.filter((row) => row.type === 'result').length === 1 && !first.queryPromise, 'first recovered turn');
    const claimed = app.db.getSession(firstId)?.metadata.oapRecovery;
    assert(claimed?.claim);
    assert(claimObservedBeforeSubmit);
    assert(cleanupFailed);
    const firstTurns = calls().filter((call) => call.request.method === 'turn/start');
    assert.equal(firstTurns.length, 1);
    assert(JSON.stringify(firstTurns[0]).includes('Synthetic saved conversation excerpt'));
    assert(JSON.stringify(firstTurns[0]).includes('Synthetic first explicit request'));
    db.updateSession = updateSession;
    await transport.close();
    transport = undefined;
    await app.cleanup();
    app = undefined;
    app = await createDaemonApp({ config: { ...config, disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
    assert.notEqual(app.server.port, 8399);
    assert.notEqual(app.server.port, 8499);
    assert.equal(app.db.getSession(firstId)?.metadata.oapRecovery?.claim, claimed.claim);
    assert.equal(calls().filter((call) => call.request.method === 'turn/start').length, 1);
    hub = new MessageHub({ defaultSessionId: 'global' });
    transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false, createSocket: createLocalSocket });
    hub.registerTransport(transport);
    await transport.initialize();
    const resumed = await app.sessionManager.getSessionAsync(firstId, { startQuery: false, replayPendingMessages: false });
    assert(resumed);
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic second explicit request' });
    await waitFor(() => app!.db.getSDKMessages(firstId, 1000).messages.filter((row) => row.type === 'result').length === 2 && !resumed.queryPromise, 'explicit turn after restart');
    const turns = calls().filter((call) => call.request.method === 'turn/start');
    assert.equal(turns.length, 2);
    assert(!JSON.stringify(turns[1]).includes('Synthetic saved conversation excerpt'));
    assert(JSON.stringify(turns[1]).includes('Synthetic second explicit request'));
    if (process.env.VERIFY_BROWSER) await verifyNoticeInBrowser(app, firstId, 'Synthetic second explicit request');
    Object.assign(evidence, { port: app.server.port, presetRecoveryClaimedBeforeSubmit: true, markerCleanupFailed: true, markerSurvivedRestart: true, excerptAttachedOnce: true, explicitTurns: turns.length, automaticResends: 0, pass: true });
  } else if (mode === 'fresh-clear') {
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic original conversation' });
    await waitFor(() => app!.db.getSDKMessages(firstId, 1000).messages.filter((row) => row.type === 'result').length === 1 && !first.queryPromise, 'original native turn');
    const nativeId = app.db.getSession(firstId)?.sdkSessionId;
    assert.equal(nativeId, 'native-workspace-a');
    await first.startFreshContext();
    assert.equal(first.session.sdkSessionId, 'native-workspace-a-2');
    assert.equal(app.db.getSession(firstId)?.sdkSessionId, 'native-workspace-a-2');
    assert.equal(calls().filter((call) => call.request.method === 'turn/start').length, 1);
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic explicit next message' });
    await waitFor(() => app!.db.getSDKMessages(firstId, 1000).messages.filter((row) => row.type === 'result').length === 2 && !first.queryPromise, 'explicit turn after fresh clear');
    let handedOff = false;
    const workerDeps: AgentMessageDeliveryDeps = {
      workflowRunId: 'synthetic-run',
      taskRepo: { getTask: () => ({ id: 'synthetic-task', workflowRunId: 'synthetic-run', status: 'in_progress' }) },
      nodeExecutionRepo: { listByWorkflowRun: () => [{ agentSessionId: firstId, agentName: 'reviewer', workflowNodeId: 'synthetic-node' }] },
      resolveTerminalStatus: () => null,
      isPostApprovalWorker: () => false,
      ensureSession: async () => ({ kind: 'resolved', sessionId: firstId, created: false }),
      getSessionAsync: async () => first,
      withSessionInjectLock: (_sessionId, fn) => fn(),
      isRateOrUsageLimited: () => false,
      slotResetsContext: () => true,
      hasActiveDeliveryJob: () => false,
      hasUnconsumedDeliveredWork: () => false,
      hasHeldDeliveryBacklog: () => false,
      hasSettledDelivery: () => false,
      mailboxDeliveryPending: () => true,
      verifyDeliveryContent: () => {},
      handoffToMailbox: async (args) => {
        assert.equal(args.deliveryMode, undefined);
        assert.equal(first.session.sdkSessionId, 'native-workspace-a-3');
        handedOff = true;
        return { kind: 'enqueued', id: 'synthetic-mailbox' };
      },
      recordActivity: () => {},
    };
    const delivered = await deliverAgentMessageToTarget({
      deps: workerDeps,
      target: { kind: 'worker', taskId: 'synthetic-task', agentName: 'reviewer', workflowNodeId: 'synthetic-node' },
      message: 'Synthetic worker task',
      messageId: 'synthetic-worker-message',
    });
    assert.equal(delivered.state, 'delivered');
    assert(handedOff);
    assert.equal(first.session.sdkSessionId, 'native-workspace-a-3');
    assert.equal(app.db.getSession(firstId)?.sdkSessionId, 'native-workspace-a-3');
    assert.equal(calls().filter((call) => call.request.method === 'turn/start').length, 2);
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic second explicit message' });
    await waitFor(() => app!.db.getSDKMessages(firstId, 1000).messages.filter((row) => row.type === 'result').length === 3 && !first.queryPromise, 'explicit turn after second clear');
    const turns = calls().filter((call) => call.request.method === 'turn/start');
    assert.deepEqual(turns.map((call) => (call.request.params as { threadId?: string }).threadId), [nativeId, 'native-workspace-a-2', 'native-workspace-a-3']);
    assert(turns.every((call) => !JSON.stringify(call).includes('/clear')));
    assert.equal(calls().filter((call) => call.request.method === 'thread/start').length, 3);
    Object.assign(evidence, { port: app.server.port, bothClearPathsCreatedFreshThreads: true, resetPerTurnWorkerHandedOff: true, distinctIdsPersisted: true, controlMessagesSent: 0, explicitTurns: turns.length, pass: true });
  } else if (mode === 'fresh-clear-crash') {
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic prior conversation' });
    await waitFor(() => app!.db.getSDKMessages(firstId, 1000).messages.some((row) => row.type === 'result') && !first.queryPromise, 'prior native turn');
    const nativeId = app.db.getSession(firstId)?.sdkSessionId;
    assert.equal(nativeId, 'native-workspace-a');
    const engineHub = await app.oapEngine.getHub(config.oap);
    const child = (engineHub as unknown as { child: { pid: number; kill(signal: string): boolean; once(event: string, callback: () => void): void } }).child;
    assert(child && child.pid > 0);
    const mutable = engineHub as unknown as { request: (op: string, params: Record<string, unknown>) => Promise<unknown> };
    const originalRequest = mutable.request.bind(engineHub);
    mutable.request = async (op, params) => {
      const result = await originalRequest(op, params);
      if (op === 'close' && params.session_id === firstId) {
        const exited = new Promise<void>((resolveExit) => child.once('close', resolveExit));
        assert(child.kill('SIGKILL'));
        await exited;
        throw new Error('synthetic hub crash after close');
      }
      return result;
    };
    await assert.rejects(first.clearConversationContext(), /could not clear/i);
    assert.equal(app.db.getSession(firstId)?.metadata?.oapClearThreadId, nativeId);
    assert.equal(app.db.getSession(firstId)?.sdkSessionId, nativeId);
    assert.equal(calls().filter((call) => call.request.method === 'turn/start').length, 1);
    await first.oap!.hub;
    assert.equal(app.db.getSession(firstId)?.sdkSessionId, 'native-workspace-a-2');
    assert.equal(app.db.getSession(firstId)?.metadata?.oapClearThreadId, undefined);
    assert.equal(calls().filter((call) => call.request.method === 'turn/start').length, 1);
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic message after interrupted clear' });
    await waitFor(() => app!.db.getSDKMessages(firstId, 1000).messages.filter((row) => row.type === 'result').length === 2 && !first.queryPromise, 'turn after interrupted clear');
    const turns = calls().filter((call) => call.request.method === 'turn/start');
    assert.equal((turns[1].request.params as { threadId?: string }).threadId, 'native-workspace-a-2');
    Object.assign(evidence, { port: app.server.port, hubCrashedAfterClose: true, intentSurvived: true, freshIdPersisted: true, automaticResends: 0, pass: true });
  } else if (mode === 'submit-internal') {
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic crash during admission' });
    await waitFor(() => calls().some((call) => call.request.method === 'turn/start'), 'native submit before crash');
    await waitFor(() => errors.length > 0 && !first.queryPromise, 'visible uncertain submit outcome');
    await new Promise((done) => setTimeout(done, 500));
    assert.equal(app.db.getUserMessagesByStatus(firstId, 'submitted').total, 1);
    assert.equal(app.db.getUserMessagesByStatus(firstId, 'failed').total, 0);
    assert.equal(calls().filter((call) => call.request.method === 'turn/start').length, 1);
    Object.assign(evidence, { port: app.server.port, backendOutcomeUnknown: true, submittedRows: 1, failedRows: 0, automaticResends: 0, pass: true });
  } else if (['missing-history', 'missing-history-web', 'clear-missing-history', 'clear-missing-history-web'].includes(mode)) {
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic prior turn' });
    await waitFor(() => app!.db.getSDKMessages(firstId, 1000).messages.some((row) => row.type === 'result') && !first.queryPromise, 'prior native turn');
    const saved = app.db.getSession(firstId)?.sdkSessionId;
    assert.equal(saved, 'native-workspace-a');
    const engineHub = await app.oapEngine.getHub(config.oap);
    const child = (engineHub as unknown as { child: { pid: number; kill(signal: string): boolean; once(event: string, callback: () => void): void } }).child;
    assert(child && child.pid > 0);
    const exited = new Promise<void>((resolveExit) => child.once('close', resolveExit));
    assert(child.kill('SIGKILL'));
    await exited;
    unlinkSync(join(config.oap.stateDirectory, 'session-history.jsonl'));
    if (mode.startsWith('clear-')) {
      await assert.rejects(first.clearConversationContext(), /cannot be resumed/i);
    } else await assert.rejects(Promise.resolve(first.oap!.hub), /cannot be resumed/i);
    const notices = app.db.getSDKMessages(firstId, 1000).messages.filter((row) => JSON.stringify(row).includes('The previous Codex thread cannot be resumed'));
    assert.equal(notices.length, 1);
    assert.equal(app.db.getSDKMessages(firstId, 1000).messages.filter((row) => JSON.stringify(row).includes('Could not clear the Codex thread')).length, 0);
    assert.equal(app.db.getSession(firstId)?.sdkSessionId, saved);
    assert.equal(calls().filter((call) => call.request.method === 'thread/start').length, 1);
    assert.equal(calls().filter((call) => call.request.method === 'turn/start').length, 1);
    if (mode.endsWith('-web')) await verifyNoticeInBrowser(app, firstId, 'The previous Codex thread cannot be resumed. No new thread was started.');
    Object.assign(evidence, { port: app.server.port, visibleNoticeSaved: true, noticeCount: notices.length, priorThreadIdPreserved: true, newThreads: 0, automaticResends: 0, pass: true });
  } else if (mode === 'reopen') {
    const seen: Array<{ type: string; uuid?: string }> = [];
    const handler = first.onSDKMessage.bind(first);
    first.onSDKMessage = async (...args) => { seen.push({ type: args[0].type, uuid: args[0].uuid }); await handler(...args); };
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic first native turn' });
    await waitFor(() => app!.db.getSDKMessages(firstId, 1000).messages.filter((row) => row.type === 'result').length === 1 && !first.queryPromise, 'first native turn');
    const saved = app.db.getSession(firstId)?.sdkSessionId;
    assert.equal(saved, 'native-workspace-a');
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic second native turn' });
    await waitFor(() => app!.db.getSDKMessages(firstId, 1000).messages.filter((row) => row.type === 'result').length === 2 && !first.queryPromise, 'second native turn');
    assert.equal(calls().filter((call) => call.request.method === 'thread/start').length, 1);
    const engineHub = await app.oapEngine.getHub(config.oap);
    const child = (engineHub as unknown as { pid?: number; child: { pid: number; kill(signal: string): boolean; once(event: string, callback: () => void): void } }).child;
    assert(child && child.pid > 0);
    const exited = new Promise<void>((resolveExit) => child.once('close', resolveExit));
    assert(child.kill('SIGKILL'));
    await exited;
    await new Promise((done) => setTimeout(done, 500));
    assert.equal(calls().filter((call) => call.request.method === 'turn/start').length, 2);
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic explicit turn after hub restart' });
    await waitFor(() => {
      const results = app!.db.getSDKMessages(firstId, 1000).messages.filter((row) => row.type === 'result');
      Object.assign(evidence, { observedResults: results.map((row) => row.uuid), seenResults: seen.filter((row) => row.type === 'result'), errors, queryActive: !!first.queryPromise });
      return results.length === 3 && !first.queryPromise;
    }, 'explicit turn after native reopen');
    assert.equal(new Set(seen.filter((row) => row.type === 'result').map((row) => row.uuid)).size, 3);
    const resumes = calls().filter((call) => call.request.method === 'thread/resume');
    const turns = calls().filter((call) => call.request.method === 'turn/start');
    assert.equal(resumes.length, 1);
    assert.equal((resumes[0].request.params as { threadId?: string }).threadId, saved);
    assert.equal(turns.length, 3);
    assert.equal(app.db.getSession(firstId)?.sdkSessionId, saved);
    assert.equal(calls().filter((call) => call.request.method === 'thread/start').length, 1);
    Object.assign(evidence, { port: app.server.port, nativeThreadIdSaved: true, sameThreadReopened: true, explicitTurns: turns.length, automaticResends: 0, pass: true });
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
  } else if (mode === 'first-crash') {
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic hold for crash' });
    await waitFor(() => calls().some((call) => call.request.method === 'turn/start'), 'first turn before hub crash');
    assert.equal(app.db.getSession(firstId)?.metadata?.messageCount ?? 0, 0);
    const engineHub = await app.oapEngine.getHub(config.oap);
    const child = (engineHub as unknown as { child: { pid: number; kill(signal: string): boolean; once(event: string, callback: () => void): void } }).child;
    assert(child && child.pid > 0);
    const exited = new Promise<void>((resolveExit) => child.once('close', resolveExit));
    assert(child.kill('SIGKILL'));
    await exited;
    await waitFor(() => errors.some((error) => /OAP hub exited/.test(error)), 'visible first-turn failure');
    await new Promise((done) => setTimeout(done, 4000));
    assert.equal(calls().filter((call) => call.request.method === 'turn/start').length, 1);
    assert.equal(calls().filter((call) => call.request.method === 'thread/start').length, 1);
    await first.oap!.hub;
    assert.equal(calls().filter((call) => call.request.method === 'thread/resume').length, 1);
    assert.equal(calls().filter((call) => call.request.method === 'turn/start').length, 1);
    assert.equal(app.oapEngine.isCurrentHub(engineHub), false);
    const { sessionId: freshId } = await makeSession('workspace-b');
    await hub.request('message.send', { sessionId: freshId, content: 'Synthetic fresh session after first-turn crash' });
    await waitFor(() => app!.db.getSDKMessages(freshId).messages.some((row) => row.type === 'result'), 'fresh session after first-turn crash');
    assert.equal(calls().filter((call) => call.request.method === 'thread/start').length, 2);
    assert.equal(calls().filter((call) => call.request.method === 'turn/start' && JSON.stringify(call).includes('Synthetic hold for crash')).length, 1);
    Object.assign(evidence, { port: app.server.port, priorCompletedTurns: 0, crashedRunSubmissions: 1, automaticResendsObserved: 0, freshSessionAfterCrash: true, pass: true });
  } else if (mode === 'lifecycle') {
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic gated admission' });
    await waitFor(() => existsSync(join(run, 'codex-home/admission-waiting')), 'native submit before acceptance');
    assert.equal(app.db.getUserMessagesByStatus(firstId, 'submitted').messages.length, 1);
    assert.equal(app.db.getUserMessagesByStatus(firstId, 'consumed').messages.length, 0);
    assert.equal(app.db.getSDKMessages(firstId).messages.filter((row) => row.type === 'result').length, 0);
    writeFileSync(join(run, 'codex-home/admission-release'), 'synthetic');
    await waitFor(() => existsSync(join(run, 'codex-home/terminal-waiting')), 'native acceptance before terminal');
    await waitFor(() => app!.db.getUserMessagesByStatus(firstId, 'consumed').messages.length === 1, 'accepted prompt consumed');
    assert.equal(app.db.getSDKMessages(firstId).messages.filter((row) => row.type === 'result').length, 0);
    writeFileSync(join(run, 'codex-home/terminal-release'), 'synthetic');
    await waitFor(() => app!.db.getSDKMessages(firstId).messages.filter((row) => row.type === 'result').length === 1 && !first.queryPromise, 'single terminal result');
    assert.equal(calls().filter((call) => call.request.method === 'turn/start').length, 1);
    Object.assign(evidence, { port: app.server.port, submittedBeforeAcceptance: true, consumedAfterAcceptance: true, terminalResults: 1, submittedTurns: 1, pass: true });
  } else if (mode === 'native-crash') {
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic native crash' });
    await waitFor(() => app!.db.getSDKMessages(firstId).messages.some((row) => row.type === 'result') && !first.queryPromise, 'native crash terminal');
    const results = app.db.getSDKMessages(firstId).messages.filter((row) => row.type === 'result');
    assert.equal(results.length, 1);
    assert.equal(results[0].is_error, true);
    assert.equal(calls().filter((call) => call.request.method === 'turn/start').length, 1);
    Object.assign(evidence, { port: app.server.port, nativeCrashErrorTerminals: results.length, submittedTurns: 1, pass: true });
  } else if (mode === 'cancel') {
    await hub.request('message.send', { sessionId: firstId, content: 'Synthetic hold for crash' });
    await waitFor(() => calls().some((call) => call.request.method === 'turn/start'), 'turn before interrupt');
    await waitFor(() => app!.db.getUserMessagesByStatus(firstId, 'consumed').messages.length === 1, 'accepted prompt before interrupt');
    await first.handleInterrupt();
    await waitFor(() => app!.db.getSDKMessages(firstId).messages.filter((row) => row.type === 'result').length === 1, 'cancellation terminal');
    const results = app.db.getSDKMessages(firstId).messages.filter((row) => row.type === 'result');
    assert.equal(results.length, 1);
    assert.equal(results[0].is_error, true);
    assert.equal(calls().filter((call) => call.request.method === 'turn/interrupt').length, 1);
    Object.assign(evidence, { port: app.server.port, cancellationTerminals: results.length, nativeInterrupts: 1, pass: true });
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
    const { sessionId: idleId } = await makeSession('workspace-b');
    const idle = app.sessionManager.getSession(idleId);
    assert(idle);
    await idle.oap!.hub;
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
    assert.equal(calls().filter((call) => call.request.method === 'thread/start').length, 3);
    assert.equal(app.oapEngine.isCurrentHub(engineHub), false);
    await idle.oap!.hub;
    await first.oap!.hub;
    assert.equal(calls().filter((call) => call.request.method === 'thread/resume').length, 2);
    assert.equal(calls().filter((call) => call.request.method === 'turn/start' && JSON.stringify(call).includes('Synthetic hold for crash')).length, 1);
    const restartedHub = await app.oapEngine.getHub(config.oap);
    assert.notEqual(restartedHub, engineHub);
    const { sessionId: freshId } = await makeSession('workspace-b');
    await hub.request('message.send', { sessionId: freshId, content: 'Synthetic fresh session after crash' });
    await waitFor(() => app!.db.getSDKMessages(freshId).messages.some((row) => row.type === 'result'), 'fresh session after hub crash');
    assert.equal(calls().filter((call) => call.request.method === 'thread/start').length, 4);
    assert.equal(calls().filter((call) => call.request.method === 'turn/start' && JSON.stringify(call).includes('Synthetic hold for crash')).length, 1);
    Object.assign(evidence, { port: app.server.port, runtimeInjected: false, distinctWorkspaceSessions: 2, queryHubsPerSession: true, sharedDaemonHub: true, deletedSessionReleased: true, remainingSessionKept: true, firstSessionCompletedTurns: firstResults, secondSessionCompletedTurns: secondResults, resultWindowQueued: true, queuedVia: 'messageQueue', textDeltasPerTurn: 96, isolatedCodexHome: true, approvalPolicy: 'on-request', sandbox: 'workspace-write', developerInstructionsSent: false, experimentalApiEnabled: false, crashedRunSubmissions: heldTurns.length, automaticResendsObserved: 0, restartOnLaterUse: true, savedHistoryReopened: true, freshSessionAfterCrash: true, pass: true });
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
