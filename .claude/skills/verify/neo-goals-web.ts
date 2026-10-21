import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit',
  });
  const response = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0);
  assert(!response.reply.error, JSON.stringify(response));
  return response.reply;
}
const root = (await rpc('neo.open', {})).sessionId;
const worker = (await rpc('rpc:session.create', { workspacePath: run, title: 'Other goal owner' })).sessionId;
async function create(ownerSessionId: string, title: string, measured = false) {
  const result = await rpc('goal.session.create', { ownerSessionId, title,
    type: measured ? 'measurable' : 'one_shot', description: 'Synthetic goal definition',
    ...(measured ? { metrics: { readers: 30 }, progress: 30 } : { doneTest: 'Release is public' }),
    cadence: { kind: 'every', everyMs: 3600000 },
  });
  assert(result.accepted, JSON.stringify(result));
  return result.goal.id;
}
const measured = await create(root, 'Publish guide', true);
const paused = await create(root, 'Launch release');
const closed = await create(root, 'Already shipped');
await create(worker, 'Other private goal');
assert((await rpc('goal.session.update', { ownerSessionId: root, goalId: paused, status: 'paused' })).accepted);
assert((await rpc('goal.session.update', { ownerSessionId: root, goalId: closed, status: 'completed' })).accepted);
for (const effect of ['Old draft effect', 'Reached thirty readers']) {
  assert((await rpc('goal.journal.append', { ownerSessionId: root, goalId: measured,
    done: 'Published synthetic guide', effect, worked: 'Show a concrete example', evidence: [],
  })).accepted);
}
writeFileSync(`${run}/evidence/neo-goals-seed.json`, JSON.stringify({ root, measured, paused, closed, worker }, null, 2));
console.log(`Seeded goal list through real RPC: ${run}/evidence/neo-goals-seed.json`);
