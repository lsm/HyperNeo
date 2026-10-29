import assert from 'node:assert/strict';
import { mkdirSync, existsSync, statSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from 'node:http';
import { startSessionDoor } from '../../../packages/daemon/src/lib/messaging/session-door.ts';
import { sdkBodyBackupChannel } from '../../../packages/daemon/src/storage/sdk-message-body-backup.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createArtifactProofPhases } from './lane-c-artifact-proof-phases.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
const run=process.argv.at(-1)!;
mkdirSync(join(run,'evidence'));mkdirSync(join(run,'data/backups'),{recursive:true,mode:0o700});
const directory=join(run,'data/backups/sdk-message-bodies-v1'), dbPath=join(run,'data/daemon.db');
const db=new Database(dbPath);runMigrations(db,()=>{});createTables(db);
const phase=createArtifactProofPhases(run);phase('backup-channel');
const abort=new AbortController(), channel=sdkBodyBackupChannel(dbPath,join(directory,'owned.db'),abort.signal);
const listen=Server.prototype.listen, gate=new Int32Array(new SharedArrayBuffer(4));
let pending:ReturnType<typeof channel.verify>|undefined, observedMask:number|undefined, directoryMode:number|undefined, door:Awaited<ReturnType<typeof startSessionDoor>>|undefined;
const socketPath=join(run,'door.sock');
Server.prototype.listen=function(...args:unknown[]){
 if(args[0]===socketPath){
  observedMask=process.umask();pending=channel.verify(false);pending.catch(()=>{});
  const until=Date.now()+1000;
  while(!existsSync(join(directory,'owned.db'))&&Date.now()<until)Atomics.wait(gate,0,0,2);
  if(existsSync(directory))directoryMode=statSync(directory).mode&0o777;
 }
 return Reflect.apply(listen,this,args);
} as typeof listen;
try{
 phase('socket-bind');door=await startSessionDoor(()=>{throw Error('No RPC call belongs to this fixture');},socketPath);
 let error='', backup:Awaited<ReturnType<typeof channel.verify>>|undefined;try{backup=await pending;}catch(cause){error=String(cause);}
 phase('backup-receipt');
 const evidence={observedMask:observedMask?.toString(8),directoryMode:directoryMode?.toString(8),backupMode:existsSync(join(directory,'owned.db'))?(statSync(join(directory,'owned.db')).mode&0o777).toString(8):null,socketMode:(statSync(socketPath).mode&0o777).toString(8),backup,error,ambientMaskAfter:process.umask().toString(8)};
 writeFileSync(join(run,'evidence/permissions.json'),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify(evidence));
 assert.equal(observedMask,0o177);assert.equal(directoryMode,0o700);assert.equal(error,'');assert.equal(backup?.quickCheck,'ok');assert.equal(evidence.backupMode,'600');assert.equal(evidence.socketMode,'600');
 console.log('PASS: real backup completes during socket binding with private directory, backup and socket permissions.');
}finally{
 Server.prototype.listen=listen;channel.close();abort.abort();await door?.close();db.close();if(existsSync(directory))chmodSync(directory,0o700);phase('complete');
}
