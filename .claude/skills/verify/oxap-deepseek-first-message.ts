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

const [binary, version, sha256, runArgument] = process.argv.slice(2);
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
const evidence: Record<string, unknown> = { version, sha256 };
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
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: workspace,
    title: 'Synthetic DeepSeek first message',
    config: { provider: 'deepseek', model: 'deepseek-v4-pro' },
  });
  const errors: string[] = [];
  app.internalEventBus.subscribe('session.errorObserved', ({ details }) => {
    const error = details as { userMessage?: string } | undefined;
    if (error?.userMessage) errors.push(error.userMessage);
  }, { subscriberName: 'oxap-deepseek-first-message-proof' });
  evidence.errors = errors;
  type ChatRow = {
    id: string;
    type: string;
    is_error?: boolean;
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
  await hub.request('message.send', { sessionId, content: 'Synthetic DeepSeek prompt' });
  const client = await app.oxapEngine.getHub(() => readHubOptions(app.oxapSettings));
  const deadline = Date.now() + 20_000;
  while (![...rows.values()].some((row) => row.type === 'result')) {
    assert.deepEqual(errors, [], 'The first message failed');
    assert(Date.now() < deadline, 'The first message did not finish');
    await new Promise((done) => setTimeout(done, 25));
  }
  const status = await client.request('work.status', { session_id: sessionId });
  assert.equal((status as { link?: string }).link, `deepseek://sessions/${sessionId}`);
  assert.equal(app.db.getSession(sessionId)?.sdkSessionId, sessionId);
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
  assert.deepEqual(
    replies.flatMap((row) => (row.message?.content ?? []).map((block) => block.text)),
    ['Synthetic DeepSeek reply']
  );
  Object.assign(evidence, { opened: 1, firstMessageReplies: replies.length, modelSwitch, pass: true });
  console.log(JSON.stringify(evidence));
} finally {
  await transport.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/deepseek-first-message.json'), JSON.stringify(evidence, null, 2));
}
