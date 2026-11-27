import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { startCodexBootstrapServer } from '../../../packages/daemon/src/lib/drivers/codex-app-server.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import {
  OxapHubClient,
  OxapHubRequestError,
} from '../../../packages/daemon/src/lib/oxap/oxap-hub-client.ts';
import { OXAP_VERSION, releaseName } from '../../../packages/daemon/src/lib/oxap/oxap-install.ts';
import { readHubOptions } from '../../../packages/daemon/src/lib/oxap/oxap-settings.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { answerCodexProbeLocally, oxapCodexProvider } from './oxap-codex-provider.ts';

const [manifest, archive, codex, root] = process.argv.slice(2);
const run = resolve(root);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const codexHome = join(run, 'codex-home');
const state = join(run, 'data/oap');
const evidence = join(run, 'evidence');
const capabilityDirectory = join(state, 'session-tool-sources');
await Promise.all([codexHome, evidence].map((path) => mkdir(path, { mode: 0o700 })));
const counts = {
  nativeTurns: 0,
  discovery: 0,
  sends: 0,
  desktopRefusals: 0,
  legacyTurns: 0,
  crossClient: 0,
  foreignCapabilitiesRefused: 0,
  replayedCapabilitiesRefused: 0,
  capabilitiesWritten: 0,
  staleCapabilitiesRemoved: 0,
  revoked: 0,
  secretHits: 0,
};
const users = new Map<string, { calls: string[]; reply: string }>();
let destination = '';
let requestId = 0;
let modelFailure: string | undefined;

function response(item: object) {
  const id = `response-${++requestId}`;
  const events = [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

type Tool = { name?: string; tools?: { name: string }[] };

const model = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    try {
      assert.equal(new URL(request.url).pathname, '/model/responses');
      const body = (await request.json()) as {
        tools?: Tool[];
        input: { type?: string; content?: { text?: string }[]; output?: unknown }[];
      };
      const markerIndex = body.input.findLastIndex((item) =>
        item.content?.some(({ text }) => text?.includes('VERIFY_'))
      );
      const marker = body.input[markerIndex]?.content?.flatMap(
        ({ text }) => text?.match(/VERIFY_[A-Z_]+/) ?? []
      )[0];
      assert(marker, 'model request is missing the verification prompt');
      const turn = users.get(marker);
      assert(turn);
      const namespace = 'mcp__hyperneo_operations';
      const tool = body.tools
        ?.find((entry) => entry.name === namespace)
        ?.tools?.find((entry) => entry.name === 'invoke');
      if (marker.startsWith('VERIFY_LEGACY')) {
        assert(!tool, 'legacy thread was offered HyperNeo operations');
      } else {
        assert(tool, 'native Codex did not discover the HyperNeo MCP tool');
      }
      const results = body.input
        .slice(markerIndex + 1)
        .filter(({ type }) => type === 'function_call_output');
      results.forEach(({ output }, index) => {
        const result = JSON.stringify(output);
        assert(
          !result.includes('user rejected MCP tool call'),
          'Codex refused the operations tool before dispatch'
        );
        switch (turn.calls[index]) {
          case 'operations.list':
          case 'operations.describe':
            assert(
              result.includes('message.send'),
              'operation discovery result did not include message.send'
            );
            break;
          case 'desktop.call':
            assert(
              /desktop_(?:not_enabled|worker_only)|turn_stopped/.test(result),
              'ordinary chat did not get a desktop gate refusal'
            );
            assert(/dispatched[^a-z]+false/.test(result), 'desktop dispatch was not refused');
            break;
        }
      });
      const name = turn.calls[results.length];
      if (name) {
        const input =
          name === 'message.send'
            ? { to: destination, text: 'Released Codex sent this message VERIFY_DELIVERY' }
            : name === 'desktop.call'
              ? { tool: 'get_window_state', args: { pid: 1, window_id: 1 } }
              : name === 'operations.describe'
                ? { name: 'message.send' }
                : {};
        return response({
          type: 'function_call',
          id: `fc-${requestId + 1}`,
          call_id: `call-${requestId + 1}`,
          name: 'invoke',
          namespace,
          arguments: JSON.stringify({ name, input }),
          status: 'completed',
        });
      }
      const output = { type: 'output_text', text: turn.reply, annotations: [] };
      const item = {
        type: 'message',
        id: `msg-${requestId + 1}`,
        role: 'assistant',
        status: 'completed',
        content: [output],
      };
      const streamed = response(item);
      const text = await streamed.text();
      const event = {
        type: 'response.output_text.delta',
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        delta: turn.reply,
      };
      return new Response(
        text.replace(
          'data: {"type":"response.output_item.done"',
          `data: ${JSON.stringify(event)}\n\ndata: {"type":"response.output_item.done"`
        ),
        { headers: streamed.headers }
      );
    } catch (error) {
      modelFailure = error instanceof Error ? error.message : String(error);
      return new Response('Verification fixture rejected the request', { status: 400 });
    }
  },
});

process.env.CODEX_HOME = codexHome;
await writeFile(
  join(codexHome, 'config.toml'),
  `model_provider = "fixture"
web_search = "disabled"
cli_auth_credentials_store = "file"
[features]
plugins = false
[model_providers.fixture]
name = "Fixture"
base_url = "http://127.0.0.1:${model.port}/model"
wire_api = "responses"
requires_openai_auth = true
`
);
const login = Bun.spawn([codex, 'login', '--with-api-key'], {
  env: process.env,
  stdin: new Blob(['local-verify-fixture-account\n']),
  stdout: 'ignore',
  stderr: 'ignore',
});
assert.equal(await login.exited, 0, 'initialize the disposable Codex account');
const admission = await startCodexBootstrapServer(codex);
try {
  const result = (await admission.call('account/read', { refreshToken: false })) as {
    account: unknown;
  };
  assert(result.account, 'native Codex did not detect the disposable fixture account');
} finally {
  await admission.close();
}

const release = `${releaseName()}.tar.gz`;
assert(archive.endsWith('/' + release), 'supply the pinned release archive');
const fetches = answerCodexProbeLocally();
const loopback = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const base = `https://github.com/lsm/oxap/releases/download/v${OXAP_VERSION}/`;
    if (url === `${base}SHA256SUMS.txt`) return new Response(await readFile(manifest));
    if (url === base + release) return new Response(await readFile(archive));
    return loopback(input, init);
  },
  { preconnect: loopback.preconnect }
) as typeof fetch;

await mkdir(capabilityDirectory, { recursive: true, mode: 0o700 });
await writeFile(join(capabilityDirectory, 'abandoned'), '', { mode: 0o600 });
const config = getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') });
const app = await createDaemonApp({
  config: { ...config, disableWorktrees: true, disableGoalProcessing: true },
  verbose: false,
});
assert.deepEqual(await readdir(capabilityDirectory), []);
assert.equal((await stat(capabilityDirectory)).mode & 0o777, 0o700);
counts.staleCapabilitiesRemoved++;
const rpc = new MessageHub({ defaultSessionId: 'global' });
const wire = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket: createLocalSocket,
});
rpc.registerTransport(wire);
const clients: Client[] = [];
let otherHub: OxapHubClient | undefined;
const canaries = new Set<string>();
const manager = app.sessionManager;
let sessionFailure: string | undefined;
app.internalEventBus.subscribe(
  'session.errorObserved',
  ({ details }) => {
    sessionFailure = (details as { userMessage?: string } | undefined)?.userMessage;
  },
  { subscriberName: 'oxap-codex-operations-proof' }
);
async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    assert(!modelFailure, modelFailure);
    assert(!sessionFailure, sessionFailure);
    assert(Date.now() < deadline, label);
    await Bun.sleep(20);
  }
}

async function turn(sessionId: string, marker: string, calls: string[] = []) {
  const reply = marker.replace('VERIFY', 'DONE');
  users.set(marker, { calls, reply });
  const sent = await rpc.request('message.send', { sessionId, content: marker });
  assert(sent, 'chat send returned no receipt');
  await waitFor(() => {
    const rows = app.db.getSDKMessages(sessionId, 500).messages;
    return (
      rows.some(
        (row) => row.type === 'assistant' && JSON.stringify(row.message.content).includes(reply)
      ) && !manager.getSession(sessionId)?.queryPromise
    );
  }, `missing completed chat reply ${reply}`).catch((error) => {
    console.log(
      'reply diagnostics',
      requestId,
      app.db.getSDKMessages(sessionId, 500).messages.map((row) => row.type),
      manager.getSessionFromDB(sessionId)?.sdkSessionId ? 'native ID recorded' : 'no native ID'
    );
    throw error;
  });
  if (marker.startsWith('VERIFY_LEGACY')) counts.legacyTurns++;
  else counts.nativeTurns++;
  assert.deepEqual(await readdir(capabilityDirectory), []);
}

async function connect(sessionId: string) {
  const grant = await manager.grantOperationMcp(sessionId);
  canaries.add(grant.bearer);
  const transport = new StreamableHTTPClientTransport(new URL(grant.endpoint), {
    requestInit: { headers: { authorization: `Bearer ${grant.bearer}` } },
  });
  const client = new Client({ name: 'verify-released-tool-grant', version: '1' });
  clients.push(client);
  await client.connect(transport);
  assert(transport.sessionId);
  return { ...grant, id: transport.sessionId, client };
}

async function status(endpoint: string, bearer: string, id: string) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'mcp-session-id': id,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'invoke', arguments: { name: 'operations.list', input: {} } },
    }),
    signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
  return response.status;
}

function openParameters(sessionId: string, reference?: string) {
  return {
    adapter: 'anthropic-codex',
    directory: run,
    request: {
      protocol: 'open-agent-protocol',
      version: '0.1',
      profile: 'open-agent-protocol.agent-control-core',
      type: 'session.open.request',
      id: 'verify-open',
      payload: {
        session_id: sessionId,
        ...(reference
          ? {
              tool_sources: [
                { id: 'hyperneo-operations', kind: 'remote', credential_ref: reference },
              ],
            }
          : {}),
      },
    },
  };
}

async function refusesCapability(hub: OxapHubClient, sessionId: string, reference: string) {
  await assert.rejects(
    hub.request('open', openParameters(sessionId, reference)),
    (error) =>
      error instanceof OxapHubRequestError &&
      error.code === 'unsupported_feature' &&
      error.feature === 'action.tool_sources.attach'
  );
}

try {
  await wire.initialize();
  await rpc.request('providers.create', { params: oxapCodexProvider.params });
  assert.deepEqual(
    await rpc.request('operation.invoke', {
      name: 'oxap.settings.save',
      input: {
        providerId: 'anthropic-codex',
        harness: 'oxap-codex',
        settings: { executable: codex },
      },
    }),
    { accepted: true }
  );
  const pin = app.settingsManager.getGlobalSettings().oxapHub;
  assert(pin && `${pin.version}.tar.gz` === release);
  const options = await readHubOptions(app.oxapSettings);
  await app.oxapEngine.getHub(async () => options);
  otherHub = new OxapHubClient({
    command: pin.path,
    args: [
      'serve',
      '--stdio',
      '--config',
      join(state, 'oap-serve.json'),
      '--session-tool-sources',
      capabilityDirectory,
    ],
    cwd: state,
    env: options.hub.environment,
  });
  await otherHub.connect();
  let observed: { sessionId: string; reference: string } | undefined;
  const attach = manager.attachOperationMcp.bind(manager);
  manager.attachOperationMcp = async (...args) => {
    const cap = await attach(...args);
    canaries.add(cap.reference);
    const file = join(capabilityDirectory, cap.reference);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const grant = JSON.parse(await readFile(file, 'utf8')) as {
      session_id: string;
      tool_approval?: string;
      source: { id: string; kind: string; protocol: string };
      headers: { Authorization: string };
    };
    assert.equal(grant.session_id, args[0]);
    assert.equal(grant.source.id, 'hyperneo-operations');
    assert.equal(
      grant.tool_approval,
      'approve',
      'the daemon-owned operations source must carry approval'
    );
    canaries.add(grant.headers.Authorization.slice('Bearer '.length));
    counts.capabilitiesWritten++;
    if (!observed) {
      observed = { sessionId: args[0], reference: cap.reference };
      await refusesCapability(otherHub!, destination, cap.reference);
      counts.foreignCapabilitiesRefused++;
    }
    return cap;
  };
  const create = async (title: string) =>
    (
      await rpc.request<{ sessionId: string }>('session.create', {
        title,
        workspacePath: run,
        config: { model: 'codex-5.4-mini', provider: 'anthropic-codex' },
      })
    ).sessionId;
  const first = await create('Operations sender');
  destination = await create('Operations receiver');
  users.set('VERIFY_DELIVERY', { calls: [], reply: 'DONE_DELIVERY' });
  await turn(first, 'VERIFY_CREATE', ['operations.list', 'message.send', 'desktop.call']);
  assert(observed);
  await refusesCapability(otherHub, observed.sessionId, observed.reference);
  counts.replayedCapabilitiesRefused++;
  await waitFor(
    () =>
      app.db
        .getUserMessagesByStatus(destination, 'consumed', 20)
        .messages.some((row) =>
          JSON.stringify(row.message.content).includes(
            'Released Codex sent this message VERIFY_DELIVERY'
          )
        ),
    'message.send did not deliver to the receiving chat'
  );
  counts.sends++;
  counts.discovery++;
  counts.desktopRefusals++;
  await turn(destination, 'VERIFY_SECOND');
  const nativeId = manager.getSessionFromDB(first)?.sdkSessionId;
  assert(nativeId);

  const before = await connect(first);
  const other = await connect(destination);
  assert.equal(before.endpoint, other.endpoint);
  assert.notEqual(before.bearer, other.bearer, 'released opens have separate grants');
  for (const [a, b] of [
    [before, other],
    [other, before],
  ]) {
    assert.equal(await status(a.endpoint, a.bearer, b.id), 401);
    counts.crossClient++;
  }
  await manager.archiveSessionResources(first, 'ui_session_archive');
  assert.equal(await status(before.endpoint, before.bearer, before.id), 401);
  counts.revoked++;
  assert.equal((await other.client.listTools()).tools.length, 1, 'other grant survived archive');
  assert.equal((await manager.getSessionLifecycle().unarchive(first)).success, true);
  await turn(first, 'VERIFY_REOPEN', ['operations.describe']);
  assert.equal(manager.getSessionFromDB(first)?.sdkSessionId, nativeId);
  const reopened = await connect(first);
  assert.notEqual(reopened.bearer, before.bearer);

  const legacy = await create('Operations legacy binding');
  const hub = await app.oxapEngine.getHub(() => readHubOptions(app.oxapSettings));
  await hub.request('open', openParameters(legacy));
  await turn(legacy, 'VERIFY_LEGACY_CREATE');
  const legacyNative = manager.getSessionFromDB(legacy)?.sdkSessionId;
  assert(legacyNative);
  await app.oxapEngine.restart();
  await turn(legacy, 'VERIFY_LEGACY_REOPEN');
  assert.equal(manager.getSessionFromDB(legacy)?.sdkSessionId, legacyNative);

  counts.discovery++;
  await manager.deleteSessionResources(first, 'ui_session_delete');
  assert.equal(await status(reopened.endpoint, reopened.bearer, reopened.id), 401);
  counts.revoked++;

  assert.equal(counts.capabilitiesWritten, 3);
  const candidates = [
    join(run, 'proof.log'),
    join(state, 'session-history.jsonl'),
    join(state, 'oap-serve.json'),
    join(run, 'data/daemon.db'),
    ...(await readdir(codexHome, { recursive: true }))
      .filter((path) => path.endsWith('.jsonl') || path.endsWith('.toml'))
      .map((path) => join(codexHome, path)),
  ];
  for (const file of candidates) {
    const contents = await readFile(file);
    for (const bearer of canaries) counts.secretHits += Number(contents.includes(bearer));
  }
  assert.equal(counts.secretHits, 0);
  assert.equal(fetches.length, 0, 'the native proof did not need provider credentials');
  console.log(
    'PASS',
    JSON.stringify(counts),
    'binary SHA-256',
    createHash('sha256')
      .update(await readFile(pin.path))
      .digest('hex')
  );
} finally {
  await Promise.all(clients.map((client) => client.close()));
  await wire.close();
  await otherHub?.close();
  await app.cleanup();
  model.stop(true);
  await writeFile(join(evidence, 'codex-operations.json'), JSON.stringify(counts, null, 2));
}
