import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { clearModelsCache, refreshModels } from '../../../packages/daemon/src/lib/model-service.ts';
import { OxapHubRequestError } from '../../../packages/daemon/src/lib/oxap/oxap-hub-client.ts';
import { readHubOptions } from '../../../packages/daemon/src/lib/oxap/oxap-settings.ts';
import { releaseName } from '../../../packages/daemon/src/lib/oxap/oxap-install.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport, type Session } from '../../../packages/shared/src/mod.ts';
import { answerCodexProbeLocally, oxapCodexProvider } from './oxap-codex-provider.ts';

const [binary, codex, runArg] = process.argv.slice(2);
const run = resolve(runArg);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(binary.startsWith('/') && codex.startsWith('/'));
const version = releaseName();
const versionCall = Bun.spawn([binary, '--version']);
assert.equal((await new Response(versionCall.stdout).text()).trim(), version);
assert.equal(await versionCall.exited, 0);

const workspace = join(run, 'workspace');
const home = join(run, 'home', '.codex');
await Promise.all([mkdir(home, { recursive: true }), mkdir(workspace)]);
const requests: Array<{ model?: string; effort?: string }> = [];
const model = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    assert(request.url.endsWith('/v1/responses'));
    const body = await request.json() as { model?: string; reasoning?: { effort?: string } };
    requests.push({ model: body.model, effort: body.reasoning?.effort });
    const n = requests.length;
    const item = { type: 'message', id: 'msg_' + n, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Synthetic effort received.', annotations: [] }] };
    const response = { id: 'resp_' + n, object: 'response', created_at: 1, status: 'completed',
      model: body.model, output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
    const events = [
      ['response.created', { response: { ...response, status: 'in_progress', output: [] } }],
      ['response.output_item.added', { output_index: 0, item }],
      ['response.output_item.done', { output_index: 0, item }],
      ['response.completed', { response }],
    ].map(([type, data], sequence_number) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number, ...data as object })}\n\n`).join('');
    return new Response(events, { headers: { 'content-type': 'text/event-stream' } });
  },
});
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
try {
  await writeFile(join(home, 'config.toml'), `model = "gpt-6-luna"
model_provider = "fixture"
[model_providers.fixture]
name = "Fixture"
base_url = "http://127.0.0.1:${model.port}/v1"
wire_api = "responses"
requires_openai_auth = false
`);
  const executable = join(run, 'codex-proof');
  await writeFile(executable, `#!${process.execPath}
import { createInterface } from 'node:readline';
const child = Bun.spawn([${JSON.stringify(codex)}, ...process.argv.slice(2)], {
  stdin: 'pipe', stdout: 'inherit', stderr: 'inherit',
});
process.on('SIGTERM', () => child.kill());
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === 'account/read') {
    console.log(JSON.stringify({ id: request.id, result: { account: { type: 'chatgpt' } } }));
  } else {
    child.stdin.write(line + '\\n');
    child.stdin.flush();
  }
}
child.stdin.end();
process.exit(await child.exited);
`, { mode: 0o700 });
  answerCodexProbeLocally();
  app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0,
    dbPath: join(run, 'data/daemon.db'), workspaceRoot: workspace,
  }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`,
    autoReconnect: false, createSocket: createLocalSocket });
  hub.registerTransport(transport);
  await transport.initialize();
  app.settingsManager.updateGlobalSettings({ oxapHub: { path: binary, version,
    sha256: createHash('sha256').update(await readFile(binary)).digest('hex') } });
  await hub.request('providers.create', { ...oxapCodexProvider, params: { ...oxapCodexProvider.params,
    configJson: JSON.stringify({ harness: 'oxap-codex', harnessSettings: { executable } }),
  } });
  await refreshModels();
  const catalog = await hub.request<{ models: Array<{ id: string; codexReasoning?: { levels: string[] } }> }>('models.list', {});
  const luna = 'gpt-6-luna';
  const sol = 'gpt-6.2-sol';
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  const published = Object.fromEntries([luna, sol].map(id =>
    [id, catalog.models.find(entry => entry.id === id)?.codexReasoning?.levels]
  ));
  assert.deepEqual(published[luna], levels);
  assert.deepEqual(published[sol], [...levels, 'ultra']);
  const create = (model: string, title: string, thinkingLevel: string) =>
    hub.request<{ sessionId: string }>('session.create', {
      title, workspacePath: workspace, config: { model, provider: 'anthropic-codex', thinkingLevel },
    });
  await assert.rejects(create(luna, 'Luna ultra refusal', 'think64k'), /does not publish support/);
  await assert.rejects(create(sol, 'Sol ultra refusal', 'think64k'), /OXAP.*cannot send ultra/);
  const { sessionId } = await create(luna, 'GPT-6 Luna', 'think24k');
  const { sessionId: solSessionId } = await create(sol, 'GPT-6.2 Sol', 'think48k');
  const session = async () => (await hub.request<{ session: Session }>('session.get', { sessionId })).session;
  const change = (level: string) => hub.request('session.thinking.set', { sessionId, level });
  const turn = async (effort: string) => {
    const index = requests.length;
    await hub.request('message.send', { sessionId, content: `Verify effort ${effort}` });
    const deadline = Date.now() + 15000;
    while (!requests[index] || app!.sessionManager.getSession(sessionId)?.getProcessingState().status !== 'idle') {
      assert(Date.now() < deadline, `Turn did not settle. Observed ${JSON.stringify(requests)}`);
      await Bun.sleep(30);
    }
    assert.deepEqual(requests[index], { model: luna, effort });
  };
  await turn('high');
  const thread = (await session()).sdkSessionId;
  assert(thread);
  await assert.rejects(change('think64k'), /does not publish support/);
  assert.equal((await session()).config.thinkingLevel, 'think24k');
  const daemon = app;
  const wire = await daemon.oxapEngine.getHub(() => readHubOptions(daemon.oxapSettings));
  const nativeRequest = wire.request.bind(wire);
  const verifyLostReceipt = async (update: () => Promise<unknown>) => {
    let failApply = true;
    wire.request = async (operation, parameters) => {
      if (operation === 'settings' && failApply) {
        failApply = false;
        await nativeRequest(operation, parameters);
        throw new OxapHubRequestError('timeout', 'Synthetic lost settings acknowledgment');
      }
      return nativeRequest(operation, parameters);
    };
    try {
      await assert.rejects(update);
      const saved = (await session()).config;
      assert.equal(saved.model, luna);
      assert.equal(saved.thinkingLevel, 'think24k');
      await turn('high');
      assert.equal((await session()).sdkSessionId, thread);
      assert.equal(failApply, false);
    } finally {
      wire.request = nativeRequest;
    }
  };
  await verifyLostReceipt(() => change('think48k'));
  await hub.request('session.resetQuery', { sessionId, restartQuery: false });
  await verifyLostReceipt(() => hub.request('operation.invoke', {
    name: 'session.runtimeSettings.update',
    input: { sessionId, model: sol, thinkingLevel: 'think48k' },
  }));

  const reasoningRequest = (type: string, id: string, reasoning_level = 'ultra') => ({
    protocol: 'open-agent-protocol',
    version: '0.1',
    profile: 'open-agent-protocol.agent-control-core',
    type,
    id: crypto.randomUUID(),
    ...(type === 'session.open.request' ? {} : { session_id: id }),
    payload: { session_id: id, reasoning_level },
  });
  await assert.rejects(wire.request('open', {
    adapter: 'anthropic-codex',
    directory: workspace,
    request: reasoningRequest('session.open.request', 'unsupported-ultra-probe'),
  }), { code: 'schema_invalid' });
  await assert.rejects(wire.request('settings', {
    session_id: sessionId,
    request: reasoningRequest('session.settings.update.request', sessionId),
  }), { code: 'schema_invalid' });
  const off = await wire.request('settings', {
    session_id: sessionId,
    request: reasoningRequest('session.settings.update.request', sessionId, 'off'),
  }) as { payload?: { reasoning_level?: string } };
  assert.equal(off.payload?.reasoning_level, 'off');
  for (const [level, effort] of [['think8k', 'low'], ['think16k', 'medium'], ['think32k', 'xhigh']]) {
    assert.deepEqual(await change(level), { success: true, thinkingLevel: level });
    await turn(effort);
  }
  const evidenceDir = join(run, 'evidence');
  await mkdir(evidenceDir);
  if (process.env.VERIFY_BROWSER) {
    const dist = resolve('packages/web/dist');
    const preview = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request, server) {
        const refusal = await daemon.guardRequest(request);
        if (refusal) return refusal;
        const url = new URL(request.url);
        if (url.pathname === '/pair' && request.method === 'POST') return daemon.handlePair(request);
        if (url.pathname === '/ws') {
          const device = await daemon.authenticateUpgrade(request, '127.0.0.1');
          if (server.upgrade(request, { data: { connectionSessionId: 'global', device } })) return;
          return new Response('Upgrade failed', { status: 500 });
        }
        const file = Bun.file(join(dist, url.pathname.startsWith('/session/') ? 'index.html' : url.pathname));
        return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
      },
      websocket: createWebSocketHandlers(daemon.transport, daemon.sessionManager),
    });
    try {
      const pairing = await hub.request<{ ok: boolean; code: string }>('operation.invoke', {
        name: 'device.pair.create', input: { kind: 'human', name: 'Codex picker proof' },
      });
      assert(pairing.ok);
      const browser = Bun.spawn(['node', '.claude/skills/verify/oxap-codex-thinking-web.mjs',
        String(preview.port), pairing.code, sessionId, solSessionId, evidenceDir], {
        stdout: 'inherit', stderr: 'inherit',
      });
      assert.equal(await browser.exited, 0, 'The browser journey failed');
    } finally {
      await preview.stop(true);
    }
  } else {
    assert.deepEqual(await change('think48k'), { success: true, thinkingLevel: 'think48k' });
  }
  await turn('max');
  assert.equal((await session()).config.thinkingLevel, 'think48k');
  await hub.request('session.resetQuery', { sessionId, restartQuery: false });
  await app.oxapEngine.restart();
  clearModelsCache();
  await turn('max');
  assert.equal((await session()).sdkSessionId, thread);
  assert.equal(requests.length, 8);
  const evidence = { version, published, requests, sameThreadAfterReopen: true, ultraOpen: 'schema_invalid', ultraLive: 'schema_invalid', acceptedOffWireLevel: off.payload.reasoning_level, recoveredLostSettingsAck: true };
  await writeFile(join(run, 'evidence', 'thinking.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await transport?.close();
  await app?.cleanup();
  await model.stop(true);
}
