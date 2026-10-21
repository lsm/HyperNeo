import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [directory, phase, port = '9386'] = process.argv.slice(2);
const root = realpathSync(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(root, 'home'));
assert.notEqual(port, '8399');
if (phase === 'seed') {
 const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./preview-reads-rpc.ts', import.meta.url)), root, 'seed'], { env: process.env, stdout: 'pipe', stderr: 'inherit' });
 const output = await new Response(child.stdout).text(); assert.equal(await child.exited, 0, output);
 console.log('seeded isolated producer-reference fixture');
} else {
 const rpc = async (name: string, input: unknown) => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./rpc.ts', import.meta.url)), name, JSON.stringify(input)], {
   env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit',
  });
  const result = JSON.parse(await new Response(child.stdout).text()); assert.equal(await child.exited, 0);
  assert(!result.reply.error, JSON.stringify(result)); return result.reply.value ?? result.reply;
 };
 const card = async () => {
  const snapshot = await rpc('neo.snapshot', {});
  const todo = snapshot.todoAsks?.flatMap((entry: { todos: { id: string }[] }) => entry.todos).find((item: { id: string }) => item.id === 'todo');
  assert(todo, 'todo card missing from neo.snapshot'); return todo;
 };
 const evidencePath = join(root, 'evidence', 'producer-refs-rpc.json');
 if (phase === 'publish') {
  const registered = await rpc('artifact.file.register', { requestId: 'producer-refs', context: { kind: 'todo', id: 'todo' }, path: 'report.md', title: 'Streamed report' });
  assert(registered.accepted, JSON.stringify(registered));
  const ref = registered.artifact;
  const before = await card(); assert.equal(before.artifacts, undefined);
  const tick = (artifacts: unknown[]) => rpc('neo.todo.edit', { todoId: 'todo', done: 'met', evidence: 'Report registered and read.', artifacts });
  const refused = [];
  for (const artifacts of [[{ ...ref, title: 'Renamed' }], [{ ...ref, artifactId: 'missing' }], [{ ...ref, daemonId: crypto.randomUUID() }]]) {
   const result = await tick(artifacts); assert.equal(result.ok, false); assert.match(result.reason, /^invalid_artifact_reference:/); refused.push(result.reason);
  }
  assert.equal((await card()).state, 'todo');
  const ticked = await tick([ref]); assert.equal(ticked.ok, true, JSON.stringify(ticked));
  assert.deepEqual(ticked.todo.artifacts, [ref]);
  const shown = await card(); assert.deepEqual(shown.artifacts, [ref]); assert.equal(shown.evidence, 'Report registered and read.');
  assert(!JSON.stringify(shown).includes(root));
  writeFileSync(evidencePath, JSON.stringify({ ref, card: shown, refused }, null, 2));
  console.log('PASS: publish ticked todo card carries the registered reference; forged references refused');
 } else {
  assert.equal(phase, 'restart');
  const { ref } = JSON.parse(readFileSync(evidencePath, 'utf8'));
  const shown = await card(); assert.deepEqual(shown.artifacts, [ref]);
  const metadata = await rpc('artifact.file.get', { artifactId: ref.artifactId }); assert(metadata.accepted); assert.deepEqual(metadata.metadata.artifact, ref);
  writeFileSync(join(root, 'evidence', 'producer-refs-rpc-restart.json'), JSON.stringify({ ref, card: shown, metadata }, null, 2));
  console.log('PASS: restart card reference survives and still opens registered metadata');
 }
}
