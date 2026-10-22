import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { spawnProcess } from '../../../packages/daemon/src/lib/runtime-spawn/index.ts';

const [run, mode = 'shared'] = process.argv.slice(2);
assert(run?.startsWith('/') && process.env.NODE_ENV === 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.GIT_CONFIG_GLOBAL, join(run, 'gitconfig'));
await writeFile(join(run, 'gitconfig'), '[user]\n name = Synthetic Neo\n email = verify@example.invalid\n[commit]\n gpgsign = false\n');
async function git(cwd: string, args: string[], allowFailure = false) {
  const child = spawnProcess(['git', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code && !allowFailure) throw new Error(error);
  return text.trim();
}
const source = join(run, 'first-machine');
const remote = join(run, 'shared.git');
await mkdir(source);
await writeFile(join(source, '.gitignore'), '.coordinators/\n.claude/\nworktrees/\n');
await writeFile(join(source, 'README.md'), '# Synthetic shared home\n');
await writeFile(join(source, 'direction.md'), 'Human direction from the first machine\n');
if (mode === 'nested') {
  await mkdir(join(source, 'projects'));
  await writeFile(join(source, 'projects', 'shared.md'), 'Remote document');
}
await git(source, ['init', '--initial-branch=main', '--quiet']);
await git(source, ['add', '.']);
await git(source, ['commit', '-m', 'First machine shared home']);
await git(run, ['clone', '--bare', source, remote]);
const root = join(run, 'data', 'Neo');
const privateFile = join(root, '.coordinators', 'second', 'transcript.md');
await mkdir(join(root, '.coordinators', 'second'), { recursive: true });
await writeFile(privateFile, 'Private second-machine transcript');
const evidence: Record<string, unknown> = { run, source, remote, root, mode };
let daemon: Awaited<ReturnType<typeof import('../../../packages/daemon/src/app.ts').createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
let observer: ReturnType<typeof watch> | undefined;
try {
  const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
  const { getConfig } = await import('../../../packages/daemon/src/config.ts');
  daemon = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', dbPath: join(run, 'data', 'daemon.db'), workspaceRoot: run }), port: 0, disableWorktrees: true, disableGoalProcessing: true }, standalone: false, verbose: false });
  assert.notEqual(daemon.server.port, 8399);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${daemon.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport); await transport.initialize();
  const call = (name: string, input: unknown) => hub.request<Record<string, unknown>>('operation.invoke', { name, input });
  if (mode === 'existing') {
    await call('neo.home.init', {});
    evidence.beforeHead = await git(root, ['rev-parse', 'HEAD']);
  }
  if (mode === 'nested') {
    evidence.intervened = false;
    observer = watch(root, (_event, name) => {
      if (evidence.intervened || String(name) !== 'projects' || !existsSync(join(root, 'projects'))) return;
      evidence.intervened = true;
      writeFileSync(join(root, 'projects', 'human.txt'), 'Human nested file');
      mkdirSync(join(root, '.git'));
      writeFileSync(join(root, '.git', 'human.txt'), 'Human metadata');
    });
  }
  const remoteUrl = mode === 'missing' ? join(run, 'missing.git') : remote;
  evidence.reply = await call('neo.home.init', { remoteUrl });
  evidence.contents = await readFile(join(root, 'direction.md'), 'utf8').catch(() => null);
  evidence.origin = await git(root, ['remote', 'get-url', 'origin'], true);
  evidence.transcript = await readFile(privateFile, 'utf8');
  evidence.entries = await readdir(root);
  assert.equal(evidence.transcript, 'Private second-machine transcript');
  if (mode === 'nested') {
    evidence.humanFile = await readFile(join(root, 'projects', 'human.txt'), 'utf8').catch(() => null);
    assert.equal(evidence.intervened, true, 'human intervention was not observed; inconclusive race fixture');
    assert.equal((evidence.reply as { ok: boolean }).ok, false);
    assert.match(String((evidence.reply as { reason: string }).reason), /clone_failed/);
    assert.equal(evidence.humanFile, 'Human nested file');
    assert.deepEqual(await readdir(join(root, 'projects')), ['human.txt']);
    assert.equal(await readFile(join(root, '.git', 'human.txt'), 'utf8'), 'Human metadata');
    assert.deepEqual((evidence.entries as string[]).sort(), ['.coordinators', '.git', 'projects']);
  } else if (mode === 'existing') {
    evidence.afterHead = await git(root, ['rev-parse', 'HEAD']);
    assert.equal(evidence.beforeHead, evidence.afterHead);
    assert.equal((evidence.reply as { ok: boolean }).ok, false);
    assert.match(String((evidence.reply as { reason: string }).reason), /local_home_exists.*no origin.*fresh data directory/);
  } else if (mode === 'missing') {
    assert.equal((evidence.reply as { ok: boolean }).ok, false);
    assert.match(String((evidence.reply as { reason: string }).reason), /clone_failed/);
    assert.deepEqual(evidence.entries, ['.coordinators']);
  } else {
    assert.deepEqual(evidence.reply, { ok: true, path: root, projects: [] });
    assert.equal(evidence.contents, 'Human direction from the first machine\n');
    assert.equal(evidence.origin, remote);
    const head = await git(root, ['rev-parse', 'HEAD']);
    assert.equal(head, await git(source, ['rev-parse', 'HEAD']));
    evidence.upstream = await git(root, ['rev-parse', '--abbrev-ref', '@{upstream}']);
    assert.equal(evidence.upstream, 'origin/main');
    assert.equal(await git(root, ['ls-files', '.coordinators']), '');
    assert.equal(await git(root, ['status', '--porcelain']), '');
    evidence.retry = await call('neo.home.init', { remoteUrl });
    assert.equal((evidence.retry as { ok: boolean }).ok, true);
    assert.equal(await git(root, ['rev-parse', 'HEAD']), head);
    evidence.read = await call('neo.home.read', { path: 'direction.md' });
    assert.equal((evidence.read as { content: string }).content, evidence.contents);
    evidence.saved = await call('neo.home.save', { path: 'notes.md', content: 'Second machine note\n', message: 'Second machine note' });
    assert.equal((evidence.saved as { ok: boolean }).ok, true);
    assert.equal(await git(run, ['--git-dir', remote, 'show', 'main:notes.md']), 'Second machine note');
    evidence.sharedSavePushed = true;
  }
  console.log(`PASS: isolated home clone ${mode}. ${run}/evidence/neo-home-clone.json`);
} finally {
  await writeFile(join(run, 'evidence', 'neo-home-clone.json'), JSON.stringify(evidence, null, 2));
  observer?.close();
  await transport?.close();
  await daemon?.cleanup();
}
