const ts = require(process.cwd() + '/node_modules/typescript');
const fs = require('node:fs');
const groups = {
 'packages/daemon/src/lib/pairing/pairing-operations.ts': ['fromDoor','SESSION_DOOR_PRINCIPAL','NEEDS_PAIRED_HUMAN','refused'],
 'packages/daemon/src/lib/pairing/upgrade-auth.ts': ['announceDeviceRevoked','revocationListeners','revokedDuringLookups','lookups'],
 'packages/daemon/src/lib/websocket-server-transport.ts': ['closeDevice'],
 'packages/daemon/src/lib/operations/caller.ts': ['isLocalUser'],
 'packages/daemon/src/storage/repositories/device-pairing-repository.ts': ['isActiveDevice','revokeDevice','closeSignal','isActiveDeviceAsync','revokeAsync'],
};
const units=[];
for (const [file,names] of Object.entries(groups)) {
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 const visit=node=> {
  if ((ts.isFunctionDeclaration(node)||ts.isMethodDeclaration(node)||ts.isGetAccessorDeclaration(node)||ts.isVariableDeclaration(node)) && node.name && names.includes(node.name.getText(source))) {
   const start=source.getLineAndCharacterOfPosition(node.getStart(source)).line+1;
   const end=source.getLineAndCharacterOfPosition(node.getEnd()).line+1;
   units.push({file,name:node.name.getText(source),start,end,lines:end-start+1});
  }
  if (ts.isConstructorDeclaration(node) && file.endsWith('/device-pairing-repository.ts')) {
   const start=source.getLineAndCharacterOfPosition(node.getStart(source)).line+1;
   const end=source.getLineAndCharacterOfPosition(node.getEnd()).line+1;
   units.push({file,name:'constructor',start,end,lines:end-start+1});
  }
  ts.forEachChild(node,visit);
 };visit(source);
}
const command='packages/daemon/src/storage/repositories/pairing-revoke-write.ts';
const commandLines=fs.readFileSync(command,'utf8').trimEnd().split('\n').length;
units.push({file:command,name:'whole typed writer command',lines:commandLines});
for(const file of ['packages/daemon/src/lib/pairing/revoke-device.ts','packages/daemon/src/storage/repositories/pairing-state-read.ts']) units.push({file,name:'whole local module',lines:fs.readFileSync(file,'utf8').trimEnd().split('\n').length});
for (const [file, className, names] of [
 ['packages/daemon/src/storage/db-gateway/db-gateway.ts','DbGateway',['closing','closeSignal','close']],
 ['packages/daemon/src/lib/websocket-server-transport.ts','WebSocketServerTransport',['stopRevocations']],
]) {
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 const visit=node=>{
  if(ts.isClassDeclaration(node)&&node.name?.getText(source)===className) for(const member of node.members) if(member.name&&names.includes(member.name.getText(source))){
   const start=source.getLineAndCharacterOfPosition(member.getStart(source)).line+1;
   const end=source.getLineAndCharacterOfPosition(member.getEnd()).line+1;
   units.push({file,name:className+'.'+member.name.getText(source),start,end,lines:end-start+1});
  }
  ts.forEachChild(node,visit);
 };visit(source);
}
{
 const file='packages/daemon/src/lib/pairing/pairing-operations.ts';
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 const record=(node,name)=>{const start=source.getLineAndCharacterOfPosition(node.getStart(source)).line+1;const end=source.getLineAndCharacterOfPosition(node.getEnd()).line+1;units.push({file,name,start,end,lines:end-start+1});};
 const visit=node=>{
  if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='revoke') record(node,'revoker binding');
  if(ts.isCallExpression(node)&&node.expression.getText(source)==='defineOperation'&&node.arguments[0]&&ts.isObjectLiteralExpression(node.arguments[0])){
   const props=node.arguments[0].properties;const name=props.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(source)==='name');const execute=props.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(source)==='execute');
   if(name&&name.initializer.getText(source)==="'device.revoke'"&&execute)record(execute.initializer,'device.revoke execute');
  }
  ts.forEachChild(node,visit);
 };visit(source);
}
{
 const file='packages/daemon/src/lib/operations/database-catalog.ts';
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 const visit=node=>{
  if(ts.isCallExpression(node)&&node.expression.getText(source)==='createDevicePairingOperations'){
   const start=source.getLineAndCharacterOfPosition(node.getStart(source)).line+1;const end=source.getLineAndCharacterOfPosition(node.getEnd()).line+1;units.push({file,name:'real daemon pairing dependency binding',start,end,lines:end-start+1});
  }
  ts.forEachChild(node,visit);
 };visit(source);
}
const total=units.reduce((n,u)=>n+u.lines,0);
console.log(JSON.stringify({units,totalLines:total,sharedGateway:'Only the authorized DbGateway lifetime hook changes; worker lanes, transaction executor and registered command transport are reused.'},null,2));
if(total>200) process.exitCode=1;
