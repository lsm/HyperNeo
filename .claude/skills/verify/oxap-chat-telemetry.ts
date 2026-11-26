import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket, readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { OXAP_CODEX_MODEL, oxapCodexProvider, serveLocalRelease } from './oxap-codex-provider.ts';
import { verifyHubLossToast } from './oxap-hub-loss-toast.ts';

const [oxap, version, codex, codexHome] = process.argv.slice(2);
const run = process.argv.at(-1)!;
const hubLoss = process.argv[6] === 'hub-loss';
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const workspace = join(run, 'workspace');
const evidence = join(run, 'evidence');
const codexEntrypoint = join(run, 'bin/codex');
mkdirSync(workspace);
mkdirSync(evidence);
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
chmodSync(join(run, 'bin/gh'), 0o700);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
writeFileSync(codexEntrypoint, `#!/bin/sh
unset CODEX_HOME
${hubLoss ? `printf '%s\\n' ${quote('Disposable Codex diagnostic line. '.repeat(220))} >&2` : ''}
HOME=${quote(codexHome)} exec ${quote(codex)} "$@"
`, { mode: 0o700 });
serveLocalRelease(oxap, version, join(run, 'release'));
const app = await createDaemonApp({
  config: {
    ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: workspace }),
    disableWorktrees: true,
  },
  verbose: false,
});
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket: createLocalSocket,
});
const root = resolve('packages/web/dist');
const web = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  websocket: createWebSocketHandlers(app.transport, app.sessionManager),
  async fetch(req, server) {
    const refused = await app.guardRequest(req);
    if (refused) return refused;
    const path = new URL(req.url).pathname;
    if (path === '/ws') {
      const device = await app.authenticateUpgrade(req, server.requestIP(req)?.address ?? null);
      if (!device) return new Response('Device pairing required', { status: 401 });
      return server.upgrade(req, { data: { connectionSessionId: 'global', device } })
        ? undefined
        : new Response('Upgrade failed', { status: 500 });
    }
    const file = resolve(root, `.${path}`);
    if (file.startsWith(`${root}/`) && await Bun.file(file).exists()) return new Response(Bun.file(file));
    return new Response(Bun.file(join(root, 'index.html')));
  },
});
async function verify() {
  assert(![8399, 8499].includes(app.server.port));
  assert(![8399, 8499].includes(web.port));
  const hub = new MessageHub({ defaultSessionId: 'global' });
  hub.registerTransport(transport);
  await transport.initialize();
  await hub.request('providers.create', {
    params: { ...oxapCodexProvider.params, displayName: 'Codex' },
  });
  const saved = await hub.request('operation.invoke', {
    name: 'oxap.settings.save',
    input: {
      providerId: 'anthropic-codex',
      harness: 'oxap-codex',
      settings: { executable: codexEntrypoint },
    },
  });
  assert.deepEqual(saved, { accepted: true });
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: workspace,
    title: 'Codex chat telemetry',
    harness: 'oxap-codex',
    config: {
      provider: 'anthropic-codex',
      model: OXAP_CODEX_MODEL,
      chatDisplayMode: 'full',
    },
  });
  if (hubLoss) {
    await verifyHubLossToast({ port: web.port, sessionId, run });
    return;
  }
  const rows = () => app.db.getSDKMessages(sessionId, 100).messages;
  const prompt = 'Reply with exactly OXAP-TELEMETRY-OK. Do not use any tools.';
  const errors: string[] = [];
  app.internalEventBus.subscribe('session.errorObserved', ({ sessionId: id, details }) => {
    const error = details as { userMessage?: string } | undefined;
    if (id === sessionId && error?.userMessage) errors.push(error.userMessage);
  }, { subscriberName: 'oxap-chat-telemetry-proof' });
  const runTurn = async (expectedResults: number) => {
    const sent = await hub.request('message.send', { sessionId, content: prompt });
    assert(sent);
    const deadline = Date.now() + 90_000;
    while (rows().filter((row) => row.type === 'result').length < expectedResults) {
      assert.deepEqual(errors, []);
      assert(Date.now() < deadline, 'Codex run did not settle');
      await Bun.sleep(100);
    }
  };
  await runTurn(1);
  const inits = rows().filter((row) => row.type === 'system' && row.subtype === 'init');
  const assistants = rows().filter((row) => row.type === 'assistant');
  const results = rows().filter((row) => row.type === 'result');
  const observed = {
    oxap: version,
    binarySha256: createHash('sha256').update(readFileSync(oxap)).digest('hex'),
    inits: inits.map((init) => init.model),
    replies: assistants.map((assistant) => assistant.message.model),
    results: results.map(({ duration_ms, num_turns, total_cost_usd, usage, subtype }) => ({
      duration_ms, num_turns, total_cost_usd, usage, subtype,
    })),
  };
  writeFileSync(join(evidence, 'observed.json'), JSON.stringify(observed, null, 2));
  console.log(JSON.stringify(observed));
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
  try {
    const base = `http://127.0.0.1:${web.port}`;
    let resultText = '';
    for (const [name, width] of [['desktop', 1280], ['phone', 390]] as const) {
      const context = await browser.newContext({ viewport: { width, height: 850 }, hasTouch: name === 'phone' });
      try {
        await context.addCookies([{ name: 'hyperneo_device', value: readLocalCredential(), url: base }]);
        const page = await context.newPage();
        await page.goto(`${base}/session/${sessionId}`);
        await page.getByText('OXAP-TELEMETRY-OK', { exact: true }).last().waitFor({ timeout: 20_000 });
        const result = page.getByRole('button', { name: /→.* tokens/ }).last();
        await result.waitFor({ timeout: 5_000 });
        resultText = await result.innerText();
        const init = page.getByRole('button', { name: /Session Started.*gpt-6-luna/ });
        if (inits.length > 0) {
          await init.waitFor({ timeout: 5_000 });
          await init.click();
          await page.getByText(/Codex.*OXAP.*on-request/).waitFor({ timeout: 5_000 });
          await page.locator('[title="Context usage unavailable"]').waitFor({ timeout: 5_000 });
          await result.click();
          await page.getByText('Completed in 1 turn', { exact: true }).waitFor({ timeout: 5_000 });
          assert.equal(await page.getByText('Cost', { exact: true }).count(), 0);
        }
        await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' });
      } finally {
        await context.close();
      }
    }
    assert.equal(inits.length, 1, 'one initialization message');
    assert.equal(inits[0].model, 'gpt-6-luna');
    assert.equal(results.length, 1, 'one result');
    assert.deepEqual(observed.replies, ['gpt-6-luna']);
    assert(results[0].duration_ms > 0, 'elapsed duration is measured');
    assert.equal(results[0].total_cost_usd, undefined, 'unreported cost is absent');
    assert(!resultText.includes('$0.0000'), 'result row hides unreported cost');
    assert(results[0].usage.input_tokens > 0, 'the run reported input tokens');
    assert(results[0].usage.output_tokens > 0, 'the run reported output tokens');
    const countInits = () => rows().filter((row) => row.type === 'system' && row.subtype === 'init').length;
    await runTurn(2);
    assert.equal(countInits(), 1, 'a second turn on the same thread adds no init');
    const nativeId = app.db.getSession(sessionId)?.sdkSessionId;
    assert(nativeId);
    await app.oxapEngine.restart();
    await runTurn(3);
    assert.equal(app.db.getSession(sessionId)?.sdkSessionId, nativeId);
    assert.equal(countInits(), 2, 'one more init after reopening the native thread');
    console.log('Reviewed 2 viewports, 3 completed turns, and 2 session init messages.');
  } finally {
    await browser.close();
  }
}

try {
  await verify();
} finally {
  await web.stop(true);
  await transport.close();
  await app.cleanup();
}
