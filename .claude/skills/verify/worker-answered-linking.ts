import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { query } from '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { resolveSDKCliPath } from '../../../packages/daemon/src/lib/agent/sdk-cli-resolver.ts';
import { Database } from '../../../packages/daemon/src/storage/database.ts';
import { createReactiveDatabase } from '../../../packages/daemon/src/storage/reactive-database.ts';
import { InternalEventBus } from '../../../packages/daemon/src/lib/internal-event-bus.ts';
import { NeoService } from '../../../packages/daemon/src/lib/neo/service.ts';
import { NeoCoordinatorTurn } from '../../../packages/daemon/src/lib/neo/coordinator-turn.ts';
import { MessageQueue } from '../../../packages/daemon/src/lib/agent/message-queue.ts';
import { QueryRunner } from '../../../packages/daemon/src/lib/agent/query-runner.ts';
import { createNeoPublicationOperation } from '../../../packages/daemon/src/lib/neo/publication-operation.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createOperationMcpServer } from '../../../packages/daemon/src/lib/operations/mcp-server.ts';
Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en'] }, configurable: true });
const { projectNeoMessageStatuses, NEO_MESSAGE_STATUS_LABELS } = await import('../../../packages/web/src/neo/message-status.ts');
const run=resolve(process.argv[2]??'');const port=Number(process.argv[3]??9365);
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.HOME,join(run,'home'));assert.equal(process.env.HYPERNEO_DATA_DIR,join(run,'data'));assert(port>0&&port!==8399);assert(!existsSync(join(run,'data/daemon.db')));
for(const p of ['home','data','workspace'])mkdirSync(join(run,p),{recursive:true});
const path=join(run,'data/daemon.db');let db=new Database(path);await db.initialize(createReactiveDatabase(db));
const conversation='10000000-0000-4000-8000-000000000005';const root=`neo:${conversation}`;
db.createSession({id:root,title:'Synthetic',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{model:'claude-sonnet-4-20250514',maxTokens:8192,temperature:1},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
const service=()=>new NeoService(db,{getSessionAsync:async()=>undefined} as never,{event:()=>{}} as never,new InternalEventBus());let neo=service();neo.repo.reserveBinding({sessionId:root,kind:'neo',projectId:null});
const queue=new MessageQueue();queue.start();const active=new NeoCoordinatorTurn(db,root,{isLive:()=>true});
const runner=new QueryRunner({session:{id:root},db,messageQueue:queue,stateManager:{setProcessing:async()=>{}},logger:{debug:()=>{}},firstMessageReceived:true,markHolderInputConsumed:(uuid:string)=>db.getSDKMessageRepo().markDeliveryConsumedByUuids(root,[uuid])} as never);
const save=(id:string,kind:string,text:string)=>{db.getSDKMessageRepo().saveSDKMessage(root,{type:'user',uuid:id,session_id:root,parent_tool_use_id:null,inputKind:kind,message:{role:'user',content:[{type:'text',text}]}} as never);};
save('todo-event','system','Synthetic todo progress');void queue.enqueueWithId('todo-event','Synthetic todo progress',false,{durable:true}).catch(()=>{});
const humanA='20000000-0000-4000-8000-000000000001';const humanB='20000000-0000-4000-8000-000000000002';
const states=()=>Object.fromEntries(projectNeoMessageStatuses([...(neo.asks.list(conversation)??[]).map(ask=>({kind:'ask',key:ask.requestId,ask})),...(neo.publications.list(conversation)??[]).map(publication=>({kind:'publication',key:publication.publicationId,publication,replyTo:null}))] as never,'inactive',{status:'idle'},{connected:true,status:'ready'}));
let before:Record<string,string>={};let step=0;const requests:unknown[]=[];const receipts:string[]=[];let selected:string|undefined;let requestId='answer-midturn';
const registry=()=>createOperationRegistry([createNeoPublicationOperation(neo.publish)]);
const server=Bun.serve({hostname:'127.0.0.1',port,async fetch(request){
 if(!request.url.includes('/v1/messages'))return new Response('{}');
 const body=await request.json() as {messages:{content:unknown}[]};requests.push(body);
 for(const m of body.messages??[])if(Array.isArray(m.content))for(const b of m.content)if(b.type==='tool_result')receipts[Number(b.tool_use_id.split('-').at(-1))]=JSON.stringify(b.content);
 if(step===0){for(const id of [humanA,humanB]){save(id,'human',`Synthetic human ${id}`);neo.asks.append({conversationId:conversation,requestId:id,askOrigin:{sessionId:root,messageId:id},content:`Synthetic human ${id}`});void queue.admitWithId(id,`Synthetic human ${id}`,false,{durable:true,steer:true}).catch(()=>{});}before=states();}
 if(step===1){const texts=body.messages.flatMap(m=>typeof m.content==='string'?[m.content]:Array.isArray(m.content)?m.content.filter(b=>b.type==='text').map(b=>b.text):[]).join('\n');const matches=[...texts.matchAll(/<human-input>(.*?)<\/human-input>/g)];for(const m of matches){try{const value=JSON.parse(m[1]);if(value.messageId===humanB)selected=value.triggerId;}catch{}}}
 const command=step===0?{requestId:'todo-progress',shortText:'Progress',fullText:'Synthetic todo progress only',links:[]}:step===1?{requestId,triggerId:selected??'human:missing-daemon-envelope',shortText:'Answered B',fullText:'The second mid-turn question is answered.',links:[]}:undefined;
 const id=`publish-${step++}`;const usage={input_tokens:20,output_tokens:20};
 const events=[['message_start',{type:'message_start',message:{id:`msg_${id}`,type:'message',role:'assistant',model:'claude-sonnet-4-20250514',content:[],stop_reason:null,stop_sequence:null,usage}}],['content_block_start',{type:'content_block_start',index:0,content_block:command?{type:'tool_use',id,name:'mcp__hyperneo-operations__invoke',input:{}}:{type:'text',text:''}}],['content_block_delta',{type:'content_block_delta',index:0,delta:command?{type:'input_json_delta',partial_json:JSON.stringify({name:'neo.publication.publish',input:command})}:{type:'text_delta',text:'Done.'}}],['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:command?'tool_use':'end_turn',stop_sequence:null},usage}],['message_stop',{type:'message_stop'}]];
 return new Response(events.map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}});
let maxLagMs=0;let previous=performance.now();const timer=setInterval(()=>{const now=performance.now();maxLagMs=Math.max(maxLagMs,now-previous-10);previous=now;},10);
const stream=query({prompt:runner.createMessageGeneratorWrapper(1,undefined,active),options:{cwd:join(run,'workspace'),executable:'bun',pathToClaudeCodeExecutable:resolveSDKCliPath(),model:'claude-sonnet-4-20250514',tools:[],permissionMode:'bypassPermissions',allowDangerouslySkipPermissions:true,settingSources:[],env:{...process.env,ANTHROPIC_BASE_URL:`http://127.0.0.1:${port}`,ANTHROPIC_API_KEY:'sk-devproxy-test-key',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},mcpServers:{'hyperneo-operations':createOperationMcpServer(registry,()=>({sessionId:root,role:'neo',neoTurn:active.identity()}))},stderr:data=>writeFileSync(join(run,'sdk-stderr.log'),data,{flag:'a'}),maxTurns:8}});
const watchdog=setTimeout(()=>{active.dispose();stream.close();},20000);
try{
 for await(const event of stream){active.noteCarried(event);writeFileSync(join(run,'sdk-events.jsonl'),JSON.stringify(event)+'\n',{flag:'a'});if(event.type==='result')break;}
 const after=states();writeFileSync(join(run,'observed.json'),JSON.stringify({before,after,selected,receipts,requests,publications:neo.publications.list(conversation),maxLagMs},null,2));
 assert.equal(before[humanB],'received');assert.equal(selected,`human:${humanB}`);assert.equal(after[humanB],'answered');assert.equal(after[humanA],'received');assert.equal(NEO_MESSAGE_STATUS_LABELS[after[humanB]],'Answered');
 const first=neo.publications.list(conversation)!.find(p=>p.triggerId===selected)!;assert.equal(first.producerInput.messageId,'todo-event');assert.equal(first.askOrigin.messageId,humanB);
 await neo.dispose();db.close();db=new Database(path);await db.initialize(createReactiveDatabase(db));neo=service();const retry=neo.publish({requestId,triggerId:selected,shortText:'Answered B',fullText:'The second mid-turn question is answered.',links:[]},{source:'mcp',sessionId:root,role:'neo',neoTurn:active.identity()});assert.equal(retry.accepted,true);assert.equal(retry.created,false);assert.equal(states()[humanB],'answered');assert(maxLagMs<1000);
 writeFileSync(join(run,'evidence.json'),JSON.stringify({actualSdkMcp:true,actualPromptFeed:true,before,after,durableRetry:true,selected,producerInput:first.producerInput,answer:first.askOrigin,maxLagMs},null,2));console.log(join(run,'evidence.json'));
}finally{clearTimeout(watchdog);active.dispose();queue.clear();queue.stop();stream.close();clearInterval(timer);await server.stop(true);await neo.dispose();db.close();}
