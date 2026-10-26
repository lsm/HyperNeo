import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createCodingLedgerReader } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger-source.ts';
import { CodingPrLedgerRepository, reconcileCodingPrLedger } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';

const [mode, run] = process.argv.slice(2);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY']) assert.equal(process.env[key], undefined);
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/gh'), String.raw`#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';
const root=${JSON.stringify(run)},args=process.argv.slice(2),c=JSON.parse(readFileSync(root+'/control.json','utf8'));
if(args[0]!=='api'||!args.includes('--include'))process.exit(2);
const user=args[1]==='user', graphql=args[1]==='graphql', empty=c.repo==='synthetic/empty';
if(!user&&!graphql&&!args[1].startsWith('repos/'+c.repo+'/pulls?'))process.exit(2);
const denied=(empty&&(c.phase==='identity-refused'||(['limited','recovery'].includes(c.phase)&&!user)))||(c.phase==='graphql-limited'&&graphql);
appendFileSync(root+'/evidence/requests.jsonl',JSON.stringify({phase:c.phase,repo:c.repo,user,graphql,denied})+'\n');
process.stdout.write('HTTP/2.0 '+(denied?'403 Forbidden':'200 OK')+'\r\nx-ratelimit-resource: '+(graphql?'graphql':'core')+'\r\nx-ratelimit-remaining: '+(denied?0:4000)+'\r\nx-ratelimit-reset: '+Math.floor((c.base+7200000)/1000)+'\r\n\r\n');
let data;
if(denied)data={message:'API rate limit exceeded'};
else if(user)data={id:empty?1:2,url:'https://api.github.com/users/'+(empty?'limited':'healthy')};
else if(!graphql)data=empty||args[1].includes('state=closed')?[]:[{number:7,title:'Healthy PR',head:{ref:'branch',sha:'head'},updated_at:'unchanged',created_at:new Date(c.base).toISOString(),closed_at:null,draft:false,base:{repo:{full_name:c.repo}}}];
else data={data:{rateLimit:{cost:1,remaining:4000,resetAt:new Date(c.base+7200000).toISOString()},repository:{nameWithOwner:c.repo,p7:{number:7,title:'Healthy PR',headRefName:'branch',headRefOid:'head',state:'OPEN',isDraft:false,mergeable:'MERGEABLE',reviewDecision:null,closedAt:null,commits:{nodes:[{commit:{statusCheckRollup:{state:c.phase==='limited'?'FAILURE':'SUCCESS'}}}]}}}}};
await Bun.write(Bun.stdout,JSON.stringify(data));if(denied){await Bun.write(Bun.stderr,'HTTP 403: API rate limit exceeded');process.exit(1);}
`, { mode: 0o700 });
const network = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('Real network refused'); }) as typeof fetch;
const evidence: Record<string, unknown> = { verified: false, mode };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
const clock = Date.now, base = clock();
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
  app.db.updateGlobalSettings({ neo: { packs: [] } });
  const db = app.db.getDatabase(), ledger = new CodingPrLedgerRepository(db), repos = ['synthetic/empty', 'synthetic/healthy'];
  db.prepare("UPDATE neo_pack_preferences SET value_json=? WHERE pack='coding' AND key='watchedRepos'").run(JSON.stringify(repos));
  const readers = new Map(repos.map(repo => [repo, createCodingLedgerReader()]));
  let phase = 'seed'; const order: string[] = [];
  const read = async (repo: string, ...extra: unknown[]) => {
    order.push(repo); writeFileSync(join(run, 'control.json'), JSON.stringify({ repo, phase, base }));
    return (readers.get(repo)! as (...args: unknown[]) => Promise<unknown>)(repo, ...extra);
  };
  Date.now = () => base;
  await reconcileCodingPrLedger(ledger, ['synthetic/healthy'], read, base);
  Date.now = () => base + 100;
  await reconcileCodingPrLedger(ledger, ['synthetic/empty'], read, Date.now());
  phase = 'limited'; order.length = 0; Date.now = () => base + 31*60000;
  await reconcileCodingPrLedger(ledger, repos, read, Date.now());
  Date.now = clock;
  ws = new WebSocket('ws://127.0.0.1:'+app.server.port+'/ws');
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connect')); });
  const rpc = (name: string) => new Promise<Record<string, unknown>>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
    ws!.onmessage = event => { const msg = JSON.parse(String(event.data)); if (msg.id!==id&&msg.requestId!==id)return;clearTimeout(timer);if(msg.error)fail(new Error(JSON.stringify(msg.error)));else done(msg.data); };
    ws!.send(JSON.stringify({id,type:'REQ',sessionId:'global',method:'operation.invoke',data:{name,input:{}},timestamp:new Date().toISOString(),version:'1.0.0'}));
  });
  await rpc('neo.open'); app.db.updateGlobalSettings({ neo: { packs: ['coding'] } });
  const snapshot = await rpc('neo.snapshot'); evidence.snapshot = snapshot; evidence.order = order;
  const visible = (snapshot.packRows as {pack:string;rows:{pr:string;state:string}[]}[]).find(row=>row.pack==='coding')!.rows;
  assert.equal(visible.find(row=>row.pr==='synthetic/healthy#7')?.state,'failing','Healthy credential must still observe CI failure');
  assert.deepEqual(order,['synthetic/healthy','synthetic/empty']);
  assert.equal(ledger.health.read('synthetic/healthy')?.reason,'complete');
  assert.equal(ledger.list().filter(row=>row.repo==='synthetic/empty').length,0);
  phase = 'recovery'; order.length = 0;
  readers.set('synthetic/empty', createCodingLedgerReader());
  Date.now = () => base + 36*60000;
  await reconcileCodingPrLedger(ledger, repos, read, Date.now());
  Date.now = clock;
  const recovered = await rpc('neo.snapshot'); evidence.recoverySnapshot = recovered;
  const recoveredRows = (recovered.packRows as {pack:string;rows:{pr:string;state:string}[]}[]).find(row=>row.pack==='coding')!.rows;
  assert.deepEqual(order,['synthetic/empty','synthetic/healthy']);
  assert.equal(recoveredRows.find(row=>row.pr==='synthetic/healthy#7')?.state,'waiting_human','An earlier target cooldown must not hide another account CI recovery');
  assert.equal(ledger.health.read('synthetic/empty')?.reason,'cooldown');
  assert.equal(ledger.health.read('synthetic/empty')?.misses,1);
  phase = 'identity-refused';
  for (const minute of [41, 46, 51]) {
    readers.set('synthetic/empty', createCodingLedgerReader());
    Date.now = () => base + minute*60000;
    await reconcileCodingPrLedger(ledger, repos, read, Date.now());
    Date.now = clock;
    assert.equal(ledger.health.read('synthetic/empty')?.reason,'cooldown');
    assert.equal(ledger.health.read('synthetic/empty')?.misses,1,'A refused identity probe must not create target misses');
    assert.equal(ledger.health.read('synthetic/empty')?.incident,null);
    assert.equal(ledger.health.read('synthetic/healthy')?.reason,'complete');
  }
  phase = 'graphql-limited'; Date.now = () => base + 56*60000;
  await reconcileCodingPrLedger(ledger, ['synthetic/healthy'], read, Date.now());
  phase = 'graphql-held';
  for (const minute of [61, 66]) {
    readers.set('synthetic/healthy', createCodingLedgerReader());
    Date.now = () => base + minute*60000;
    await reconcileCodingPrLedger(ledger, ['synthetic/healthy'], read, Date.now());
    assert.equal(ledger.health.read('synthetic/healthy')?.reason,'cooldown');
    assert.equal(ledger.health.read('synthetic/healthy')?.misses,1);
  }
  Date.now = clock;
  const heldSnapshot = await rpc('neo.snapshot'); evidence.graphqlHeldSnapshot = heldSnapshot;
  const heldRows = (heldSnapshot.packRows as {pack:string;rows:{pr:string;state:string}[]}[]).find(row=>row.pack==='coding')!.rows;
  assert.equal(heldRows.find(row=>row.pr==='synthetic/healthy#7')?.state,'waiting_human');
  const requests=readFileSync(join(run,'evidence/requests.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const heldReads=requests.filter(row=>row.phase==='graphql-held');
  assert.equal(heldReads.length,2);
  assert(heldReads.every(row=>row.user),'Known GraphQL cooldown must skip all core PR list reads');
  evidence.graphqlHeldReads=heldReads;
  const probeFailureReads=requests.filter(row=>row.phase==='identity-refused'&&row.repo==='synthetic/empty');
  assert.equal(probeFailureReads.length,1,'Probe refusal cooldown must survive reader recreation');
  assert(probeFailureReads[0].user);
  evidence.identityRefusalReads=probeFailureReads;
  evidence.health = repos.map(repo=>({repo,health:ledger.health.read(repo)})); evidence.verified = true;
  console.log(JSON.stringify({verified:true,order,healthyFailureAndRecovery:true,scopedCooldownSurvivesReaderRecreation:true,inventedEmptyPRs:0}));
} finally {
  Date.now=clock;ws?.close();await app?.cleanup();globalThis.fetch=network;
  writeFileSync(join(run,'evidence/fairness.json'),JSON.stringify(evidence,null,2));
}
