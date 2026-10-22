import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { runMigration331 } from '../../../packages/daemon/src/storage/schema/m331-session-external-events.ts';

const [mode, path] = process.argv.slice(2), run = resolve(path);
assert(['baseline','verify'].includes(mode));
assert(run.startsWith('/private/tmp/'));
assert.equal(process.env.NODE_ENV,'test');
assert.equal(process.env.HOME,join(run,'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
mkdirSync(join(run,'data')); mkdirSync(join(run,'evidence'));
const dbPath=join(run,'data/writer.db'), db=new Database(dbPath);
runMigration331(db); db.close();
const writerURL=new URL('../../../packages/daemon/src/lib/external-events/session-event-writer.ts',import.meta.url).href;
const workerURL=new URL('../../../packages/daemon/src/lib/external-events/session-event-writer-worker.ts',import.meta.url).href;
const body='Complete cold-start human result 🦊\n'.repeat(300);
const fixture=join(run,'worker.ts');
writeFileSync(fixture,`postMessage({phase:'before-import'});await new Promise(resolve=>setTimeout(resolve,50));await import(${JSON.stringify(workerURL)});postMessage({phase:'after-import'});`);
const event={id:'cold-start',spaceId:'sessions',source:'github',topic:'github/synthetic/writer/pull_request/1.review_submitted',dedupeKey:'cold-once',occurredAt:1,ingestedAt:2,summary:'Complete',payload:{body}};
const code=`const {SessionEventWriter}=await import(${JSON.stringify(writerURL)});const phases=[];const writer=new SessionEventWriter(${JSON.stringify(dbPath)},()=>{const w=new Worker(${JSON.stringify(pathToFileURL(fixture).href)},{type:'module'});w.addEventListener('message',e=>{if(e.data.phase)phases.push(e.data.phase);});return w;},1000);let error='',result=null;const at=performance.now();try{result=await writer.ingest(${JSON.stringify(event)});}catch(e){error=String(e);}finally{await writer.close();}console.log(JSON.stringify({error,result,phases,totalMs:performance.now()-at}));`;
const child=spawn(process.env.VERIFY_DENO_BIN??'deno',['eval','--config',new URL('../../../packages/daemon/deno.json',import.meta.url).pathname,code],{env:{...process.env,DENO_DIR:join(run,'cache')},stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';child.stdout.on('data',d=>{stdout+=String(d);});child.stderr.on('data',d=>{stderr+=String(d);});
const deadline=setTimeout(()=>child.kill(),10000);
try{
 const exit=await new Promise<number|null>((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
 assert.equal(exit,0,stderr);
 const observed=JSON.parse(stdout.trim().split('\n').at(-1)!);
 const read=new Database(dbPath,{readonly:true});
 const rows=read.prepare('SELECT payload_json FROM session_external_events').all() as {payload_json:string}[];read.close();
 const evidence={mode,...observed,rowCount:rows.length,bodyPreserved:rows.length===1&&JSON.parse(rows[0].payload_json).body===body};
 writeFileSync(join(run,'evidence/startup.json'),JSON.stringify(evidence,null,2));
 assert.deepEqual(observed.phases,['before-import','after-import']);
 if(mode==='baseline'){assert.match(observed.error,/timeout/);assert.equal(rows.length,0);}else{assert.equal(observed.error,'');assert.equal(observed.result.action,'ingested');assert.equal(evidence.bodyPreserved,true);}
 console.log(JSON.stringify(evidence));
}finally{clearTimeout(deadline);child.kill();writeFileSync(join(run,'evidence/child.log'),stdout+stderr);}
