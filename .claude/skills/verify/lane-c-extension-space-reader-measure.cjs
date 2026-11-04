const fs = require('node:fs');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const base = cp.execFileSync('git',['merge-base','HEAD','origin/dev'],{encoding:'utf8'}).trim();
const command = 'packages/daemon/src/storage/repositories/space-extension-config-read.ts';
const registry = 'packages/daemon/src/storage/db-gateway/db-ops.ts';
const smoke = 'scripts/deno-smoke.sh';
const read = file => fs.readFileSync(file,'utf8');
const previous = file => cp.execFileSync('git',['show',base+':'+file],{encoding:'utf8'});
const specs = [
 ['packages/daemon/src/storage/repositories/space-extension-config-lookup.ts',44,'39e1a76e3b063127197ecb750b2e26f563b5111128d0e35b70fc729d0375c80b'],
 ['packages/daemon/src/storage/repositories/extension-config-json.ts',9,'eb2b9892e29402f0f8c75c7cfb3c487e643ac76d18308b658d79fe7f382bb16a'],
];
const fullModules = [command,...specs.map(row=>row[0])].map(file=>({file,lines:read(file).trimEnd().split('\n').length,sha256:hash(read(file))}));
for(const[file,lines,expected]of specs)if(read(file)!==previous(file)||read(file).trimEnd().split('\n').length!==lines||hash(read(file))!==expected)throw Error('Merged lookup/JSON module changed: '+file);
const importLine = "import {\n  spaceExtensionConfigReads,\n  enabledSpaceExtensionConfigReads,\n} from '../repositories/space-extension-config-read.ts';\n";
const opLines = ['    spaceExtensionConfigReads,\n','    enabledSpaceExtensionConfigReads,\n'];
let normalized=read(registry);if(!normalized.includes(importLine))throw Error('Missing reader imports');normalized=normalized.replace(importLine,'');for(const line of opLines){if(!normalized.includes(line))throw Error('Missing reader registration');normalized=normalized.replace(line,'');}if(normalized!==previous(registry))throw Error('Registry exceeds append-only imports and entries');
const registration = read(smoke).split('\n').filter(line=>line.includes('lane-c-extension-space-reader-command.ts'));
if(registration.length!==1||read(smoke).replace(registration[0]+'\n','')!==previous(smoke))throw Error('Smoke exceeds one append-only registration');
const stableFiles=['packages/daemon/src/lib/external-events/extension-config-store.ts','packages/daemon/src/lib/external-events/extension-manager.ts','packages/daemon/src/lib/external-events/github/github-event-extension.ts','packages/daemon/src/lib/rpc-handlers/index.ts','packages/daemon/src/app.ts','packages/daemon/src/storage/db-gateway/db-op.ts','packages/daemon/src/storage/db-gateway/db-gateway.ts','packages/daemon/src/storage/db-gateway/db-gateway-worker.ts'];
const stableDependencies=stableFiles.map(file=>{if(read(file)!==previous(file))throw Error('Public/framework file changed: '+file);return{file,sha256:hash(read(file)),pinnedNotTransitiveAudited:true};});
const registryLines=6,smokeLines=1,ownedModuleLines=fullModules.reduce((n,row)=>n+row.lines,0),ownedWithRegistrations=ownedModuleLines+registryLines+smokeLines;
const delta=cp.execFileSync('git',['diff','--numstat',base,'--','packages/daemon/src',smoke],{encoding:'utf8'}).trim().split('\n').filter(Boolean).map(line=>{const[a,d,file]=line.split('\t');return{file,lines:Number(a)+Number(d)};});
for(const file of cp.execFileSync('git',['ls-files','--others','--exclude-standard','--','packages/daemon/src'],{encoding:'utf8'}).trim().split('\n').filter(Boolean))if(!delta.some(row=>row.file===file))delta.push({file,lines:read(file).trimEnd().split('\n').length});
for(const row of delta)if(![command,registry,smoke].includes(row.file))throw Error('Unexpected production edit: '+row.file);
const changedProductionAndRegistrations=delta.reduce((n,row)=>n+row.lines,0);if(ownedWithRegistrations>200||changedProductionAndRegistrations>200)throw Error('Construction exceeds 200 lines');
console.log(JSON.stringify({base,fullModules,ownedModuleLines,registryLines,smokeLines,ownedWithRegistrations,excludedLines:0,delta,changedProductionAndRegistrations,stableDependencies,contract:'extension.space.config.read: data-only spaceId/source, exact config or null; extension.space.enabled.read: data-only source, enabled configs ordered by Space id. One named direct pipeline per operation using unchanged lookup/JSON functions; existing read lane owns each snapshot, no write/callback/cache/retry policy.',auditLimit:'Complete new operation plus merged lookup/JSON modules counted, no data exclusions. Public getter/caller/app/framework identities pinned, not a full transitive runtime audit. Direct native reader commands are measured with target main SQL denied; public config/disable/health comparisons run outside that trap. This construction does not activate either public store method, move constructor/other SQL, or complete #8714.',publicGetterActivatedInThisSlice:false,netPrepare:0,netRun:0,baselineIncrease:false},null,2));
