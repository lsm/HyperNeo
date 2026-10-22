import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoPublicationRepository } from '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts';
import { seedNeoWake } from '../../../packages/daemon/tests/helpers/neo-wake-corpus.ts';
const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log=readFileSync(`${run}/daemon.log`,'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
const child=Bun.spawn(['bun','.claude/skills/verify/rpc.ts','neo.open','{}'],{env:{...process.env,VERIFY_PORT:port},stdout:'pipe',stderr:'inherit'});
const result=JSON.parse(await new Response(child.stdout).text());
assert.equal(await child.exited,0);
const root=result.reply.sessionId;
const id=root.slice(4);
const db=new Database(`${run}/data/daemon.db`);
db.exec('PRAGMA busy_timeout = 5000');
try {
  db.exec('BEGIN IMMEDIATE');
  const publications=new NeoPublicationRepository(db);
  const add=(text:string, at:number) => {
    const publicationId=crypto.randomUUID();
    assert(publications.append({conversationId:id,publicationId,askOrigin:{sessionId:root,messageId:publicationId},producerInput:{sessionId:root,messageId:publicationId},shortText:text,fullText:text,links:[]}).accepted);
    db.prepare('UPDATE neo_publications SET created_at=? WHERE publication_id=?').run(new Date(at).toISOString(),publicationId);
    return publicationId;
  };
  const now=Date.now();
  const older=add('Later retained update 1.',now-10000);
  const wake=seedNeoWake(db,id);
  wake.finish('Guide check complete.');
  const publication=wake.expected.find(item=>item.kind==='publication')!.id;
  db.prepare('UPDATE session_schedule_wakes SET fired_at=? WHERE message_id=?').run(now,wake.messageId);
  db.prepare('UPDATE neo_publications SET created_at=? WHERE publication_id=?').run(new Date(now+1000).toISOString(),publication);
  let cached = '';
  for(let index=0;index<49;index++) {
    const added=add(`Later retained update ${index+1}.`,now+2000+index*1000);
    if(index===0) cached=added;
  }
  db.exec('COMMIT');
  writeFileSync(`${run}/evidence/neo-wake-pagination-seed.json`,JSON.stringify({root,scheduleId:wake.scheduleId,publication,older,cached},null,2));
} finally {db.close();}
