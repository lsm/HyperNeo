import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { checkOxapBinary } from '../../../packages/daemon/src/lib/oxap/oxap-binary.ts';
import { readHubOptions } from '../../../packages/daemon/src/lib/oxap/oxap-settings.ts';
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
assert(['first', 'recovery', 'pending', 'flash', 'image'].includes(mode));
const run = resolve(runArgument);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.deepEqual(await checkOxapBinary(binary, { version, sha256 }), { ok: true });
const workspace = join(run, 'workspace');
const peer = join(run, 'dsh');
mkdirSync(workspace);
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
const app = await createDaemonApp({
  config: { ...config, disableWorktrees: true, disableGoalProcessing: true },
  verbose: false,
});
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket: createLocalSocket,
});
const evidence: Record<string, unknown> = { version, sha256, mode };
try {
  const hub = new MessageHub({ defaultSessionId: 'global' });
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
  });
  const saved = await hub.request('operation.invoke', {
    name: 'oxap.settings.save',
    input: { providerId: 'deepseek', harness: 'oxap-deepseek', settings: { executable: peer } },
  });
  evidence.harnessSave = saved;
  assert.deepEqual(saved, { accepted: true });
  assert.deepEqual(releaseRequests, ['SHA256SUMS.txt', `${version}.tar.gz`]);
  const flash = mode === 'flash' || mode === 'image';
  const model = flash ? 'deepseek-v4-flash' : 'deepseek-v4-pro';
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4NEAAAAASUVORK5CYII=';
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: workspace,
    title: 'Synthetic DeepSeek first message',
    config: { provider: 'deepseek', model },
  });
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
  await hub.request('message.send', {
    sessionId,
    content: flash ? 'Verify model and images' : 'Synthetic DeepSeek prompt',
    ...(mode === 'image' ? { images: [{ data: png, media_type: 'image/png' }] } : {}),
  });
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
      ? [JSON.stringify({ model, images: mode === 'image' ? [{ type: 'image', data: png, mimeType: 'image/png' }] : [] })]
      : ['Synthetic DeepSeek reply']
  );
  if (mode === 'recovery' || mode === 'pending') {
    while (app.sessionManager.getCachedSession(sessionId)?.queryPromise) {
      assert(Date.now() < deadline, 'The first query did not finish shutting down');
      await Bun.sleep(25);
    }
    const original = app.db.getSession(sessionId)!;
    const excerpt = 'Saved conversation excerpt';
    if (mode === 'pending') {
      await app.sessionManager.updateSession(sessionId, {
        metadata: {
          ...original.metadata,
          oapRecovery: { previous: sessionId, text: excerpt, pendingOpen: true },
        },
      });
    }
    await app.oxapEngine.restart();
    const { messageId } = await hub.request<{ messageId: string }>('message.send', {
      sessionId,
      content: 'Message after hub restart',
    });
    const retryDeadline = Date.now() + 20_000;
    const job = () =>
      app.jobQueue
        .listJobs({ queue: 'message_delivery', limit: 20 })
        .find((entry) => entry.payload.messageUuid === messageId);
    const deliveryStatus = () =>
      [...rows.values()].find((row) => row.uuid === messageId)?.deliveryStatus;
    while (errors.length === 0 || (!job()?.retryCount && deliveryStatus() !== 'failed')) {
      if (Date.now() >= retryDeadline) {
        Object.assign(evidence, {
          deliveryStatus: deliveryStatus(),
          deliveryJob: { status: job()?.status, retryCount: job()?.retryCount, error: job()?.error },
          storedSendStatus: app.db.getSDKMessageRepo().getDeliveryContent(sessionId, messageId)
            ?.sendStatus,
        });
        assert.fail('The failed delivery did not settle');
      }
      await Bun.sleep(25);
    }
    const saved = app.db.getSession(sessionId)!;
    const notices = (app.db.getSDKMessages(sessionId, 50).messages as ChatRow[])
      .filter((row) => row.type === 'assistant')
      .flatMap((row) => (row.message?.content ?? []).map((block) => block.text))
      .filter((line) => line?.includes('new thread'));
    Object.assign(evidence, {
      deliveryStatus: deliveryStatus(),
      deliveryJob: { status: job()?.status, retryCount: job()?.retryCount },
      notices,
      pendingOpen: saved.metadata.oapRecovery?.pendingOpen,
      recoveryFailure: saved.metadata.oapRecovery?.failure,
      previousThreadPreserved: saved.sdkSessionId === original.sdkSessionId,
      excerptPreserved: mode !== 'pending' || saved.metadata.oapRecovery?.text === excerpt,
    });
    assert.deepEqual(errors, ['OXAP DeepSeek opened the previous thread again. Start a new chat.']);
    assert.equal(deliveryStatus(), 'failed');
    assert.equal(job()?.status, 'dead');
    assert.equal(job()?.retryCount, 0);
    assert.deepEqual(notices, []);
    assert.equal(saved.metadata.oapRecovery?.pendingOpen, false);
    assert.equal(saved.metadata.oapRecovery?.failure, 'same_native_thread');
    assert.equal(saved.sdkSessionId, original.sdkSessionId);
    if (mode === 'pending') assert.equal(saved.metadata.oapRecovery?.text, excerpt);
  }
  Object.assign(evidence, { opened: 1, firstMessageReplies: replies.length, modelSwitch, pass: true });
  console.log(JSON.stringify(evidence));
} finally {
  await transport.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/deepseek-first-message.json'), JSON.stringify(evidence, null, 2));
}
