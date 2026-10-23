import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const [mode, directory] = process.argv.slice(2), run = resolve(directory);
assert(['reproduce', 'verify'].includes(mode));
assert(run.startsWith('/private/tmp/hn-claims-'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'home'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
mkdirSync(join(run, 'evidence'));
copyFileSync(fileURLToPath(new URL('./github-ledger-gh.ts', import.meta.url)), join(run, 'bin/gh'));
chmodSync(join(run, 'bin/gh'), 0o700);
const now = Date.now(), url = 'https://github.com/synthetic/ledger/pull/7';
writeFileSync(join(run, 'fixture.json'), JSON.stringify({ scenario: 'merged', phase: 'initial', now }));
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
const report: Record<string, unknown> = { mode, runtime: Bun.version, syntheticOnly: true };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, socket: WebSocket | undefined;
let probe: ReturnType<typeof spawn> | undefined, timer: ReturnType<typeof setInterval> | undefined;
let measuring = false;
const calls: { ms: number; urls: readonly string[]; rows: number; stack?: string }[] = [];
const statements: { sql: string; params: string[] }[] = [];
const originalRead = CodingTodoPrRepository.prototype.claimsOn, originalPrepare = Database.prototype.prepare;
CodingTodoPrRepository.prototype.claimsOn = function(urls) {
  const start = performance.now();
  const result = originalRead.call(this, urls);
  if (measuring) calls.push({ ms: performance.now()-start, urls, rows: result.length, stack: new Error('synthetic caller').stack });
  return result;
};
Database.prototype.prepare = function(sql: string) {
  const statement = originalPrepare.call(this, sql);
  if (!measuring || !sql.includes("todo_id NOT IN (SELECT id FROM neo_todos")) return statement;
  return new Proxy(statement, { get(target, key) {
    if (key === 'all') return (...params: string[]) => { statements.push({ sql, params }); return Reflect.apply(target.all, target, params); };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
} as typeof Database.prototype.prepare;
try {
  app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  socket = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { socket!.onopen = () => done(); socket!.onerror = fail; });
  const pending = new Map<string, (reply: { data: unknown }) => void>();
  socket.onmessage = event => { const reply = JSON.parse(String(event.data)); pending.get(reply.requestId)?.(reply); };
  const rpc = (name: string, input: unknown) => new Promise<{ ms: number; data: unknown }>((done, fail) => {
    const id = crypto.randomUUID(), start = performance.now();
    const timeout = setTimeout(() => fail(new Error(`${name} timeout`)), 60000);
    pending.set(id, reply => { pending.delete(id); clearTimeout(timeout); done({ ms: performance.now()-start, data: reply.data }); });
    socket!.send(JSON.stringify({ id, type: 'REQ', method: 'operation.invoke', data: { name, input }, sessionId: 'global', version: '1.0.0', timestamp: new Date().toISOString() }));
  });
  const opened = await rpc('neo.open', {});
  const openData = opened.data as { sessionId?: string; value?: { sessionId?: string } };
  const sessionId = openData.sessionId ?? openData.value?.sessionId;
  assert(sessionId, JSON.stringify(opened));
  const db = app.db.getDatabase(), rows = 300000;
  db.prepare("INSERT INTO neo_asks(id,session_id,title,request,status,created_at,updated_at) VALUES('history',?,'Synthetic history','History','done',?,?),('target-ask',?,'Merge synthetic PR','Merge','open',?,?)").run(sessionId,now,now,sessionId,now,now);
  const put = db.prepare('INSERT INTO neo_todos(id,ask_id,position,title,done_when,state,report,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)');
  const claim = db.prepare('INSERT INTO pack_coding_pr_claims(todo_id,url,claim,claimed_at) VALUES(?,?,?,?)');
  const body = 'Complete synthetic todo report 🦊\n'.repeat(1000);
  db.transaction(() => {
    for (let i=0; i<rows; i++) put.run(`history-${i}`,'history',i,'Historical todo','Done',i%10 ? 'done':'removed',body,now,now);
    for (let i=0; i<100; i++) {
      put.run(`live-${i}`,'history',rows+i,'Live shared-session todo','Done','doing',null,now,now);
      for (let j=0; j<200; j++) claim.run(`live-${i}`,`https://github.com/synthetic/ledger/pull/${j+100}`,'branch',now);
    }
    put.run('target','target-ask',0,'Merge PR','Merged','todo',url,now,now);
    claim.run('target',url,'named',now);
    claim.run('history-0',url,'named',now);
  })();
  db.prepare('UPDATE neo_todos SET check_json=? WHERE id=?').run(JSON.stringify({ pack:'coding',kind:'pr_merged',params:{urls:[url]} }),'target');
  new CodingTodoPrRepository(db).record('target', [{ url, state: 'MERGED', checks: 'passing', review: 'approved', createdAt: now-7200000, mergedAt: now-60000 }], now);
  const digest = () => {
    const hash = createHash('sha256');
    for (const row of db.prepare("SELECT * FROM neo_todos WHERE id != 'target' ORDER BY id").iterate()) hash.update(JSON.stringify(row));
    for (const row of db.prepare('SELECT * FROM pack_coding_pr_claims ORDER BY todo_id,url').iterate()) hash.update(JSON.stringify(row));
    return hash.digest('hex');
  };
  report.storedBefore = digest();
  report.rows = rows+101; report.claimRows = 20002;
  probe = spawn(process.execPath, ['-e', `const ws=new WebSocket(${JSON.stringify(`ws://127.0.0.1:${app.server.port}/ws`)});let stop=false,id=0,at=0;const samples=[];const send=()=>{if(stop){console.log(JSON.stringify({samples}));ws.close();return;}at=performance.now();ws.send(JSON.stringify({id:String(++id),type:'REQ',method:'system.health',data:{},sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}));};ws.onopen=()=>{console.log('READY');send();};ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.requestId!==String(id))return;if(r.error)throw new Error(JSON.stringify(r.error));samples.push(performance.now()-at);setTimeout(send,10);};process.stdin.on('data',()=>{stop=true;});setTimeout(()=>process.exit(2),90000).unref();`], { env:process.env, stdio:['pipe','pipe','pipe'] });
  let output='', errors='';
  probe.stdout!.on('data',chunk=>{output+=String(chunk);}); probe.stderr!.on('data',chunk=>{errors+=String(chunk);});
  const exited = new Promise((done,fail)=>{probe!.once('exit',done);probe!.once('error',fail);});
  for(let i=0;i<500&&!output.includes('READY');i++) await pause(10);
  assert(output.includes('READY'),errors);
  let last=performance.now(), maxLagMs=0;
  timer=setInterval(()=>{const at=performance.now();maxLagMs=Math.max(maxLagMs,at-last-10);last=at;},10);
  await pause(30); measuring=true;
  const completion=await rpc('neo.todo.edit',{todoId:'target',done:'met',evidence:'Synthetic merged PR'});
  await pause(50); measuring=false; clearInterval(timer); timer=undefined;
  probe.stdin!.end('stop'); assert.equal(await exited,0,errors);
  const health=JSON.parse(output.trim().split('\n').at(-1)!).samples as number[];
  report.completion=completion; report.calls=calls;
  report.plans=statements.map(({sql,params})=>db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params));
  report.maxLagMs=maxLagMs; report.maxHealthMs=Math.max(...health);
  report.target=db.prepare("SELECT state,evidence FROM neo_todos WHERE id='target'").get();
  report.storedAfter=digest(); assert.equal(report.storedBefore,report.storedAfter);
  assert.equal((report.target as {state:string}).state,'done',JSON.stringify(completion));
  assert(calls.some(call=>call.stack?.includes('todo-prs.ts:420')), 'real coding pack readFacts was not reached');
  assert(calls.every(call=>call.rows===1), 'removed claim was not excluded');
  console.log(JSON.stringify({run,maxLagMs,maxHealthMs:report.maxHealthMs,rpcMs:completion.ms,queryMs:calls.map(c=>c.ms),plans:report.plans}));
  if(mode==='verify') { assert(maxLagMs<250,`loop lag ${maxLagMs}`);assert(Number(report.maxHealthMs)<250,'health');assert(calls.every(c=>c.ms<250),'query');assert(completion.ms<250,'RPC'); }
  else assert(calls.some(c=>c.ms>250),'synthetic query did not reproduce');
} finally {
  if(timer)clearInterval(timer);probe?.kill();socket?.close();await app?.cleanup();
  CodingTodoPrRepository.prototype.claimsOn=originalRead;Database.prototype.prepare=originalPrepare;
  writeFileSync(join(run,'observed.json'),JSON.stringify(report,null,2));
}
