const fs = require('node:fs');
const cp = require('node:child_process');
const ts = require(process.cwd() + '/node_modules/typescript');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const base = cp.execFileSync('git',['merge-base','HEAD','origin/dev'],{encoding:'utf8'}).trim();
const store='packages/daemon/src/lib/external-events/extension-config-store.ts',smoke='scripts/deno-smoke.sh';
const read=file=>fs.readFileSync(file,'utf8');
const previous=file=>cp.execFileSync('git',['show',base+':'+file],{encoding:'utf8'});
function inspect(file,text){
 const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),units=[];
 function visit(n){if(ts.isMethodDeclaration(n)||ts.isFunctionDeclaration(n)||ts.isConstructorDeclaration(n)){const name=ts.isConstructorDeclaration(n)?'constructor':n.name?.getText(sf);units.push({file,name,lines:sf.getLineAndCharacterOfPosition(n.end).line-sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1,sha256:hash(n.getText(sf))});}ts.forEachChild(n,visit);}visit(sf);return units;
}
const normalized=read(store).replace("import { globalExtensionConfigReads } from '../../storage/repositories/global-extension-config-read.ts';","import { lookupGlobalExtensionConfig } from '../../storage/repositories/global-extension-config-lookup.ts';").replace('return gatewayFor(this.db).run(globalExtensionConfigReads, { source });','return lookupGlobalExtensionConfig(this.db, source);');
if(normalized!==previous(store))throw Error('Store exceeds getter import/call swap');
const selected=['constructor','getGlobalConfig','getSpaceConfig','listEnabledSpaces','ensureExternalEventExtensionConfigTables','spaceRowToConfig','validateSourceId','validateSpaceId'];
const ownedUnits=inspect(store,read(store)).filter(r=>selected.includes(r.name));if(ownedUnits.length!==selected.length)throw Error('Missing read/setup unit');
const specs=[
 ['global-extension-config-read.ts',16],
 ['global-extension-config-lookup.ts',39],
 ['extension-config-json.ts',9],
];
const fullModules=specs.map(([name,lines])=>{const file='packages/daemon/src/storage/repositories/'+name,text=read(file);if(text!==previous(file)||text.trimEnd().split('\n').length!==lines)throw Error('Merged data module changed: '+name);return{file,lines,sha256:hash(text),counted:true};});
const stableFiles=['packages/daemon/src/lib/external-events/extension-manager.ts','packages/daemon/src/lib/rpc-handlers/index.ts','packages/daemon/src/app.ts','packages/daemon/src/storage/db-gateway/db-op.ts','packages/daemon/src/storage/db-gateway/db-gateway.ts','packages/daemon/src/storage/db-gateway/db-gateway-worker.ts','packages/daemon/src/storage/db-gateway/db-ops.ts'];
const stableDependencies=stableFiles.map(file=>{if(read(file)!==previous(file))throw Error('Public/framework file changed: '+file);return{file,sha256:hash(read(file)),pinnedNotTransitiveAudited:true};});
const registrations=read(smoke).split('\n').filter(line=>line.includes('lane-c-extension-global-reader-activation.ts'));if(registrations.length!==1||read(smoke).replace(registrations[0]+'\n','')!==previous(smoke))throw Error('Smoke exceeds one append-only registration');
const delta=cp.execFileSync('git',['diff','--numstat',base,'--','packages/daemon/src',smoke],{encoding:'utf8'}).trim().split('\n').filter(Boolean).map(line=>{const[a,d,file]=line.split('\t');return{file,lines:Number(a)+Number(d)};});
for(const file of cp.execFileSync('git',['ls-files','--others','--exclude-standard','--','packages/daemon/src'],{encoding:'utf8'}).trim().split('\n').filter(Boolean))if(!delta.some(row=>row.file===file))delta.push({file,lines:read(file).trimEnd().split('\n').length});
for(const row of delta)if(![store,smoke].includes(row.file))throw Error('Unexpected production change: '+row.file);
const ownedStoreLines=ownedUnits.reduce((n,row)=>n+row.lines,0),ownedModuleLines=fullModules.reduce((n,row)=>n+row.lines,0),importLines=1,smokeLines=1,ownedWithRegistrations=ownedStoreLines+ownedModuleLines+importLines+smokeLines,changedProductionAndRegistrations=delta.reduce((n,row)=>n+row.lines,0);
if(ownedWithRegistrations>200||changedProductionAndRegistrations>200)throw Error('Activation exceeds 200 lines');
console.log(JSON.stringify({base,ownedUnits,fullModules,ownedStoreLines,ownedModuleLines,importLines,smokeLines,ownedWithRegistrations,excludedDataLines:0,delta,changedProductionAndRegistrations,stableDependencies,otherStoreBytesUnchanged:true,contract:'Validated source getter awaits extension.global.config.read; data-only source, complete configuration result, existing read-lane snapshot; public list rejects on infrastructure failure, no fallback/retry/cache. Main-side lifecycle and existing writer remain unchanged.',auditLimit:'Complete reader/lookup/JSON modules and owned store read/setup units counted, no data exclusions. Unchanged public caller/app/framework identities pinned, not a full transitive runtime audit. Target global SELECT denied after startup during actual public RPCs; constructor DDL, Space reads, startup/drain, GUI and live deployment are separate. Final #8714 incomplete.',netPrepare:0,netRawRun:1,netSqlWrites:0,rawRunNote:"The scanner counts the gateway .run delegation as one run call; SQLite write ownership is unchanged and the baseline file is unchanged.",baselineIncrease:false},null,2));
