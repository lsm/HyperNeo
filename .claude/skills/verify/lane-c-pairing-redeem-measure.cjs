const ts = require(process.cwd() + '/node_modules/typescript');
const fs = require('node:fs');
const groups = {
 'packages/daemon/src/lib/pairing/pairing-limiter.ts': ['createPairingLimiter'],
 'packages/daemon/src/lib/pairing/pair-route.ts': ['readBoundedText','parseJson','answer','deviceCookie','answerPaired','createPairRoute'],
 'packages/daemon/src/storage/repositories/device-pairing-repository.ts': ['hash','normalizePairingCode','redeemAsync','redeem','isAwaitingApproval','humanRecoveryOpen'],
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
  ts.forEachChild(node,visit);
 };visit(source);
}
const command='packages/daemon/src/storage/repositories/pairing-redeem-write.ts';
const commandLines=fs.readFileSync(command,'utf8').trimEnd().split('\n').length;
units.push({file:command,name:'whole typed writer command',lines:commandLines});
const total=units.reduce((n,u)=>n+u.lines,0);
console.log(JSON.stringify({units,totalLines:total,sharedGateway:'Unchanged transaction executor and typed .call plumbing are reused; not moved or edited.'},null,2));
if(total>200) process.exitCode=1;
