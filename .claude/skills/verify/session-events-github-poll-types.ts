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
const REPO = 'synthetic/watch';
const SHA = 'a'.repeat(40);
const iso = (at: number) => new Date(at).toISOString();
const person = (login: string) => ({ login, id: 7, type: 'User', html_url: `https://github.com/${login}` });
const pull = (at: number, extra: Record<string, unknown> = {}) => ({
  id: 8008, node_id: 'PR_8', number: 8, title: 'Synthetic watch', body: 'Body', state: 'open', draft: false,
  merged: false, mergeable: true, mergeable_state: 'clean', merged_at: null, closed_at: null, merge_commit_sha: null,
  html_url: PR, url: `https://api.github.com/repos/${REPO}/pulls/8`, created_at: iso(at - 60000), updated_at: iso(at),
  head: { sha: SHA, ref: 'synthetic', label: 'synthetic:synthetic', repo: { full_name: REPO } },
  base: { sha: 'b'.repeat(40), ref: 'dev', label: 'synthetic:dev', repo: { full_name: REPO } },
  user: person('synthetic-author'), author_association: 'OWNER', labels: [], ...extra,
});
const activity = (at: number) => ({
  pull: pull(at, { mergeable: false, mergeable_state: 'dirty' }),
  issueComments: [{
    id: 701, node_id: 'IC_1', body: 'Please look at this', user: person('synthetic-commenter'), author_association: 'MEMBER',
    html_url: `${PR}#issuecomment-701`, issue_url: `https://api.github.com/repos/${REPO}/issues/8`, created_at: iso(at), updated_at: iso(at),
  }],
  reviewComments: [{
    id: 702, node_id: 'RC_1', pull_request_review_id: 901, body: 'Rename this', path: 'src/a.ts', line: 3, side: 'RIGHT', commit_id: SHA,
    diff_hunk: '@@ -1 +1 @@', user: person('synthetic-reviewer'), author_association: 'MEMBER', html_url: `${PR}#discussion_r702`,
    pull_request_url: `https://api.github.com/repos/${REPO}/pulls/8`, created_at: iso(at), updated_at: iso(at),
  }],
  reviews: [{
    id: 901, node_id: 'PRR_1', body: 'Please rename the helper', state: 'CHANGES_REQUESTED', submitted_at: iso(at), commit_id: SHA,
    user: person('synthetic-reviewer'), author_association: 'MEMBER', html_url: `${PR}#pullrequestreview-901`,
    pull_request_url: `https://api.github.com/repos/${REPO}/pulls/8`,
  }],
  checkRuns: [{
    id: 555, node_id: 'CR_1', name: 'ci', head_sha: SHA, status: 'completed', conclusion: 'failure', started_at: iso(at), completed_at: iso(at),
    html_url: `https://github.com/${REPO}/runs/555`, details_url: `https://github.com/${REPO}/runs/555`, app: { id: 15368, slug: 'github-actions', name: 'GitHub Actions' },
    check_suite: { id: 556 }, output: { title: 'Failed', summary: 'Tests failed', text: null }, pull_requests: [{ id: 8008, number: 8, head: { sha: SHA, ref: 'synthetic' }, base: { sha: 'b'.repeat(40), ref: 'dev' } }],
  }],
  reactions: [{ id: 801, node_id: 'R_1', content: '+1', user: person('synthetic-reactor'), created_at: iso(at) }],
});
const quiet = (at: number) => ({ pull: pull(at), issueComments: [], reviewComments: [], reviews: [], checkRuns: [], reactions: [] });
const closed = (at: number) => ({
  ...activity(at - 1000),
  pull: pull(at, { state: 'closed', merged: true, mergeable: null, merged_at: iso(at), closed_at: iso(at), merge_commit_sha: 'c'.repeat(40), merged_by: person('synthetic-author') }),
});
const setPhase = (fixture: unknown) => writeFileSync(join(run, 'fixture.json'), JSON.stringify(fixture));
setPhase(quiet(Date.now()));
writeFileSync(
  join(run, 'bin/gh'),
  `#!${process.execPath}
const fs=require('node:fs'),root=${JSON.stringify(run)},args=process.argv.slice(2);
if(args[0]!=='api')process.exit(2);
const path=args.find(a=>a.startsWith('/repos/')||a.startsWith('repos/')||a==='/user'||a==='user');if(!path)process.exit(2);
const f=JSON.parse(fs.readFileSync(root+'/fixture.json','utf8'));
let body=[];
if(path.endsWith('user'))body={login:'synthetic-self'};
else if(/\\/issues\\/comments/.test(path))body=f.issueComments;
else if(/\\/pulls\\/comments/.test(path))body=f.reviewComments;
else if(/\\/pulls\\/8\\/reviews/.test(path))body=f.reviews;
else if(/\\/pulls\\/8(?:\\?|$)/.test(path))body=f.pull;
else if(/\\/pulls(?:\\?|$)/.test(path))body=[f.pull];
else if(path.includes('/check-runs'))body={total_count:f.checkRuns.length,check_runs:f.checkRuns};
else if(/\\/reactions/.test(path))body=f.reactions;
fs.appendFileSync(root+'/evidence/requests.jsonl',JSON.stringify({path})+'\\n');
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
const client = new Client({ name: 'session-events-poll-types-proof', version: '1' });
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

  const poll = () => hub.request('space.github.pollOnce', {});
  evidence.quietPoll = await poll();
  setPhase(activity(Date.now() + 1000));
  evidence.activityPoll = await poll();
  setPhase(closed(Date.now() + 2000));
  evidence.closedPoll = await poll();
  evidence.pollCursor = raw.prepare('SELECT poll_cursor FROM github_session_watched_repos').all();
  evidence.topics = (raw.prepare('SELECT topic FROM session_external_events ORDER BY rowid').all() as { topic: string }[])
    .map((row) => row.topic.split('/').at(-1));
  evidence.deliveries = await invoke('event.external.delivery.list');
  evidence.subscriptionsAfter = await invoke('event.external.subscription.list');
  for (const topic of [
    '8.polled',
    '8.comment_polled',
    '8.review_comment_polled',
    '8.review_submitted',
    '8.check_failed',
    '8.merge_conflict',
    '8.reaction_added',
    '8.closed',
  ])
    assert(evidence.topics.includes(topic), `${topic} was not stored`);
  assert.deepEqual(evidence.subscriptionsAfter.stored, []);
  evidence.pass = true;
} finally {
  globalThis.fetch = network;
  await client.close().catch(() => {});
  await transport.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/session-events-poll-types.json'), JSON.stringify(evidence, null, 2));
}
