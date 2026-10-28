const ts=require(process.cwd()+'/node_modules/typescript');
const fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const hash=text=>createHash('sha256').update(text).digest('hex');
const units=[];const sharedAdapterUnits=[];
const add=(source,file,node,name,group=units)=>{const start=source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,end=source.getLineAndCharacterOfPosition(node.getEnd()).line+1;group.push({file,name,start,end,lines:end-start+1,sha256:hash(node.getText(source))});};
const repository='packages/daemon/src/storage/repositories/workspace-history-repository.ts';
const handler='packages/daemon/src/lib/rpc-handlers/workspace-handlers.ts';
const command='packages/daemon/src/storage/repositories/workspace-history-remove-write.ts';
for(const file of [repository,handler,'packages/daemon/src/lib/rpc-handlers/index.ts','packages/daemon/src/storage/db-gateway/db-gateway.ts']){
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 const visit=node=>{
  if(file===repository&&ts.isClassDeclaration(node)&&node.name?.getText(source)==='WorkspaceHistoryRepository')for(const member of node.members){const name=ts.isConstructorDeclaration(member)?'constructor':member.name?.getText(source);if(['constructor','remove','removeAsync'].includes(name))add(source,file,member,'WorkspaceHistoryRepository.'+name);}
  if(file===handler&&ts.isCallExpression(node)&&node.expression.getText(source)==='messageHub.onRequest'&&node.arguments[0]?.getText(source)==="'workspace.remove'")add(source,file,node.arguments[1],'workspace.remove RPC callback');
  if(file.endsWith('/rpc-handlers/index.ts')&&ts.isCallExpression(node)&&node.expression.getText(source)==='setupWorkspaceHandlers')add(source,file,node,'existing daemon workspace handler binding');
  if(file.endsWith('/db-gateway.ts')&&ts.isFunctionDeclaration(node)&&node.name?.getText(source)==='gatewayFor')add(source,file,node,'unchanged shared gateway binding',sharedAdapterUnits);
  ts.forEachChild(node,visit);
 };visit(source);
}
if(fs.existsSync(command)){const text=fs.readFileSync(command,'utf8');units.push({file:command,name:'whole typed data-only removal command',lines:text.trimEnd().split('\n').length,sha256:hash(text)});}
const base=execFileSync('git',['merge-base','HEAD','origin/dev'],{encoding:'utf8'}).trim();
const delta=execFileSync('git',['diff','--numstat',base,'--','packages/daemon/src','scripts/deno-smoke.sh'],{encoding:'utf8'}).trim().split('\n').filter(Boolean).map(line=>{const[added,removed,file]=line.split('\t');return{file,lines:Number(added)+Number(removed)};});
const totalLines=units.reduce((n,u)=>n+u.lines,0),productionLines=delta.filter(d=>d.file.startsWith('packages/daemon/src/')).reduce((n,d)=>n+d.lines,0),smokeRegistrationLines=delta.filter(d=>d.file==='scripts/deno-smoke.sh').reduce((n,d)=>n+d.lines,0);
for(const {file}of delta)if(![repository,handler,command,'packages/daemon/src/storage/db-gateway/db-ops.ts','scripts/deno-smoke.sh'].includes(file))throw new Error('Unexpected production scope: '+file);
console.log(JSON.stringify({base,units,totalLines,productionLines,smokeRegistrationLines,delta,sharedAdapterUnits,contract:'workspace.remove({path}): {success:boolean}; one data-only writer command, both legacy deletes and membership cascades inside one immediate transaction; no filesystem, callbacks or network inside the command; unknown-outcome errors propagate without replay.',sharedPlumbing:'Unchanged gateway command adapter, SQLite transaction/savepoint and foreign-key machinery are reused. Workspace addition, project-folder mutation, history reads and startup callers are separate.',sqlBaselineChanged:false},null,2));
if(totalLines>200||productionLines+smokeRegistrationLines>200)process.exitCode=1;
