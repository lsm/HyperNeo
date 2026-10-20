import { mkdir, readFile, writeFile } from 'node:fs/promises';
const [port, run] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: neo-home-review.ts <test-port> <run-dir>');
const log = await readFile(`${run}/daemon.log`, 'utf8');
if (!log.includes('HyperNeo Test Server') || !log.includes(`Database: ${run}/data/daemon.db`)) throw new Error('Not an isolated test daemon');
const root = `${run}/data/Neo`;
async function git(...args: string[]) {
  const process = Bun.spawn(['git', ...args], { cwd: root, env: { HOME: `${run}/home`, PATH: '/usr/bin:/bin', NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' });
  const [text, error, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code) throw new Error(error);
  return text.trim();
}
await mkdir(`${root}/human-private`, { recursive: true });
await writeFile(`${root}/human-private/draft.md`, 'Synthetic private draft.\n');
await writeFile(`${root}/.gitignore`, '.coordinators/\nhuman-private/\n');
await mkdir(`${root}/projects/review`, { recursive: true });
await writeFile(`${root}/projects/review/mandate.md`, 'Human mandate.\n');
await git('add', '--', '.gitignore', 'projects/review/mandate.md');
await git('commit', '-m', 'Seed review fixture');
const head = await git('rev-parse', 'HEAD');
const direction = await readFile(`${root}/direction.md`, 'utf8');
const protectedCases = ['Direction.md', 'DIRECTION.MD', 'projects/review/MANDATE.md'].map((path) => ({ name: 'neo.home.save', input: { path, content: 'Unconfirmed change.', message: 'Must refuse' }, reason: 'confirmation_required' }));
const invalidCases = ['projects/review', 'README.md/child.md'].flatMap((path) => [
  { name: 'neo.home.read', input: { path }, reason: 'invalid_path' },
  { name: 'neo.home.save', input: { path, content: 'Not a document.', message: 'Must refuse' }, reason: 'invalid_path' },
]);
const results = [];
for (const check of [...protectedCases, ...invalidCases]) {
  const process = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', check.name, JSON.stringify(check.input)], { env: { ...globalThis.process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const output = JSON.parse(await new Response(process.stdout).text());
  if (await process.exited) throw new Error(`RPC transport failed: ${check.name}`);
  results.push({ ...check, reply: output.reply.value ?? output.reply });
}
const evidence = { results, head, afterHead: await git('rev-parse', 'HEAD'), direction, afterDirection: await readFile(`${root}/direction.md`, 'utf8'), mandate: await readFile(`${root}/projects/review/mandate.md`, 'utf8') };
await writeFile(`${run}/evidence/neo-home-review.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
if (results.some(({ reason, reply }) => reply.ok !== false || !reply.reason?.startsWith(reason)) || evidence.head !== evidence.afterHead || evidence.direction !== evidence.afterDirection || evidence.mandate !== 'Human mandate.\n') throw new Error('Home review journey failed');
console.log('PASS: case-variant protected saves and non-document paths are refused without changing files or HEAD.');
