const ts = require(process.cwd() + '/node_modules/typescript');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const extension = 'packages/daemon/src/lib/external-events/github/github-event-extension.ts';
const helper = 'packages/daemon/src/lib/external-events/github/github-watched-projection.ts';
const repo = 'packages/daemon/src/lib/external-events/github/github-repository.ts';
const store = 'packages/daemon/src/lib/external-events/extension-config-store.ts';
const record = 'packages/daemon/src/lib/record.ts';
const smoke = 'scripts/deno-smoke.sh';
const base = execFileSync('git',['merge-base','HEAD','origin/dev'],{encoding:'utf8'}).trim();
const previous = file => execFileSync('git',['show',base+':'+file],{encoding:'utf8'});
const read = file => fs.readFileSync(file,'utf8');
function shape(text) {
  const sf=ts.createSourceFile('unit.ts',text,ts.ScriptTarget.Latest,true);
  function walk(node){const children=[];ts.forEachChild(node,c=>{children.push(walk(c));});return children.length?[node.kind,children]:[node.kind,node.text??node.getText(sf)];}
  return JSON.stringify(walk(sf));
}
function inspect(file,text){
  const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),units=[];
  function walk(node){if(ts.isMethodDeclaration(node)||ts.isFunctionDeclaration(node)||ts.isConstructorDeclaration(node)){const name=ts.isConstructorDeclaration(node)?'constructor':node.name?.getText(sf);units.push({file,name,lines:sf.getLineAndCharacterOfPosition(node.end).line-sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1,sha256:hash(node.getText(sf)),text:node.getText(sf)});}ts.forEachChild(node,walk);}walk(sf);return units;
}
const old=inspect(extension,previous(extension)),current=inspect(extension,read(extension));
const sf=ts.createSourceFile(extension,previous(extension),ts.ScriptTarget.Latest,true);let arrow;
function walk(node){if(ts.isMethodDeclaration(node)&&node.name.getText(sf)==='persistSpaceConfig'){function nested(n){if(ts.isArrowFunction(n))arrow=n;ts.forEachChild(n,nested);}nested(node);}ts.forEachChild(node,walk);}walk(sf);
const hf=ts.createSourceFile(helper,read(helper),ts.ScriptTarget.Latest,true);const fn=hf.statements.find(ts.isFunctionDeclaration),returned=fn.body.statements[0];
if(!ts.isReturnStatement(returned)||fn.body.statements.length!==1||shape('const projected = '+arrow.body.expression.getText(sf)+';')!==shape('const projected = '+returned.expression.getText(hf)+';'))throw Error('Projection fields/order/secret contract changed');
const importLine="import { projectGitHubWatchedRepo } from './github-watched-projection.ts';\n";
const restored=read(extension).replace(importLine,'').replace('repos.map(projectGitHubWatchedRepo)','repos.map('+arrow.getText(sf)+')');
if(shape(restored)!==shape(previous(extension)))throw Error('Extension changed beyond replacing the projection callback');
const stable=units=>units.filter(u=>u.name!=='persistSpaceConfig').map(({text,...u})=>u);
if(JSON.stringify(stable(old))!==JSON.stringify(stable(current)))throw Error('Other extension functions/methods changed');
const dependencies=[];
for(const file of ['packages/daemon/src/storage/repositories/github-watched-repos-read.ts','packages/daemon/src/storage/repositories/github-space-settings-read.ts','packages/daemon/src/storage/repositories/space-extension-config-persist.ts']){
  if(read(file)!==previous(file))throw Error('Stable complete data dependency changed: '+file);
  dependencies.push({file,lines:read(file).trimEnd().split('\n').length,sha256:hash(read(file))});
}
const units=[];
for(const[file,names]of [[repo,['listWatchedRepos','isSpaceEnabled','getPollingIntent','getFilterCurrentUser']],[store,['setSpaceConfig','validateSpaceConfig','validateSourceId','validateSpaceId']],[record,['isRecord']]]){
  if(read(file)!==previous(file))throw Error('Stable wrapper/validation source changed: '+file);
  units.push(...inspect(file,read(file)).filter(u=>names.includes(u.name)).map(({text,...u})=>u));
}
const caller=current.find(u=>u.name==='persistSpaceConfig');const helperLines=read(helper).trimEnd().split('\n').length;
const fullOwnedGraphLines=helperLines+caller.lines+dependencies.reduce((n,d)=>n+d.lines,0)+units.reduce((n,u)=>n+u.lines,0);
const delta=execFileSync('git',['diff','--numstat',base,'--','packages/daemon/src',smoke],{encoding:'utf8'}).trim().split('\n').filter(Boolean).map(line=>{const[a,d,file]=line.split('\t');return{file,lines:Number(a)+Number(d)};});
for(const d of delta)if(![extension,helper,smoke].includes(d.file))throw Error('Unexpected source scope: '+d.file);
const smokeLines=read(smoke).split('\n').filter(line=>line.includes('lane-c-github-watched-projection.ts'));
if(smokeLines.length!==1||read(smoke).replace(smokeLines[0]+'\n','')!==previous(smoke))throw Error('Smoke exceeds append-only line');
const productionLines=delta.filter(d=>d.file!==smoke).reduce((n,d)=>n+d.lines,0);
if(productionLines+1>200||fullOwnedGraphLines>200)throw Error('Projection slice cap exceeded');
const fixtures=['.claude/skills/verify/lane-c-github-watched-repos-read.ts','.claude/skills/verify/lane-c-github-space-settings-read.ts','.claude/skills/verify/lane-c-github-space-enabled-extract.ts'].map(file=>{if(read(file)!==previous(file))throw Error('Imported fixture changed');return{file,sha256:hash(read(file))};});
console.log(JSON.stringify({base,completeHelper:{file:helper,lines:helperLines,sha256:hash(read(helper))},caller:(({text,...unit})=>unit)(caller),dependencies,stableReadWriteValidationUnits:units,stableReadWriteValidationSubtreeSha256:hash(JSON.stringify({dependencies,units})),fullOwnedGraphLines,productionLines,smokeLines:1,delta,projectionAstUnchanged:true,extensionRestoredAstUnchanged:true,otherExtensionUnits:stable(current),fixtures,netPrepare:0,netRun:0,baselineIncrease:false,mainThreadMovementClaim:false,auditLimit:'Complete owned saved-config projection/read/write/validation subtree counted; wrappers/modules pinned unchanged. Existing initialization, authorization, polling, hooks, other extension/plugin/startup call graphs are not transitively audited. Public reads/writes stay on main; this is pure projection extraction only.'},null,2));
