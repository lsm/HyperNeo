import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub } from '../../../packages/shared/src/mod.ts';
import { mappedWatchedRow } from '../../../packages/daemon/tests/unit/helpers/github-watched-read-fixture.ts';

const run=resolve(process.argv.at(-1)!);
const request=MessageHub.prototype.request;
const snapshots: {publicWatched: Record<string,unknown>[];savedWatched:unknown}[]=[];
let listed:Record<string,unknown>[]=[];
MessageHub.prototype.request=async function(...args){
  const reply=await Reflect.apply(request,this,args);
  if(args[0]==='space.github.listWatchedRepos')listed=(reply as {repositories:Record<string,unknown>[]}).repositories;
  if(args[0]==='space.github.listConfig')snapshots.push({publicWatched:listed,savedWatched:(reply as {settings:{watchedRepos:unknown}}).settings.watchedRepos});
  return reply;
};
try { await import('./lane-c-github-watched-repos-read.ts'); } finally { MessageHub.prototype.request=request; }
const characterized=JSON.parse(readFileSync(join(run,'evidence/github-watched-repos-read.json'),'utf8'));
assert.equal(characterized.pass,true);
assert.equal(snapshots.length,2);
for(const snapshot of snapshots)assert.deepEqual(snapshot.savedWatched,snapshot.publicWatched.map(row=>{const result={...row};delete result.spaceId;delete result.pollCursor;return result;}));
const evidence:Record<string,unknown>={publicRpcCharacterization:characterized.publicRpcCharacterization,publicCompleteProjectionPreserved:true,publicSnapshots:snapshots,mainThreadMovementClaim:false};
try {
  const file=new URL('../../../packages/daemon/src/lib/external-events/github/github-watched-projection.ts',import.meta.url);
  assert(existsSync(file),'Saved GitHub watched projection is unavailable');
  const { projectGitHubWatchedRepo }=await import(file.href);
  const expected:Record<string,unknown>={...mappedWatchedRow,webhookSecret:'configured'};
  delete expected.spaceId;delete expected.pollCursor;
  const frozen=Object.freeze({...mappedWatchedRow});
  assert.deepEqual(projectGitHubWatchedRepo(frozen),expected);
  assert(!JSON.stringify(projectGitHubWatchedRepo(frozen)).includes('synthetic-webhook-only'));
  assert(!JSON.stringify(projectGitHubWatchedRepo(frozen)).includes('synthetic-etag'));
  for(const secret of [null,''])assert.equal(projectGitHubWatchedRepo({...mappedWatchedRow,webhookSecret:secret}).webhookSecret,null);
  evidence.pureProjectionSecretMaskAndOmissionsPreserved=true;
  evidence.pass=true;
} finally { writeFileSync(join(run,'evidence/github-watched-projection.json'),JSON.stringify(evidence,null,2)); }
console.log('ok native complete saved/public Space watched projections retain fields, secret masks and private-data omissions');
