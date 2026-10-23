import assert from 'node:assert/strict';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
const events:{message:string;metadata:Record<string,unknown>}[]=[];
const off=subscribeToStructuredLogs(event=>{if(event.module==='hyperneo:daemon:sqlite.query')events.push(event);});
const options={slowThresholdMs:0,summaryIntervalMs:0,maxQueryGroups:10,summaryQueryLimit:10};
try{
  const db=new Database(':memory:',{queryObservability:options});
  try{const s=db.prepare("SELECT 'private-phase-literal' AS value");assert.equal(s,db.prepare("SELECT 'private-phase-literal' AS value"));assert.equal((s.get() as {value:string}).value,'private-phase-literal');assert.throws(()=>db.prepare('SELECT * FROM missing_phase_table'));}
  finally{db.close();}
  assert.throws(()=>new Database('/nonexistent-phase-private-dir/not-a-real-db.sqlite',{queryObservability:options}));
  assert.deepEqual(events.filter(e=>e.message==='sqlite.phase.slow').map(e=>[e.metadata.operation,e.metadata.outcome]),[['open','ok'],['prepare','ok'],['prepare','error'],['open','error']]);
  assert.equal(events.find(e=>e.metadata.event==='summary')?.metadata.executionCount,1);
  assert(!JSON.stringify(events).includes('private-phase-literal'));assert(!JSON.stringify(events).includes('nonexistent-phase-private-dir'));
  console.log(JSON.stringify({runtime:typeof Bun!=='undefined'?`Bun ${Bun.version}`:'Deno/node:sqlite',phases:4,executions:1,cacheIdentity:true,privacy:true,events}));
}finally{off();}
