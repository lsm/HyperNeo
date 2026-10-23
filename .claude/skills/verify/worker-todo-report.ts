import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync,mkdirSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { query } from '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { resolveSDKCliPath } from '../../../packages/daemon/src/lib/agent/sdk-cli-resolver.ts';
import { createHyperneoAdapter } from '../../../packages/daemon/src/lib/drivers/hyperneo-adapter.ts';
import { createWorkVerbOperations } from '../../../packages/daemon/src/lib/drivers/work-operations.ts';
import { createNeoTodoOperations } from '../../../packages/daemon/src/lib/neo/todo-operations.ts';
import { createNeoTodoRunner } from '../../../packages/daemon/src/lib/neo/todo-runner.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { createOperationMcpServer } from '../../../packages/daemon/src/lib/operations/mcp-server.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { DatabaseCore } from '../../../packages/daemon/src/storage/database-core.ts';
const run=resolve(process.argv[2]??'');const port=Number(process.argv[3]??9364);
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(port>0&&port!==8399);
assert(!existsSync(join(run,'data/daemon.db')));
for(const part of ['home','data','workspace'])mkdirSync(join(run,part),{recursive:true});
const core=new DatabaseCore(join(run,'data/daemon.db'));await core.initialize();const db=core.getDb();
db.prepare(`INSERT INTO sessions(id,title,created_at,last_active_at,status,config,metadata,processing_state,type) VALUES ('worker','Synthetic','2026-10-20','2026-10-20','active','{}','{}','{"status":"idle"}','worker')`).run();
const report='  SYNTHETIC_TODO_REPORT 🔬\n'.repeat(300)+'\n';
const store=new NeoAskTodoRepository(db);const sessions=new NeoTodoSessionRepository(db);
store.openAsk({id:'ask',projectId:null,sessionId:'neo:verify',originMessageId:'ask-input',title:'Synthetic',request:'Get the full report',createdAt:Date.now()});
let receipt:{executionId:string;inputId:string}|undefined;let original='';
const digest=()=>createHash('sha256').update(JSON.stringify([db.prepare('SELECT * FROM sdk_messages ORDER BY seq').all(),db.prepare('SELECT * FROM sdk_message_bodies ORDER BY seq').all()])).digest('hex');
const base=Date.now();
const put=(id:string,type:string,text:string,seq:number|null)=>db.prepare(`INSERT INTO sdk_messages(id,session_id,sdk_uuid,message_type,sdk_message,timestamp,send_status,consumed_seq,is_terminal) VALUES (?,'worker',?,?,?,?, 'consumed',?,?)`).run(id,id,type,JSON.stringify(type==='result'?{type,subtype:'success',result:text,is_error:false}:{type,message:{content:[{type:'text',text}]}}),new Date(base+(seq??18)).toISOString(),seq,type==='result'?1:0);
put('prior-progress','assistant','UNRELATED_BEFORE_TODO',null);
const adapter=createHyperneoAdapter({db:()=>db,machine:'synthetic',searchChats:async()=>[],
 handoff:async(_id,message,_from,uuid)=>{receipt={executionId:'worker',inputId:uuid};put(uuid,'user',message,10);put('human','user','Mid-turn human clarification',15);put('report','assistant',report,null);db.prepare('INSERT INTO sdk_message_bodies(seq,sdk_message) SELECT seq,sdk_message FROM sdk_messages WHERE id=?').run('report');db.prepare('UPDATE sdk_messages SET sdk_message=? WHERE id=?').run('{"type":"assistant"}','report');put('terminal','result','',20);put('other','user','A separate later turn',30);put('other-result','result','UNRELATED_LATER_REPORT',40);original=digest();return {kind:'enqueued',id:'synthetic-handoff'};},
 sessions:{create:async()=>{throw new Error('unused');},resolveModel:async()=>null,model:()=>null,chooseWorktree:async()=>{},announce:()=>{},interrupt:()=>false},neoFolder:()=>join(run,'data/Neo'),folderExists:()=>true,makeFolder:()=>{},homeDir:join(run,'home')});
let registry:ReturnType<typeof createOperationRegistry>;const notes:string[]=[];const errors:string[]=[];
const runner=createNeoTodoRunner({store,sessions,invoke:(caller,name,input)=>invokeOperation(registry,name,input,caller),packs:()=>[],tell:async(_ask,_todo,note)=>{notes.push(note);},changed:()=>{}});
registry=createOperationRegistry([...createWorkVerbOperations({adapters:()=>[adapter],daemonName:'synthetic',remote:{list:()=>[],invoke:async()=>{throw new Error('no remote');}}}),...createNeoTodoOperations(store,sessions,runner,()=>[])]);
const results:string[]=[];let step=0;
const strings=(value:unknown):string=>typeof value==='string'?value:Array.isArray(value)?value.map(strings).join('\n'):value&&typeof value==='object'&&'text'in value?strings(value.text):JSON.stringify(value);
const object=(value:string)=>JSON.parse(value.slice(value.indexOf('{'),value.lastIndexOf('}')+1));
const server=Bun.serve({hostname:'127.0.0.1',port,async fetch(request){
 if(!request.url.includes('/v1/messages'))return new Response('{}');
 const body=await request.json() as {messages?:{content?:unknown}[]};
 for(const message of body.messages??[])if(Array.isArray(message.content))for(const block of message.content)if(block.type==='tool_result')results[Number(block.tool_use_id.split('-').at(-1))]=strings(block.content);
 if(step===1)for(let n=0;n<3;n++)await runner.refresh((message,error)=>errors.push(`${message}: ${error}`));
 const command=step===0?{name:'neo.todo.add',input:{askId:'ask',title:'Report',doneWhen:'Human has the complete report',instruction:'Produce the complete report',target:{verb:'send',ref:{adapter:'hyperneo',id:'worker'}},start:true}}:step===1?{name:'work.status',input:{ref:{adapter:'hyperneo',id:'worker'},receipt}}:undefined;
 const input=command?.input;
  const id=`read-${step++}`;
  const usage={input_tokens:20,output_tokens:20};
  const events=[
    ['message_start',{type:'message_start',message:{id:`msg_${id}`,type:'message',role:'assistant',model:'claude-sonnet-4-20250514',content:[],stop_reason:null,stop_sequence:null,usage}}],
    ['content_block_start',{type:'content_block_start',index:0,content_block:input?{type:'tool_use',id,name:'mcp__hyperneo-operations__invoke',input:{}}:{type:'text',text:''}}],
    ['content_block_delta',{type:'content_block_delta',index:0,delta:input?{type:'input_json_delta',partial_json:JSON.stringify({name:command!.name,input})}:{type:'text_delta',text:'Synthetic verification complete.'}}],
    ['content_block_stop',{type:'content_block_stop',index:0}],
    ['message_delta',{type:'message_delta',delta:{stop_reason:input?'tool_use':'end_turn',stop_sequence:null},usage}],
    ['message_stop',{type:'message_stop'}],
  ];
  return new Response(events.map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}});
let maxLagMs=0;let previous=performance.now();const timer=setInterval(()=>{const now=performance.now();maxLagMs=Math.max(maxLagMs,now-previous-10);previous=now;},10);
const stream=query({prompt:'Create the report todo, then read its receipt-bound status.',options:{cwd:join(run,'workspace'),executable:'bun',pathToClaudeCodeExecutable:resolveSDKCliPath(),model:'claude-sonnet-4-20250514',tools:[],permissionMode:'bypassPermissions',allowDangerouslySkipPermissions:true,settingSources:[],env:{...process.env,ANTHROPIC_BASE_URL:`http://127.0.0.1:${port}`,ANTHROPIC_API_KEY:'sk-devproxy-test-key',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},mcpServers:{'hyperneo-operations':createOperationMcpServer(registry,()=>({sessionId:'neo:verify',role:'neo'}))},stderr:data=>writeFileSync(join(run,'sdk-stderr.log'),data,{flag:'a'}),maxTurns:8}});
try{
 for await(const event of stream)writeFileSync(join(run,'sdk-events.jsonl'),JSON.stringify(event)+'\n',{flag:'a'});
 const calls=results.map(object);const todo=store.listTodos('ask')[0];
 writeFileSync(join(run,'observed.json'),JSON.stringify({calls,todo,notes,errors,maxLagMs},null,2));
 assert.equal(errors.length,0);assert.equal(calls[0].ok,true);assert.equal(calls[1].ok,true);
 assert.equal(createHash('sha256').update(todo.report??'').digest('hex'),createHash('sha256').update(`Agent: ${report}`).digest('hex'));
 assert(!todo.report?.includes('UNRELATED_LATER_REPORT'));assert(!todo.report?.includes('UNRELATED_BEFORE_TODO'));assert(notes.some(note=>note.includes(report)));
 assert.equal(digest(),original);assert(maxLagMs<1000);
 writeFileSync(join(run,'evidence.json'),JSON.stringify({actualSdkMcp:true,todoId:todo.id,reportBytes:Buffer.byteLength(report),sha256:createHash('sha256').update(report).digest('hex'),midTurnInputRetained:true,laterTurnExcluded:true,sdkStorageUnchanged:true,maxLagMs},null,2));
 console.log(join(run,'evidence.json'));
}finally{stream.close();clearInterval(timer);await server.stop(true);core.close();}
