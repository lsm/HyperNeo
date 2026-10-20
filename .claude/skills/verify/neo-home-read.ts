import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
const [port, run] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: neo-home-read.ts <test-port> <run-dir>');
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
const beforeInit = await readdir(root).catch(() => []);
const missing = await rpc('neo.home.read', { path: 'direction.md' });
await writeFile(`${run}/evidence/neo-home-read.json`, JSON.stringify({ missing }, null, 2));
if (!missing.reason?.includes('not_found')) throw new Error(JSON.stringify(missing));
if (JSON.stringify(beforeInit) !== JSON.stringify(await readdir(root).catch(() => []))) throw new Error('Read bootstrapped home');
await writeFile(`${run}/home/.gitconfig`, '[user]\n name = Verify Neo\n email = verify@example.invalid\n[commit]\n gpgsign = false\n');
await rpc('neo.home.init');
const content = '\ufeff  Human direction 🦊\n' + 'Full text.\n'.repeat(60000) + '\n';
await writeFile(`${root}/direction.md`, content);
const head = await git('rev-parse', 'HEAD');
const status = await git('status', '--porcelain');
const read = await rpc('neo.home.read', { path: 'direction.md' });
await writeFile(`${run}/evidence/neo-home-read-response.json`, JSON.stringify(read));
const readStatus = await git('status', '--porcelain');
const internal = await rpc('neo.home.read', { path: '.git/config' });
await mkdir(`${root}/.coordinators/verify`, { recursive: true });
await writeFile(`${root}/.coordinators/verify/transcript.md`, 'Private synthetic transcript.');
const transcript = await rpc('neo.home.read', { path: '.coordinators/verify/transcript.md' });
const absent = await rpc('neo.home.read', { path: 'missing.md' });
const bytes = new Uint8Array([0xff, 0xc3, 0x28]);
await writeFile(`${root}/legacy.md`, bytes);
const statusBeforeInvalid = await git('status', '--porcelain');
const invalid = await rpc('neo.home.read', { path: 'legacy.md' });
const afterBytes = [...await readFile(`${root}/legacy.md`)];
const evidence = { missing, beforeInit, path: read.path, ok: read.ok, length: read.content?.length, expectedLength: content.length, sha256: read.sha256, expectedHash: createHash('sha256').update(content).digest('hex'), internal, transcript, absent, invalid, bytes: [...bytes], afterBytes, head, afterHead: await git('rev-parse', 'HEAD'), status, readStatus, statusBeforeInvalid, afterStatus: await git('status', '--porcelain'), sourceUnchanged: await readFile(`${root}/direction.md`, 'utf8') === content };
await writeFile(`${run}/evidence/neo-home-read.json`, JSON.stringify(evidence, null, 2));
if (!read.ok || read.content !== content || read.sha256 !== evidence.expectedHash || internal.ok || !internal.reason?.includes('path') || transcript.ok || !transcript.reason?.includes('path') || absent.ok || !absent.reason?.includes('not_found') || invalid.ok || !invalid.reason?.includes('UTF-8') || JSON.stringify(afterBytes) !== JSON.stringify([...bytes]) || head !== evidence.afterHead || !evidence.sourceUnchanged || readStatus !== status || evidence.afterStatus !== statusBeforeInvalid) throw new Error('Home read contract failed');
console.log('PASS: real RPC reads full dirty UTF-8 text/hash unchanged, never initializes on read, refuses private paths and preserves non-UTF-8 source bytes.');
