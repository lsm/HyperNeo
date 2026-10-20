import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { ToolContinuationRecoveryRepository } from '../../../packages/daemon/src/storage/repositories/tool-continuation-recovery-repository.ts';

const [mode, portText, runText, scope = 'full-tick'] = process.argv.slice(2);
const port = Number(portText);
const run = resolve(runText);
assert(['reproduce', 'verify'].includes(mode));
assert(['full-tick', 'expiry'].includes(scope));
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
let lock: ReturnType<typeof spawn> | undefined;
let measuring = false;
let last = performance.now();
let maxLagMs = 0;
const queries: { sql: string; elapsedMs: number; rowsChanged?: number }[] = [];
const pause = () => new Promise((done) => setTimeout(done, 25));
const timer = setInterval(() => { const now = performance.now(); if (measuring) maxLagMs = Math.max(maxLagMs, now-last-10); last=now; }, 10);
try {
  app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.spaceRuntimeService.ready();
  await pause();
  const db = app.db.getDatabase();
  const prepare = db.prepare.bind(db);
  const expiry = new ToolContinuationRecoveryRepository(db);
  const put = prepare(`INSERT INTO tool_continuation_recovery
    (tool_use_id,session_id,status,created_at,updated_at,expires_at)
    VALUES (?,'synthetic',?,1,1,0)`);
  db.transaction(() => { for (let i=0;i<22287;i++) put.run(`synthetic-${i}`, i<22269 ? 'consumed' : 'expired'); })();
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target,key);
      if (!['get','all','run'].includes(String(key))) return typeof value==='function' ? value.bind(target) : value;
      return (...params: unknown[]) => {
        const at=performance.now();
        let result: { changes?: number } | undefined;
        try { result=value.apply(target,params); return result; }
        finally { if (measuring) queries.push({sql,elapsedMs:performance.now()-at,rowsChanged:result?.changes}); }
      };
    }});
  }) as typeof db.prepare;
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done,fail) => { ws!.onopen=() => done(); ws!.onerror=() => fail(new Error('RPC connection failed')); });
  const sample = async (label: string) => {
    maxLagMs=0; last=performance.now(); measuring=true;
    const id=crypto.randomUUID();
    const at=performance.now();
    const health=new Promise<unknown>((done,fail) => {
      const timeout=setTimeout(() => fail(new Error('health RPC timed out')),10000);
      ws!.onmessage=(event) => { const reply=JSON.parse(String(event.data)); if (reply.id!==id && reply.requestId!==id) return; clearTimeout(timeout); if(reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
      ws!.send(JSON.stringify({id,type:'REQ',sessionId:'global',method:'system.health',data:{},timestamp:new Date().toISOString(),version:'1.0.0'}));
    });
    const queryStart=queries.length;
    if (scope === 'expiry') expiry.markExpired();
    else await app!.spaceRuntimeService.getSpaceRuntime().executeTick();
    const tickMs=performance.now()-at;
    const response=await health;
    const healthMs=performance.now()-at;
    await pause();
    measuring=false;
    return {label,tickMs,healthMs,maxLagMs,response,queries:queries.slice(queryStart)};
  };
  const uncontended=await sample('uncontended');
  lock=spawn('/usr/bin/python3',['-c',`import sqlite3,sys,time
db=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()`,join(run,'data/daemon.db')],{stdio:['ignore','pipe','pipe']});
  const released=new Promise<void>((done,fail) => { lock!.once('error',fail); lock!.once('exit',(code) => code===0 ? done() : fail(new Error('synthetic writer failed'))); });
  await new Promise<void>((done,fail) => { lock!.stdout!.once('data',(data) => String(data).includes('locked') ? done() : fail(new Error('writer not locked'))); lock!.once('error',fail); });
  const contended=await sample('unrelated writer holds WAL lock for 1.2s; no rows eligible');
  await released;
  lock=undefined;
  const plans=['tool_continuation_recovery','tool_continuation_inbox'].map((table) => ({table,plan:prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE ${table.endsWith('recovery') ? "status IN ('active','waiting_rebind')" : "status='pending'"} AND expires_at<? LIMIT 1`).all(Date.now())}));
  const counts=prepare('SELECT status,COUNT(*) AS n FROM tool_continuation_recovery GROUP BY status').all();
  const slowest=Math.max(...contended.queries.map((query) => query.elapsedMs));
  expiry.recordToolUse({ toolUseId:'due-tool',sessionId:'synthetic',ttlMs:-10000,owner:{executionId:null,workflowRunId:null} });
  const request={full:'完整工具结果'.repeat(100000)};
  const queued=expiry.queueContinuation({toolUseId:'due-tool',sessionId:'synthetic',requestBody:request,reason:'preserve reason',ttlMs:10000});
  assert.equal(expiry.markExpired(),1);
  assert.equal(expiry.getToolUse('due-tool')?.status,'expired');
  const retained=expiry.getInbox(queued.inbox.id)!;
  assert.equal(retained.status,'expired');
  assert.equal(retained.recoveryReason,'preserve reason');
  assert.deepEqual(JSON.parse(retained.requestJson),request);
  assert.equal(expiry.markExpired(),0);
  const report={scope,uncontended,contended,slowest,plans,counts,fullRequestRetained:true,productionContentionProven:false};
  writeFileSync(join(run,`evidence/${mode}.json`),JSON.stringify(report,null,2));
  if(mode==='reproduce') assert(slowest>250,'Did not reproduce a slow expiry UPDATE');
  else { assert(slowest<250); assert(contended.maxLagMs<1000); assert(contended.healthMs<250); }
  console.log(JSON.stringify({uncontended:{...uncontended,queries:undefined},contended:{...contended,queries:undefined},slowest,counts}));
} finally { measuring=false; clearInterval(timer); lock?.kill(); ws?.close(); await app?.cleanup(); }
