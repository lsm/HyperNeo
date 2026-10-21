import { mkdir, readFile, writeFile } from 'node:fs/promises';
const [port, run, mode = 'race', phase = 'after'] = process.argv.slice(2);
if (!port || !run || port === '8399' || !['race', 'deadline'].includes(mode)) throw new Error('usage: neo-home-sync-faults.ts <test-port> <run-dir> [race|deadline] [before|after]');
const log = await readFile(`${run}/daemon.log`, 'utf8');
if (!log.includes('HyperNeo Test Server') || !log.includes(`Database: ${run}/data/daemon.db`)) throw new Error('Not an isolated test daemon');
const root = `${run}/data/Neo`, remote = `${run}/remote.git`;
async function rpc(name: string, input: unknown = {}) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const result = JSON.parse(await new Response(child.stdout).text());
  if (await child.exited) throw new Error(JSON.stringify(result));
  return result.reply.value ?? result.reply;
}
async function git(args: string[], extra: Record<string,string> = {}) {
  const child = Bun.spawn(['git', ...args], { cwd: root, env: { HOME: `${run}/home`, PATH: '/usr/bin:/bin', NODE_ENV: 'test', ...extra }, stdout: 'pipe', stderr: 'pipe' });
  const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(error);
  return text.trim();
}
await mkdir(`${run}/home`, { recursive: true });
await writeFile(`${run}/home/.gitconfig`, '[user]\n name = Verify Neo\n email = verify@example.invalid\n[commit]\n gpgsign = false\n');
await rpc('neo.home.init');
await git(['init', '--bare', '--quiet', '--initial-branch=main', remote]);
await git(['branch', '-M', 'main']); await git(['remote', 'add', 'origin', remote]); await git(['push', '-u', 'origin', 'main']);
if (mode === 'race') {
  await writeFile(`${root}/local.md`, 'Local commit.'); await git(['add', 'local.md']); await git(['commit', '-m', 'Synthetic local commit']);
}
const ready = `${run}/fetch-ready`, release = `${run}/fetch-release`, envFile = `${run}/network-env`;
const upload = `${run}/held-upload`;
await writeFile(upload, `#!/bin/sh\nprintf '%s|%s|%s' "$GIT_TERMINAL_PROMPT" "$GIT_ASKPASS" "$GIT_SSH_COMMAND" > "${envFile}"\n: > "${ready}"\nwhile [ ! -f "${release}" ]; do sleep 0.05; done\n${mode === 'race' ? 'exec /usr/bin/git-upload-pack "$@"' : 'exit 42'}\n`, { mode: 0o755 });
await git(['config', 'remote.origin.uploadpack', upload]);
const evidence: Record<string,unknown> = { mode, phase };
const started = Date.now();
const pending = rpc('neo.home.save', { path: 'digest.md', content: 'Pending content.\n', message: 'Synthetic network check' });
const releaseTimer = setTimeout(() => { void writeFile(release, 'automatic fixture release'); }, mode === 'deadline' ? 35000 : 5000);
try {
  for (let i = 0; i < 300; i++) {
    if (await readFile(ready).then(() => true, () => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await readFile(ready);
  const queuedRead = mode === 'deadline' ? rpc('neo.home.read', { path: 'README.md' }) : null;
  if (mode === 'race') {
    const editor = `${run}/edit-rebase`;
    await writeFile(editor, '#!/bin/sh\nsed "1s/^pick /edit /" "$1" > "$1.new"\nmv "$1.new" "$1"\n', { mode: 0o755 });
    await git(['rebase', '-i', 'HEAD~1'], { GIT_SEQUENCE_EDITOR: editor, GIT_REFLOG_ACTION: 'human-fixture-rebase' });
    await writeFile(`${root}/local.md`, 'Human edits at the stop.');
    Object.assign(evidence, { beforeStatus: await git(['status']), beforeHead: await git(['rev-parse', 'HEAD']) });
    await writeFile(release, 'human rebase is paused');
  }
  const result = await pending;
  Object.assign(evidence, { result, elapsedMs: Date.now() - started, networkEnv: await readFile(envFile, 'utf8'), queuedRead: queuedRead ? await queuedRead : null, afterStatus: await git(['status']), afterHead: await git(['rev-parse', 'HEAD']), localContent: mode === 'race' ? await readFile(`${root}/local.md`, 'utf8') : null });
  await writeFile(`${run}/evidence/neo-home-sync-${mode}-${phase}.json`, JSON.stringify(evidence, null, 2));
  if (mode === 'race') {
    if (result.ok || !result.reason?.includes('sync_failed') || evidence.beforeStatus !== evidence.afterStatus || evidence.beforeHead !== evidence.afterHead || evidence.localContent !== 'Human edits at the stop.') throw new Error('Save aborted or altered the concurrent human rebase');
  } else if (result.ok || !result.reason?.includes('timed out') || Number(evidence.elapsedMs) >= 33000 || !(evidence.queuedRead as {ok:boolean})?.ok || evidence.networkEnv !== '0|/usr/bin/false|ssh -oBatchMode=yes') throw new Error('Network deadline/prompt suppression or queue recovery failed');
  console.log(`PASS: ${mode} RPC preserves human state or releases the home queue at the noninteractive network deadline.`);
} finally {
  clearTimeout(releaseTimer); await writeFile(release, 'fixture cleanup'); await pending;
}
