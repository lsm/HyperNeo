const ts = require(process.cwd() + '/node_modules/typescript');
const fs = require('node:fs');
const groups = {
 'packages/daemon/src/lib/pairing/pairing-operations.ts': ['fromDoor','SESSION_DOOR_PRINCIPAL','NEEDS_PAIRED_HUMAN','refused'],
 'packages/daemon/src/lib/operations/caller.ts': ['isLocalUser'],
 'packages/daemon/src/storage/repositories/device-pairing-repository.ts': ['isActiveDevice','revokeDevice'],
};
const units=[];
for (const [file,names] of Object.entries(groups)) {
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 const visit=node=> {
  if ((ts.isFunctionDeclaration(node)||ts.isMethodDeclaration(node)||ts.isVariableDeclaration(node)) && node.name && names.includes(node.name.getText(source))) {
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
const total=units.reduce((n,u)=>n+u.lines,0);
console.log(JSON.stringify({units,totalLines:total,sharedGateway:'Unchanged transaction executor and registered command transport are reused; not moved or edited.'},null,2));
if(total>200) process.exitCode=1;
