import { CodingPrSweepRepository, sweepCodingPrs } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { configureLogger, LogLevel } from '../../../packages/daemon/src/lib/logger.ts';
import { CodingPrLedgerRepository, readCodingLedgerRepo, reconcileCodingPrLedger } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';

const [mode, run] = process.argv.slice(2);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY']) assert.equal(process.env[key], undefined);
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/gh'), String.raw`#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';
const root=${JSON.stringify(run)}, args=process.argv.slice(2), tick=Number(readFileSync(root+'/tick','utf8'));
if(args[0]!=='api')process.exit(2);
const query=args.find(x=>x.startsWith('query='))??'', idle=args.some(x=>x==='n=idle'||x.includes('/idle/'));
const repo='synthetic/'+(idle?'idle':'active');
const rest=args[1]!=='graphql', phase=tick>=6?'changed':'initial';
const numbers=idle?[]:Array.from({length:20},(_,i)=>i+1);
const node=n=>({number:n,title:'PR '+n,headRefName:'b'+n,headRefOid:n===1&&tick>=9?'new-head':'h'+n,state:n===2&&tick>=10?'MERGED':'OPEN',isDraft:false,mergeable:n===4&&tick===5?'CONFLICTING':'MERGEABLE',reviewDecision:n===5&&tick>=7?'CHANGES_REQUESTED':null,closedAt:n===2&&tick>=10?new Date().toISOString():null,createdAt:new Date().toISOString(),author:{login:'human',__typename:'User'},reviews:{nodes:n===1&&tick>=6?[{state:'APPROVED',commit:{oid:tick>=9?'new-head':'h1'},author:{login:'bot'}}]:[]},comments:{nodes:[]},replies:{nodes:[]},files:{nodes:[],pageInfo:{hasNextPage:false}},commits:{nodes:[{commit:{statusCheckRollup:{state:n===3&&tick<3?'PENDING':n===3&&tick===4?'FAILURE':'SUCCESS'},checkSuites:{totalCount:1}}}]}});
let result,cost=0;
if(rest){
 if(!args[1].startsWith('repos/'+repo+'/pulls?'))process.exit(2);
 const closed=args[1].includes('state=closed');
 result=numbers.map(node).filter(n=>closed?n.state!=='OPEN':n.state==='OPEN').map(n=>({number:n.number,title:n.title,head:{ref:n.headRefName,sha:n.headRefOid},state:n.state==='OPEN'?'open':'closed',draft:n.isDraft,merged_at:n.state==='MERGED'?n.closedAt:null,closed_at:n.closedAt,created_at:n.createdAt,updated_at:n.number===1?phase:'initial',base:{repo:{full_name:repo}}}));
}else{
 const selected=[...query.matchAll(/pullRequest\(number:\s*(\d+)\)/g)].map(m=>Number(m[1]));
 cost=selected.length?1:6;
 const repository=selected.length?Object.fromEntries([['nameWithOwner',repo],...selected.map(n=>['p'+n,node(n)])]):{nameWithOwner:repo,open:{pageInfo:{hasNextPage:false},nodes:numbers.map(node).filter(n=>n.state==='OPEN')},done:{nodes:numbers.map(node).filter(n=>n.state!=='OPEN')}};
 result={data:{rateLimit:{cost,remaining:4500-cost,resetAt:'2099-01-01T00:00:00Z'},repository}};
}
appendFileSync(root+'/evidence/requests.jsonl',JSON.stringify({tick,repo,rest,cost,query:rest?undefined:query})+'\n');
console.log(JSON.stringify(result));
`, { mode: 0o700 });
const network = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('Real network forbidden'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
const evidence: Record<string, unknown> = { mode, verified: false, quota: 'synthetic six points per full query, one per selective query; not real GitHub cost' };
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  app.db.updateGlobalSettings({ neo: { packs: [] } });
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connect')); });
  const rpc = (name: string) => new Promise<Record<string, unknown>>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
    ws!.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input: {} }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const root = await rpc('neo.open');
  const db = app.db.getDatabase(), ledger = new CodingPrLedgerRepository(db);
  db.prepare("UPDATE neo_pack_preferences SET value_json=? WHERE pack='coding' AND key='watchedRepos'").run(JSON.stringify(['synthetic/active', 'synthetic/idle']));
  db.prepare("INSERT INTO neo_pack_preferences (pack,scope_kind,scope_key,key,value_json,set_by,set_at) VALUES ('coding','repo','synthetic/active','mergePolicy','\"review_bot\"','human',0)").run();
  db.prepare("INSERT INTO neo_pack_preferences (pack,scope_kind,scope_key,key,value_json,set_by,set_at) VALUES ('coding','repo','synthetic/active','reviewBot','\"bot\"','human',0)").run();
  await ledger.write('observeSessions', [{ ref: { adapter: 'hyperneo', id: String(root.sessionId) }, status: { state: 'running' }, lastActivityAt: Date.now(), remotes: ['git@github.com:synthetic/active.git'], branches: ['b1'], openedPrs: ['https://github.com/synthetic/active/pull/1'] }], Date.now());
  const mainSql: string[] = [];
  evidence.mainSql = mainSql;
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    if (sql.includes('SELECT repo, MAX(readAt)') || sql.includes('state_since AS stateSince, read_at AS readAt') || sql.includes('nudges, owner FROM pack_coding_pr_ledger')) {
      mainSql.push(sql);
      if (mode === 'off-main') throw new Error('Ledger inventory SQL forbidden on main');
    }
    return prepare(sql);
  }) as typeof db.prepare;
  const base = Date.now(), clock = Date.now;
  configureLogger({ level: LogLevel.INFO });
  app.db.updateGlobalSettings({ neo: { packs: ['coding'] } });
  const snapshots: unknown[] = [];
  const nudgeDeliveries: string[] = [];
  evidence.nudgeDeliveries = nudgeDeliveries;
  for (let tick = 0; tick < 12; tick++) {
    writeFileSync(join(run, 'tick'), String(tick));
    Date.now = () => base + tick * 300_000;
    try { await reconcileCodingPrLedger(ledger, ['synthetic/active', 'synthetic/idle'], readCodingLedgerRepo, Date.now());
      await sweepCodingPrs(new CodingPrSweepRepository(db), { tell: async (_ref, _key, text) => { nudgeDeliveries.push(text); return true; }, wake: async (_key, text) => { nudgeDeliveries.push(text); return true; } }, Date.now());
    }
    finally { Date.now = clock; }
    const rows = ledger.snapshot(null, base + tick * 300_000);
    assert.equal(rows.length, 20);
    assert.equal(rows.find(row => row.pr === 'synthetic/active#1')?.state, tick >= 6 ? 'approved_green' : 'waiting_review');
    assert.equal(rows.find(row => row.pr === 'synthetic/active#1')?.ownerId, root.sessionId);
    assert.equal(rows.find(row => row.pr === 'synthetic/active#2')?.state, tick >= 10 ? 'merged' : 'waiting_review');
    const visible = await rpc('neo.snapshot');
    const visibleRows = (visible.packRows as { pack: string; rows: { pr: string; state: string }[] }[]).find(row => row.pack === 'coding')!.rows;
    assert.equal(visibleRows.find(row => row.pr === 'synthetic/active#3')?.state, tick === 4 ? 'failing' : 'waiting_review');
    assert.equal(visibleRows.find(row => row.pr === 'synthetic/active#4')?.state, tick === 5 ? 'dirty' : 'waiting_review');
    assert.equal(visibleRows.find(row => row.pr === 'synthetic/active#5')?.state, tick >= 7 ? 'changes_requested' : 'waiting_review');
    snapshots.push(rows);
  }
  const requests = readFileSync(join(run, 'evidence/requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const graphql = requests.filter(row => !row.rest), cost = graphql.reduce((sum, row) => sum + row.cost, 0);
  app.db.updateGlobalSettings({ neo: { packs: ['coding'] } });
  const snapshot = await rpc('neo.snapshot');
  const coding = (snapshot.packRows as { pack: string; rows: { pr: string; state: string }[] }[]).find(row => row.pack === 'coding');
  assert(coding, 'Snapshot RPC must expose the coding ledger');
  assert.equal(coding.rows.find(row => row.pr === 'synthetic/active#1')?.state, 'approved_green');
  assert.equal(coding.rows.find(row => row.pr === 'synthetic/active#2')?.state, 'merged');
  assert(nudgeDeliveries.length > 0, 'No owned-PR reminders were delivered');
  evidence.snapshot = snapshot;
  evidence.result = { graphqlReads: graphql.length, costPerHour: cost, restReads: requests.length - graphql.length, snapshots };
  if (mode !== 'baseline') {
    assert(cost <= 12, `GraphQL query cost regressed: ${cost} synthetic points`);
    assert(requests.filter(row => row.repo === 'synthetic/idle').length <= 4, 'idle repos still read every sweep');
  }
  evidence.verified = true;
  console.log(JSON.stringify({ verified: true, graphqlReads: graphql.length, costPerHour: cost, restReads: requests.length - graphql.length }));
} finally {
  ws?.close(); await app?.cleanup(); globalThis.fetch = network;
  writeFileSync(join(run, 'evidence/slimming.json'), JSON.stringify(evidence, null, 2));
}
