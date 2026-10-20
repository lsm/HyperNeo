import { verifyPromptContent } from '../../../packages/daemon/src/lib/agent/message-delivery-outbox.ts';
import { readHyperneoLastResult, readHyperneoInputs, readHyperneoExchange } from '../../../packages/daemon/src/lib/drivers/hyperneo-adapter.ts';
import { runScopedQuery } from '../../../packages/daemon/src/lib/db-query/scoped-query.ts';
import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { DEBOUNCE_SPACE_TASK_FEEDS_MS } from '../../../packages/daemon/src/lib/live-query/queries/task-messages.ts';
import { BACKGROUND_TASK_METADATA_SQL, MESSAGES_BY_SESSION_SQL } from '../../../packages/daemon/src/lib/live-query/queries/messages.ts';

const [mode, portText, runText] = process.argv.slice(2);
const port = Number(portText);
const run = resolve(runText);
assert(['reproduce','verify'].includes(mode));
assert(port > 0 && port !== 8399);
assert(process.env.NODE_ENV === 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const dbPath = join(run, 'data/daemon.db');
const seed = JSON.parse(readFileSync(join(run, 'evidence/seed.json'), 'utf8'));
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
let measuring = true;
let maxLagMs = 0;
let last = performance.now();
const timer = setInterval(() => { const now = performance.now(); if (measuring) maxLagMs = Math.max(maxLagMs, now - last - 10); last = now; }, 10);
const pause = () => new Promise((done) => setTimeout(done, 25));
const queries: { sql: string; method: string; elapsedMs: number }[] = [];
const calls: { method: string; elapsedMs: number; data: unknown }[] = [];
const phases: Record<string, number> = {};
const start = async () => {
  last = performance.now();
  app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath }), verbose: false });
  const db = app.db.getDatabase();
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    let statement: ReturnType<typeof prepare>;
    try { statement = prepare(sql); }
    catch(error) { writeFileSync(join(run,'evidence/failed-sql.json'),JSON.stringify({sql,error:String(error)},null,2)); throw error; }
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key);
      if (!['get', 'all', 'run'].includes(String(key))) return typeof value === 'function' ? value.bind(target) : value;
      return (...params: unknown[]) => {
        const at = performance.now();
        try { return value.apply(target, params); }
        finally { if (measuring) queries.push({ sql, method: String(key), elapsedMs: performance.now() - at }); }
      };
    } });
  }) as typeof db.prepare;
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  return { db, prepare };
};
const rpc = async (method: string, data: unknown, includeEvents = false) => {
  const id = crypto.randomUUID();
  const at = performance.now();
  const events: unknown[] = [];
  const reply = await new Promise<Record<string, unknown>>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error(`RPC timeout: ${method}`)), 30000);
    ws!.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'EVENT' && (!includeEvents || message.data?.subscriptionId === (data as { subscriptionId?: string }).subscriptionId)) events.push({ method: message.method, data: message.data });
      if (message.requestId !== id && message.id !== id) return;
      clearTimeout(timeout);
      if (message.error) fail(new Error(JSON.stringify({method,data,error:message.error})));
      else if (includeEvents) setTimeout(() => done({ reply: message.data, events }), 25);
      else done(message.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  calls.push({ method, elapsedMs: performance.now() - at, data: reply });
  return reply;
};
const stop = async () => { ws?.close(); ws = undefined; await app?.cleanup(); app = undefined; };
try {
  let current = await start();
  await pause(); phases.startupLagMs = maxLagMs; measuring=false;
  const sid='synthetic-live';
  const scoped='space:proof-space:body-proof';
  current.prepare("INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,'Body scope proof',?,datetime('now'),datetime('now'),'active','{}','{}')").run(scoped,run);
  current.prepare("INSERT INTO rooms(id,name,created_at,updated_at) VALUES ('body-room','Body proof',1,1)").run();
  current.prepare("INSERT INTO tasks(id,room_id,title,description,created_at) VALUES ('body-task','body-room','Body proof','Synthetic group',1)").run();
  current.prepare("INSERT INTO session_groups(id,ref_id,created_at) VALUES ('body-group','body-task',1)").run();
  current.prepare("INSERT INTO session_group_members(group_id,session_id,role,joined_at) VALUES ('body-group',?,'worker',1)").run(scoped);
  const prompt={type:'user',uuid:'body-input',inputKind:'human',parent_tool_use_id:null,message:{role:'user',content:[{type:'text',text:'完整报告'.repeat(4000)}]}} as SDKMessage;
  const repo=app!.db.getSDKMessageRepo();
  repo.saveUserMessage(sid,prompt,'consumed');
  repo.saveUserMessage(scoped,prompt,'consumed');
  repo.saveSDKMessage(sid,{type:'result',uuid:'body-result',subtype:'success',result:'complete report',is_error:false} as SDKMessage);
  const definitions:[string,(string|number)[]][]=[['messages.bySession',[sid,200]],['messages.bySession.compact',[sid,200]],['spaceTaskMessages.byTask',['proof-task']],['spaceTaskMessages.byTask.compact',['proof-task',100]],['spaceTaskActiveTurn.byTask',['proof-task']],['sessionGroupMessages.byGroup',['body-group']]];
  const snapshots=async(label:string) => {
    const result:Record<string,unknown>={};
    for(const [queryName,params] of definitions) {
      const subscriptionId=`${label}-${queryName}`;
      const observed=await rpc('liveQuery.subscribe',{queryName,params,subscriptionId},true);
      const snapshot=(observed.events as {method:string;data:{rows:unknown}}[]).find((event) => event.method==='liveQuery.snapshot');
      assert(snapshot,`Missing snapshot ${queryName}`); result[queryName]=snapshot.data.rows;
      await rpc('liveQuery.unsubscribe',{subscriptionId});
    }
    result.sdk=await rpc('message.sdkMessages',{sessionId:sid,limit:200});
    result.key=await rpc('message.sdkMessage',{sessionId:sid,messageUuid:'parent'});
    const db=app!.db.getDatabase();
    result.lastResult=readHyperneoLastResult(db,sid);
    result.inputs=readHyperneoInputs(db,sid);
    result.exchange=readHyperneoExchange(db,sid,0);
    result.scope=runScopedQuery(db,'space','proof-space',{sql:'SELECT sdk_message FROM sdk_messages'}).rows;
    verifyPromptContent({db,sessionId:sid,messageUuid:'body-input',message:prompt});
    assert.throws(() => verifyPromptContent({db,sessionId:sid,messageUuid:'body-input',message:{...prompt,message:{role:'user',content:'different'}} as SDKMessage}));
    return result;
  };
  const hash=() => {
    const digest=createHash('sha256');
    for(const row of current.prepare('SELECT COALESCE(b.sdk_message,m.sdk_message) AS body FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.rowid ORDER BY m.rowid').iterate() as Iterable<{body:string}>) digest.update(row.body);
    return digest.digest('hex');
  };
  const plans = [
    {name:'backgroundMetadata',sql:BACKGROUND_TASK_METADATA_SQL,params:Array(7).fill(sid)},
    {name:'sessionFeed',sql:MESSAGES_BY_SESSION_SQL,params:[sid,200]},
  ].map(({name,sql,params}) => ({name,detail:current.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)}));
  writeFileSync(join(run,'evidence/plans.json'),JSON.stringify(plans,null,2));
  if(mode==='verify') assert(!JSON.stringify(plans).includes('CORRELATED'));
  const beforeHash=hash();
  measuring=true; maxLagMs=0;last=performance.now();
  const before=await snapshots('before'); await pause();phases.beforeLagMs=maxLagMs;
  measuring=false;
  current.prepare("UPDATE sdk_messages SET sdk_message='' WHERE rowid IN (SELECT seq FROM sdk_message_bodies)").run();
  app!.reactiveDb.notifyChange('sdk_messages');
  await new Promise((done) => setTimeout(done,DEBOUNCE_SPACE_TASK_FEEDS_MS+50));
  maxLagMs=0;last=performance.now();measuring=true;
  let failure:string|undefined;let after:unknown;
  try {after=await snapshots('after');} catch(error) {failure=String(error);}
  await pause();phases.afterLagMs=maxLagMs;measuring=false;
  if(mode==='reproduce') {
    assert(failure || JSON.stringify(after)!==JSON.stringify(before));
    writeFileSync(join(run,'evidence/reproduction.json'),JSON.stringify({failure,before,after},null,2));
    console.log(JSON.stringify({reproduced:true,failure}));
  } else {
    assert.equal(failure,undefined);assert.deepEqual(after,before);
    await stop();maxLagMs=0;last=performance.now();measuring=true;
    current=await start();await pause();phases.restartLagMs=maxLagMs;
    maxLagMs=0;last=performance.now();
    assert.deepEqual(await snapshots('restart'),before);await pause();phases.restartedReadsLagMs=maxLagMs;
    measuring=false;const afterHash=hash();assert.equal(afterHash,beforeHash);
    const maxQueryMs=Math.max(...queries.map((query) => query.elapsedMs));
    const observed={seed,phases,maxQueryMs,queries,calls,plans,beforeHash,afterHash,before,after};
    writeFileSync(join(run,'evidence/observed.json'),JSON.stringify(observed,null,2));
    assert(Math.max(...Object.values(phases))<1000);assert(maxQueryMs<250);
    console.log(JSON.stringify({phases,maxQueryMs,beforeHash,afterHash}));
  }
} finally {clearInterval(timer);await stop();}
