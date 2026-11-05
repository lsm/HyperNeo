const ts = require(process.cwd() + '/node_modules/typescript');
const fs = require('node:fs');
const groups = {
 'packages/daemon/src/lib/pairing/pairing-operations.ts': ['planPairingCode','fromDoor','SESSION_DOOR_PRINCIPAL','NO_HUMAN_DEVICE','refused'],
 'packages/daemon/src/lib/operations/caller.ts': ['isLocalUser'],
 'packages/daemon/src/storage/repositories/device-pairing-repository.ts': ['createCodeAsync','countDevices','isActiveDevice','humanRecoveryOpen','createCode','hash'],
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
  if (ts.isCallExpression(node) && node.expression.getText(source)==='defineOperation' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
   const props=node.arguments[0].properties;
   const name=props.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(source)==='name');
   const execute=props.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(source)==='execute');
   if(name&&name.initializer.getText(source)==="'device.pair.create'"&&execute) {
    const start=source.getLineAndCharacterOfPosition(execute.initializer.getStart(source)).line+1;
    const end=source.getLineAndCharacterOfPosition(execute.initializer.getEnd()).line+1;
    units.push({file,name:'device.pair.create execute',start,end,lines:end-start+1});
   }
  }
  ts.forEachChild(node,visit);
 };visit(source);
}
const command='packages/daemon/src/storage/repositories/pairing-code-create-write.ts';
const commandLines=fs.readFileSync(command,'utf8').trimEnd().split('\n').length;
units.push({file:command,name:'whole typed writer command',lines:commandLines});
const total=units.reduce((n,u)=>n+u.lines,0);
console.log(JSON.stringify({units,totalLines:total,sharedGateway:'Unchanged transaction executor and typed .call plumbing are reused; not moved or edited.'},null,2));
if(total>200) process.exitCode=1;
