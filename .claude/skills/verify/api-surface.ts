process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { OPERATION_NAMES } from '../../../packages/shared/src/types/operation-names.ts';

const [mode, directory] = process.argv.slice(2), run = resolve(directory);
assert.equal(mode, 'verify');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'bin'), {recursive:true});
mkdirSync(join(run, 'evidence'), {recursive:true});
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', {mode:0o700});
const fetchBefore = globalThis.fetch;
globalThis.fetch = (()=>{throw new Error('External HTTP disabled');}) as typeof fetch;
const snapshot = readFileSync(new URL('../../../api-surface.json', import.meta.url), 'utf8');
const surface = JSON.parse(snapshot) as { operations:{name:string;inputSchema:unknown;resultSchema:unknown}[];events:string[] };
const app = await createDaemonApp({config:{...getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),disableWorktrees:true,disableGoalProcessing:true},verbose:false});
assert.notEqual(app.server.port,8399);
const hub = new MessageHub({defaultSessionId:'global'});
const transport = new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});
hub.registerTransport(transport);
const evidence:Record<string,unknown> = {};
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await transport.initialize();
  const operations = await hub.request<{name:string}[]>('operation.invoke',{name:'operations.list',input:{all:true}});
  assert.deepEqual(operations.map(x=>x.name).sort(), surface.operations.map(x=>x.name));
  assert.deepEqual(surface.operations.map(x=>x.name), [...OPERATION_NAMES].sort());
  const checked:string[]=[];
  for(const name of ['operations.list','task.get','message.send','neo.snapshot','work.read','work.status']) {
    const actual = await hub.request<{found:boolean;inputSchema:unknown;resultSchema:unknown}>('operation.invoke',{name:'operations.describe',input:{name}});
    assert.equal(actual.found,true);
    const expected=surface.operations.find(op=>op.name===name)!;
    assert.deepEqual(actual.inputSchema,expected.inputSchema);
    assert.deepEqual(actual.resultSchema,expected.resultSchema);
    checked.push(name);
  }
  await hub.request('system.health',{});
  assert.deepEqual(surface.events,[...new Set(surface.events)].sort());
  for(const event of ['state.system','state.session','state.sdkMessages.delta','neo.changed','session.toolInventory.changed'])assert(surface.events.includes(event));
  evidence.verified=true;
  evidence.operations=operations.length;
  evidence.events=surface.events.length;
  evidence.describedOverRealRpc=checked;
  evidence.sha256=createHash('sha256').update(snapshot).digest('hex');
  evidence.unrepresentableNodes=(snapshot.match(/x-zod-unrepresentable/g)??[]).length;
  evidence.limitations=['Transform nodes are explicitly marked and fingerprinted, not claimed to be complete JSON validation schemas. Event names are source-derived; this proof does not emit every event.'];
} finally {
  await transport.close();await app.cleanup();globalThis.fetch=fetchBefore;
  evidence.resourcesStopped=true;
  writeFileSync(join(run,'evidence/api-surface.json'),JSON.stringify(evidence,null,2));
}
console.log(JSON.stringify(evidence));
