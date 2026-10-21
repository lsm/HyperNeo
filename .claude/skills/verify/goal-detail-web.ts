import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
async function rpc(name: string, input: unknown) {
  const response = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8',
  }));
  assert(!response.reply.error, JSON.stringify(response));
  return response.reply;
}
const root = (await rpc('neo.open', {})).sessionId;
const home = `${run}/data/Neo`;
mkdirSync(home, { recursive: true });
function git(...args: string[]) {
  return execFileSync('git', ['-c','user.name=Synthetic Verify','-c','user.email=verify@example.invalid',
    '-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args], {
    cwd:home, env:{ ...process.env, HOME:`${run}/home`, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null' }, encoding:'utf8',
  }).trim();
}
git('init','--quiet');
writeFileSync(`${home}/mandate.md`, '# Adoption\nMake guides useful.\n');
git('add','mandate.md'); git('commit','--quiet','-m','Synthetic mandate');
const bare = `${run}/synthetic-neo-home.git`;
execFileSync('git', ['clone','--quiet','--bare',home,bare]);
git('config',`url.${bare}.insteadOf`,'git@github.com:example/synthetic-neo-home.git');
git('remote','add','origin','git@github.com:example/synthetic-neo-home.git');
git('fetch','--quiet','origin');
git('branch','--set-upstream-to',`origin/${git('branch','--show-current')}`);
const rev = git('rev-parse','HEAD');
const created = await rpc('goal.session.create', {ownerSessionId:root,title:'Publish useful guide',
  description:'Guide for adopters',type:'measurable',metrics:{readers:30,useful:true},
  doneTest:'One hundred readers',nextSteps:['Write examples'],mandateRef:'mandate.md#adoption',mandateRev:rev,
});
assert(created.accepted,JSON.stringify(created));
const goalId = created.goal.id;
const ids = [];
for(let i=1;i<=21;i++) {
  const entry = await rpc('goal.journal.append',{ownerSessionId:root,goalId,
    done:`Published draft ${i}`,effect:`Effect ${i}`,worked:'Repeat concrete examples',failed:'Stop filler',
    evidence:[{kind:'pr',ref:`https://github.com/example/synthetic-repo/pull/${i}`,note:`Guide PR ${i}`}],
  });
  assert(entry.accepted,JSON.stringify(entry));ids.unshift(entry.entry.id);
}
const db = new Database(`${run}/data/daemon.db`);
try { db.exec('PRAGMA busy_timeout=5000');db.query('UPDATE space_goals SET works_note = ? WHERE id = ?').run('Concrete examples work',goalId); }
finally { db.close(); }
assert.equal((await rpc('goal.session.get',{ownerSessionId:root,goalId})).goal.worksNote,'Concrete examples work');
const homeRead = await rpc('neo.home.read',{path:'mandate.md',includeRemote:true});
assert.equal(homeRead.remoteUrl,'https://github.com/example/synthetic-neo-home',JSON.stringify(homeRead));
writeFileSync(`${run}/evidence/goal-detail-seed.json`,JSON.stringify({root,goalId,ids,rev,worksNote:'Synthetic DB fixture; G8 owns writing/compaction.'},null,2));
console.log(`Seeded real goal/home/journal reads: ${run}/evidence/goal-detail-seed.json`);
