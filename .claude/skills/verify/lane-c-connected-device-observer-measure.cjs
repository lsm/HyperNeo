const ts = require(process.cwd() + '/node_modules/typescript');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const units = [];
const record = (file, source, node, name) => {
 const start=source.getLineAndCharacterOfPosition(node.getStart(source)).line+1;
 const end=source.getLineAndCharacterOfPosition(node.getEnd()).line+1;
 units.push({file,name,start,end,lines:end-start+1});
};
for(const file of ['packages/daemon/src/lib/pairing/connected-device-observer.ts','packages/daemon/src/storage/repositories/connected-device-read.ts']) units.push({file,name:'whole observer module',lines:fs.readFileSync(file,'utf8').trimEnd().split('\n').length});
for(const [file,className,names] of [
 ['packages/daemon/src/lib/websocket-server-transport.ts','WebSocketServerTransport',['constructor','initialize','startDeviceObserver','connectedDeviceIds','deviceOf','close','stopStaleConnectionChecker','unregisterClient','notifyConnectionHandlers','closeDevice','stopRevocations','readInactiveDevices','observeDevices']],
 ['packages/daemon/src/storage/repositories/device-pairing-repository.ts','DevicePairingRepository',['constructor','isActiveDevice']],
]){
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 const visit=node=>{
  if(ts.isClassDeclaration(node)&&node.name?.getText(source)===className) for(const member of node.members){
   const name=ts.isConstructorDeclaration(member)?'constructor':member.name?.getText(source);
   if(names.includes(name))record(file,source,member,className+'.'+name);
  }
  ts.forEachChild(node,visit);
 };visit(source);
}
{
 const file='packages/daemon/src/lib/pairing/upgrade-auth.ts';
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 const visit=node=>{
  if((ts.isFunctionDeclaration(node)||ts.isVariableDeclaration(node))&&node.name&&['announceDeviceRevoked','onDeviceRevoked','revocationListeners','revokedDuringLookups','lookups'].includes(node.name.getText(source)))record(file,source,node,node.name.getText(source));
  ts.forEachChild(node,visit);
 };visit(source);
}
{
 const file='packages/daemon/src/app.ts';const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 const visit=node=>{if(ts.isNewExpression(node)&&node.expression.getText(source)==='WebSocketServerTransport')record(file,source,node,'app transport reader binding');ts.forEachChild(node,visit);};visit(source);
}
const totalLines=units.reduce((n,u)=>n+u.lines,0);
const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/dev'], {encoding:'utf8'}).trim();
const delta = execFileSync('git', ['diff', '--numstat', base, '--', 'packages/daemon/src', 'scripts/deno-smoke.sh'], {encoding:'utf8'}).trim().split('\n').filter(Boolean).map(line => { const [added, removed, file] = line.split('\t'); return {file,lines:Number(added)+Number(removed)}; });
const productionLines = delta.filter(d => d.file.startsWith('packages/daemon/src/')).reduce((n,d)=>n+d.lines,0);
const smokeRegistrationLines = delta.filter(d => d.file === 'scripts/deno-smoke.sh').reduce((n,d)=>n+d.lines,0);
console.log(JSON.stringify({units,totalLines,productionLines,smokeRegistrationLines,delta,sharedPlumbing:'Unchanged socket registration, router, timer, logger and gateway transport/transaction adapters are reused.'},null,2));
if(totalLines>200||productionLines+smokeRegistrationLines>200)process.exitCode=1;
