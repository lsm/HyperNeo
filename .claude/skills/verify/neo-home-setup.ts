import { mkdir, readFile, writeFile } from 'node:fs/promises';
const [port, run] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: neo-home-setup.ts <test-port> <run-dir>');
const log = await readFile(`${run}/daemon.log`, 'utf8');
if (!log.includes('HyperNeo Test Server') || !log.includes(`Database: ${run}/data/daemon.db`)) throw new Error('Not an isolated test daemon');
const root = `${run}/data/Neo`;
async function rpc(name: string, input: unknown = {}) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const result = JSON.parse(await new Response(child.stdout).text());
  if (await child.exited) throw new Error(JSON.stringify(result));
  return result.reply.value ?? result.reply;
}
async function git(...args: string[]) {
  const child = Bun.spawn(['git', ...args], { cwd: root, env: { HOME: `${run}/home`, PATH: '/usr/bin:/bin', NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' });
  const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(error);
  return text.trim();
}
await mkdir(`${root}/.coordinators/verify`, { recursive: true });
await writeFile(`${root}/.coordinators/verify/transcript.md`, 'Synthetic private transcript.');
await writeFile(`${run}/home/.gitconfig`, '[user]\n name = Verify Neo\n email = verify@example.invalid\n[commit]\n gpgsign = false\n');
const project = await rpc('neo.project.save', { title: 'Setup project', summary: '', context: '', expectedRevision: 0 });
const first = await rpc('neo.home.init');
await writeFile(`${run}/evidence/neo-home-setup.json`, JSON.stringify({ first }, null, 2));
if (!first.ok) throw new Error(JSON.stringify(first));
const initialHead = await git('rev-parse', 'HEAD');
const second = await rpc('neo.home.init');
const entry = first.projects.find((p: { id: string }) => p.id === project.project.id);
if (!entry) throw new Error('Project folder not returned');
await rpc('neo.project.save', { id: project.project.id, title: 'Renamed setup', summary: '', context: '', expectedRevision: project.project.revision });
const renamed = await rpc('neo.home.init');
const afterHead = await git('rev-parse', 'HEAD');
const tracked = await git('ls-files');
const direction = await readFile(`${root}/direction.md`, 'utf8');
const author = await git('log', '-1', '--format=%an <%ae>');
await git('update-ref', '-d', 'HEAD');
await git('read-tree', '--empty');
await git('config', 'user.name', '');
await git('config', 'user.email', '');
const failed = await rpc('neo.home.init');
const staged = await git('diff', '--cached', '--name-only');
await git('config', 'user.name', 'Verify Neo');
await git('config', 'user.email', 'verify@example.invalid');
const recovered = await rpc('neo.home.init');
const evidence = { project, first, second, renamed, initialHead, afterHead, tracked, direction, author, failed, staged, recovered, status: await git('status', '--porcelain') };
await writeFile(`${run}/evidence/neo-home-setup.json`, JSON.stringify(evidence, null, 2));
if (!second.ok || initialHead !== afterHead || renamed.projects.find((p: { id: string }) => p.id === project.project.id)?.homePath !== entry.homePath || tracked !== '.gitignore\nREADME.md\ndirection.md' || direction || author !== 'Verify Neo <verify@example.invalid>' || !failed.error || staged || !recovered.ok || evidence.status) throw new Error('Home setup contract failed');
console.log('PASS: RPC initializes one local commit, ignores transcripts, preserves project paths on rename, and recovers after identity configuration.');
