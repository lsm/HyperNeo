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
  while (!errors.some((message) => /OAP configuration is incomplete/i.test(message))) {
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
        const common = { session_id: syntheticSession, run_id: runId, message_id: `message-${runId}` };
        for (const [index, text] of ['Think', ' carefully'].entries()) {
          yield { type: 'content.delta', id: `reason-${runId}-${index}`, payload: { ...common, part: { type: 'reasoning', reasoning: text } } };
        }
        for (const [index, text] of ['reply-', runId].entries()) {
          yield { type: 'content.delta', id: `text-${runId}-${index}`, payload: { ...common, part: { type: 'text', text } } };
        }
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
        const assistants = rows.filter((row) => row.type === 'assistant');
        assert.equal(assistants.length, turn);
        assert(assistants.some((row) => JSON.stringify(row).includes('Think carefully') && JSON.stringify(row).includes(`reply-run-${turn}`)));
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
  let rejectOld: ((error: Error) => void) | undefined;
  (agent as unknown as { runtimeOptions: { oap: OapQueryRuntime } }).runtimeOptions.oap = {
    openDirectorySupported: true,
    hub: {
      submit: () => new Promise<{ runId: string }>((_resolve, reject) => { rejectOld = reject; }),
      events: async function* () {},
      cancel: async () => {},
    },
  };
  void agent.messageQueue.enqueueWithId('synthetic-old', 'old prompt', false, { durable: true }).catch(() => {});
  await agent.startStreamingQuery();
  const staleQuery = agent.queryPromise;
  assert(staleQuery);
  const submitDeadline = Date.now() + 10_000;
  while (!rejectOld) {
    assert(Date.now() < submitDeadline, 'synthetic old run did not submit');
    await new Promise((done) => setTimeout(done, 50));
  }
  agent.messageQueue.stop();
  agent.incrementQueryGeneration();
  agent.messageQueue.start();
  const successor = agent.attemptTokens.allocate();
  void agent.messageQueue.enqueueWithId('synthetic-replacement', 'replacement prompt', false, { durable: true }).catch(() => {});
  rejectOld(new Error('synthetic stale hub failure'));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([staleQuery, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('stale query did not settle')), 10_000); })]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  assert(agent.messageQueue.isRunning());
  assert(agent.messageQueue.hasPendingOrInFlight('synthetic-replacement'));
  assert(successor.isLive());
  assert.equal(errors.length, errorsBeforeTurns);
  agent.messageQueue.clear();
  await agent.lifecycleManager.stop({ timeoutMs: 100, catchQueryErrors: true });
  const { sessionId: orderSession } = await hub.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'workspace'), title: 'Synthetic OAP order', config: { model: 'haiku', provider: 'anthropic', harness: 'codex' } });
  const orderAgent = app.sessionManager.getSession(orderSession);
  assert(orderAgent);
  let orderTurn = 0;
  (orderAgent as unknown as { runtimeOptions: { oap: OapQueryRuntime } }).runtimeOptions.oap = {
    openDirectorySupported: true,
    hub: {
      submit: async () => ({ runId: `order-${++orderTurn}` }),
      events: async function* (_target: string, runId: string) {
        const content = (id: string, text: string) => ({ type: 'content.delta', id, payload: { message_id: runId, part: { type: 'text', text } } });
        if (runId === 'order-1') {
          yield content('before', 'before tool');
          yield { type: 'action.call.started', id: 'tool-start', payload: { tool_call_id: 't1', name: 'codex.command' } };
          yield { type: 'action.call.completed', id: 'tool-end', payload: { tool_call_id: 't1', result: 'ok' } };
          yield content('after', 'after tool');
          yield { type: 'run.completed', id: 'done', payload: {} };
        } else {
          yield content('partial', 'partial before failure');
          throw new Error('synthetic hub stream failure');
        }
      },
      cancel: async () => {},
    },
  };
  await hub.request('message.send', { sessionId: orderSession, content: 'Synthetic ordering' });
  const orderDeadline = Date.now() + 15_000;
  while (!app.db.getSDKMessages(orderSession).messages.some((row) => row.type === 'result') || orderAgent.queryPromise) {
    assert(Date.now() < orderDeadline, 'ordered turn did not finish');
    await new Promise((done) => setTimeout(done, 50));
  }
  const orderRows = app.db.getSDKMessages(orderSession).messages.filter((row) => row.type === 'assistant' || (row.type === 'user' && JSON.stringify(row).includes('tool_result')));
  assert.deepEqual(orderRows.map((row) => row.type === 'assistant' ? row.message.content[0]?.type : 'tool_result'), ['text', 'tool_use', 'tool_result', 'text']);
  assert(JSON.stringify(orderRows[0]).includes('before tool'));
  assert(JSON.stringify(orderRows[3]).includes('after tool'));
  await hub.request('message.send', { sessionId: orderSession, content: 'Synthetic failure' });
  const failureDeadline = Date.now() + 15_000;
  while (!JSON.stringify(app.db.getSDKMessages(orderSession).messages).includes('partial before failure')) {
    assert(Date.now() < failureDeadline, 'partial text was not saved after stream failure');
    await new Promise((done) => setTimeout(done, 50));
  }
  evidence.chronologicalToolRows = true;
  evidence.abruptStreamPartialSaved = true;
  let releaseLate!: () => void;
  let listening!: () => void;
  const lateGate = new Promise<void>((resolve) => { releaseLate = resolve; });
  const listeningStarted = new Promise<void>((resolve) => { listening = resolve; });
  let staleCancellations = 0;
  (agent as unknown as { runtimeOptions: { oap: OapQueryRuntime } }).runtimeOptions.oap = {
    openDirectorySupported: true,
    hub: {
      submit: async () => ({ runId: 'synthetic-late-run' }),
      events: async function* () {
        listening();
        await lateGate;
        yield { type: 'content.delta', id: 'late-text', payload: { part: { type: 'text', text: 'stale output must not persist' } } };
        yield { type: 'run.completed', id: 'late-terminal', payload: {} };
      },
      cancel: async () => { staleCancellations++; },
    },
  };
  void agent.messageQueue.enqueueWithId('synthetic-late', 'old prompt', false, { durable: true }).catch(() => {});
  await agent.startStreamingQuery();
  const lateQuery = agent.queryPromise;
  assert(lateQuery);
  await listeningStarted;
  agent.messageQueue.stop();
  agent.incrementQueryGeneration();
  agent.messageQueue.start();
  const lateSuccessor = agent.attemptTokens.allocate();
  void agent.messageQueue.enqueueWithId('synthetic-late-successor', 'replacement prompt', false, { durable: true }).catch(() => {});
  releaseLate();
  await lateQuery;
  assert.equal(staleCancellations, 1);
  assert(lateSuccessor.isLive());
  assert(agent.messageQueue.hasPendingOrInFlight('synthetic-late-successor'));
  assert(!JSON.stringify(app.db.getSDKMessages(syntheticSession).messages).includes('stale output must not persist'));
  agent.messageQueue.clear();
  await agent.lifecycleManager.stop({ timeoutMs: 100, catchQueryErrors: true });
  evidence.port = app.server.port;
  evidence.persistedHarness = 'codex';
  evidence.updateRefused = true;
  evidence.workerOperationsRefused = true;
  evidence.visibleRefusal = errors.find((message) => /OAP configuration is incomplete/i.test(message));
  evidence.sdkStartupGateCalls = gateCalls;
  evidence.trackedAgentProcesses = 0;
  evidence.syntheticTurnsFinished = submissions.length;
  evidence.joinedTextAndReasoningPerTurn = true;
  evidence.assistantRowsPerTurn = 1;
  evidence.syntheticCompletedRunCancellations = cancellations;
  evidence.staleFailurePreservedReplacement = true;
  evidence.staleFailurePreservedSuccessorAttempt = true;
  evidence.lateEventDropped = true;
  evidence.lateEventPreservedSuccessor = true;
  evidence.pass = true;
} finally {
  await transport?.close();
  await app?.cleanup();
  evidence.cleaned = true;
  writeFileSync(join(run, 'evidence/oap-workspace-refusal.json'), JSON.stringify(evidence, null, 2));
}
