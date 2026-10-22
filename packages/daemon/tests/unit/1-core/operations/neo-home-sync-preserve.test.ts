import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NeoHomeRepository } from '../../../../src/lib/neo/home/repository';
import { createNeoHomeOperations } from '../../../../src/lib/neo/home/operations';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { spawnProcess } from '../../../../src/lib/runtime-spawn';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository';
import { createTestDb } from '../../../helpers/database';

let fixture: string, root: string, peer: string, remote: string;
let db: Awaited<ReturnType<typeof createTestDb>>;
let home: NeoHomeRepository;
let previous: Map<string, string | undefined>;
async function git(cwd: string, ...args: string[]) {
  const child = spawnProcess(['git', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(error);
  return out.trim();
}
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'neo-home-preserve-'));
  root = join(fixture, 'Neo');
  peer = join(fixture, 'peer');
  remote = join(fixture, 'remote.git');
  previous = new Map(
    ['PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].map((key) => [key, process.env[key]])
  );
  process.env.GIT_CONFIG_GLOBAL = join(fixture, 'gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  await writeFile(
    process.env.GIT_CONFIG_GLOBAL,
    '[user]\n name = Synthetic Neo\n email = test@example.invalid\n[commit]\n gpgsign = false\n'
  );
  await mkdir(join(fixture, 'bin'));
  await writeFile(
    join(fixture, 'bin/git'),
    `#!/bin/sh\nfor arg do\n if [ "$arg" = merge ] && [ -f '${fixture}/armed' ]; then\n  : > '${fixture}/ready'\n  while [ ! -f '${fixture}/release' ]; do sleep 0.02; done\n fi\ndone\nexec /usr/bin/git "$@"\n`,
    { mode: 0o755 }
  );
  process.env.PATH = `${join(fixture, 'bin')}:${process.env.PATH}`;
  await mkdir(peer);
  await git(peer, 'init', '--quiet', '--initial-branch=main');
  await writeFile(join(peer, '.gitignore'), '.coordinators/\n.claude/\nworktrees/\nprivate/\n');
  await writeFile(join(peer, 'direction.md'), 'Initial\n');
  await git(peer, 'add', '.');
  await git(peer, 'commit', '-m', 'Initial');
  await git(fixture, 'clone', '--bare', peer, remote);
  await git(peer, 'remote', 'add', 'origin', remote);
  db = await createTestDb();
  home = new NeoHomeRepository(root, new NeoRepository(db.getDatabase()));
  expect(await home.init(remote)).toMatchObject({ ok: true });
});
afterEach(async () => {
  await writeFile(join(fixture, 'release'), 'go');
  db?.close();
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(fixture, { recursive: true, force: true });
});
async function call(operation: 'neo.home.read' | 'neo.home.save') {
  const registry = createOperationRegistry(
    createNeoHomeOperations(
      {
        repo: new NeoRepository(db.getDatabase()),
        todos: new NeoAskTodoRepository(db.getDatabase()),
        defaultSessionId: () => 'neo:root',
      },
      home
    )
  );
  const result = await invokeOperation(
    registry,
    operation,
    operation === 'neo.home.read'
      ? { path: 'direction.md' }
      : { path: 'notes.md', content: 'Must not apply', message: 'Synthetic save' },
    { source: 'rpc', principal: 'local' }
  );
  if (result.kind !== 'completed') throw new Error(result.message);
  return result.value;
}

test.each(['neo.home.read', 'neo.home.save'] as const)(
  '%s never overwrites ignored binary human bytes during a fast-forward',
  async (operation) => {
    const path = 'private/report.bin';
    await mkdir(join(peer, 'private'));
    await writeFile(join(peer, path), 'Origin file');
    await git(peer, 'add', '-f', '--', path);
    await git(peer, 'commit', '-m', 'Origin collision');
    await git(peer, 'push', 'origin', 'main');
    const bytes = Buffer.from([0, 255, 128, 10, 42]);
    await mkdir(join(root, 'private'));
    await writeFile(join(root, path), bytes);
    const head = await git(root, 'rev-parse', 'HEAD'),
      reflog = await git(root, 'reflog', 'show', '--format=%H %gs', 'HEAD');
    expect(await call(operation)).toMatchObject({ ok: false });
    expect(await readFile(join(root, path))).toEqual(bytes);
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(root, 'reflog', 'show', '--format=%H %gs', 'HEAD')).toBe(reflog);
    expect(await readFile(join(root, 'notes.md')).catch(() => null)).toBeNull();
  }
);

test.each(['ignored', 'untracked', 'tracked'])(
  'the final publication refuses a late %s file without rollback',
  async (kind) => {
    const path =
      kind === 'ignored'
        ? 'private/report.bin'
        : kind === 'tracked'
          ? 'direction.md'
          : 'untracked.bin';
    await git(root, 'config', 'merge.autoStash', 'true');
    await mkdir(dirname(join(peer, path)), { recursive: true });
    await writeFile(join(peer, path), 'Remote collision');
    await git(peer, 'add', '-f', '--', path);
    await git(peer, 'commit', '-m', 'Remote collision');
    await git(peer, 'push', 'origin', 'main');
    const head = await git(root, 'rev-parse', 'HEAD');
    const reflog = await git(root, 'reflog', 'show', '--format=%H %gs', 'HEAD');
    const ready = join(fixture, 'ready'),
      release = join(fixture, 'release');
    await writeFile(join(fixture, 'armed'), 'go');
    const pending = call('neo.home.read');
    try {
      for (let n = 0; n < 500; n++) {
        if (
          await readFile(ready).then(
            () => true,
            () => false
          )
        )
          break;
        await new Promise((done) => setTimeout(done, 10));
      }
      await readFile(ready);
      const bytes = Buffer.from('Late human bytes\0' + 'Unabridged result'.repeat(1000));
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), bytes);
      await writeFile(release, 'go');
      expect(await pending).toMatchObject({ ok: false });
      expect(await readFile(join(root, path))).toEqual(bytes);
      expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
      expect(await git(root, 'reflog', 'show', '--format=%H %gs', 'HEAD')).toBe(reflog);
    } finally {
      await writeFile(release, 'go');
      await pending;
    }
  }
);

test.each(['same-file', 'directory-collision'])(
  'a rebase conflict keeps ignored human bytes and original history: %s',
  async (kind) => {
    await writeFile(join(root, 'direction.md'), 'Human local choice\n');
    await git(root, 'add', 'direction.md');
    await git(root, 'commit', '-m', 'Human local choice');
    const path = 'private/nested/report.bin',
      remotePath = kind === 'same-file' ? path : 'private';
    await mkdir(dirname(join(peer, remotePath)), { recursive: true });
    await writeFile(join(peer, remotePath), 'Remote collision');
    await writeFile(join(peer, 'direction.md'), 'Other machine choice\n');
    await git(peer, 'add', '-f', '--', remotePath, 'direction.md');
    await git(peer, 'commit', '-m', 'Conflict and collision');
    await git(peer, 'push', 'origin', 'main');
    const bytes = Buffer.from('Complete human result\0' + 'Keep every byte'.repeat(1000));
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
    const head = await git(root, 'rev-parse', 'HEAD'),
      reflog = await git(root, 'reflog', 'show', '--format=%H %gs', 'HEAD');
    expect(await call('neo.home.read')).toMatchObject({ ok: false });
    expect(await readFile(join(root, path))).toEqual(bytes);
    expect(await readFile(join(root, 'direction.md'), 'utf8')).toBe('Human local choice\n');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(root, 'reflog', 'show', '--format=%H %gs', 'HEAD')).toBe(reflog);
    expect(await git(root, 'status', '--porcelain')).toBe('');
  }
);

test.each(['separate-files', 'same-tree'])(
  'diverged nonconflicting histories offer one actionable question: %s',
  async (kind) => {
    if (kind === 'separate-files') {
      await writeFile(join(root, 'local.md'), 'Complete local text\n');
      await git(root, 'add', 'local.md');
      await writeFile(join(peer, 'remote.md'), 'Complete remote text\n');
      await git(peer, 'add', 'remote.md');
    }
    await git(root, 'commit', '--allow-empty', '-m', 'Local history');
    await git(peer, 'commit', '--allow-empty', '-m', 'Remote history');
    await git(peer, 'push', 'origin', 'main');
    const local = await git(root, 'rev-parse', 'HEAD');
    const remoteHead = await git(peer, 'rev-parse', 'HEAD');
    const reflog = await git(root, 'reflog', 'show', '--format=%H %gs', 'HEAD');
    const first = (await call('neo.home.read')) as { ok: boolean; questionId?: string };
    expect(first).toMatchObject({ ok: false, questionId: expect.any(String) });
    expect(await call('neo.home.read')).toMatchObject({ questionId: first.questionId });
    const store = new NeoAskTodoRepository(db.getDatabase());
    const questions = store.listAsks(undefined, 100).flatMap((ask) => store.listQuestions(ask.id));
    expect(questions).toHaveLength(1);
    expect(questions[0].document).toContain(local);
    expect(questions[0].document).toContain(remoteHead);
    if (kind === 'separate-files') {
      expect(questions[0].document).toContain('Complete local text\n');
      expect(questions[0].document).toContain('Complete remote text\n');
      expect(await readFile(join(root, 'local.md'), 'utf8')).toBe('Complete local text\n');
      expect(await readFile(join(root, 'remote.md')).catch(() => null)).toBeNull();
    }
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(local);
    expect(await git(root, 'reflog', 'show', '--format=%H %gs', 'HEAD')).toBe(reflog);
    expect(await git(remote, 'rev-parse', 'main')).toBe(remoteHead);
  }
);
