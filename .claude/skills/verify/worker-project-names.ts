import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createWorkerNameSource } from '../../../packages/daemon/src/lib/drivers/worker-names.ts';
import { createWorkVerbOperations } from '../../../packages/daemon/src/lib/drivers/work-operations.ts';
import type { WorkAdapter, WorkSummary } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { packWorkerStartFixture } from '../../../packages/daemon/tests/unit/helpers/pack-worker-start.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const app = await createDaemonApp({ config: getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false });
const names: string[] = [];
try {
  await app.jobProcessor.stop();
  assert(![8399,8499].includes(app.server.port!));
  const place = { machine: 'synthetic', folder: join(run, 'project'), name: 'Project' };
  mkdirSync(place.folder,{recursive:true});
  const workers: WorkSummary[] = [];
  const adapter: WorkAdapter = {
    id:'hyperneo', capabilities:['find','start','status'],
    find:()=>[{place,work:workers,adapters:['hyperneo'],openCount:workers.length,archivedCount:0,lastActivityAt:1}],
    start:async request=>{
      const worker: WorkSummary = {ref:{adapter:'hyperneo',id:`worker-${workers.length+1}`},place,title:request.title,status:'running',lastActivityAt:Date.now()};
      workers.push(worker);names.push(worker.title);return {ok:true,value:worker};
    },
    status:async ref=>({ok:true,value:workers.find(worker=>worker.ref.id===ref.id)!}),
  };
  const caller={source:'internal' as const,role:'neo' as const,sessionId:'fixture-neo'};
  const verbs=createOperationRegistry(createWorkVerbOperations({adapters:()=>[adapter],remote:{list:()=>[],invoke:async()=>{throw new Error('No remote');}},startPlace:input=>({value:{...input,place}})}));
  const world=packWorkerStartFixture(app.db.getDatabase(),{workerNames:createWorkerNameSource(()=>[adapter],place),invoke:(name,input)=>invokeOperation(verbs,name,input,caller)});
  const mcp=createOperationMcpHandler(createOperationRegistry(world.operations),()=>({sessionId:'fixture-neo',role:'neo'}));
  const call=async(name:string,input:unknown)=>{
    const reply=await mcp({name,input});assert(!reply.isError,JSON.stringify(reply));
    const result=JSON.parse(reply.content[0].text);assert(result.ok,JSON.stringify(result));return result;
  };
  const opened=await call('neo.ask.open',{title:'Synthetic matter',request:'Name the workers',todos:[]});
  const askId=world.store.listOpenAsks()[0].id;
  assert(opened.ok);
  for(const title of ['Investigate synthetic task','Implement synthetic task']) {
    const result=await call('neo.todo.add',{askId,...world.draft(title),target:{verb:'start',adapter:'hyperneo',place}});
    assert.equal(result.todo.state,'doing');
  }
  assert.deepEqual(names,['HyperNeo project 1','HyperNeo project 2']);
  const description=world.operations.find(op=>op.name==='neo.todo.add')!.description;
  assert(description.includes('target.name'));
  assert(!description.includes('use work.rename after starting'));
  writeFileSync(join(run,'evidence/worker-names.json'),JSON.stringify({names,startedTodos:2,guidance:true,ports:[app.server.port]},null,2));
  console.log(`PASS: ${names.join(', ')}`);
} finally { await app.cleanup(); }
