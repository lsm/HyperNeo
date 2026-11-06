import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { ProviderCredentialManager } from '../../../packages/daemon/src/lib/credentials/provider-credential-manager.ts';
import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import { ProviderService } from '../../../packages/daemon/src/lib/provider-service.ts';
import { AnthropicProvider } from '../../../packages/daemon/src/lib/providers/anthropic-provider.ts';
import { createLocalSocket, readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';

process.env.HYPERNEO_HUMAN_SEND_SILENCE_MS = '2000';
process.env.HYPERNEO_SDK_STREAM_SILENCE_TIMEOUT_MS = '6000';
process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = '3000';
const run = resolve(process.argv.at(-1) ?? '');
assert(process.env.NODE_ENV === 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'data'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
process.env.PATH = `${run}/bin:${process.env.PATH}`;

type Mode = 'ok' | 'hang' | '401' | '429';
let mode: Mode = 'ok';
let hang: { marker: string; until: number } | null = null;
let slow: { marker: string; ms: number } | null = null;
const served: string[] = [];
const seen: string[] = [];
const sse = (text: string) => {
  const start = { id: `msg_${served.length}`, type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  const events = [
    ['message_start', { type: 'message_start', message: start }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};
const never = () => new Promise<Response>(() => {});
const serveModel = (port: number) => Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, async fetch(request) {
  if (new URL(request.url).pathname !== '/v1/messages') return Response.json({ data: [], has_more: false });
  const text = await request.text();
  seen.push(text);
  if (hang && text.includes(hang.marker) && Date.now() < hang.until) return never();
  if (slow && text.includes(slow.marker)) await Bun.sleep(slow.ms);
  if (mode === 'hang') return never();
  if (mode === '401') return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'OAuth token has expired' } }, { status: 401 });
  if (mode === '429') return Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'Usage limit reached' } }, { status: 429, headers: { 'x-should-retry': 'false' } });
  served.push(text);
  return sse('Synthetic reply.');
} });
let model: ReturnType<typeof serveModel> | null = serveModel(0);
const modelPort = model.port as number;
const modelDown = () => { model?.stop(true); model = null; };
const modelUp = () => { model ??= serveModel(modelPort); };

const build = QueryOptionsBuilder.prototype.build;
const sessionEnv = ProviderService.prototype.resolveSessionProviderEnvVars;
const modelEnv = ProviderService.prototype.getEnvVarsForModel;
const loopback = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}` };
ProviderService.prototype.resolveSessionProviderEnvVars = async function (...args) { return { ...await sessionEnv.apply(this, args), ...loopback }; };
ProviderService.prototype.getEnvVarsForModel = async function (...args) { return { ...await modelEnv.apply(this, args), ...loopback }; };
QueryOptionsBuilder.prototype.build = async function (...args) { return { ...await build.apply(this, args), sandbox: { enabled: false } }; };

async function boot() {
  const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  const transport = new WebSocketClientTransport({ createSocket: createLocalSocket, url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  return { app, hub, transport };
}
let daemon = await boot();
const invoke = <T>(name: string, input: unknown) => daemon.hub.request<T>('operation.invoke', { name, input });
const web = Bun.serve({ hostname: '127.0.0.1', port: 0,
  websocket: createWebSocketHandlers(daemon.app.transport, daemon.app.sessionManager),
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === '/ws') {
      if (server.upgrade(request, { data: { connectionSessionId: 'global', device: await daemon.app.authenticateUpgrade(new Request(request.url, { headers: { authorization: `Bearer ${readLocalCredential()}` } }), '127.0.0.1') } })) return;
      return new Response('Upgrade failed', { status: 500 });
    }
    const file = Bun.file(join(resolve('packages/web/dist'), path === '/neo' || path.startsWith('/neo/') ? 'neo/index.html' : path));
    return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
  },
});

const results: Record<string, unknown>[] = [];
let root = '';
const live = () => daemon.app.sessionManager.getCachedSession(root)!;
const until = async (test: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await test()) return; await Bun.sleep(50); }
  assert.fail(`timed out: ${what}`);
};
const send = async (marker: string) => {
  const requestId = crypto.randomUUID();
  assert((await invoke<{ ok: boolean }>('neo.message.send', { sessionId: root, requestId, content: marker })).ok);
  return requestId;
};
const answered = (marker: string, ms = 25_000) => until(
  () => served.some((body) => body.includes(marker)) && daemon.app.sessionManager.getCachedSession(root)?.getProcessingState().status === 'idle',
  ms, `${marker} answered by the model`);
const settled = async () => {
  let quietSince = Date.now();
  await until(() => {
    if (daemon.app.sessionManager.getCachedSession(root)?.getProcessingState().status !== 'idle') quietSince = Date.now();
    return Date.now() - quietSince >= 1_000;
  }, 30_000, 'session settled');
};
const latch = () => daemon.app.db.updateSession(root, { metadata: { queryFailureEpisode: { id: crypto.randomUUID(), failures: 3, retryAt: Date.now() + 300_000, error: 'stalled', failed: true } } } as never);
const systemTurn = async (text: string) => {
  const receipt = await invoke<{ kind: string; messageId: string }>('message.send', { to: root, from: 'session:synthetic-worker', kind: 'blocked', text });
  assert.equal(receipt.kind, 'accepted');
  return receipt.messageId;
};
const parkedJobs = () => (daemon.app.db.getDatabase().prepare(
  `SELECT COUNT(*) AS n FROM job_queue WHERE queue='message_delivery' AND status='pending' AND run_at > ? AND json_extract(payload,'$.sessionId')=?`
).get(Date.now(), root) as { n: number }).n;

const cases: Record<string, (marker: string) => Promise<Record<string, unknown>>> = {
  async healthy_chat_send_is_not_rebuilt(marker) {
    const { sessionId } = await daemon.hub.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'home'), config: { model: 'haiku' } });
    const first = await daemon.app.sessionManager.getSessionAsync(sessionId);
    await daemon.hub.request('message.send', { sessionId, content: marker });
    await until(() => served.some((body) => body.includes(marker)), 20_000, 'plain chat answered');
    assert.equal(daemon.app.sessionManager.getCachedSession(sessionId), first);
    return {};
  },
  async failure_latch(marker) {
    await latch();
    await send(marker);
    await answered(marker);
    return {};
  },
  async network_pause(marker) {
    await live().onNetworkOutage('API Error: Connection error.', null);
    assert.equal(live().getProcessingState().status, 'rate_limit_cooldown');
    await send(marker);
    await answered(marker);
    return {};
  },
  async restored_rate_limit_cooldown(marker) {
    await daemon.app.db.updateSession(root, { processingState: JSON.stringify({ status: 'rate_limit_cooldown', retryCount: 1, maxRetries: 3, retryAt: Date.now() + 600_000 }) });
    await live().resetQuery({ restartQuery: false, hardReset: true });
    await until(() => live().getProcessingState().status === 'rate_limit_cooldown', 5_000, 'cooldown restored');
    await send(marker);
    await answered(marker);
    return {};
  },
  async hung_process(marker) {
    mode = 'hang';
    const startedAt = Date.now();
    await systemTurn(`earlier work before ${marker.slice(-8).split('').reverse().join('')}`);
    await until(() => live().getProcessingState().status === 'processing', 15_000, 'turn running');
    await Bun.sleep(6_500);
    mode = 'ok';
    await send(marker);
    await answered(marker, 40_000);
    return { answeredAfterMs: Date.now() - startedAt };
  },
  async slow_first_token_is_not_killed(marker) {
    const first = live();
    slow = { marker, ms: 4_000 };
    await send(marker);
    await answered(marker);
    slow = null;
    assert.equal(live(), first, 'a healthy slow turn must keep its session');
    return {};
  },
  async swallowed_message(marker) {
    hang = { marker, until: Date.now() + 6_200 };
    await send(marker);
    await answered(marker, 30_000);
    const recovered = served.findLast((body) => body.includes(marker)) ?? '';
    const userTurns = (JSON.parse(recovered) as { messages: { role: string; content: unknown }[] }).messages.filter((message) => message.role === 'user' && JSON.stringify(message.content).includes(marker));
    return { requestsSeen: seen.filter((body) => body.includes(marker)).length, copiesInRecoveredRequest: userTurns.length };
  },
  async two_messages_in_a_hang(marker) {
    const second = `second-${crypto.randomUUID().slice(0, 8)}`;
    hang = { marker, until: Date.now() + 6_200 };
    await send(marker);
    await Bun.sleep(1_000);
    hang = { marker: second, until: hang.until };
    await send(second);
    await answered(second, 40_000);
    await until(() => served.some((body) => body.includes(marker)), 10_000, 'first message answered too');
    return {};
  },
  async parked_deliveries(marker) {
    await latch();
    const ids = [await systemTurn(`${marker} parked one`), await systemTurn(`${marker} parked two`)];
    await until(() => parkedJobs() > 0, 10_000, 'system deliveries parked');
    const before = parkedJobs();
    await send(marker);
    await answered(marker);
    await until(() => parkedJobs() === 0, 15_000, 'parked deliveries ran');
    return { before, ids: ids.length };
  },
  async expired_token_401(marker) {
    const getCredentials = ProviderCredentialManager.prototype.getCredentials;
    const storeOAuthTokens = ProviderCredentialManager.prototype.storeOAuthTokens;
    const getAuthStatus = AnthropicProvider.prototype.getAuthStatus;
    const refreshToken = AnthropicProvider.prototype.refreshToken;
    let expired = true;
    let refreshes = 0;
    ProviderCredentialManager.prototype.getCredentials = async function (id) {
      return id === 'anthropic' ? { type: 'oauth', accessToken: 'fake', refreshToken: 'fake', expiresAt: expired ? Date.now() - 1000 : Date.now() + 3_600_000 } : getCredentials.call(this, id);
    } as typeof getCredentials;
    ProviderCredentialManager.prototype.storeOAuthTokens = async function () {} as typeof storeOAuthTokens;
    AnthropicProvider.prototype.getAuthStatus = async function () { return { ...await getAuthStatus.call(this), expiresAt: expired ? Date.now() - 1000 : Date.now() + 3_600_000 }; };
    AnthropicProvider.prototype.refreshToken = async function () { refreshes += 1; expired = false; mode = 'ok'; return true; };
    try {
      mode = '401';
      await send(marker);
      await answered(marker);
      return { refreshes };
    } finally {
      mode = 'ok';
      ProviderCredentialManager.prototype.getCredentials = getCredentials;
      ProviderCredentialManager.prototype.storeOAuthTokens = storeOAuthTokens;
      AnthropicProvider.prototype.getAuthStatus = getAuthStatus;
      AnthropicProvider.prototype.refreshToken = refreshToken;
    }
  },
  async no_network(marker) {
    modelDown();
    const url = `http://127.0.0.1:${web.port}/neo`;
    await send(marker);
    await until(() => { const state = live().getProcessingState(); return state.status === 'rate_limit_cooldown' && state.reason === 'network'; }, 30_000, 'network status recorded');
    const browserView = await composerView(url);
    await Bun.sleep(1_000);
    assert(!served.some((body) => body.includes(marker)));
    modelUp();
    await answered(marker, 45_000);
    return { browserView, messagesSent: 1 };
  },
  async waiting_lines(marker) {
    const watch = watchWaiting();
    const browserView = await waitingView(`http://127.0.0.1:${web.port}/neo`, async () => {
      hang = { marker, until: Date.now() + 6_200 };
      slow = { marker, ms: 1_500 };
      await send(marker);
    });
    await answered(marker, 30_000);
    slow = null;
    const lines = watch.stop();
    assert.deepEqual(lines.map((line) => line.waiting).filter((line) => line !== 'none'), ['model', 'reconnecting']);
    assert.equal(lines.at(-1)?.waiting, 'none');
    return { lines, browserView };
  },
  async fast_reply_shows_no_line(marker) {
    const watch = watchWaiting();
    await send(marker);
    await answered(marker);
    assert.deepEqual(watch.stop(), []);
    return {};
  },
  async daemon_restart_mid_outage(marker) {
    modelDown();
    await live().onNetworkOutage('API Error: Connection error.', null);
    await latch();
    await daemon.transport.close();
    await daemon.app.cleanup();
    daemon = await boot();
    modelUp();
    await send(marker);
    await answered(marker);
    return {};
  },
  async real_quota(marker) {
    await latch();
    mode = '429';
    const startedAt = Date.now();
    await send(marker);
    await until(() => seen.some((body) => body.includes(marker)), 10_000, 'tried at once');
    const triedAfterMs = Date.now() - startedAt;
    await until(() => { const rows = daemon.app.db.getSDKMessageRepo().getSDKMessages(root, 30).messages; return JSON.stringify(rows.slice(-8)).includes('Usage limit reached'); }, 30_000, 'human told about the limit');
    mode = 'ok';
    return { triedAfterMs };
  },
};

function watchWaiting() {
  const startedAt = Date.now();
  const lines: { waiting: string; atMs: number }[] = [];
  const timer = setInterval(() => {
    const state = daemon.app.sessionManager.getCachedSession(root)?.getProcessingState();
    const waiting = state?.status === 'processing' ? state.waiting : undefined;
    const last = lines.at(-1)?.waiting;
    if (waiting ? waiting !== last : last && last !== 'none') lines.push({ waiting: waiting ?? 'none', atMs: Date.now() - startedAt });
  }, 20);
  return { stop: () => { clearInterval(timer); return lines; } };
}

async function waitingView(url: string, act: () => Promise<void>) {
  if (!process.env.VERIFY_BROWSER) { await act(); return 'skipped: VERIFY_BROWSER not set'; }
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
    await page.goto(url);
    await page.locator('textarea').first().waitFor({ timeout: 15_000 });
    await act();
    const model = page.getByText("The model hasn't answered yet. Still waiting; it reconnects by itself after 3 minutes.");
    await model.waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(run, 'evidence/waiting-model.png') });
    const reconnecting = page.getByText('The connection got stuck. Reconnecting.');
    await reconnecting.waitFor({ timeout: 15_000 });
    await page.screenshot({ path: join(run, 'evidence/waiting-reconnecting.png') });
    await reconnecting.waitFor({ state: 'hidden', timeout: 15_000 });
    assert.equal(await model.count(), 0);
    await page.screenshot({ path: join(run, 'evidence/waiting-cleared.png') });
    return { model: true, reconnecting: true, cleared: true };
  } finally {
    await browser.close();
  }
}

async function composerView(url: string) {
  if (!process.env.VERIFY_BROWSER) return 'skipped: VERIFY_BROWSER not set';
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    const box = page.locator('textarea').first();
    await box.waitFor({ timeout: 15_000 }).catch(async (error: unknown) => {
      await page.screenshot({ path: join(run, 'evidence/no-network-failed.png') });
      console.log('page text:', (await page.locator('body').innerText()).slice(0, 400));
      throw error;
    });
    await box.fill('second message');
    const line = page.getByText('No network.');
    await line.waitFor({ timeout: 15_000 });
    const send = page.getByRole('button', { name: 'Send message' });
    const view = { line: await line.textContent(), sendDisabled: await send.isDisabled() };
    await page.screenshot({ path: join(run, 'evidence/no-network-composer.png') });
    assert.equal(view.sendDisabled, true);
    return view;
  } finally {
    await browser.close();
  }
}

try {
  const { servers } = await daemon.hub.request<{ servers: { id: string }[] }>('mcp.registry.list', {});
  for (const server of servers) await daemon.hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  await daemon.hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Loopback', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const opened = await invoke<{ ok: boolean; sessionId: string }>('neo.open', {});
  assert(opened.ok);
  root = opened.sessionId;
  await send('warmup-history-marker');
  await answered('warmup-history-marker', 45_000);
  const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7).split(',');
  for (const [name, proof] of Object.entries(cases)) {
    if (only && !only.includes(name)) continue;
    await settled();
    const marker = `case-${name}-${crypto.randomUUID().slice(0, 8)}`;
    const startedAt = Date.now();
    try {
      const details = await proof(marker);
      results.push({ case: name, pass: true, ms: Date.now() - startedAt, ...details });
    } catch (error) {
      results.push({ case: name, pass: false, ms: Date.now() - startedAt, error: String(error).slice(0, 300) });
      mode = 'ok';
      hang = null;
      modelUp();
      await daemon.app.db.updateSession(root, { processingState: JSON.stringify({ status: 'idle' }), metadata: { queryFailureEpisode: null } } as never);
      await daemon.app.sessionManager.getCachedSession(root)?.resetQuery({ restartQuery: false, hardReset: true });
    }
    console.log(JSON.stringify(results.at(-1)));
    writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(results, null, 2));
  }
  const historySurvived = served.at(-1)?.includes('warmup-history-marker') ?? false;
  results.push({ case: 'history_survives', pass: historySurvived });
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(results, null, 2));
  assert(results.every((row) => row.pass === true), JSON.stringify(results.filter((row) => !row.pass)));
  console.log('PASS: one human message recovered every stuck state.');
} finally {
  await daemon.transport.close();
  web.stop(true);
  await daemon.app.cleanup();
  modelDown();
  QueryOptionsBuilder.prototype.build = build;
  ProviderService.prototype.resolveSessionProviderEnvVars = sessionEnv;
  ProviderService.prototype.getEnvVarsForModel = modelEnv;
}
