import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
const [candidateText, ownPr] = process.argv.slice(2);
const candidate = Number(candidateText);
assert(Number.isInteger(candidate) && candidate > 0, 'pass the proposed migration number');
const call = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8' }).trim();
call('git', ['fetch', 'origin', 'dev']);
const files = call('git', ['ls-tree', '-r', '--name-only', 'origin/dev', 'packages/daemon/src/storage/schema']).split('\n');
const prs = call('gh', ['api', 'repos/lsm/HyperNeo/pulls?state=open&per_page=100', '--paginate', '--jq', '.[].number']).split('\n').filter(Boolean);
let reservedByOwnPr = false;
for (const pr of prs) {
  const changed = call('gh', ['api', `repos/lsm/HyperNeo/pulls/${pr}/files`, '--paginate', '--jq', '.[].filename']).split('\n');
  if (pr === ownPr) { reservedByOwnPr = changed.some((file) => file.includes(`/schema/m${candidate}-`)); continue; }
  files.push(...changed);
}
const numbers = files.flatMap((file) => { const match = /\/schema\/m(\d+)-/.exec(file); return match ? [Number(match[1])] : []; });
const next = Math.max(...numbers) + 1;
console.log(JSON.stringify({ candidate, next, openPrs: prs, excludedOwnPr: ownPr ?? null, reservedByOwnPr }));
if (reservedByOwnPr) assert(!numbers.includes(candidate), 'migration number collides with dev or another PR');
else assert.equal(candidate, next, `choose next free migration ${next}`);
