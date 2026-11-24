import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { refreshModels } from '../../../packages/daemon/src/lib/model-service.ts';
import { releaseName } from '../../../packages/daemon/src/lib/oxap/oxap-install.ts';
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
  await writeFile(join(home, 'config.toml'), `model = "gpt-5.5"
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
  const published = catalog.models.find(entry => entry.id === 'gpt-5.5')?.codexReasoning?.levels;
  assert(published?.includes('low') && published.includes('high'), JSON.stringify(catalog.models));
  const config = { model: 'gpt-5.5', provider: 'anthropic-codex', thinkingLevel: 'think24k' };
  const create = (thinkingLevel: string) => hub.request<{ sessionId: string }>('session.create', {
    title: 'Synthetic thinking proof', workspacePath: workspace, config: { ...config, thinkingLevel },
  });
  await assert.rejects(create('think64k'), /does not publish support/);
  const { sessionId } = await create(config.thinkingLevel);
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
    assert.deepEqual(requests[index], { model: config.model, effort });
  };
  await turn('high');
  const thread = (await session()).sdkSessionId;
  assert(thread);
  await assert.rejects(change('think64k'), /does not publish support/);
  assert.equal((await session()).config.thinkingLevel, 'think24k');
  assert.deepEqual(await change('think8k'), { success: true, thinkingLevel: 'think8k' });
  await turn('low');
  assert.equal((await session()).config.thinkingLevel, 'think8k');
  await hub.request('session.resetQuery', { sessionId, restartQuery: false });
  await app.oxapEngine.restart();
  await turn('low');
  assert.equal((await session()).sdkSessionId, thread);
  assert.equal(requests.length, 3);
  const evidence = { version, published, requests, sameThreadAfterReopen: true, unsupportedRefused: true };
  await mkdir(join(run, 'evidence'));
  await writeFile(join(run, 'evidence', 'thinking.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await transport?.close();
  await app?.cleanup();
  await model.stop(true);
}
