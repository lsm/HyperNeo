import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.GITHUB_TOKEN, undefined);
for (const dir of ['home', 'bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
writeFileSync(join(run, 'bin/gh'), `#!/usr/bin/env bun
import {readFileSync,appendFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
const root=dirname(dirname(process.argv[1])),args=process.argv.slice(2);
const phase=readFileSync(join(root,'phase'),'utf8');
appendFileSync(join(root,'evidence/requests.jsonl'),JSON.stringify({phase,args})+'\\n');
if(!['pr','issue'].includes(args[0])||args[1]!=='list'){process.stderr.write('unsupported synthetic request');process.exit(2);}
await Bun.sleep(300);
if(phase==='failed'){process.stderr.write('synthetic unavailable');process.exit(1);}
const item=n=>({number:n,title:phase==='changed'?'Changed '+n:'Synthetic '+n,url:'https://github.com/synthetic/ledger/pull/'+n,state:'MERGED',createdAt:'2026-10-15T09:00:00Z',updatedAt:'2026-10-15T11:00:00Z',mergedAt:'2026-10-15T11:00:00Z',closedAt:'2026-10-15T11:00:00Z'});
process.stdout.write(JSON.stringify(phase==='empty'?[]:phase==='malformed'?{unexpected:true}:[item(3),item(2),item(1)]));
`, { mode: 0o700 });
const input = { repo: 'synthetic/ledger', state: 'merged', since: '2026-10-15T10:00:00Z', until: '2026-10-15T12:00:00Z', limit: 2 };
const control = (phase: string) => writeFileSync(join(run, 'phase'), phase);
control('initial');
const evidence: Record<string, any> = {};
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
const waiting = new Map<string, { done: (value: any) => void; fail: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('No real HTTP in synthetic proof'); }) as typeof fetch;
async function open() {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connect')); });
  ws.onmessage = event => {
    const msg = JSON.parse(String(event.data)), id = waiting.has(msg.requestId) ? msg.requestId : msg.id, held = waiting.get(id);
    if (!held) return;
    waiting.delete(id); clearTimeout(held.timer);
    if (msg.error) held.fail(new Error(JSON.stringify(msg.error))); else held.done(msg.data);
  };
}
const read = () => new Promise<any>((done, fail) => {
  const id = crypto.randomUUID(), timer = setTimeout(() => { waiting.delete(id); fail(new Error('RPC timeout')); }, 15000);
  waiting.set(id, { done, fail, timer });
  ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name: 'neo.github.read', input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
});
const requests = () => readFileSync(join(run, 'evidence/requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const stored = () => app!.db.getDatabase().prepare('SELECT * FROM pack_coding_query_facts').get() as Record<string, any>;
try {
  await open();
  evidence.fanout = await Promise.all(Array.from({ length: 5 }, () => read()));
  for (const result of evidence.fanout) {
    assert.equal(result.ok, true); assert.equal(result.kind, 'list'); assert.equal(result.truncated, true);
    assert.deepEqual(result.window, { by: 'merged', since: input.since, until: input.until });
    assert.deepEqual(result.items.map((item: any) => item.number), [3, 2]);
    assert.deepEqual(result, evidence.fanout[0]);
  }
  evidence.initialRequests = requests();
  assert.equal(evidence.initialRequests.length, 1, 'Concurrent public queries must share one ledger acquisition');
  evidence.firstStored = stored();
  control('changed'); evidence.changed = await read(); assert.equal(evidence.changed.items[0].title, 'Changed 3');
  evidence.changedStored = stored();
  for (const phase of ['failed', 'malformed']) {
    control(phase); evidence[phase] = await read(); assert.equal(evidence[phase].ok, false); assert.match(evidence[phase].reason, /unreadable/);
    evidence[`${phase}Stored`] = stored(); assert.equal(evidence[`${phase}Stored`].value_json, evidence.changedStored.value_json);
    assert.equal(evidence[`${phase}Stored`].observed_at, evidence.changedStored.observed_at); assert.equal(evidence[`${phase}Stored`].reason, 'failed');
  }
  ws!.close(); await app!.cleanup(); app = undefined; control('empty'); await open();
  evidence.retained = stored(); assert.equal(evidence.retained.value_json, evidence.changedStored.value_json);
  evidence.empty = await read(); assert.equal(evidence.empty.ok, true); assert.deepEqual(evidence.empty.items, []); assert.equal(evidence.empty.truncated, false);
  evidence.emptyStored = stored(); assert.equal(evidence.emptyStored.value_json, '[]'); assert.equal(evidence.emptyStored.reason, null);
  evidence.counts = Object.fromEntries(['initial', 'changed', 'failed', 'malformed', 'empty'].map(phase => [phase, requests().filter(r => r.phase === phase).length]));
  assert.deepEqual(evidence.counts, { initial: 1, changed: 1, failed: 1, malformed: 1, empty: 1 });
  evidence.verified = true;
  console.log(JSON.stringify({ verified: true, counts: evidence.counts, path: join(run, 'evidence/query-ledger.json') }));
} finally {
  if (existsSync(join(run, 'evidence/requests.jsonl'))) evidence.requests = requests();
  writeFileSync(join(run, 'evidence/query-ledger.json'), JSON.stringify(evidence, null, 2));
  for (const held of waiting.values()) clearTimeout(held.timer);
  waiting.clear(); ws?.close(); await app?.cleanup(); globalThis.fetch = network;
}
