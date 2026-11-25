import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { checkOxapBinary } from '../../../packages/daemon/src/lib/oxap/oxap-binary.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { readHubOptions } from '../../../packages/daemon/src/lib/oxap/oxap-settings.ts';
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
assert(['first', 'recovery', 'pending', 'flash', 'image', 'flash-web', 'pro-web', 'flash-recovery', 'sdk-default', 'locked-recovery', 'refused-reopen', 'first-open-retry', 'no-replay'].includes(mode));
const run = resolve(runArgument);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.deepEqual(await checkOxapBinary(binary, { version, sha256 }), { ok: true });
const workspace = join(run, 'workspace');
const peer = join(run, 'dsh');
mkdirSync(workspace);
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
const connect = () => new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket: createLocalSocket,
});
let transport = connect();
const evidence: Record<string, unknown> = { version, sha256, mode };
try {
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
    credentials: { apiKey: 'synthetic-deepseek-proof' },
  });
  const saved = await hub.request('operation.invoke', {
    name: 'oxap.settings.save',
    input: { providerId: 'deepseek', harness: 'oxap-deepseek', settings: { executable: peer } },
  });
  evidence.harnessSave = saved;
  assert.deepEqual(saved, { accepted: true });
  assert.deepEqual(releaseRequests, ['SHA256SUMS.txt', `${version}.tar.gz`]);
  const flash = ['flash', 'image', 'flash-web', 'flash-recovery', 'locked-recovery', 'refused-reopen'].includes(mode);
  const web = mode.endsWith('-web');
  const locked = mode === 'locked-recovery';
  const refusesReopen = mode === 'refused-reopen';
  if (locked || mode === 'flash-recovery') writeFileSync(join(workspace, 'verify-native-lease'), '');
  const withImage = mode === 'image' || mode === 'flash-web';
  const model = flash ? 'deepseek-v4-flash' : 'deepseek-v4-pro';
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4NEAAAAASUVORK5CYII=';
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: workspace,
    title: 'Synthetic DeepSeek first message',
    config: { provider: 'deepseek', model },
  });
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
  if (web) {
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
        const file = Bun.file(join(dist, url.pathname.startsWith('/session/') ? 'index.html' : url.pathname));
        return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
      },
      websocket: createWebSocketHandlers(app.transport, app.sessionManager),
    });
    try {
      const pairing = await hub.request<{ ok: boolean; code: string }>('operation.invoke', {
        name: 'device.pair.create', input: { kind: 'human', name: 'Synthetic DeepSeek browser' },
      });
      assert(pairing.ok);
      const browser = Bun.spawn([process.execPath, '.claude/skills/verify/oxap-deepseek-images-web.mjs',
        String(preview.port), pairing.code, sessionId, mode, png, run], { stdout: 'inherit', stderr: 'inherit' });
      assert.equal(await browser.exited, 0, 'The browser journey failed');
    } finally {
      preview.stop(true);
    }
  } else {
    await hub.request('message.send', {
      sessionId,
      content: flash ? 'Verify model and images' : 'Synthetic DeepSeek prompt',
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
  const nativeId = app.db.getSession(sessionId)?.sdkSessionId;
  assert(nativeId);
  assert.equal((status as { link?: string }).link, `deepseek://sessions/${nativeId}`);
  const capabilities = (await client.request('capabilities', { adapter: 'deepseek' })) as {
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
    flash
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
  if (['recovery', 'pending', 'flash-recovery', 'sdk-default', 'locked-recovery', 'refused-reopen'].includes(mode)) {
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
      if (mode === 'sdk-default') {
        assert.deepEqual(await hub.request('operation.invoke', {
          name: 'oxap.settings.save', input: { providerId: 'deepseek', harness: 'sdk' },
        }), { accepted: true });
      } else {
        await app.oxapEngine.restart();
      }
      const verifyModel = mode === 'flash-recovery';
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

  Object.assign(evidence, { opened: 1, firstMessageReplies: replies.length, modelSwitch, pass: true });
  console.log(JSON.stringify(evidence));
} finally {
  await transport.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/deepseek-first-message.json'), JSON.stringify(evidence, null, 2));
}
