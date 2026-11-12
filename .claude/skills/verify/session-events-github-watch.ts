import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.notEqual(process.env.HYPERNEO_SPACE, 'on');
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'])
  assert.equal(process.env[key], undefined);
for (const name of ['workspace', 'evidence', 'bin']) mkdirSync(join(run, name), { recursive: true });

const PR = 'https://github.com/synthetic/watch/pull/8';
const now = Date.now();
const iso = (at: number) => new Date(at).toISOString();
const pull = {
  number: 8,
  title: 'Synthetic watch',
  state: 'open',
  merged: false,
  mergeable: true,
  html_url: PR,
  updated_at: iso(now),
  created_at: iso(now - 60000),
  head: { sha: 'a'.repeat(40), ref: 'synthetic' },
  base: { ref: 'dev' },
  user: { login: 'synthetic-author', type: 'User' },
};
const review = {
  id: 901,
  body: 'Please rename the helper',
  state: 'CHANGES_REQUESTED',
  submitted_at: iso(now + 1000),
  user: { login: 'synthetic-reviewer', type: 'User' },
  commit_id: 'a'.repeat(40),
  html_url: `${PR}#pullrequestreview-901`,
};
writeFileSync(join(run, 'fixture.json'), JSON.stringify({ pull, review }));
writeFileSync(join(run, 'phase'), 'quiet');
writeFileSync(
  join(run, 'bin/gh'),
  `#!${process.execPath}
const fs=require('node:fs'),root=${JSON.stringify(run)},args=process.argv.slice(2);
if(args[0]!=='api')process.exit(2);
const path=args.find(a=>a.startsWith('/repos/')||a.startsWith('repos/')||a==='/user'||a==='user');if(!path)process.exit(2);
const {pull,review}=JSON.parse(fs.readFileSync(root+'/fixture.json','utf8')),phase=fs.readFileSync(root+'/phase','utf8');
let body=[];
if(path.endsWith('user'))body={login:'synthetic-self'};
else if(/\\/pulls\\/8\\/reviews/.test(path))body=phase==='review'?[review]:[];
else if(/\\/pulls\\/8(?:\\?|$)/.test(path))body=pull;
else if(/\\/pulls(?:\\?|$)/.test(path))body=[pull];
else if(path.includes('/check-runs'))body={check_runs:[]};
fs.appendFileSync(root+'/evidence/requests.jsonl',JSON.stringify({path,phase})+'\\n');
if(args.includes('--include'))process.stdout.write('HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\nX-RateLimit-Remaining: 4900\\r\\nX-RateLimit-Limit: 5000\\r\\n\\r\\n');
process.stdout.write(JSON.stringify(body));
`,
  { mode: 0o700 }
);

const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { createLocalSocket } = await import(
  '../../../packages/daemon/src/lib/pairing/local-credential.ts'
);
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const { ExternalEventExtensionConfigStore } = await import(
  '../../../packages/daemon/src/lib/external-events/extension-config-store.ts'
);

const network = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error('No real HTTP in this proof');
}) as typeof fetch;
const evidence: Record<string, any> = {};
const app = await createDaemonApp({
  config: {
    ...getConfig({
      host: '127.0.0.1',
      port: 0,
      dbPath: join(run, 'data/daemon.db'),
      workspaceRoot: join(run, 'workspace'),
    }),
    disableWorktrees: true,
    disableGoalProcessing: true,
  },
  verbose: false,
});
const client = new Client({ name: 'session-events-watch-proof', version: '1' });
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket: (address) => createLocalSocket(address, join(run, 'data/local-rpc.credential')),
});
try {
  assert.notEqual(app.server.port, 8399);
  const raw = app.db.getDatabase();
  const hub = new MessageHub({ defaultSessionId: 'global', timeout: 30000 });
  hub.registerTransport(transport);
  await transport.initialize();
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: join(run, 'workspace'),
    config: { queryMode: 'manual' },
  });
  const agent = await app.sessionManager.getSessionAsync(sessionId);
  assert(agent);
  const [left, right] = InMemoryTransport.createLinkedPair();
  await agent.getOperationMcpServer().instance.connect(left);
  await client.connect(right);
  const invoke = async (name: string, input: unknown = {}) => {
    const reply = await client.callTool({ name: 'invoke', arguments: { name, input } });
    const text = (reply.content as { text: string }[])[0].text;
    assert(!reply.isError, `${name}: ${text}`);
    return JSON.parse(text);
  };

  await new ExternalEventExtensionConfigStore(raw).setGlobalConfig('github', {
    source: 'github',
    globallyEnabled: true,
    capabilities: { polling: true, rpcConfig: true },
  });
  evidence.subscribe = await invoke('event.external.subscribe', { prUrl: PR });
  assert.deepEqual(evidence.subscribe, {
    ok: true,
    topicPattern: 'github/synthetic/watch/pull_request/8.*',
  });
  evidence.watched = raw
    .prepare('SELECT space_id, owner, repo, enabled, polling_enabled FROM github_session_watched_repos')
    .all();
  assert.equal(evidence.watched.length, 1);

  evidence.quietPoll = await hub.request('space.github.pollOnce', {});
  writeFileSync(join(run, 'phase'), 'review');
  evidence.reviewPoll = await hub.request('space.github.pollOnce', {});
  evidence.pollCursor = raw
    .prepare('SELECT poll_cursor FROM github_session_watched_repos')
    .all();
  evidence.events = raw.prepare('SELECT id, topic, summary FROM session_external_events').all();
  for (let attempt = 0; attempt < 50; attempt++) {
    evidence.deliveries = await invoke('event.external.delivery.list');
    evidence.message = raw
      .prepare(
        "SELECT send_status FROM sdk_messages WHERE session_id = ? AND message_type = 'user' ORDER BY rowid DESC LIMIT 1"
      )
      .get(sessionId);
    if (evidence.message && evidence.deliveries.deliveries.length > 0) break;
    await Bun.sleep(100);
  }
  assert.equal(evidence.deliveries.deliveries[0]?.state, 'pending');
  assert(evidence.message);
  assert.match(evidence.deliveries.deliveries[0].event.topic, /github\/synthetic\/watch\/pull_request\/8\./);
  evidence.pass = true;
} finally {
  globalThis.fetch = network;
  await client.close().catch(() => {});
  await transport.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/session-events-watch.json'), JSON.stringify(evidence, null, 2));
}
