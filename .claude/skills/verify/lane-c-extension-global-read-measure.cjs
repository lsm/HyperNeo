const fs = require('node:fs');
const cp = require('node:child_process');
const ts = require(process.cwd() + '/node_modules/typescript');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const base = cp.execFileSync('git', ['merge-base','HEAD','origin/dev'], {encoding:'utf8'}).trim();
const store = 'packages/daemon/src/lib/external-events/extension-config-store.ts';
const query = 'packages/daemon/src/storage/repositories/global-extension-config-lookup.ts';
const json = 'packages/daemon/src/storage/repositories/extension-config-json.ts';
const read = file => fs.readFileSync(file,'utf8');
const previous = file => cp.execFileSync('git',['show',base+':'+file],{encoding:'utf8'});
function inspect(file, text) {
 const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),units=[],sql=[],declarations={};
 function visit(node){const name=ts.isConstructorDeclaration(node)?'constructor':node.name?.getText(sf);if(name&&(ts.isMethodDeclaration(node)||ts.isFunctionDeclaration(node)||ts.isConstructorDeclaration(node)||ts.isInterfaceDeclaration(node))){declarations[name]=node;units.push({file,name,lines:sf.getLineAndCharacterOfPosition(node.end).line-sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1,sha256:hash(node.getText(sf))});}if((ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))&&node.text.startsWith('SELECT * FROM external_event_extension_configs'))sql.push({text:node.text,sha256:hash(node.text),bytes:Buffer.byteLength(node.text)});ts.forEachChild(node,visit);}visit(sf);return{sf,units,sql,declarations};
}
function bodyShape(text){const sf=ts.createSourceFile('body.ts','function probe(){'+text+'}',ts.ScriptTarget.Latest,true);function shape(n){const children=[];ts.forEachChild(n,c=>{children.push(shape(c));});return children.length?[n.kind,children]:[n.kind,n.text??n.getText(sf)];}return JSON.stringify(shape(sf));}
const old=inspect(store,previous(store)),current=inspect(store,read(store)),lookup=inspect(query,read(query)),parser=inspect(json,read(json));
const before=old.declarations.getGlobalConfig,after=current.declarations.getGlobalConfig;
const moved=before.body.statements.slice(1).map(n=>n.getText(old.sf).replace(/this\.db/g,'db')).join('\n');
const newBody=lookup.declarations.lookupGlobalExtensionConfig.body.statements.map(n=>n.getText(lookup.sf)).join('\n');
if(bodyShape(moved)!==bodyShape(newBody)||JSON.stringify(old.sql)!==JSON.stringify(lookup.sql))throw Error('SELECT/default/return AST or exact SQL bytes changed');
if(after.body.statements.length!==2||after.body.statements[0].getText(current.sf)!==before.body.statements[0].getText(old.sf)||after.body.statements[1].getText(current.sf)!=='return lookupGlobalExtensionConfig(this.db, source);')throw Error('Getter exceeds validated delegation');
for(const [name,target]of[['globalRowToConfig',lookup],['parseJsonRecord',parser]])if(old.declarations[name].body.getText(old.sf)!==target.declarations[name].body.getText(target.sf))throw Error('Moved mapper/parser body changed: '+name);
if(old.declarations.GlobalConfigRow.getText(old.sf)!==lookup.declarations.GlobalConfigRow.getText(lookup.sf))throw Error('Row interface changed');
const omitted=new Set(['getGlobalConfig','globalRowToConfig','parseJsonRecord','GlobalConfigRow']);
for(const row of old.units.filter(r=>!omitted.has(r.name)))if(!current.units.some(r=>r.name===row.name&&r.sha256===row.sha256))throw Error('Other store unit changed: '+row.name);
for(const inspected of[lookup,parser])for(const node of inspected.sf.statements)if(!(ts.isFunctionDeclaration(node)||ts.isInterfaceDeclaration(node)||(ts.isImportDeclaration(node)&&node.importClause?.isTypeOnly)||(ts.isImportDeclaration(node)&&node.moduleSpecifier.text==='./extension-config-json.ts')))throw Error('Lookup/parser gained top-level effects');
const selected=['constructor','getGlobalConfig','getSpaceConfig','listEnabledSpaces','ensureExternalEventExtensionConfigTables','spaceRowToConfig','validateSourceId','validateSpaceId'];
const ownedUnits=current.units.filter(r=>selected.includes(r.name));const fullModules=[query,json].map(file=>({file,lines:read(file).trimEnd().split('\n').length,sha256:hash(read(file))}));
const ownedStoreAndLookupLines=ownedUnits.concat(fullModules).reduce((n,r)=>n+r.lines,0),importLines=2,smokeLines=1;
if(ownedStoreAndLookupLines+importLines+smokeLines>200)throw Error('Owned extraction exceeds 200 lines');
const stableFiles=['packages/daemon/src/lib/external-events/extension-manager.ts','packages/daemon/src/lib/rpc-handlers/index.ts','packages/daemon/src/app.ts','packages/daemon/src/storage/db-gateway/db-op.ts','packages/daemon/src/storage/db-gateway/db-gateway.ts','packages/daemon/src/storage/db-gateway/db-gateway-worker.ts','packages/daemon/src/storage/db-gateway/db-ops.ts'];
const stableDependencies=stableFiles.map(file=>{if(read(file)!==previous(file))throw Error('Caller/framework changed: '+file);return{file,sha256:hash(read(file)),pinnedNotTransitiveAudited:true};});
const smoke='scripts/deno-smoke.sh',registration=read(smoke).split('\n').filter(line=>line.includes('lane-c-extension-global-read-extract.ts'));if(registration.length!==1||read(smoke).replace(registration[0]+'\n','')!==previous(smoke))throw Error('Smoke exceeds one append-only registration');
const delta=cp.execFileSync('git',['diff','--numstat',base,'--','packages/daemon/src',smoke],{encoding:'utf8'}).trim().split('\n').filter(Boolean).map(line=>{const[a,d,file]=line.split('\t');return{file,lines:Number(a)+Number(d)};});for(const file of cp.execFileSync('git',['ls-files','--others','--exclude-standard','--','packages/daemon/src'],{encoding:'utf8'}).trim().split('\n').filter(Boolean))if(!delta.some(row=>row.file===file))delta.push({file,lines:read(file).trimEnd().split('\n').length});for(const d of delta)if(![store,query,json,smoke].includes(d.file))throw Error('Unexpected production change: '+d.file);const changedProductionAndRegistrations=delta.reduce((n,r)=>n+r.lines,0);if(changedProductionAndRegistrations>200)throw Error('Changed production exceeds 200 lines');
console.log(JSON.stringify({base,ownedUnits,fullModules,ownedStoreAndLookupLines,importLines,smokeLines,ownedWithRegistrations:ownedStoreAndLookupLines+importLines+smokeLines,excludedLines:0,delta,changedProductionAndRegistrations,sql:lookup.sql,queryAstSha256:hash(bodyShape(newBody)),queryAndMapperAndParserPreserved:true,otherStoreUnitsUnchanged:true,stableDependencies,netPrepare:0,netRun:0,mainThreadMovementClaim:false,contract:'Constructor-free lookup consumes supplied connection/source and preserves exact SELECT, default/source/flag/null/JSON behavior; shared parser reused by unchanged Space readers. Validation stays in store.',auditLimit:'Complete new lookup/JSON modules and selected store read/setup units counted, no data exclusions. Existing external caller/framework roots pinned, not full public/runtime transitive closure. No worker activation, constructor/other SQL migration or final #8714 claim.'},null,2));
