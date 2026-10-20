import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { query } from '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { resolveSDKCliPath } from '../../../packages/daemon/src/lib/agent/sdk-cli-resolver.ts';
import { createReadWorkOperation } from '../../../packages/daemon/src/lib/drivers/read-operation.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createOperationMcpServer } from '../../../packages/daemon/src/lib/operations/mcp-server.ts';
import { DatabaseCore } from '../../../packages/daemon/src/storage/database-core.ts';
import { readWorkTurnPage } from '../../../packages/daemon/src/storage/work-turn-page.ts';

const run = resolve(process.argv[2] ?? '');
const port = Number(process.argv[3] ?? 9363);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(port > 0 && port !== 8399);
assert(!existsSync(join(run, 'data/daemon.db')), 'requires a fresh synthetic DB');
for (const part of ['home','data','workspace']) mkdirSync(join(run,part),{recursive:true});
const core = new DatabaseCore(join(run,'data/daemon.db'));
await core.initialize();
const db = core.getDb();
db.prepare("INSERT INTO sessions(id,title,created_at,last_active_at,status,config,metadata) VALUES ('worker','Synthetic','2026-10-20','2026-10-20','active','{}','{}')").run();
const text = '  SYNTHETIC_COMPLETE_REPORT 🔬\n'.repeat(6000) + '\n';
const insert = db.prepare('INSERT INTO sdk_messages(id,session_id,message_type,sdk_message,timestamp) VALUES (?, ?, ?, ?, ?)');
insert.run('legacy-retracted','worker','assistant',JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'HIDDEN_REPLACED_REPORT'}]}}),'2026-10-20T00:00:00Z');
insert.run('report','worker','assistant','{"type":"assistant"}','2026-10-20T00:00:00Z');
db.prepare('INSERT INTO sdk_message_bodies(seq,sdk_message) VALUES ((SELECT seq FROM sdk_messages WHERE id=?),?)').run('report',JSON.stringify({type:'assistant',message:{content:[{type:'thinking',thinking:'HIDDEN_SYNTHETIC'},{type:'text',text}]}}));
db.prepare("INSERT INTO sdk_message_replacements(source_message_id,session_id,target_uuid,kind) VALUES ('report','worker','legacy-retracted','retracted')").run();
for(let n=0;n<30;n++) insert.run(`followup-${n}`,'worker','user',JSON.stringify({type:'user',message:{content:`Later followup ${n}`}}),'2026-10-20T00:00:00Z');
const digest = () => createHash('sha256').update(JSON.stringify([db.prepare('SELECT * FROM sdk_messages ORDER BY seq').all(),db.prepare('SELECT * FROM sdk_message_bodies ORDER BY seq').all()])).digest('hex');
const original = digest();
const registry = createOperationRegistry([createReadWorkOperation({readTurns:(id,around,before,after,cursor) => readWorkTurnPage(db,id,around,before,after,cursor),remote:{list:()=>[],invoke:async()=>{throw new Error('No remote in this proof');}},daemonName:'synthetic'})]);
const results: string[] = [];
let step = 0;
const strings = (value:unknown):string => typeof value==='string'?value:Array.isArray(value)?value.map(strings).join('\n'):value&&typeof value==='object'&&'text' in value?strings(value.text):JSON.stringify(value);
const object = (value:string) => JSON.parse(value.slice(value.indexOf('{'),value.lastIndexOf('}')+1));
const server = Bun.serve({hostname:'127.0.0.1',port,async fetch(request){
  if(!request.url.includes('/v1/messages')) return new Response('{}');
  const body=await request.json() as {messages?:{content?:unknown}[]};
  for(const message of body.messages??[]) if(Array.isArray(message.content)) for(const block of message.content) if(block.type==='tool_result') results[Number(block.tool_use_id.split('-').at(-1))]=strings(block.content);
  const prior=step?object(results[step-1]??'{}'):undefined;
  const input=step===0?{sessionId:'worker',around:'report',before:0,after:0}:prior?.value?.nextCursor?{sessionId:'worker',before:0,after:0,cursor:prior.value.nextCursor}:undefined;
  const id=`read-${step++}`;
  const usage={input_tokens:20,output_tokens:20};
  const events=[
    ['message_start',{type:'message_start',message:{id:`msg_${id}`,type:'message',role:'assistant',model:'claude-sonnet-4-20250514',content:[],stop_reason:null,stop_sequence:null,usage}}],
    ['content_block_start',{type:'content_block_start',index:0,content_block:input?{type:'tool_use',id,name:'mcp__hyperneo-operations__invoke',input:{}}:{type:'text',text:''}}],
    ['content_block_delta',{type:'content_block_delta',index:0,delta:input?{type:'input_json_delta',partial_json:JSON.stringify({name:'work.read',input})}:{type:'text_delta',text:'Synthetic verification complete.'}}],
    ['content_block_stop',{type:'content_block_stop',index:0}],
    ['message_delta',{type:'message_delta',delta:{stop_reason:input?'tool_use':'end_turn',stop_sequence:null},usage}],
    ['message_stop',{type:'message_stop'}],
  ];
  return new Response(events.map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}});
let maxLagMs=0; let previous=performance.now();
const timer=setInterval(()=>{const now=performance.now();maxLagMs=Math.max(maxLagMs,now-previous-10);previous=now;},10);
const stream=query({prompt:'Read the complete older report using work.read and its cursors.',options:{cwd:join(run,'workspace'),executable:'bun',pathToClaudeCodeExecutable:resolveSDKCliPath(),model:'claude-sonnet-4-20250514',tools:[],permissionMode:'bypassPermissions',allowDangerouslySkipPermissions:true,settingSources:[],env:{...process.env,ANTHROPIC_BASE_URL:`http://127.0.0.1:${port}`,ANTHROPIC_API_KEY:'sk-devproxy-test-key',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},mcpServers:{'hyperneo-operations':createOperationMcpServer(registry,()=>({sessionId:'neo:verify-work-read',role:'neo'}))},stderr:data=>writeFileSync(join(run,'sdk-stderr.log'),data,{flag:'a'}),maxTurns:40}});
try {
  for await(const event of stream) writeFileSync(join(run,'sdk-events.jsonl'),JSON.stringify(event)+'\n',{flag:'a'});
  const pages=results.map(object);
  writeFileSync(join(run,'observed.json'),JSON.stringify({pages,maxLagMs},null,2));
  assert(pages.every(page=>page.ok===true),'work.read must locate an older report without its search-index row');
  const actual=pages.flatMap(page=>page.value.turns.map((turn:{text:string})=>turn.text)).join('');
  assert.equal(createHash('sha256').update(actual).digest('hex'),createHash('sha256').update(text).digest('hex'));
  assert.equal(Buffer.byteLength(actual),Buffer.byteLength(text));
  assert(!actual.includes('HIDDEN_SYNTHETIC'));
  assert(!actual.includes('HIDDEN_REPLACED_REPORT'));
  assert.equal(digest(),original);
  assert.equal(pages.at(-1).value.availability,'complete');
  assert(pages.length>1,'long reports must be paged without truncation');
  assert(maxLagMs<1000);
  writeFileSync(join(run,'evidence.json'),JSON.stringify({actualSdkMcp:true,pages:pages.length,reportBytes:Buffer.byteLength(text),sha256:createHash('sha256').update(actual).digest('hex'),maxLagMs,sdkStorageUnchanged:true,searchIndexEmpty:true,retractedLegacyIdHidden:true},null,2));
  console.log(join(run,'evidence.json'));
} finally {stream.close();clearInterval(timer);await server.stop(true);core.close();}
