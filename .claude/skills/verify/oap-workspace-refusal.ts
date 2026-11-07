import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { getSdkStartupGate } from '../../../packages/daemon/src/lib/agent/sdk-startup-gate.ts';
import type { OapQueryRuntime } from '../../../packages/daemon/src/lib/agent/query-runner.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { SDKUserMessage } from '../../../packages/shared/src/sdk/index.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'workspace'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
const evidence: Record<string, unknown> = { synthetic: true, usedRealOap: false };
try {
  app = await createDaemonApp({
    config: {
      ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }),
      disableWorktrees: true,
      disableGoalProcessing: true,
    },
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
  }, { subscriberName: 'oap-workspace-proof' });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false, createSocket: createLocalSocket });
  hub.registerTransport(transport);
  await transport.initialize();
  await hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Synthetic provider', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'workspace'), title: 'Synthetic Codex', config: { model: 'haiku', provider: 'anthropic', harness: 'codex' } });
  const stored = app.db.getSession(sessionId);
  assert.equal(stored?.config.harness, 'codex');
  const update = await hub.request('session.update', { sessionId, config: { harness: 'sdk' } }).then(() => 'accepted', (error: Error) => error.message);
  assert.match(update, /harness/i);
  const guardUpdate = await hub.request('session.update', { sessionId, config: { workerOperations: true } }).then(() => 'accepted', (error: Error) => error.message);
  assert.match(guardUpdate, /Codex.*not supported/i);
  await hub.request('message.send', { sessionId, content: 'Synthetic request' }).catch(() => {});
  const deadline = Date.now() + 10_000;
  while (!errors.some((message) => /open-directory.*not available/i.test(message))) {
    assert(Date.now() < deadline, `missing visible workspace refusal: ${JSON.stringify(errors)}`);
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(gateCalls, 0);
  assert.deepEqual(app.sessionManager.getTrackedAgentRootPidsSplit().live, []);
  assert.equal(app.db.getSession(sessionId)?.config.harness, 'codex');
  const { sessionId: syntheticSession } = await hub.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'workspace'), title: 'Synthetic OAP query', config: { model: 'haiku', provider: 'anthropic', harness: 'codex' } });
  const agent = app.sessionManager.getSession(syntheticSession);
  assert(agent);
  const submissions: string[] = [];
  let cancellations = 0;
  const syntheticOap: OapQueryRuntime = {
    openDirectorySupported: true,
    hub: {
      submit: async (target: string, message: SDKUserMessage) => {
        assert.equal(target, syntheticSession);
        assert(message.uuid);
        submissions.push(message.uuid);
        return { runId: `run-${submissions.length}` };
      },
      events: async function* (_target: string, runId: string) {
        yield { type: 'content.delta', id: `text-${runId}`, payload: { part: { type: 'text', text: `reply-${runId}` } } };
        yield { type: 'run.completed', id: `end-${runId}`, payload: { final_response: { content: `reply-${runId}` } } };
      },
      cancel: async () => { cancellations++; },
    },
  };
  (agent as unknown as { runtimeOptions: { oap: OapQueryRuntime } }).runtimeOptions.oap = syntheticOap;
  const errorsBeforeTurns = errors.length;
  for (let turn = 1; turn <= 2; turn++) {
    await hub.request('message.send', { sessionId: syntheticSession, content: `Synthetic prompt ${turn}` });
    const turnDeadline = Date.now() + 10_000;
    while (true) {
      const rows = app.db.getSDKMessages(syntheticSession).messages;
      const results = rows.filter((row) => row.type === 'result');
      if (results.length === turn && !agent.queryPromise && !agent.messageQueue.isRunning()) {
        assert(results.some((row) => 'result' in row && row.result === `reply-run-${turn}`));
        break;
      }
      assert(Date.now() < turnDeadline, `synthetic turn ${turn} did not finish`);
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  assert.equal(new Set(submissions).size, 2);
  assert.equal(cancellations, 0);
  assert.equal(errors.length, errorsBeforeTurns);
  assert.equal(gateCalls, 0);
  assert.deepEqual(app.sessionManager.getTrackedAgentRootPidsSplit().live, []);
  evidence.port = app.server.port;
  evidence.persistedHarness = 'codex';
  evidence.updateRefused = true;
  evidence.workerOperationsRefused = true;
  evidence.visibleRefusal = errors.find((message) => /open-directory.*not available/i.test(message));
  evidence.sdkStartupGateCalls = gateCalls;
  evidence.trackedAgentProcesses = 0;
  evidence.syntheticTurnsFinished = submissions.length;
  evidence.syntheticCompletedRunCancellations = cancellations;
  evidence.pass = true;
} finally {
  await transport?.close();
  await app?.cleanup();
  evidence.cleaned = true;
  writeFileSync(join(run, 'evidence/oap-workspace-refusal.json'), JSON.stringify(evidence, null, 2));
}
