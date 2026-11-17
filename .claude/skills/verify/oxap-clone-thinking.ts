import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { answerCodexProbeLocally, OXAP_CODEX_MODEL, oxapCodexProvider } from './oxap-codex-provider.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'workspace'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
try {
  answerCodexProbeLocally();
  app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false, createSocket: createLocalSocket });
  hub.registerTransport(transport);
  await transport.initialize();
  await hub.request('providers.create', oxapCodexProvider);
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'workspace'), title: 'Synthetic Codex', config: { model: OXAP_CODEX_MODEL, provider: 'anthropic-codex' } });
  assert.equal(app.db.getSession(sessionId)?.config.harness, 'oxap-codex');
  const off = await hub.request('session.create', { workspacePath: join(run, 'workspace'), title: 'Off', config: { model: OXAP_CODEX_MODEL, provider: 'anthropic-codex', thinkingLevel: 'off' } });
  assert.ok(off);
  const clone = await hub.request<{ accepted: boolean }>('operation.invoke', { name: 'session.clone.spawn', input: { parentSessionId: sessionId } });
  assert.equal(clone.accepted, true);
  const before = app.db.listSessions().length;
  const result = await hub.request('operation.invoke', { name: 'session.clone.spawn', input: { parentSessionId: sessionId, thinkingLevel: 'think16k' } }).catch((error: Error) => ({ thrown: error.message }));
  const after = app.db.listSessions().length;
  const evidence = { result, before, after };
  writeFileSync(join(run, 'evidence/result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  assert.deepEqual(result, { accepted: false, reason: 'harness_unsupported', message: 'OXAP Codex does not take a thinking level.' });
  assert.equal(after, before);
} finally {
  await transport?.close();
  await app?.cleanup();
}
