import assert from 'node:assert/strict';
import { createPollingGitFixture } from './github-poll-git.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { ExternalEventExtensionConfigStore } from '../../../packages/daemon/src/lib/external-events/extension-config-store.ts';
import { GitHubEventExtension } from '../../../packages/daemon/src/lib/external-events/github/github-event-extension.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';

const [scenario, path] = process.argv.slice(2), run = resolve(path);
assert(['normal', 'conditional', 'failure'].includes(scenario));
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data')));
assert.equal(process.env.GH_TOKEN, undefined); assert.equal(process.env.GITHUB_TOKEN, undefined);
for (const dir of ['bin', 'evidence', 'home/a', 'home/b']) mkdirSync(join(run, dir), { recursive: true });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const when = Date.now() - 10_000, head = createPollingGitFixture(run, ['synthetic/shared']);
writeFileSync(join(run, 'phase'), 'initial');
writeFileSync(join(run, 'bin/gh'), `#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';
const root=${JSON.stringify(run)},args=process.argv.slice(2),phase=readFileSync(root+'/phase','utf8');
if(args[0]!=='api'||!args.includes('--include'))process.exit(2);
const path=args.find(a=>a.startsWith('/repos/')||a==='/user');if(!path)process.exit(2);
const url=new URL(path,'https://api.github.com'),conditional=args.some(a=>a.startsWith('If-None-Match:'));
const status=phase==='failed'&&path!=='/user'?503:${JSON.stringify(scenario)}==='conditional'&&conditional?304:200;
let body=[];
const at=new Date(${when}+(phase==='recovered'?1000:0)).toISOString(),head=${JSON.stringify(head)};
if(path==='/user')body={login:'synthetic-human'};
else if(url.pathname==='/repos/synthetic/shared')body={default_branch:'main'};
else if(url.pathname==='/repos/synthetic/shared/git/ref/heads/main')body={object:{sha:head}};
else if(url.pathname.endsWith('/check-runs'))body={check_runs:[]};
else if(url.pathname.endsWith('/reviews'))body=[{id:phase==='recovered'?42:41,state:'APPROVED',commit_id:head,body:'Synthetic approval',submitted_at:at,html_url:'https://github.com/synthetic/shared/pull/7#review',user:{login:'synthetic-reviewer'}}];
else if(/\\/pulls\\/7$/.test(url.pathname))body={number:7,state:'open',mergeable:true,head:{sha:head}};
else if(url.pathname.endsWith('/pulls'))body=[{number:7,state:'open',updated_at:at,created_at:at,html_url:'https://github.com/synthetic/shared/pull/7',head:{sha:head},user:{login:'synthetic-author'}}];
if(status===503)body={message:'Synthetic unavailable'};
appendFileSync(root+'/evidence/requests.jsonl',JSON.stringify({phase,path,status,conditional})+'\\n');
process.stdout.write('HTTP/2.0 '+status+' Synthetic\\r\\nETag: "pin"\\r\\nX-RateLimit-Remaining: 4900\\r\\nX-RateLimit-Limit: 5000\\r\\nX-RateLimit-Resource: core\\r\\nContent-Type: application/json\\r\\n\\r\\n'+(status===304?'':JSON.stringify(body)));
process.exitCode=status>=400||status===304?1:0;
`, { mode: 0o700 });
const network = globalThis.fetch; globalThis.fetch = (() => { throw new Error('Real HTTP refused'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
const evidence: Record<string, any> = { scenario, productionWired: false, cycles: [] };
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
  app.db.updateGlobalSettings({ neo: { packs: [] } });
  evidence.codingPackDisabled = true;
  const db = app.db.getDatabase(), github = app.extensionManager.getExtension('github') as GitHubEventExtension;
  const spaces = ['a', 'b'].map(name => new SpaceRepository(db).createSpace({ name: `Synthetic ${name}`, slug: `synthetic-${name}`, workspacePath: join(run, 'home', name) }));
  for (const space of spaces) {
    const row = github.repo.upsertWatchedRepo({ spaceId: space.id, owner: 'synthetic', repo: 'shared', pollingEnabled: true });
    db.prepare('UPDATE space_github_watched_repos SET poll_cursor=? WHERE id=?').run(JSON.stringify({ lastSeenAt: when - 3600_000, recentPullRequestNumbers: [7], recentPullRequestHeadShas: { 7: head }, selfLogin: 'synthetic-human' }), row.id);
  }
  await new ExternalEventExtensionConfigStore(db).setGlobalConfig('github', { source: 'github', globallyEnabled: true, capabilities: { polling: true, rpcConfig: true } });
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC unavailable')); });
  const rpc = (method: string, data: unknown) => new Promise<any>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC deadline')), 30000);
    ws!.onmessage = event => { const m = JSON.parse(String(event.data)); if (m.id !== id && m.requestId !== id) return; clearTimeout(timer); m.error ? fail(new Error(JSON.stringify(m.error))) : done(m.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', method, data, sessionId: 'global', timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const approvals = () => db.prepare("SELECT id,space_id,topic,payload_json FROM space_external_events WHERE topic LIKE 'github/synthetic/shared/pull_request/7.review_submitted'").all() as { id: string; space_id: string; payload_json: string }[];
  const phases = scenario === 'failure' ? ['initial', 'failed', 'recovered'] : ['initial', 'repeat'];
  for (const phase of phases) {
    writeFileSync(join(run, 'phase'), phase);
    const reply = await rpc('space.github.pollOnce', {});
    const watched = []; for (const space of spaces) watched.push(await rpc('space.github.listWatchedRepos', {spaceId: space.id}));
    const events = approvals();
    const pages = db.prepare('SELECT subject,fact_revision,observation_revision,reason,http_json FROM pack_coding_poll_facts').all();
    evidence.cycles.push({ phase, reply, watched, events, pages });
    assert.equal(new Set(events.map(event => event.id)).size, events.length);
    for (const space of spaces) assert.equal(events.filter(event => event.space_id === space.id).length, phase === 'recovered' ? 2 : 1);
    for (const event of events) assert.equal(JSON.parse(event.payload_json).commitId, head);
    if (phase === 'failed') {
      assert.equal(reply.errors, 2);
      assert(pages.some(page => page.reason === 'failed'));
      for(let i=0;i<watched.length;i++) {
        const current=watched[i].repositories[0], prior=evidence.cycles[0].watched[i].repositories[0];
        assert.equal(current.lastPollAt,prior.lastPollAt);assert.equal(current.pollCursor.lastSeenAt,prior.pollCursor.lastSeenAt);
        assert.match(current.pollCursor.lastPollError,/Synthetic unavailable/);
      }
    } else assert.equal(reply.errors, undefined);
  }
  const requests = readFileSync(join(run, 'evidence/requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const initialReviews = requests.filter(r => r.phase === 'initial' && r.path.includes('/pulls/7/reviews'));
  assert.equal(initialReviews.length, 1);
  assert(evidence.cycles[0].pages.length > 0);
  for (const cycle of evidence.cycles) for (const page of cycle.pages) {
    const metadata = JSON.parse(page.http_json ?? 'null');
    assert(!metadata?.headers.authorization); assert(!metadata?.headers['set-cookie']);
  }
  if (scenario === 'conditional') assert(requests.some(r => r.phase === 'repeat' && r.status === 304));
  if (scenario === 'failure') {
    assert(requests.some(r => r.phase === 'failed' && r.status === 503));
    assert(requests.some(r => r.phase === 'recovered' && r.status === 200));
  }
  evidence.productionWired = true; evidence.requests = requests; evidence.duplicateInitialReviewReads = initialReviews.length; evidence.verified = true;
  console.log(JSON.stringify({ scenario, verified: true, duplicateInitialReviewReads: initialReviews.length, eventCounts: evidence.cycles.map((cycle: any) => cycle.events.length) }));
} finally {
  writeFileSync(join(run, 'evidence/polling-ledger.json'), JSON.stringify(evidence, null, 2)); ws?.close(); await app?.cleanup(); globalThis.fetch = network;
}
