import { mkdir, readFile, writeFile } from 'node:fs/promises';
const [port, run] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: neo-home-identity.ts <test-port> <run-dir>');
const log = await readFile(`${run}/daemon.log`, 'utf8');
if (!log.includes('HyperNeo Test Server') || !log.includes(`Database: ${run}/data/daemon.db`)) throw new Error('Not an isolated test daemon');
const root = `${run}/data/Neo`;
await mkdir(root, { recursive: true });
async function git(...args: string[]) {
  const child = Bun.spawn(['git', ...args], { cwd: root, env: { HOME: `${run}/home`, PATH: '/usr/bin:/bin', NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' });
  const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(error);
  return text.trim();
}
async function rpc(name: string, input: unknown = {}) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const output = JSON.parse(await new Response(child.stdout).text());
  if (await child.exited) throw new Error(JSON.stringify(output));
  return output.reply.value ?? output.reply;
}
await git('init', '--quiet');
await git('config', 'user.name', '');
await git('config', 'user.email', '');
const failed = await rpc('neo.home.init');
const stagedAfterFailure = await git('diff', '--cached', '--name-only');
await git('config', 'user.name', 'Verify Neo');
await git('config', 'user.email', 'verify@example.invalid');
const retry = await rpc('neo.home.init');
if (!retry.ok) {
  await git('rm', '--cached', '--ignore-unmatch', '--', 'README.md', '.gitignore', 'direction.md');
  await rpc('neo.home.init');
}
const metadata = await readFile(`${root}/.git/config`, 'utf8');
const hidden = await rpc('neo.home.read', { path: '.GIT/config' });
const missing = await rpc('neo.home.read', { path: 'GIT/config' });
const document = await rpc('neo.home.save', { path: 'GIT/config', content: 'Curated document.', message: 'Save public document' });
const read = await rpc('neo.home.read', { path: 'GIT/config' });
const afterMetadata = await readFile(`${root}/.git/config`, 'utf8');
const evidence = { failed, stagedAfterFailure, retry, hidden, missing, document, read, metadataUnchanged: metadata === afterMetadata };
await writeFile(`${run}/evidence/neo-home-identity.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
if (!failed.error || stagedAfterFailure || !retry.ok || hidden.ok || !hidden.reason?.startsWith('invalid_path') || missing.ok || !missing.reason?.startsWith('not_found') || !document.ok || read.content !== 'Curated document.' || !evidence.metadataUnchanged) throw new Error('Home identity recovery or dot-path boundary failed');
console.log('PASS: failed bootstrap leaves no staged files and retries after identity setup; .GIT is refused, GIT is a separate public folder.');
