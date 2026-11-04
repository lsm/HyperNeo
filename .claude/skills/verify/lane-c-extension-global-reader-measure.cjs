const fs = require('node:fs');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const base = cp.execFileSync('git',['merge-base','HEAD','origin/dev'],{encoding:'utf8'}).trim();
const command = 'packages/daemon/src/storage/repositories/global-extension-config-read.ts';
const registry = 'packages/daemon/src/storage/db-gateway/db-ops.ts';
const smoke = 'scripts/deno-smoke.sh';
const read = file => fs.readFileSync(file,'utf8');
const previous = file => cp.execFileSync('git',['show',base+':'+file],{encoding:'utf8'});
const specs = [
 ['packages/daemon/src/storage/repositories/global-extension-config-lookup.ts',39,'941146b03ce91e3e981216a6a9fca808f3f7f6dfce8b4d7ac31249f75b9240e2'],
 ['packages/daemon/src/storage/repositories/extension-config-json.ts',9,'eb2b9892e29402f0f8c75c7cfb3c487e643ac76d18308b658d79fe7f382bb16a'],
];
const fullModules = [command,...specs.map(row=>row[0])].map(file=>({file,lines:read(file).trimEnd().split('\n').length,sha256:hash(read(file))}));
for(const[file,lines,expected]of specs)if(read(file)!==previous(file)||read(file).trimEnd().split('\n').length!==lines||hash(read(file))!==expected)throw Error('Merged lookup/JSON module changed: '+file);
const importLine = "import { globalExtensionConfigReads } from '../repositories/global-extension-config-read.ts';\n";
const opLine = '    globalExtensionConfigReads,\n';
if(!read(registry).includes(importLine)||!read(registry).includes(opLine)||read(registry).replace(importLine,'').replace(opLine,'')!==previous(registry))throw Error('Registry exceeds two append-only lines');
const registration = read(smoke).split('\n').filter(line=>line.includes('lane-c-extension-global-reader-command.ts'));
if(registration.length!==1||read(smoke).replace(registration[0]+'\n','')!==previous(smoke))throw Error('Smoke exceeds one append-only registration');
const stableFiles=['packages/daemon/src/lib/external-events/extension-config-store.ts','packages/daemon/src/lib/external-events/extension-manager.ts','packages/daemon/src/lib/rpc-handlers/index.ts','packages/daemon/src/app.ts','packages/daemon/src/storage/db-gateway/db-op.ts','packages/daemon/src/storage/db-gateway/db-gateway.ts','packages/daemon/src/storage/db-gateway/db-gateway-worker.ts'];
const stableDependencies=stableFiles.map(file=>{if(read(file)!==previous(file))throw Error('Public/framework file changed: '+file);return{file,sha256:hash(read(file)),pinnedNotTransitiveAudited:true};});
const registryLines=2,smokeLines=1,ownedModuleLines=fullModules.reduce((n,row)=>n+row.lines,0),ownedWithRegistrations=ownedModuleLines+registryLines+smokeLines;
const delta=cp.execFileSync('git',['diff','--numstat',base,'--','packages/daemon/src',smoke],{encoding:'utf8'}).trim().split('\n').filter(Boolean).map(line=>{const[a,d,file]=line.split('\t');return{file,lines:Number(a)+Number(d)};});
for(const file of cp.execFileSync('git',['ls-files','--others','--exclude-standard','--','packages/daemon/src'],{encoding:'utf8'}).trim().split('\n').filter(Boolean))if(!delta.some(row=>row.file===file))delta.push({file,lines:read(file).trimEnd().split('\n').length});
for(const row of delta)if(![command,registry,smoke].includes(row.file))throw Error('Unexpected production edit: '+row.file);
const changedProductionAndRegistrations=delta.reduce((n,row)=>n+row.lines,0);if(ownedWithRegistrations>200||changedProductionAndRegistrations>200)throw Error('Construction exceeds 200 lines');
console.log(JSON.stringify({base,fullModules,ownedModuleLines,registryLines,smokeLines,ownedWithRegistrations,excludedLines:0,delta,changedProductionAndRegistrations,stableDependencies,contract:'extension.global.config.read: data-only source argument, complete configuration result, one named direct pipeline using the unchanged lookup/JSON functions; existing read lane owns snapshot, no write/callback/cache/retry policy.',auditLimit:'Complete new operation plus merged lookup/JSON modules counted, no data exclusions. Public getter/caller/app/framework identities pinned, not a full transitive runtime audit. Direct native reader commands are measured with target main SQL denied; public list/disable/health comparisons run outside that trap. This construction does not activate the public getter, move constructor/other SQL, or complete #8714.',publicGetterActivatedInThisSlice:false,netPrepare:0,netRun:0,baselineIncrease:false},null,2));
