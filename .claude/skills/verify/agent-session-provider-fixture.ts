import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const run=resolve(process.argv[2]);
const mode=process.argv[3]??'verify';
assert(['verify','baseline','full'].includes(mode));
const caseName='fails each delivery once and tells the user every time when an unpinned session has no registered provider';
for(const dir of ['home','bin','evidence'])mkdirSync(join(run,dir),{recursive:true});
writeFileSync(join(run,'bin/gh'),'#!/bin/sh\nexit 1\n',{mode:0o700});
writeFileSync(join(run,'package.json'),'{"type":"module"}');
writeFileSync(join(run,'synthetic-provider.ts'),`
import { setCopilotProviderModuleImporter } from ${JSON.stringify(join(repo,'packages/daemon/src/lib/providers/factory.ts'))};
class SyntheticCopilot {
 id='anthropic-copilot';
 ownsModel(){return false;}
 hasCuratedModelList(){return false;}
 isAvailable(){return true;}
}
setCopilotProviderModuleImporter(async()=>({AnthropicToCopilotBridgeProvider:SyntheticCopilot}) as never);
`);
writeFileSync(join(run,'vitest.config.ts'),`
import base from ${JSON.stringify(join(repo,'packages/daemon/vitest.config.ts'))};
export default {...base,test:{...base.test,setupFiles:[...base.test.setupFiles,${JSON.stringify(join(run,'synthetic-provider.ts'))}]}};
`);
const args=['node_modules/vitest/vitest.mjs','run','tests/unit/1-core/agent/agent-session.test.ts','--config',join(run,'vitest.config.ts')];
if(mode!=='full')args.push('-t',caseName);
const result=spawnSync('node',args,{
 cwd:join(repo,'packages/daemon'),
 env:{HOME:join(run,'home'),PATH:`${join(run,'bin')}:${process.env.PATH}`,NODE_ENV:'test',NO_COLOR:'1'},
 encoding:'utf8',timeout:60000,
});
const output=(result.stdout??'')+(result.stderr??'');
writeFileSync(join(run,'evidence/tests.log'),output);
const proof={mode,caseName,exitCode:result.status,syntheticCopilotAvailable:true,realCredentials:false,verified:mode==='baseline'?result.status===1&&output.includes('Interrupted by user'):result.status===0};
writeFileSync(join(run,'evidence/provider-fixture.json'),JSON.stringify(proof,null,2));
assert(proof.verified,output);
console.log(JSON.stringify(proof));
