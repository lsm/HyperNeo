import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { SDKMessage } from '../../../packages/shared/src/sdk/index.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const [mode, path] = process.argv.slice(2), run = resolve(path);
assert(['before', 'verify'].includes(mode));assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','OPENAI_API_KEY','GH_TOKEN','GITHUB_TOKEN'])assert(!process.env[key]);
for(const dir of ['workspace','evidence','bin'])mkdirSync(join(run,dir),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 2\n',{mode:0o700});process.env.PATH=join(run,'bin')+':'+process.env.PATH;
const denied=join(run,'workspace/denied-marker.txt');
const command="touch '"+denied.replaceAll("'","'\\''")+"'";
let sentTool=false;
const requests: {tool:boolean;followup:boolean}[]=[], errors: unknown[]=[];
const mock=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 const url=new URL(request.url);
 if(url.pathname.endsWith('/models'))return Response.json({data:[{id:'synthetic-denial',type:'model',display_name:'Synthetic denial'}]});
 if(url.pathname.includes('count_tokens'))return Response.json({input_tokens:20});
 if(!url.pathname.endsWith('/messages'))return new Response('{}');
 const input=await request.json() as {stream?:boolean;messages?:unknown[]};const text=JSON.stringify(input.messages);
 const tool=!sentTool&&input.stream===true&&text.includes('PERMISSION_DENIAL_PROOF');if(tool)sentTool=true;
 const followup=text.includes('FOLLOWUP_AFTER_DENIAL');requests.push({tool,followup});
 const content=tool?{type:'tool_use',id:'denied-tool',name:'Bash',input:{command}}:{type:'text',text:followup?'FOLLOWUP_OK':'DENIAL_HANDLED_OK'};
 const usage={input_tokens:20,output_tokens:10};
 if(!input.stream)return Response.json({id:'synthetic-message',type:'message',role:'assistant',model:'synthetic-denial',content:[content],stop_reason:tool?'tool_use':'end_turn',usage});
 const events=[
  ['message_start',{type:'message_start',message:{id:'synthetic-'+requests.length,type:'message',role:'assistant',model:'synthetic-denial',content:[],stop_reason:null,stop_sequence:null,usage}}],
  ['content_block_start',{type:'content_block_start',index:0,content_block:tool?{type:'tool_use',id:'denied-tool',name:'Bash',input:{}}:{type:'text',text:''}}],
  ['content_block_delta',{type:'content_block_delta',index:0,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify({command})}:{type:'text_delta',text:followup?'FOLLOWUP_OK':'DENIAL_HANDLED_OK'}}],
  ['content_block_stop',{type:'content_block_stop',index:0}],
  ['message_delta',{type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage}],
  ['message_stop',{type:'message_stop'}],
 ];
 return new Response(events.map(([event,data])=>'event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
}});assert.notEqual(mock.port,8399);
let app: Awaited<ReturnType<typeof createDaemonApp>>|undefined,transport: WebSocketClientTransport|undefined;
const evidence: Record<string,unknown>={mode,requests,errors};
try {
 app=await createDaemonApp({config:{...getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),disableWorktrees:true},verbose:false});assert.notEqual(app.server.port,8399);
 app.internalEventBus.subscribe('session.error',event=>{errors.push(event);},{subscriberName:'permission-denial-proof'});
 const hub=new MessageHub({defaultSessionId:'global'});transport=new WebSocketClientTransport({url:'ws://127.0.0.1:'+app.server.port+'/ws',autoReconnect:false});hub.registerTransport(transport);await transport.initialize();
 const registry=await hub.request<{servers:{id:string}[]}>('mcp.registry.list',{});
 for(const entry of registry.servers)await hub.request('mcp.registry.setEnabled',{id:entry.id,enabled:false});
 await hub.request('settings.global.update',{updates:{customEndpoints:[{id:'denial-proof',name:'Synthetic denial',type:'anthropic-messages',baseUrl:'http://127.0.0.1:'+mock.port,models:[{id:'synthetic-denial',capabilities:{thinking:false,toolUse:true}}],defaultModelId:'synthetic-denial'}]}});
 const {sessionId}=await hub.request<{sessionId:string}>('session.create',{workspacePath:join(run,'workspace'),title:'Permission denial proof',config:{provider:'custom:denial-proof',model:'synthetic-denial',permissionMode:'dontAsk',sdkToolsPreset:['Bash'],tools:{settingSources:[],loadSettingSources:false}}});evidence.sessionId=sessionId;
 await hub.request('message.send',{sessionId,content:'PERMISSION_DENIAL_PROOF: attempt the scripted synthetic tool, then acknowledge its denial.'});
 const page=()=>hub.request<{sdkMessages:SDKMessage[]}>('message.sdkMessages',{sessionId});
 let current: {sdkMessages:SDKMessage[]}|undefined;
 const until=async(check:()=>Promise<boolean>)=>{const deadline=Date.now()+60000;while(!await check()){assert(Date.now()<deadline,'SDK surface proof deadline');await new Promise(done=>setTimeout(done,100));}};
 await until(async()=>{current=await page();return errors.length>0||JSON.stringify(current).includes('DENIAL_HANDLED_OK');});
 evidence.first=current;
 const denials=current!.sdkMessages.filter(m=>m.type==='system'&&m.subtype==='permission_denied');evidence.denials=denials;
 if(mode==='before'){
  assert.equal(denials.length,0);assert(JSON.stringify(errors).includes('Error processing SDK message. The session has been reset.'));
 }else{
  assert.equal(errors.length,0);assert.equal(denials.length,1);assert.equal(typeof (denials[0] as {message:unknown}).message,'string');
  const initial=await hub.request<{session:{sdkSessionId:string}}>('session.get',{sessionId});assert(initial.session.sdkSessionId);
  await hub.request('message.send',{sessionId,content:'FOLLOWUP_AFTER_DENIAL: respond with the follow-up marker.'});
  await until(async()=>{current=await page();return JSON.stringify(current).includes('FOLLOWUP_OK');});
  const final=await hub.request<{session:{sdkSessionId:string}}>('session.get',{sessionId});
  assert.equal(final.session.sdkSessionId,initial.session.sdkSessionId);assert.equal(errors.length,0);
  assert(!existsSync(denied));
  assert(current!.sdkMessages.some(m=>m.type==='assistant'&&m.message.usage.input_tokens===20));
  evidence.final=current;evidence.sdkSessionId=final.session.sdkSessionId;
 }
 evidence.verified=true;console.log(JSON.stringify({mode,denials:denials.length,errors:errors.length,verified:true}));
}finally{
 writeFileSync(join(run,'evidence/permission-denied.json'),JSON.stringify(evidence,null,2));await transport?.close();await app?.cleanup();await mock.stop(true);
}
