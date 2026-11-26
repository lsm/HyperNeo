import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { checkOxapBinary } from '../../../packages/daemon/src/lib/oxap/oxap-binary.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { readHubOptions } from '../../../packages/daemon/src/lib/oxap/oxap-settings.ts';
import { OpencodeProvider } from '../../../packages/daemon/src/lib/providers/opencode-provider.ts';
import { getProviderRegistry } from '../../../packages/daemon/src/lib/providers/registry.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import {
  type LiveQueryDeltaEvent,
  MessageHub,
  WebSocketClientTransport,
} from '../../../packages/shared/src/mod.ts';
import { answerCodexProbeLocally, serveLocalRelease } from './oxap-codex-provider.ts';

const [binary, version, sha256, ...args] = process.argv.slice(2);
const mode = args.length === 2 ? args[0] : 'first';
const runArgument = args.at(-1)!;
assert(['first', 'routed', 'routed-with-key', 'routed-web', 'routed-missing-key', 'routed-zen', 'routed-zen-missing-key', 'routed-unknown', 'recovery', 'pending', 'flash', 'image', 'flash-web', 'pro-web', 'flash-recovery', 'sdk-default', 'locked-recovery', 'refused-reopen', 'first-open-retry', 'no-replay', 'opencode-go', 'opencode-go-alias', 'opencode-go-with-unkeyed-route'].includes(mode));
const run = resolve(runArgument);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.deepEqual(await checkOxapBinary(binary, { version, sha256 }), { ok: true });
const workspace = join(run, 'workspace');
const peer = join(run, 'dsh');
const routed = mode.startsWith('routed');
const missingRouteKey = mode.endsWith('-missing-key');
const unknownRoute = mode === 'routed-unknown';
const route = unknownRoute ? 'opencode-typo' : mode.startsWith('routed-zen') ? 'opencode-zen' : 'opencode-go';
mkdirSync(workspace);
if (routed) writeFileSync(join(workspace, 'verify-model-provider'), route);
const nativePromptCount = join(workspace, 'verify-native-prompt-count');
if (mode === 'no-replay') {
  process.env.HYPERNEO_HUMAN_SEND_SILENCE_MS = '250';
  process.env.HYPERNEO_SDK_STREAM_SILENCE_TIMEOUT_MS = '1500';
  writeFileSync(nativePromptCount, '');
}
mkdirSync(join(run, 'evidence'));
copyFileSync('.claude/skills/verify/oxap-deepseek-peer.py', peer);
chmodSync(peer, 0o700);
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
chmodSync(join(run, 'bin/gh'), 0o700);
answerCodexProbeLocally();
const releaseRequests = serveLocalRelease(binary, version, join(run, 'release'));
const config = getConfig({
  host: '127.0.0.1',
  port: 0,
  dbPath: join(run, 'data/daemon.db'),
  workspaceRoot: workspace,
});
const boot = () => createDaemonApp({
  config: { ...config, disableWorktrees: true, disableGoalProcessing: true },
  verbose: false,
});
let app = await boot();
if (routed && !missingRouteKey) {
  Object.assign(app.oxapSettings, {
    environment: { ...process.env, OPENCODE_API_KEY: 'synthetic-route-proof', DSH_HOME: join(run, 'home') },
  });
}
const connect = () => new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket: createLocalSocket,
});
let transport = connect();
const evidence: Record<string, unknown> = { version, sha256, mode };
async function runBrowser(hub: MessageHub, script: string, ...args: string[]) {
  const dist = resolve('packages/web/dist');
  const preview = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, server) {
      const refusal = await app.guardRequest(request);
      if (refusal) return refusal;
      const url = new URL(request.url);
      if (url.pathname === '/pair' && request.method === 'POST') return app.handlePair(request);
      if (url.pathname === '/ws') {
        const device = await app.authenticateUpgrade(request, '127.0.0.1');
        if (server.upgrade(request, { data: { connectionSessionId: 'global', device } })) return;
        return new Response('Upgrade failed', { status: 500 });
      }
      const page = /^\/(session\/|sessions$|settings$)/.test(url.pathname);
      const file = Bun.file(join(dist, page ? 'index.html' : url.pathname));
      return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
    },
    websocket: createWebSocketHandlers(app.transport, app.sessionManager),
  });
  try {
    const pairing = await hub.request<{ ok: boolean; code: string }>('operation.invoke', {
      name: 'device.pair.create', input: { kind: 'human', name: 'Synthetic DeepSeek browser' },
    });
    assert(pairing.ok);
    const browser = Bun.spawn([process.execPath, `.claude/skills/verify/${script}`,
      String(preview.port), pairing.code, ...args, run], { stdout: 'inherit', stderr: 'inherit' });
    assert.equal(await browser.exited, 0, 'The browser journey failed');
  } finally {
    preview.stop(true);
  }
}
async function verify() {
  let hub = new MessageHub({ defaultSessionId: 'global' });
  hub.registerTransport(transport);
  await transport.initialize();
  await hub.request('providers.create', {
    params: {
      providerId: 'deepseek',
      displayName: 'Synthetic DeepSeek',
      kind: 'built_in',
      authType: 'api_key',
      isEnabled: true,
      isDefault: true,
      sortOrder: 0,
    },
    ...(routed && mode !== 'routed-with-key' ? {} : { credentials: { apiKey: 'synthetic-deepseek-proof' } }),
  });
  const aliasKey = mode === 'opencode-go-alias';
  const unkeyedRoute = mode === 'opencode-go-with-unkeyed-route';
  const go = mode === 'opencode-go' || aliasKey || unkeyedRoute;
  if (go) {
    assert.deepEqual(await hub.request('operation.invoke', {
      name: 'oxap.settings.save',
      input: { providerId: 'deepseek', harness: 'oxap-deepseek', settings: { executable: peer, ...(unkeyedRoute ? { model_provider: 'opencode-go' } : {}) } },
    }), { accepted: true });
    await hub.request('providers.create', {
      params: {
        providerId: 'opencode',
        displayName: 'Synthetic OpenCode Go',
        kind: 'built_in',
        authType: 'api_key',
        isEnabled: true,
        isDefault: false,
        sortOrder: 1,
      },
      ...(aliasKey ? {} : { credentials: { apiKey: 'synthetic-opencode-go-proof' } }),
    });
    if (aliasKey) {
      const registry = getProviderRegistry();
      registry.unregister('opencode');
      registry.register(new OpencodeProvider({ OPENCODE_GO_API_KEY: 'synthetic-opencode-go-proof' }));
    }
  }
  const providerId = go ? 'opencode' : 'deepseek';
  const harness = go ? 'oxap-opencode-dsh' : 'oxap-deepseek';
  if (go) {
    const missing = join(run, 'missing-dsh');
    const rejected = [];
    for (const [executable, reason] of [
      [missing, `DeepSeek harness path "${missing}" must point to an executable file.`],
      [process.execPath, `"${process.execPath}" did not respond as the DeepSeek harness. Enter the path to dsh.`],
    ]) {
      const outcome = await hub.request('operation.invoke', {
        name: 'oxap.settings.save',
        input: { providerId, harness, settings: { executable } },
      });
      rejected.push((outcome as { accepted: boolean }).accepted);
      assert.deepEqual(outcome, { accepted: false, reason });
    }
    evidence.invalidExecutableAccepted = rejected;
    assert.equal(JSON.parse(app.db.providers.getProviderByProviderId(providerId)?.configJson ?? '{}').harnessSettings, undefined);
  }
  if (mode === 'routed-web') {
    await runBrowser(hub, 'oxap-deepseek-routing-web.mjs', peer);
    evidence.settingsSavedInBrowser = true;
  } else {
    const saved = await hub.request('operation.invoke', {
      name: 'oxap.settings.save',
      input: {
        providerId,
        harness,
        settings: { executable: peer, ...(routed ? { model_provider: route } : {}) },
      },
    });
    evidence.harnessSave = saved;
    if (unknownRoute) {
      assert.deepEqual(saved, { accepted: false, reason: 'DeepSeek model provider must be opencode-go or opencode-zen' });
      assert.deepEqual(releaseRequests, []);
      Object.assign(evidence, { refused: 1, pass: true });
      console.log(JSON.stringify(evidence));
      return;
    }
    assert.deepEqual(saved, { accepted: true });
  }
  assert.deepEqual(releaseRequests, ['SHA256SUMS.txt', `${version}.tar.gz`]);
  if (routed) {
    const { models } = await hub.request<{ models: { id: string; provider: string; available: boolean }[] }>('models.list', { useCache: true });
    assert(models.some(({ id, provider, available }) => id === 'deepseek-v4-pro' && provider === 'deepseek' && available), 'The new chat model picker needs an available DeepSeek V4 Pro');
  }
  if (go) {
    assert.deepEqual(await hub.request('operation.invoke', {
      name: 'oxap.settings.save',
      input: { providerId, harness: 'sdk' },
    }), { accepted: true });
    const { providers } = await hub.request<{
      providers: { providerId: string; readyHarnesses?: string[] }[];
    }>('providers.list', { forNewSession: true });
    assert.deepEqual(providers.find((provider) => provider.providerId === providerId)?.readyHarnesses, [harness]);
  }
  const flash = ['flash', 'image', 'flash-web', 'flash-recovery', 'locked-recovery', 'refused-reopen'].includes(mode);
  const imageWeb = mode === 'flash-web' || mode === 'pro-web';
  const locked = mode === 'locked-recovery';
  const refusesReopen = mode === 'refused-reopen';
  if (locked || mode === 'flash-recovery') writeFileSync(join(workspace, 'verify-native-lease'), '');
  const withImage = mode === 'image' || mode === 'flash-web';
  const model = go ? 'deepseek-v4.1-flash' : flash ? 'deepseek-v4-flash' : 'deepseek-v4-pro';
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4NEAAAAASUVORK5CYII=';
  const create = () => hub.request<{ sessionId: string }>('session.create', {
    workspacePath: workspace,
    title: 'Synthetic DeepSeek first message',
    ...(go ? { harness } : {}),
    config: { provider: providerId, model },
  });
  if (missingRouteKey) {
    const { providers } = await hub.request<{ providers: { providerId: string; readyHarnesses: string[] }[] }>('providers.list', { forNewSession: true });
    const deepseek = providers.find(({ providerId }) => providerId === 'deepseek');
    assert(deepseek);
    evidence.readyHarnesses = deepseek.readyHarnesses;
    await assert.rejects(create(), /OPENCODE_API_KEY/, 'Session creation must refuse the missing OpenCode key');
    assert.deepEqual(deepseek.readyHarnesses, []);
    Object.assign(evidence, { refused: 1, pass: true });
    console.log(JSON.stringify(evidence));
    return;
  }
  const { sessionId } = await create();
  if (mode === 'first-open-retry') {
    assert(!app.db.getSession(sessionId)?.sdkSessionId);
    await app.db.saveUserMessage(sessionId, {
      type: 'user',
      uuid: crypto.randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Synthetic failed first send' },
    }, 'failed');
  }
  const errors: string[] = [];
  app.internalEventBus.subscribe('session.errorObserved', ({ details }) => {
    const error = details as { userMessage?: string } | undefined;
    if (error?.userMessage) errors.push(error.userMessage);
  }, { subscriberName: 'oxap-deepseek-first-message-proof' });
  evidence.errors = errors;
  type ChatRow = {
    id: string;
    uuid?: string;
    type: string;
    is_error?: boolean;
    deliveryStatus?: string;
    message?: { content?: { type: string; text?: string }[] };
  };
  const rows = new Map<string, ChatRow>();
  hub.onEvent('liveQuery.delta', (event) => {
    const delta = event as LiveQueryDeltaEvent;
    if (delta.subscriptionId !== 'deepseek-chat') return;
    for (const row of [...(delta.added ?? []), ...(delta.updated ?? [])] as ChatRow[]) {
      rows.set(row.id, row);
    }
  });
  await hub.request('liveQuery.subscribe', {
    queryName: 'messages.bySession',
    params: [sessionId, 50],
    subscriptionId: 'deepseek-chat',
  });
  if (imageWeb) {
    await runBrowser(hub, 'oxap-deepseek-images-web.mjs', sessionId, mode, png);
  } else {
    await hub.request('message.send', {
      sessionId,
      content: flash || go ? 'Verify model and images' : 'Synthetic DeepSeek prompt',
      ...(withImage ? { images: [{ data: png, media_type: 'image/png' }] } : {}),
    });
  }
  const client = await app.oxapEngine.getHub(() => readHubOptions(app.oxapSettings));
  const deadline = Date.now() + 20_000;
  while (![...rows.values()].some((row) => row.type === 'result')) {
    assert.deepEqual(errors, [], 'The first message failed');
    assert(Date.now() < deadline, 'The first message did not finish');
    await new Promise((done) => setTimeout(done, 25));
  }
  const status = await client.request('work.status', { session_id: sessionId });
  if (routed) {
    const document = readFileSync(join(run, 'data/oap/oap-serve.json'), 'utf8');
    const entry = JSON.parse(document).adapters.deepseek;
    assert.equal(entry.model_provider, route);
    assert(entry.environment.includes('DSH_HOME'));
    assert(!entry.environment.includes('OPENCODE_API_KEY'));
    assert(!entry.environment.includes('DEEPSEEK_API_KEY'));
    assert(!document.includes('synthetic-route-proof'));
    assert(!document.includes('synthetic-deepseek-proof'));
    evidence.routedProvider = entry.model_provider;
  }
  if (unkeyedRoute) {
    const document = JSON.parse(readFileSync(join(run, 'data/oap/oap-serve.json'), 'utf8'));
    assert.equal(document.adapters.deepseek, undefined);
    assert.equal(document.adapters.opencode.provider, 'opencode-go');
    evidence.unkeyedRouteOmitted = true;
  }
  const nativeId = app.db.getSession(sessionId)?.sdkSessionId;
  assert(nativeId);
  assert.equal((status as { link?: string }).link, `deepseek://sessions/${nativeId}`);
  const capabilities = (await client.request('capabilities', { adapter: providerId })) as {
    payload?: { features?: Record<string, { level?: string }> };
  };
  const modelSwitch = capabilities.payload?.features?.['session.model.switch']?.level;
  assert.equal(modelSwitch, 'emulated');
  assert.deepEqual(errors, []);
  assert.deepEqual(
    [...rows.values()].filter((row) => row.type === 'result').map((row) => row.is_error),
    [false]
  );
  const replies = [...rows.values()].filter((row) => row.type === 'assistant');
  const replyText = replies.flatMap((row) => (row.message?.content ?? []).map((block) => block.text));
  evidence.reply = replyText;
  assert.deepEqual(
    replyText,
    flash || go
      ? [JSON.stringify({ model, images: withImage ? [{ type: 'image', data: png, mimeType: 'image/png' }] : [] })]
      : mode === 'first-open-retry'
        ? [
            'The previous OXAP DeepSeek thread cannot be resumed. A new thread will start without earlier conversation.',
            'Synthetic DeepSeek reply',
          ]
        : ['Synthetic DeepSeek reply']
  );
  if (mode === 'no-replay') {
    const snapshot = () => app.db.getDatabase().prepare(
      `SELECT seq, timestamp, consumed_seq AS consumedSeq FROM sdk_messages
       WHERE session_id = ? AND message_type = 'user' AND send_status = 'consumed'
       ORDER BY seq`
    ).all(sessionId);
    const before = snapshot();
    assert.equal(before.length, 1);
    await Bun.sleep(3500);
    const nativePrompts = readFileSync(nativePromptCount, 'utf8').length;
    evidence.nativePrompts = nativePrompts;
    assert.equal(nativePrompts, 1);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(errors, []);
  }
  if (flash) {
    const switching = await hub.request<{ success: boolean; error: string }>('session.model.switch', {
      sessionId, provider: 'deepseek', model: 'deepseek-v4-pro',
    });
    assert.equal(switching.success, false);
    assert.match(switching.error, /fixed model/);
    await assert.rejects(
      hub.request('session.update', { sessionId, config: { model: 'deepseek-v4-pro' } }),
      /fixed model/
    );
    evidence.existingSwitchRefused = true;
  }
  if (go || ['recovery', 'pending', 'flash-recovery', 'sdk-default', 'locked-recovery', 'refused-reopen'].includes(mode)) {
    while (app.sessionManager.getCachedSession(sessionId)?.queryPromise) {
      assert(Date.now() < deadline, 'The first query did not finish shutting down');
      await Bun.sleep(25);
    }
    const pending = mode === 'pending';
    const original = app.db.getSession(sessionId)!;
    if (pending) {
      await app.sessionManager.updateSession(sessionId, {
        metadata: {
          ...original.metadata,
          oapRecovery: { previous: nativeId, text: '', pendingOpen: true },
        },
      });
    }
    if (locked || refusesReopen) {
      if (refusesReopen) writeFileSync(join(workspace, 'verify-refuse-reopen'), '');
      await transport.close();
      await app.cleanup();
      app = await boot();
      transport = connect();
      hub = new MessageHub({ defaultSessionId: 'global' });
      hub.registerTransport(transport);
      await transport.initialize();
      const sender = 'neo:10000000-0000-4000-8000-000000008837';
      await app.db.createSession({
        id: sender,
        title: 'Synthetic sender',
        workspacePath: workspace,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: { queryMode: 'manual' },
        metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
      });
      const registry = app.sessionManager.getOperationRegistry();
      const caller = { role: 'neo', source: 'internal', sessionId: sender } as const;
      const ref = { adapter: 'hyperneo', id: sessionId };
      const sent = await invokeOperation(registry, 'work.send', {
        ref, notice: true, message: 'Synthetic worker follow-up after restart',
      }, caller);
      assert(sent.kind === 'completed');
      assert.match(JSON.stringify(sent.value), /"delivered":false/);
      const reason = locked
        ? 'unsupported input: session.open.reopen (unsatisfiable)'
        : 'the adapter does not advertise a feature the request elected';
      const end = Date.now() + 10000;
      const senderMessages = () => app.db.getSDKMessagesByType(sender, 'user');
      while (!JSON.stringify(senderMessages()).includes(reason) && Date.now() < end) await Bun.sleep(25);
      const status = await invokeOperation(registry, 'work.status', { ref }, caller);
      Object.assign(evidence, {
        nativeIdPreserved: app.db.getSession(sessionId)?.sdkSessionId === nativeId,
        failedInputs: app.db.getUserMessagesByStatus(sessionId, 'failed', 50).total,
        chatReason: JSON.stringify(app.db.getSDKMessages(sessionId, 50).messages).includes(reason),
        senderReason: JSON.stringify(senderMessages()).includes(reason),
        statusFailedWithReason: JSON.stringify(status).includes('"status":"failed"') && JSON.stringify(status).includes(reason),
        lockRefusal: locked && await Bun.file(join(workspace, 'verify-native-lease-refused')).exists(),
      });
      assert.equal(evidence.lockRefusal, locked, 'The recovered runtime must hold the original native lease');
      assert.equal(evidence.nativeIdPreserved, true);
      assert.equal(evidence.failedInputs, 1);
      assert.equal(evidence.senderReason, true, 'The originating sender should get the refusal reason');
      assert.equal(evidence.chatReason, true, 'The worker chat should show the refusal reason');
      assert.equal(evidence.statusFailedWithReason, true, 'Work status should expose the refusal');
    } else {
      if (mode === 'sdk-default' || go) {
        assert.deepEqual(await hub.request('operation.invoke', {
          name: 'oxap.settings.save',
          input: go ? { providerId, harness, settings: { executable: peer } } : { providerId, harness: 'sdk' },
        }), { accepted: true });
      } else {
        await app.oxapEngine.restart();
      }
      const verifyModel = mode === 'flash-recovery' || go;
      const expectedReply = verifyModel
        ? JSON.stringify({ model, images: [], reopened: true })
        : 'Synthetic DeepSeek reply after restart';
      const { messageId } = await hub.request<{ messageId: string }>('message.send', {
        sessionId,
        content: verifyModel ? 'Verify model after hub restart' : 'Message after hub restart',
      });
      const retryDeadline = Date.now() + 20_000;
      const deliveryStatus = () =>
        [...rows.values()].find((row) => row.uuid === messageId)?.deliveryStatus;
      const replyLines = () => [...rows.values()]
        .filter((row) => row.type === 'assistant')
        .flatMap((row) => (row.message?.content ?? []).map((block) => block.text));
      while (!replyLines().includes(expectedReply) || deliveryStatus() !== 'delivered') {
        assert.deepEqual(errors, [], 'The message after restart failed');
        assert(Date.now() < retryDeadline, `Restart delivery state: ${deliveryStatus()}, replies: ${replyLines()}`);
        await Bun.sleep(25);
      }
      const saved = app.db.getSession(sessionId)!;
      const reopenedClient = await app.oxapEngine.getHub(() => readHubOptions(app.oxapSettings));
      const state = await reopenedClient.request('state', { session_id: sessionId }) as {
        payload?: { current_model_id?: string };
      };
      assert.equal(state.payload?.current_model_id, model);
      evidence.reopenedModel = state.payload?.current_model_id;
      if (verifyModel) evidence.reopenedReply = expectedReply;
      assert(saved.sdkSessionId);
      assert.equal(saved.sdkSessionId === nativeId, !pending);
      assert.equal(replyLines().filter((line) => line?.includes('new thread')).length, pending ? 1 : 0);
      Object.assign(evidence, { resumedSameThread: !pending, deliveryStatus: deliveryStatus(), restartReplies: 1 });
    }
  }

  if (go) {
    evidence.endpoint = 'https://opencode.ai/zen/go/v1';
    evidence.openCodeKeyIsolated = true;
  }
  Object.assign(evidence, { opened: 1, firstMessageReplies: replies.length, modelSwitch, pass: true });
  console.log(JSON.stringify(evidence));
}
try {
  await verify();
} finally {
  await transport.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/deepseek-first-message.json'), JSON.stringify(evidence, null, 2));
}
