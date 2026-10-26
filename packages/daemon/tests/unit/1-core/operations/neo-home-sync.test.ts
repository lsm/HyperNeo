import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNeoHomeOperations } from '../../../../src/lib/neo/home/operations.ts';
import { NeoHomeRepository } from '../../../../src/lib/neo/home/repository.ts';
import { createNeoQuestionOperations } from '../../../../src/lib/neo/question-operations.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { spawnProcess } from '../../../../src/lib/runtime-spawn/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

let fixture: string;
let root: string;
let remote: string;
let peer: string;
let db: Awaited<ReturnType<typeof createTestDb>>;
let repo: NeoRepository;
let todos: NeoAskTodoRepository;
let home: NeoHomeRepository;
const input = { path: 'digest.md', content: 'Verified progress.\n', message: 'Record progress' };
const runGit = async (cwd: string, args: string[], env?: Record<string, string | undefined>) => {
  const child = spawnProcess(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    ...(env ? { env } : {}),
  });
  const [text, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, text: text.trim(), error };
};
const git = async (cwd: string, ...args: string[]) => {
  const result = await runGit(cwd, args);
  if (result.code) throw new Error(result.error);
  return result.text;
};
const call = async (name: string, input: unknown) => {
  const registry = createOperationRegistry([
    ...createNeoHomeOperations({ repo, todos, defaultSessionId: () => 'neo:root' }, home),
    ...createNeoQuestionOperations(
      todos,
      async () => {},
      async () => ({ ok: true })
    ),
  ]);
  const result = await invokeOperation(registry, name, input, {
    source: 'rpc',
    principal: 'local',
  });
  if (result.kind !== 'completed') throw new Error(result.message);
  return result.value as {
    ok: boolean;
    reason?: string;
    commit?: string;
    questionId?: string;
    question: { id: string };
  };
};
const commit = async (cwd: string, path: string, content: string) => {
  await writeFile(join(cwd, path), content);
  await git(cwd, 'add', '--', path);
  await git(cwd, 'commit', '-m', 'Synthetic change');
};
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'neo-home-sync-'));
  root = join(fixture, 'Neo');
  remote = join(fixture, 'remote.git');
  peer = join(fixture, 'peer');
  await mkdir(root);
  await git(root, 'init', '--quiet', '--initial-branch=main');
  await git(root, 'config', 'user.name', 'Verify Neo');
  await git(root, 'config', 'user.email', 'verify@example.invalid');
  await git(root, 'config', 'commit.gpgsign', 'false');
  db = await createTestDb();
  repo = new NeoRepository(db.getDatabase());
  todos = new NeoAskTodoRepository(db.getDatabase());
  home = new NeoHomeRepository(root, repo);
  await home.init();
  await git(fixture, 'init', '--bare', '--quiet', '--initial-branch=main', remote);
  await git(root, 'remote', 'add', 'origin', remote);
  await git(root, 'push', '-u', 'origin', 'main');
  await git(fixture, 'clone', '--quiet', remote, peer);
  await git(peer, 'config', 'user.name', 'Verify Peer');
  await git(peer, 'config', 'user.email', 'peer@example.invalid');
  await git(peer, 'config', 'commit.gpgsign', 'false');
});
afterEach(async () => {
  db.close();
  await rm(fixture, { recursive: true, force: true });
});

describe('Neo home save remote sync', () => {
  test.each(['global', 'system', 'local', 'command'])(
    'reads and resolves conflicts without executing a %s merge driver',
    async (scope) => {
      await commit(root, '.gitattributes', 'merged.md merge=home-probe\n');
      await commit(root, 'merged.md', 'Base version.\n');
      await git(root, 'push');
      await git(peer, 'pull', '--ff-only');
      const local = 'Human local version.\n';
      await commit(root, 'merged.md', local);
      await commit(peer, 'merged.md', 'Human peer version.\n');
      await git(peer, 'push');
      const marker = join(fixture, 'merge-ran-outside-home');
      const key = 'merge.home-probe.driver';
      const driver = `printf executed > '${marker}'; exit 1`;
      const config = join(fixture, 'merge-gitconfig');
      const previous = new Map(
        [
          'GIT_CONFIG_GLOBAL',
          'GIT_CONFIG_SYSTEM',
          'GIT_CONFIG_NOSYSTEM',
          'GIT_CONFIG_COUNT',
          'GIT_CONFIG_KEY_0',
          'GIT_CONFIG_VALUE_0',
        ].map((key) => [key, process.env[key]])
      );
      if (scope === 'local') await git(root, 'config', key, driver);
      else await git(root, 'config', '--file', config, key, driver);
      if (scope === 'global') process.env.GIT_CONFIG_GLOBAL = config;
      if (scope === 'system') {
        process.env.GIT_CONFIG_SYSTEM = config;
        process.env.GIT_CONFIG_NOSYSTEM = '0';
      }
      if (scope === 'command') {
        process.env.GIT_CONFIG_COUNT = '1';
        process.env.GIT_CONFIG_KEY_0 = key;
        process.env.GIT_CONFIG_VALUE_0 = driver;
      }
      try {
        const conflict = await call('neo.home.read', { path: 'merged.md' });
        expect(await readFile(marker, 'utf8').catch(() => null)).toBeNull();
        expect(conflict.reason).toContain('conflict');
        expect(
          (
            await call('neo.question.answer', {
              questionId: conflict.questionId,
              answer: ['Keep local'],
            })
          ).ok
        ).toBe(true);
        const result = await call('neo.home.save', {
          path: 'merged.md',
          content: local,
          message: 'Apply human choice',
          conflictQuestionId: conflict.questionId,
        });
        expect(await readFile(marker, 'utf8').catch(() => null)).toBeNull();
        expect(result.ok).toBe(true);
        expect(await readFile(join(root, 'merged.md'), 'utf8')).toBe(local);
        expect(await git(remote, 'show', 'main:merged.md')).toBe(local.trim());
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  );
  test.each([
    ['smudge', false],
    ['process', false],
    ['smudge', true],
    ['process', true],
  ])(
    'reads peer progress without executing an inherited %s filter (conditional: %s)',
    async (driver, conditional) => {
      await commit(peer, '.gitattributes', 'peer.md filter=home-probe\n');
      await commit(peer, 'peer.md', 'Unfiltered peer progress.\n');
      await git(peer, 'push');
      const config = join(fixture, 'gitconfig');
      const marker = join(fixture, 'filter-ran-outside-home');
      await git(
        root,
        'config',
        '--file',
        config,
        `filter.home-probe.${driver}`,
        `printf executed > '${marker}'; ${driver === 'process' ? 'exit 1' : 'cat'}`
      );
      await git(root, 'config', '--file', config, 'filter.home-probe.required', 'true');
      const previous = process.env.GIT_CONFIG_GLOBAL;
      if (conditional) {
        const include = join(fixture, 'conditional-gitconfig');
        await writeFile(
          include,
          `[includeIf "gitdir:${root}/.git/worktrees/"]\n path = ${config}\n`
        );
        process.env.GIT_CONFIG_GLOBAL = include;
      } else process.env.GIT_CONFIG_GLOBAL = config;
      try {
        const result = await call('neo.home.read', { path: 'peer.md' }).catch((error) => ({
          ok: false,
          reason: error.message,
        }));
        expect(await readFile(marker, 'utf8').catch(() => null)).toBeNull();
        expect(result.ok).toBe(true);
        expect(await readFile(join(root, 'peer.md'), 'utf8')).toBe('Unfiltered peer progress.\n');
      } finally {
        if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previous;
      }
    }
  );
  test('pulls peer changes, commits and pushes exact content, including an unchanged retry', async () => {
    await commit(peer, 'peer.md', 'Peer progress.\n');
    await git(peer, 'push');
    const saved = await call('neo.home.save', input);
    expect(saved.ok).toBe(true);
    expect(await readFile(join(root, 'peer.md'), 'utf8')).toBe('Peer progress.\n');
    expect(await git(remote, 'show', 'main:digest.md')).toBe(input.content.trim());
    expect(await git(remote, 'rev-parse', 'main')).toBe(saved.commit);
    const count = await git(root, 'rev-list', '--count', 'HEAD');
    expect(await call('neo.home.save', input)).toEqual(saved);
    expect(await git(root, 'rev-list', '--count', 'HEAD')).toBe(count);
    expect(await git(root, 'status', '--porcelain')).toBe('');
  });
  test('aborts conflicting rebase and preserves the local committed version', async () => {
    await commit(root, 'contested.md', 'Base.\n');
    await git(root, 'push');
    await git(peer, 'pull', '--rebase');
    await commit(root, 'contested.md', 'Local choice.\n');
    const head = await git(root, 'rev-parse', 'HEAD');
    await commit(peer, 'contested.md', 'Remote choice.\n');
    await git(peer, 'push');
    expect(await call('neo.home.save', input)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('conflict'),
    });
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await readFile(join(root, 'contested.md'), 'utf8')).toBe('Local choice.\n');
    expect(await readFile(join(root, input.path)).catch(() => null)).toBeNull();
    expect(await git(root, 'status', '--porcelain')).toBe('');
    expect(await git(root, 'status')).not.toContain('rebase in progress');
    expect(await git(remote, 'show', 'main:contested.md')).toBe('Remote choice.');
  });
  test('keeps a local commit after a failed push and retries without another commit', async () => {
    await git(root, 'config', 'remote.origin.receivepack', '/usr/bin/false');
    const before = await git(root, 'rev-list', '--count', 'HEAD');
    const failed = await call('neo.home.save', input);
    expect(failed).toMatchObject({ ok: false, reason: expect.stringContaining('push_failed') });
    const head = await git(root, 'rev-parse', 'HEAD');
    expect(failed.reason).toContain(head);
    expect(await readFile(join(root, input.path), 'utf8')).toBe(input.content);
    expect(await git(root, 'rev-list', '--count', 'HEAD')).toBe(String(Number(before) + 1));
    await git(root, 'config', '--unset', 'remote.origin.receivepack');
    expect(await call('neo.home.save', input)).toMatchObject({ ok: true, commit: head });
    expect(await git(remote, 'rev-parse', 'main')).toBe(head);
    expect(await git(root, 'status', '--porcelain')).toBe('');
  });
  test('refuses a failed pull before creating or committing the requested file', async () => {
    await git(root, 'config', 'remote.origin.uploadpack', '/usr/bin/false');
    const head = await git(root, 'rev-parse', 'HEAD');
    expect(await call('neo.home.save', input)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('sync_failed'),
    });
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await readFile(join(root, input.path)).catch(() => null)).toBeNull();
    expect(await git(root, 'status', '--porcelain')).toBe('');
  });
  test('preserves dirty human work without pulling or writing', async () => {
    await writeFile(join(root, 'README.md'), 'Human draft.');
    const head = await git(root, 'rev-parse', 'HEAD');
    expect(await call('neo.home.save', input)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('dirty'),
    });
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('Human draft.');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
  });
  test('leaves a human rebase paused for editing rather than aborting it', async () => {
    await commit(root, 'local.md', 'Local commit.');
    const editor = join(fixture, 'edit-first');
    await writeFile(
      editor,
      '#!/bin/sh\nsed "1s/^pick /edit /" "$1" > "$1.new"\nmv "$1.new" "$1"\n',
      { mode: 0o755 }
    );
    const stopped = await runGit(root, ['rebase', '-i', 'HEAD~1'], {
      ...process.env,
      GIT_SEQUENCE_EDITOR: editor,
    });
    expect(stopped.code).toBe(0);
    const status = await git(root, 'status');
    expect(status).toContain('editing a commit');
    const head = await git(root, 'rev-parse', 'HEAD');
    expect(await call('neo.home.save', input)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('sync_failed'),
    });
    expect(await git(root, 'status')).toBe(status);
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
  });
  test('rechecks links introduced by a pull before writing through them', async () => {
    const outside = join(fixture, 'outside.md');
    await writeFile(outside, 'Preserve outside.');
    await symlink(outside, join(peer, input.path));
    await git(peer, 'add', input.path);
    await git(peer, 'commit', '-m', 'Synthetic remote link');
    await git(peer, 'push');
    expect(await call('neo.home.save', input)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('path'),
    });
    expect(await readFile(outside, 'utf8')).toBe('Preserve outside.');
    expect(await git(root, 'status', '--porcelain')).toBe('');
  });
  test('pushes a human-confirmed direction and decision log in the same commit', async () => {
    todos.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo:root',
      originMessageId: null,
      title: 'Synthetic direction',
      request: 'Review direction',
      createdAt: 1,
    });
    const value = { ...input, path: 'direction.md' };
    const confirm = {
      path: value.path,
      sha256: createHash('sha256').update(value.content).digest('hex'),
    };
    const question = await call('neo.question.ask', {
      askId: 'ask',
      kind: 'yesno',
      text: `${confirm.path} ${confirm.sha256}`,
      noLabel: 'Keep old',
      yesLabel: 'Use new',
      confirm,
    });
    await call('neo.question.answer', { questionId: question.question.id, answer: 'yes' });
    const saved = await call('neo.home.save', { ...value, questionId: question.question.id });
    expect(saved.ok).toBe(true);
    expect(await git(remote, 'rev-parse', 'main')).toBe(saved.commit);
    expect(await git(remote, 'show', 'main:direction.md')).toBe(value.content.trim());
    expect(await git(remote, 'show', 'main:decisions.md')).toContain(question.question.id);
    expect(await git(remote, 'log', '-1', '--format=%B')).toContain(
      `Neo-Confirmed-By: question ${question.question.id}`
    );
  });
  test('uses origin despite a different configured push default', async () => {
    const elsewhere = join(fixture, 'elsewhere.git');
    await git(fixture, 'init', '--bare', '--quiet', '--initial-branch=main', elsewhere);
    await git(root, 'remote', 'add', 'elsewhere', elsewhere);
    await git(root, 'config', 'remote.pushDefault', 'elsewhere');
    const saved = await call('neo.home.save', input);
    expect(saved.ok).toBe(true);
    expect(await git(remote, 'rev-parse', 'main')).toBe(saved.commit);
    expect((await runGit(elsewhere, ['show-ref', '--heads'])).text).toBe('');
  });
  test('refuses an origin without an upstream before writing', async () => {
    await git(root, 'branch', '--unset-upstream');
    const head = await git(root, 'rev-parse', 'HEAD');
    expect(await call('neo.home.save', input)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('sync_failed'),
    });
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await readFile(join(root, input.path)).catch(() => null)).toBeNull();
  });
  test('does not abort a human rebase started while pull is fetching', async () => {
    await commit(root, 'local.md', 'Local commit.');
    const ready = join(fixture, 'fetch-ready'),
      release = join(fixture, 'fetch-release');
    const upload = join(fixture, 'delayed-upload');
    await writeFile(
      upload,
      `#!/bin/sh\n: > "${ready}"\nwhile [ ! -f "${release}" ]; do sleep 0.02; done\nexec /usr/bin/git-upload-pack "$@"\n`,
      { mode: 0o755 }
    );
    await git(root, 'config', 'remote.origin.uploadpack', upload);
    const pending = call('neo.home.save', input);
    try {
      for (let i = 0; i < 300; i++) {
        if (
          await readFile(ready).then(
            () => true,
            () => false
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await readFile(ready, 'utf8')).toBe('');
      const editor = join(fixture, 'edit-during-fetch');
      await writeFile(
        editor,
        '#!/bin/sh\nsed "1s/^pick /edit /" "$1" > "$1.new"\nmv "$1.new" "$1"\n',
        { mode: 0o755 }
      );
      expect(
        (
          await runGit(root, ['rebase', '-i', 'HEAD~1'], {
            ...process.env,
            GIT_SEQUENCE_EDITOR: editor,
            GIT_REFLOG_ACTION: 'human-race-rebase',
          })
        ).code
      ).toBe(0);
      await writeFile(join(root, 'local.md'), 'Human edits at the stop.');
      const status = await git(root, 'status');
      const head = await git(root, 'rev-parse', 'HEAD');
      await writeFile(release, 'go');
      expect(await pending).toMatchObject({
        ok: false,
        reason: expect.stringContaining('sync_failed'),
      });
      expect(await git(root, 'status')).toBe(status);
      expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
      expect(await readFile(join(root, 'local.md'), 'utf8')).toBe('Human edits at the stop.');
    } finally {
      await writeFile(release, 'go');
      await pending;
    }
  });
  test.each(['uploadpack', 'receivepack'])(
    'bounds stalled %s and releases queued reads without prompting',
    async (transport) => {
      const executable = join(fixture, transport),
        observed = join(fixture, 'network-env');
      await writeFile(
        executable,
        `#!/bin/sh\nprintf '%s|%s|%s' "$GIT_TERMINAL_PROMPT" "$GIT_ASKPASS" "$GIT_SSH_COMMAND" > "${observed}"\nsleep 4\nexit 42\n`,
        { mode: 0o755 }
      );
      await git(root, 'config', `remote.origin.${transport}`, executable);
      home = new NeoHomeRepository(root, repo, 1000);
      const pending = call('neo.home.save', input);
      for (let i = 0; i < 300; i++) {
        if (
          await readFile(observed).then(
            () => true,
            () => false
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await readFile(observed);
      const start = Date.now();
      const queuedRead = call('neo.home.read', { path: 'README.md' });
      const failed = await pending;
      expect(await queuedRead).toMatchObject(
        transport === 'uploadpack'
          ? { ok: false, reason: expect.stringContaining('timed out') }
          : { ok: true }
      );
      expect(Date.now() - start).toBeLessThan(4000);
      expect(failed).toMatchObject({ ok: false, reason: expect.stringContaining('timed out') });
      expect(await readFile(observed, 'utf8')).toBe('0|/usr/bin/false|ssh -oBatchMode=yes');
      expect(await git(root, 'status', '--porcelain')).toBe('');
    },
    10000
  );
  test('keeps homes without an origin local', async () => {
    await git(root, 'remote', 'remove', 'origin');
    const saved = await call('neo.home.save', input);
    expect(saved.ok).toBe(true);
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(saved.commit);
    expect(await git(remote, 'rev-parse', 'main')).not.toBe(saved.commit);
  });
});
