import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const binding=JSON.parse(readFileSync(new URL('./evidence/coding-pr-event-routing-db/observed.json',import.meta.url),'utf8')).proofBinding as {
 testedCodeCommit:string;testedGitTree:string;applicationTrees:Record<string,string>;proofBlobs:Record<string,string>;runs:Record<string,string>;postProofChangePolicy:string;
};
assert(binding,'PR event routing proofs have no committed application binding');
const candidate=git('rev-parse',process.argv[2]??'HEAD'),tested=binding.testedCodeCommit;
assert.equal(git('rev-parse',`${tested}^{tree}`),binding.testedGitTree);
git('merge-base','--is-ancestor',tested,candidate);
assert.equal(binding.postProofChangePolicy,'evidence-and-journey-only');
const permitted=(path:string)=>path.startsWith('.claude/skills/verify/evidence/coding-pr-event-routing-db/')||path==='.claude/skills/verify/journeys/coding-pr-event-routing-db.md';
const changed=git('diff','--name-only','--no-renames',tested,candidate).split('\n').filter(Boolean);
assert(changed.every(permitted),`Unproven post-test code changes: ${changed.filter(path=>!permitted(path)).join(', ')}`);
const working=git('diff','--name-only',candidate).split('\n').filter(Boolean);
assert(working.every(permitted),`Unproven working code changes: ${working.filter(path=>!permitted(path)).join(', ')}`);
for(const [path,tree] of Object.entries(binding.applicationTrees))assert.equal(git('rev-parse',`${candidate}:${path}`),tree,`${path} changed after the proofs`);
for(const [path,blob] of Object.entries(binding.proofBlobs))assert.equal(git('rev-parse',`${candidate}:${path}`),blob,`${path} changed after the proofs`);
for(const runtime of ['bun','deno']){
 const folder=binding.runs[runtime];assert(new RegExp(`^${runtime}-verify(?:-\\d+)?$`).test(folder));
 const run=JSON.parse(readFileSync(new URL(`./evidence/coding-pr-event-routing-db/${folder}/run.json`,import.meta.url),'utf8'));
 assert.equal(run.head,tested);assert.equal(run.runtime,runtime);assert.equal(run.mode,'verify');assert.equal(run.exitCode,0);assert.equal(run.temporaryDaemonDataRemoved,true);
 const proof=JSON.parse(readFileSync(new URL(`./evidence/coding-pr-event-routing-db/${folder}/coding-pr-event-routing-db.json`,import.meta.url),'utf8'));
 assert.equal(proof.verified,true);assert.deepEqual(proof.mainSql,[]);
}
console.log(JSON.stringify({verified:true,testedCodeCommit:tested,candidateHead:candidate,applicationTreesUnchanged:true,postProofChanges:changed}));
