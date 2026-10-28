const ts=require(process.cwd()+'/node_modules/typescript');
const fs=require('node:fs');
const {createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const hash=text=>createHash('sha256').update(text).digest('hex');
const dependencies=JSON.parse(fs.readFileSync('.claude/skills/verify/evidence/lane-c-human-reset-coordinator/audited-dependencies.json','utf8'));
for(const group of Object.values(dependencies)) {
 if(hash(JSON.stringify(group.units))!==group.sha256)throw new Error('Dependency manifest hash changed');
 for(const unit of group.units) {
  const text=fs.readFileSync(unit.file,'utf8');
  if(!unit.start){if(hash(text)!==unit.sha256)throw new Error('Dependency module changed: '+unit.file);continue;}
  const source=ts.createSourceFile(unit.file,text,ts.ScriptTarget.Latest,true);
  let found=false;
  const visit=node=>{if(source.getLineAndCharacterOfPosition(node.getStart(source)).line+1===unit.start&&source.getLineAndCharacterOfPosition(node.getEnd()).line+1===unit.end&&hash(node.getText(source))===unit.sha256)found=true;ts.forEachChild(node,visit);};visit(source);
  if(!found)throw new Error('Dependency unit changed: '+unit.file+' '+unit.name);
 }
}
const file='packages/daemon/src/lib/pairing/human-device-reset.ts';
const coordinator='packages/daemon/src/lib/pairing/human-reset-coordinator.ts';
const units=[file,coordinator].map(file=>{const text=fs.readFileSync(file,'utf8');return{file,name:'whole local business module including closures and pipelines',lines:text.trimEnd().split('\n').length,sha256:hash(text)};});
const sharedAdapterUnits=[];
const add=(source,file,node,name,group=units)=>{const start=source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,end=source.getLineAndCharacterOfPosition(node.getEnd()).line+1;group.push({file,name,start,end,lines:end-start+1,sha256:hash(node.getText(source))});};
const groups={
 'packages/daemon/src/lib/pairing/pairing-operations.ts':['fromDoor','SESSION_DOOR_PRINCIPAL'],
 'packages/daemon/src/lib/pairing/upgrade-auth.ts':['announceDeviceRevoked','revocationListeners','revokedDuringLookups','lookups','onDeviceRevoked'],
 'packages/daemon/src/lib/websocket-server-transport.ts':['closeDevice','stopRevocations'],
 'packages/daemon/src/lib/neo/service.ts':['offHumanReset'],
};
for(const[file,names]of Object.entries(groups)){
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 const visit=node=>{
  if((ts.isFunctionDeclaration(node)||ts.isMethodDeclaration(node)||ts.isVariableDeclaration(node)||ts.isPropertyDeclaration(node))&&node.name&&names.includes(node.name.getText(source)))add(source,file,node,node.name.getText(source));
  if(file.endsWith('/neo/service.ts')&&ts.isBinaryExpression(node)&&node.left.getText(source)==='this.notifyPublicationsChanged')add(source,file,node,'existing core publication-event callback');
  ts.forEachChild(node,visit);
 };visit(source);
}
for(const file of ['packages/daemon/src/storage/db-gateway/db-gateway.ts','packages/daemon/src/lib/operations/database-catalog.ts']){
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 const visit=node=>{
  if(ts.isClassDeclaration(node)&&node.name?.getText(source)==='DbGateway')for(const member of node.members)if(member.name&&['closing','closeSignal','close'].includes(member.name.getText(source)))add(source,file,member,'unchanged lifecycle '+member.name.getText(source));
  if(ts.isFunctionDeclaration(node)&&node.name?.getText(source)==='gatewayFor')add(source,file,node,'existing shared gateway binding adapter',sharedAdapterUnits);
  if(ts.isCallExpression(node)&&node.expression.getText(source)==='createHumanDeviceResetOperation')add(source,file,node,'real daemon public operation binding');
  ts.forEachChild(node,visit);
 };visit(source);
}
const base=execFileSync('git',['merge-base','HEAD','origin/dev'],{encoding:'utf8'}).trim();
const delta=execFileSync('git',['diff','--numstat',base,'--','packages/daemon/src','scripts/deno-smoke.sh'],{encoding:'utf8'}).trim().split('\n').filter(Boolean).map(line=>{const [added,removed,file]=line.split('\t');return{file,lines:Number(added)+Number(removed)};});
const productionLines=delta.filter(d=>d.file.startsWith('packages/daemon/src/')).reduce((n,d)=>n+d.lines,0),smokeRegistrationLines=delta.filter(d=>d.file==='scripts/deno-smoke.sh').reduce((n,d)=>n+d.lines,0),totalLines=units.reduce((n,u)=>n+u.lines,0);
for(const d of delta)if(![file,'scripts/deno-smoke.sh'].includes(d.file))throw new Error('Unexpected production scope: '+d.file);
console.log(JSON.stringify({base,units,totalLines,productionLines,smokeRegistrationLines,delta,sharedAdapterUnits,auditedDependencies:dependencies,contract:'createHumanResetCoordinator(gateway, notify)(now): Promise<plain reset receipt>; one writer command per call; exact UUID read-only recovery; original write/notification error retained; one recovery flight; lifetime-owned timer and abort subscription; no notification after gateway close. Public local-door reset uses the coordinator; authorization, reply, atomic reset/notice, callbacks and history remain unchanged.',sharedPlumbing:'Existing Logger/superpipe/runtime APIs and registered gateway adapters reused unchanged; no callbacks or closures cross into transactions.',sqlBaselineChanged:false},null,2));
if(totalLines>200||productionLines+smokeRegistrationLines>200)process.exitCode=1;
