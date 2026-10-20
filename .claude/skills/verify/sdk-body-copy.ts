import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { DatabaseCore } from '../../../packages/daemon/src/storage/database-core.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { deriveSdkMessageColumns,SDK_MESSAGE_COLUMN_TYPES } from '../../../packages/daemon/src/storage/sdk-message-columns.ts';
import { writeSdkMessageBody } from '../../../packages/daemon/src/storage/repositories/sdk-message-body-write.ts';
import { configureLogger,LogLevel,subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
import { sdkBodyBackupChannel } from '../../../packages/daemon/src/storage/sdk-message-body-backup.ts';

const [mode,portText,runText]=process.argv.slice(2);
const port=Number(portText),run=resolve(runText),dbPath=join(run,'data/daemon.db');
assert.equal(process.env.NODE_ENV,'test');assert(port>0&&port!==8399);
assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));
mkdirSync(join(run,'evidence'),{recursive:true});mkdirSync(join(run,'home'),{recursive:true});
const pause=(ms=25)=>new Promise((done)=>setTimeout(done,ms));
const digest=()=>{
  const db=new Database(dbPath,{readonly:true}),hash=createHash('sha256');let rows=0;
  try {for(const row of db.prepare(`SELECT m.seq,COALESCE(b.sdk_message,m.sdk_message) AS body FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq ORDER BY m.seq`).iterate() as Iterable<{seq:number;body:string}>) {hash.update(`${row.seq}:${Buffer.byteLength(row.body)}:`);hash.update(row.body);rows++;}
    return {hash:hash.digest('hex'),rows};
  }finally{db.close();}
};
if(mode==='seed') {
  assert(!existsSync(dbPath));
  const core=new DatabaseCore(dbPath);await core.initialize();const db=core.getDb();
  try {
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare("INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES ('synthetic-copy','Body migration',?,datetime('now'),datetime('now'),'active','{}','{}')").run(run);
    const names=Object.keys(SDK_MESSAGE_COLUMN_TYPES) as (keyof typeof SDK_MESSAGE_COLUMN_TYPES)[];
    const put=db.prepare(`INSERT INTO sdk_messages(id,session_id,message_type,sdk_uuid,sdk_message,timestamp,replacement_metadata_normalized,${names.join(',')}) VALUES (?,'synthetic-copy',?,?,?,datetime('now'),1,${names.map(()=>'?').join(',')})`);
    db.transaction(()=>{for(let n=0;n<90000;n++) {
      const id=`copy-${n}`,message=n%100===0?{type:'user',uuid:id,message:{role:'user',content:[{type:'tool_result',tool_use_id:`tool-${n}`,content:'complete-tool-result-'.repeat(35000)}]}}:{type:'assistant',uuid:id,message:{role:'assistant',content:[{type:'text',text:`Synthetic body ${n}`}]}};
      const raw=JSON.stringify(message),columns=deriveSdkMessageColumns(message);
      writeSdkMessageBody(db,()=>put.run(id,message.type,id,raw,...names.map((key)=>columns[key])),'id=?',[id]);
    }})();
    db.exec('DELETE FROM sdk_message_bodies WHERE seq%2=1');
  } finally {core.close();}
  const before=digest();writeFileSync(join(run,'evidence/before.json'),JSON.stringify({...before,dbBytes:statSync(dbPath).size}));
  console.log(JSON.stringify({...before,dbBytes:statSync(dbPath).size}));
} else if(mode==='inspect') {
  console.log(JSON.stringify(digest()));
} else if(mode==='backup-reject') {
  const dir=join(run,'data/backups/sdk-message-bodies-v1');
  const backup=join(dir,readdirSync(dir).find((name)=>name.endsWith('.db'))!);
  const manifest=`${backup}.verified.json`,original=readFileSync(manifest,'utf8'),before=digest();
  const abort=new AbortController(),channel=sdkBodyBackupChannel(dbPath,backup,abort.signal);
  let rejected=false;
  try {
    writeFileSync(manifest,JSON.stringify({...JSON.parse(original),hash:'invalid'}));
    await assert.rejects(channel.verify(true),/digest mismatch/);rejected=true;
    writeFileSync(manifest,original);
    renameSync(backup,`${backup}.held`);
    try {await assert.rejects(channel.verify(true),/backup is missing/);}
    finally {renameSync(`${backup}.held`,backup);}
  }finally{writeFileSync(manifest,original);channel.close();}
  const after=digest();assert.deepEqual(after,before);
  writeFileSync(join(run,'evidence/backup-rejection.json'),JSON.stringify({rejected,before,after}));
} else if(mode==='crash'||mode==='child') {
  configureLogger({level:LogLevel.INFO});
  let app:Awaited<ReturnType<typeof createDaemonApp>>|undefined;
  let maxLagMs=0,last=performance.now(),complete=false,startupMs=0;
  const logs:Record<string,unknown>[]=[],started=performance.now();
  const timer=setInterval(()=>{const now=performance.now();maxLagMs=Math.max(maxLagMs,now-last-10);last=now;},10);
  const unsubscribe=subscribeToStructuredLogs((event)=>{
    const prefix='SDK body copy: ';
    if(!event.message.startsWith(prefix)) return;
    const progress=JSON.parse(event.message.slice(prefix.length));logs.push(progress);
    if(progress.phase==='chunk'&&mode==='crash') {
      writeFileSync(join(run,'evidence/crash.json'),JSON.stringify({progress,logs,maxLagMs,startupMs,elapsedMs:performance.now()-started}));
      process.kill(process.pid,'SIGKILL');
    }
    if(progress.phase==='complete') complete=true;
  });
  try {
    app=await createDaemonApp({config:getConfig({port,host:'127.0.0.1',dbPath}),verbose:false});
    configureLogger({level:LogLevel.INFO});
    startupMs=performance.now()-started;
    writeFileSync(join(run,`evidence/${mode}-ready.json`),JSON.stringify({startupMs,pid:process.pid}));
    const deadline=Date.now()+300000;
    while(!complete&&Date.now()<deadline) await pause();
    assert(complete,'Migration did not finish');
    const result={startupMs,elapsedMs:performance.now()-started,maxLagMs,maxTransactionMs:Math.max(...logs.filter((p)=>p.phase==='chunk').map((p)=>Number(p.transactionMs))),logs};
    writeFileSync(join(run,'evidence/child.json'),JSON.stringify(result,null,2));
  }finally{clearInterval(timer);unsubscribe();await app?.cleanup();}
} else if(mode==='verify') {
  let child:ReturnType<typeof spawn>|undefined;
  let activeWs:WebSocket|undefined;
  let peakLogicalBytes=0,peakAllocatedBytes=0;
  const sizes=(dir:string):{logical:number;allocated:number}=>{
    let logical=0,allocated=0;
    for(const entry of readdirSync(dir,{withFileTypes:true})) {const path=join(dir,entry.name);if(entry.isDirectory()){const next=sizes(path);logical+=next.logical;allocated+=next.allocated;}else{try{const stat=statSync(path);logical+=stat.size;allocated+=stat.blocks*512;}catch{}}}
    return {logical,allocated};
  };
  const health:{elapsedMs:number;status:number}[]=[];
  let transcriptSamples=0;
  const runChild=async(action:string)=>{
    let ws:WebSocket|undefined;
    child=spawn(process.execPath,[fileURLToPath(import.meta.url),action,String(port),run],{env:process.env,stdio:['ignore','pipe','pipe']});
    const pid=child.pid;
    let output='';child.stdout?.on('data',(v)=>{output+=v;});child.stderr?.on('data',(v)=>{output+=v;});
    let finished=false;
    const exit=new Promise<{code:number|null;signal:string|null}>((resolve,reject)=>{child!.on('error',reject);child!.on('exit',(code,signal)=>{finished=true;resolve({code,signal});});});
    while(!finished) {
      if(action==='child'&&existsSync(join(run,'evidence/child.json'))) break;
      const disk=sizes(join(run,'data'));peakLogicalBytes=Math.max(peakLogicalBytes,disk.logical);peakAllocatedBytes=Math.max(peakAllocatedBytes,disk.allocated);
      const at=performance.now();
      try {
        if(!ws || ws.readyState!==WebSocket.OPEN) {
          ws=activeWs=new WebSocket(`ws://127.0.0.1:${port}/ws`);
          await new Promise<void>((done,fail)=>{ws!.onopen=()=>done();ws!.onerror=()=>fail(new Error('Not ready'));});
        }
        const id=crypto.randomUUID();
        const method=health.length%4===0?'message.sdkMessages':'system.health';
        await new Promise<void>((done,fail)=>{
          const timer=setTimeout(()=>fail(new Error('RPC responsiveness timeout')),5000);
          ws!.onclose=()=>{clearTimeout(timer);fail(new Error('Child stopped'));};
          ws!.onmessage=(event)=>{const reply=JSON.parse(String(event.data));if(reply.id!==id&&reply.requestId!==id)return;clearTimeout(timer);try {if(reply.error) throw new Error(String(reply.error));if(method==='message.sdkMessages'){assert(reply.data.sdkMessages.length>0);transcriptSamples++;}done();}catch(error){fail(error);}};
          ws!.send(JSON.stringify({id,type:'REQ',sessionId:'global',method,data:method==='system.health'?{}:{sessionId:'synthetic-copy',limit:5},timestamp:new Date().toISOString(),version:'1.0.0'}));
        });
        health.push({elapsedMs:performance.now()-at,status:200});
      } catch(error) {if(!String(error).includes('Not ready')&&!String(error).includes('Child stopped')) throw error;}
      await pause();
    }
    ws?.close();activeWs=undefined;const result=await exit;writeFileSync(join(run,`evidence/${action}.log`),output);child=undefined;
    return {...result,pid};
  };
  try {
    const started=performance.now(),crash=await runChild('crash');assert.equal(crash.signal,'SIGKILL');
    const resumed=await runChild('child');assert.equal(resumed.code,0,readFileSync(join(run,'evidence/child.log'),'utf8').slice(-3000));
    const before=JSON.parse(readFileSync(join(run,'evidence/before.json'),'utf8')),after=digest();assert.equal(after.hash,before.hash);assert.equal(after.rows,before.rows);
    const db=new Database(dbPath,{readonly:true});
    const remaining=(db.prepare("SELECT COUNT(*) AS n FROM sdk_messages WHERE sdk_message<>''").get() as {n:number}).n;
    const suppression=db.prepare('SELECT * FROM sdk_message_body_copy_active').all();db.close();
    const childResult=JSON.parse(readFileSync(join(run,'evidence/child.json'),'utf8'));
    const crashResult=JSON.parse(readFileSync(join(run,'evidence/crash.json'),'utf8'));
    const observed={before,after,remaining,suppression,crash,resumed,totalMs:performance.now()-started,peakLogicalBytes,peakAllocatedBytes,healthRequests:health.length,transcriptSamples,maxHealthMs:Math.max(...health.map((h)=>h.elapsedMs)),...childResult,firstStartupMs:crashResult.startupMs,maxLagMs:Math.max(crashResult.maxLagMs,childResult.maxLagMs),maxTransactionMs:Math.max(Number(crashResult.progress.transactionMs),childResult.maxTransactionMs)};
    writeFileSync(join(run,'evidence/observed.json'),JSON.stringify(observed,null,2));
    assert.equal(remaining,0);assert.deepEqual(suppression,[]);assert(health.length>5);assert(observed.maxLagMs<1000);assert(observed.maxTransactionMs<250);assert(observed.maxHealthMs<1000);
    console.log(JSON.stringify({...observed,logs:undefined}));
  } finally {activeWs?.close();if(child&&child.exitCode===null&&child.signalCode===null){const exit=new Promise((done)=>child!.once('exit',done));child.kill('SIGKILL');await exit;}}
} else throw new Error('Expected seed|verify|crash|child');
