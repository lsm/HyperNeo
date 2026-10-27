import { createCodexDesktopAdapter } from '../../../../src/lib/drivers/codex-desktop-adapter';
import { gitWorktreeProject } from '../../../../src/lib/drivers/acp-agent-adapter';
import { workStartPreparation } from '../../../../src/lib/drivers/start-preparation';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { QA_SYSTEM_CONTRACT, REVIEWER_SYSTEM_CONTRACT } from '@hyperneo/prompts';
import {
  prepareCodingExecution,
  requireVerifySkill,
} from '../../../../src/lib/neo/packs/coding/prepare-execution';

const roots: string[] = [];
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(directory: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', env: gitEnv });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'neo-prepare-'));
  roots.push(root);
  const remote = join(root, 'remote');
  const directory = join(root, 'local');
  const destination = join(root, 'prepared');
  git(root, 'init', '--initial-branch=dev', remote);
  git(remote, 'config', 'user.name', 'Test');
  git(remote, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(remote, 'file'), 'old');
  mkdirSync(join(remote, '.claude/skills/verify'), { recursive: true });
  writeFileSync(join(remote, '.claude/skills/verify/SKILL.md'), '# Verify');
  git(remote, 'add', '.');
  git(remote, 'commit', '-m', 'initial');
  git(root, 'clone', remote, directory);
  git(directory, 'config', 'user.name', 'Repo Worker');
  git(directory, 'config', 'user.email', 'repo-worker@example.invalid');
  const before = git(directory, 'rev-parse', 'HEAD');
  writeFileSync(join(remote, 'file'), 'new');
  git(remote, 'commit', '-am', 'remote advance');
  const latest = git(remote, 'rev-parse', 'HEAD');
  writeFileSync(join(directory, 'file'), 'uncommitted user work');
  const calls: string[][] = [];
  const effects = {
    run: async (command: readonly string[], cwd: string) => {
      calls.push([...command]);
      const result = spawnSync(command[0], command.slice(1), {
        cwd,
        encoding: 'utf8',
        env: gitEnv,
      });
      return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
  };
  const request = {
    directory,
    destination,
    parameters: { target: 'dev', prerequisiteCommits: [before] },
  };
  return { remote, directory, destination, before, latest, calls, effects, request };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('createCodexDesktopAdapter with coding preparation', () => {
  test.each([false, true])(
    'a driver receives the fresh remote base, or no thread on fetch failure %s',
    async (failFetch) => {
      const f = fixture();
      if (failFetch) git(f.directory, 'remote', 'set-url', 'origin', join(f.directory, 'missing'));
      const starts: string[] = [];
      const driver = createCodexDesktopAdapter({
        statePath: '/unused',
        worktreesDir: join(f.directory, '.executions'),
        machine: 'local',
        now: Date.now,
        folderExists: existsSync,
        makeFolder: () => {
          throw new Error('Unexpected folder creation');
        },
        homeDir: '/unused',
        gitCheckout: async () => ({ repo: f.directory, linked: false }),
        prepareDesktopProject: async (folder) => {
          expect(folder).toBe(f.directory);
          return 'project-1';
        },
        newId: () => 'prepared-1',
        spawn: () => {
          throw new Error('Unregistered preparation');
        },
        prepareExecution: (request, location) =>
          workStartPreparation.prepare(
            request,
            location,
            [{ id: 'coding', prepareExecution: prepareCodingExecution }],
            f.effects
          ),
        appServer: async () => {
          throw new Error('not used');
        },
        startDesktopTurn: async () => {},
        bootstrapServer: async () => ({
          close: () => {},
          call: async (method, params) => {
            if (method === 'thread/start') {
              starts.push(git(String(params.cwd), 'rev-parse', 'HEAD'));
              return {
                thread: { id: 'fresh' },
                activePermissionProfile: { id: 'hyperneo-worker' },
              };
            }
            return {};
          },
        }),
      });
      const result = await driver.start!(
        {
          place: { machine: 'local', folder: f.directory, name: 'repo' },
          title: 't',
          message: 'm',
          preparation: { pack: 'coding', parameters: { target: 'dev' } },
        },
        { from: 'user', caller: { source: 'rpc' } }
      );
      expect(result.ok).toBe(!failFetch);
      expect(starts).toEqual(failFetch ? [] : [f.latest]);
      expect(git(f.directory, 'rev-parse', 'HEAD')).toBe(f.before);
      expect(readFileSync(join(f.directory, 'file'), 'utf8')).toBe('uncommitted user work');
    }
  );
});

describe('prepareCodingExecution', () => {
  test.each(['review', 'verify'] as const)(
    'pins the PR head and prepares the full %s contract outside the diff',
    async (role) => {
      const f = fixture();
      git(f.remote, 'checkout', '-b', 'candidate');
      writeFileSync(join(f.remote, 'file'), 'candidate change');
      git(f.remote, 'commit', '-am', 'candidate');
      const head = git(f.remote, 'rev-parse', 'HEAD');
      git(f.remote, 'update-ref', 'refs/pull/7/head', head);
      git(f.remote, 'checkout', 'dev');
      const prepared = await prepareCodingExecution(
        { ...f.request, parameters: { pullRequest: 7, head, role } },
        f.effects
      );
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error(prepared.reason);
      try {
        expect(git(prepared.value.directory, 'rev-parse', 'HEAD')).toBe(head);
        expect(readFileSync(join(prepared.value.directory, 'file'), 'utf8')).toBe(
          'candidate change'
        );
        expect(git(prepared.value.directory, 'status', '--porcelain')).toBe('');
        const contract = readFileSync(
          join(prepared.value.directory, '.git/hyperneo-stage-contract.md'),
          'utf8'
        );
        if (role === 'review') expect(contract).toBe(REVIEWER_SYSTEM_CONTRACT);
        else {
          expect(contract.startsWith(QA_SYSTEM_CONTRACT)).toBe(true);
          expect(contract).toContain('## Coding-pack Verify override');
          expect(contract).toContain(
            "skip the shared contract's base-integration checkout and base-OID revalidation"
          );
          expect(contract).toContain('a rebase or any new head requires Verify again');
        }
        expect(git(f.directory, 'rev-parse', 'HEAD')).toBe(f.before);
        expect(readFileSync(join(f.directory, 'file'), 'utf8')).toBe('uncommitted user work');
      } finally {
        await prepared.value.release();
      }
      expect(existsSync(f.destination)).toBe(false);
    }
  );
  test('a changed PR head refuses before creating a worker checkout', async () => {
    const f = fixture();
    git(f.remote, 'update-ref', 'refs/pull/7/head', f.latest);
    const prepared = await prepareCodingExecution(
      { ...f.request, parameters: { pullRequest: 7, head: f.before, role: 'verify' } },
      f.effects
    );
    expect(prepared).toEqual({
      ok: false,
      reason: 'The PR head changed during checkout preparation.',
    });
    expect(existsSync(f.destination)).toBe(false);
  });
  test.each([
    { pullRequest: '7;touch /tmp/unsafe', head: 'a'.repeat(40), role: 'verify' },
    { pullRequest: -1, head: 'a'.repeat(40), role: 'review' },
    { pullRequest: 7, role: 'verify' },
    { pullRequest: 7, head: 'a'.repeat(40), role: 'writer' },
  ])('refuses invalid actor preparation before git effects: %j', async (parameters) => {
    const f = fixture();
    const prepared = await prepareCodingExecution({ ...f.request, parameters }, f.effects);
    expect(prepared).toEqual({ ok: false, reason: 'Invalid pinned coding actor configuration.' });
    expect(f.calls).toEqual([]);
  });
  test('private clones preserve repo-local commit identity and signing configuration only', async () => {
    const f = fixture();
    const settings = {
      'user.signingkey': 'SYNTHETIC-PUBLIC-KEY-ID',
      'commit.gpgsign': 'true',
      'gpg.format': 'ssh',
      'gpg.ssh.program': '/synthetic/signer',
    };
    for (const [key, value] of Object.entries(settings)) git(f.directory, 'config', key, value);
    git(f.directory, 'config', 'credential.helper', 'synthetic-owner-helper');
    git(f.directory, 'config', 'http.extraHeader', 'synthetic-owner-header');
    const prepared = await prepareCodingExecution(f.request, f.effects);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(git(f.destination, 'config', '--local', 'user.name')).toBe('Repo Worker');
    expect(git(f.destination, 'config', '--local', 'user.email')).toBe(
      'repo-worker@example.invalid'
    );
    for (const [key, value] of Object.entries(settings))
      expect(git(f.destination, 'config', '--local', key)).toBe(value);
    for (const key of ['credential.helper', 'http.extraHeader'])
      expect(
        spawnSync('git', ['config', '--local', '--get', key], { cwd: f.destination, env: gitEnv })
          .status
      ).toBe(1);
    await prepared.value.release();
  });

  test('prepared coding work owns its Git objects and refs without hardlinks to main', async () => {
    const f = fixture();
    const prepared = await prepareCodingExecution(f.request, f.effects);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(statSync(join(f.destination, '.git')).isDirectory()).toBe(true);
    expect(git(f.destination, 'rev-parse', '--git-common-dir')).toBe('.git');
    expect(git(f.destination, 'remote', 'get-url', 'origin')).toBe(f.remote);
    expect(await gitWorktreeProject(f.destination)).toBe(f.directory);
    const blob = git(f.directory, 'rev-parse', `${f.latest}:file`);
    const objectPath = join('.git', 'objects', blob.slice(0, 2), blob.slice(2));
    const source = statSync(join(f.directory, objectPath));
    const copy = statSync(join(f.destination, objectPath));
    expect([copy.dev, copy.ino]).not.toEqual([source.dev, source.ino]);
    git(f.destination, 'checkout', '-b', 'worker-change');
    writeFileSync(join(f.destination, 'worker-file'), 'independent worker content');
    git(f.destination, 'add', 'worker-file');
    git(f.destination, 'commit', '-m', 'worker-only commit');
    const workerCommit = git(f.destination, 'rev-parse', 'HEAD');
    expect(
      spawnSync('git', ['cat-file', '-e', workerCommit], { cwd: f.directory }).status
    ).not.toBe(0);
    expect(git(f.directory, 'rev-parse', 'HEAD')).toBe(f.before);
    expect(readFileSync(join(f.directory, 'file'), 'utf8')).toBe('uncommitted user work');
    await prepared.value.release();
    await prepared.value.release();
    expect(existsSync(f.destination)).toBe(false);
    expect(readFileSync(join(f.directory, 'file'), 'utf8')).toBe('uncommitted user work');
  });

  test('LFS content refuses preparation instead of starting a worker with pointer text', async () => {
    const f = fixture();
    writeFileSync(join(f.remote, '.gitattributes'), 'asset.bin filter=lfs\n');
    writeFileSync(
      join(f.remote, 'asset.bin'),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 19\n`
    );
    git(f.remote, 'add', '.');
    git(f.remote, 'commit', '-m', 'synthetic LFS pointer');
    const cache = join(f.directory, '..', 'cached-object');
    writeFileSync(cache, 'synthetic LFS bytes');
    git(f.directory, 'config', 'filter.lfs.smudge', `cat '${cache}'`);
    git(f.directory, 'config', 'filter.lfs.required', 'true');
    git(f.directory, 'fetch', 'origin');
    const linked = join(f.directory, '..', 'lfs-linked');
    git(f.directory, 'worktree', 'add', '--detach', linked, 'origin/dev');
    expect(readFileSync(join(linked, 'asset.bin'), 'utf8')).toBe('synthetic LFS bytes');
    const result = await prepareCodingExecution(f.request, f.effects);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('LFS') });
    expect(existsSync(f.destination)).toBe(false);
    expect(readFileSync(join(f.directory, 'file'), 'utf8')).toBe('uncommitted user work');
  });

  test('a source with borrowed objects still produces an independent clone', async () => {
    const f = fixture();
    const borrowed = join(f.directory, '..', 'borrowed-source');
    git(f.directory, 'clone', '--shared', f.directory, borrowed);
    git(borrowed, 'remote', 'set-url', 'origin', f.remote);
    const prepared = await prepareCodingExecution({ ...f.request, directory: borrowed }, f.effects);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(existsSync(join(f.destination, '.git/objects/info/alternates'))).toBe(false);
    expect(git(f.destination, 'rev-parse', 'HEAD')).toBe(f.latest);
    git(f.destination, 'fsck', '--no-reflogs');
    await prepared.value.release();
  });

  test('a prepared clone from a linked checkout keeps the main project attribution', async () => {
    const f = fixture();
    const linked = join(f.directory, '..', 'linked-source');
    git(f.directory, 'worktree', 'add', '--detach', linked, 'HEAD');
    const prepared = await prepareCodingExecution({ ...f.request, directory: linked }, f.effects);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(await gitWorktreeProject(prepared.value.directory)).toBe(
      await gitWorktreeProject(linked)
    );
    await prepared.value.release();
  });

  test('prepares the fetched target and preserves dirty user checkout', async () => {
    const f = fixture();
    git(f.directory, 'branch', 'local-only', f.before);
    for (const ref of [
      'refs/stash',
      'refs/notes/test',
      'refs/remotes/other/dev',
      'refs/tags/local-only',
      'refs/custom/test',
    ])
      git(f.directory, 'update-ref', ref, f.before);
    git(f.directory, 'pack-refs', '--all');
    const result = await prepareCodingExecution(f.request, f.effects);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(git(result.value.directory, 'rev-parse', 'HEAD')).toBe(f.latest);
    expect(git(f.directory, 'rev-parse', 'HEAD')).toBe(f.before);
    expect(readFileSync(join(f.directory, 'file'), 'utf8')).toBe('uncommitted user work');
    expect(git(f.destination, 'rev-parse', 'refs/remotes/origin/dev')).toBe(f.latest);
    expect(git(f.destination, 'for-each-ref', '--format=%(refname)')).toBe(
      'refs/remotes/origin/dev'
    );
    git(f.destination, 'switch', 'dev');
    expect(git(f.destination, 'rev-parse', 'HEAD')).toBe(f.latest);
    expect(
      spawnSync('git', ['show-ref', '--verify', 'refs/remotes/origin/local-only'], {
        cwd: f.destination,
        env: gitEnv,
      }).status
    ).not.toBe(0);
    await result.value.release();
    expect(existsSync(f.destination)).toBe(false);
  });

  test('a base without a verify skill refuses the start, unless the todo is the one that creates it', async () => {
    const f = fixture();
    git(f.remote, 'rm', '-r', '-q', '.claude');
    git(f.remote, 'commit', '-m', 'drop the verify skill');
    const refused = await prepareCodingExecution(f.request, f.effects);
    expect(refused).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^verify_skill_missing: .*verifySkill "create"/),
    });
    expect(existsSync(f.destination)).toBe(false);
    const created = await prepareCodingExecution(
      { ...f.request, parameters: { ...f.request.parameters, verifySkill: 'create' } },
      f.effects
    );
    expect(created.ok).toBe(true);
    if (created.ok) await created.value.release();
    expect(
      await prepareCodingExecution(
        { ...f.request, parameters: { ...f.request.parameters, verifySkill: 'skip' } },
        f.effects
      )
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/^verify_skill_missing/) });
    writeFileSync(join(f.remote, 'AGENTS.md'), '# Repo\n\n```md\n## Verify\n```\n');
    git(f.remote, 'add', 'AGENTS.md');
    git(f.remote, 'commit', '-m', 'example only');
    expect(await prepareCodingExecution(f.request, f.effects)).toMatchObject({ ok: false });
    writeFileSync(join(f.remote, 'AGENTS.md'), '# Repo\n\n## Verify\n\nRun `make dev`.\n');
    git(f.remote, 'add', 'AGENTS.md');
    git(f.remote, 'commit', '-m', 'verify section');
    const sectioned = await prepareCodingExecution(f.request, f.effects);
    expect(sectioned.ok).toBe(true);
    if (sectioned.ok) await sectioned.value.release();
  });

  test('an omitted target uses the advertised remote default, never local HEAD', async () => {
    const f = fixture();
    const result = await prepareCodingExecution({ ...f.request, parameters: {} }, f.effects);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(git(result.value.directory, 'rev-parse', 'HEAD')).toBe(f.latest);
    expect(git(f.directory, 'rev-parse', 'HEAD')).toBe(f.before);
    expect(readFileSync(join(f.directory, 'file'), 'utf8')).toBe('uncommitted user work');
    expect(f.calls[0]).toEqual(['git', 'ls-remote', '--symref', 'origin', 'HEAD']);
    await result.value.release();
  });

  test('a missing advertised default refuses before fetch or checkout', async () => {
    const calls: unknown[] = [];
    const result = await prepareCodingExecution(
      { directory: '/repo', destination: '/prepared', parameters: {} },
      {
        run: async (command) => {
          calls.push(command);
          return { code: 0, stdout: '', stderr: '' };
        },
      }
    );
    expect(result).toEqual({ ok: false, reason: 'remote_default_unavailable' });
    expect(calls).toEqual([['git', 'ls-remote', '--symref', 'origin', 'HEAD']]);
  });

  test('failed fetch never creates a checkout from a cached ref', async () => {
    const f = fixture();
    git(f.directory, 'remote', 'set-url', 'origin', join(f.directory, 'missing-remote'));
    const result = await prepareCodingExecution(f.request, f.effects);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected preparation');
    expect(result.reason).toContain('fetch_failed');
    expect(f.calls.some((call) => call[1] === 'clone')).toBe(false);
    expect(existsSync(f.destination)).toBe(false);
  });

  test('a missing target refuses without a HEAD fallback', async () => {
    const f = fixture();
    const result = await prepareCodingExecution(
      { ...f.request, parameters: { target: 'missing' } },
      f.effects
    );
    expect(result.ok).toBe(false);
    expect(f.calls.some((call) => call[1] === 'clone')).toBe(false);
  });

  test("a base that contains the prerequisite's merge is prepared from that merge onward", async () => {
    const f = fixture();
    git(f.remote, 'checkout', '-b', 'feature');
    writeFileSync(join(f.remote, 'prerequisite'), 'done');
    git(f.remote, 'add', '.');
    git(f.remote, 'commit', '-m', 'prerequisite work');
    git(f.remote, 'checkout', 'dev');
    git(f.remote, 'merge', '--no-ff', 'feature', '-m', 'Merge prerequisite');
    const merged = git(f.remote, 'rev-parse', 'HEAD');
    const result = await prepareCodingExecution(
      { ...f.request, parameters: { target: 'dev', prerequisiteCommits: [merged] } },
      f.effects
    );
    expect(result.ok).toBe(true);
    expect(git(f.destination, 'rev-parse', 'HEAD')).toBe(merged);
    expect(readFileSync(join(f.destination, 'prerequisite'), 'utf8')).toBe('done');
  });

  test('a prerequisite on another branch cannot unlock preparation', async () => {
    const f = fixture();
    git(f.remote, 'checkout', '-b', 'unmerged');
    writeFileSync(join(f.remote, 'other'), 'not merged');
    git(f.remote, 'add', '.');
    git(f.remote, 'commit', '-m', 'unmerged prerequisite');
    const missing = git(f.remote, 'rev-parse', 'HEAD');
    git(f.directory, 'fetch', 'origin', 'unmerged');
    const result = await prepareCodingExecution(
      { ...f.request, parameters: { target: 'dev', prerequisiteCommits: [missing] } },
      f.effects
    );
    expect(result).toEqual({ ok: false, reason: `prerequisite_not_in_base: ${missing}` });
    expect(f.calls.some((call) => call[1] === 'clone')).toBe(false);
  });

  test('invalid targets and commit identifiers reject before effects', async () => {
    const calls: string[][] = [];
    const effects = {
      run: async (command: readonly string[]) => {
        calls.push([...command]);
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    for (const target of [
      '--upload-pack=evil',
      '../dev',
      'dev:other',
      'dev.lock',
      'a//b',
      'dev\nother',
    ]) {
      expect(
        await prepareCodingExecution(
          { directory: '/repo', destination: '/work', parameters: { target } },
          effects
        )
      ).toEqual({ ok: false, reason: 'invalid_preparation_target' });
    }
    expect(
      await prepareCodingExecution(
        {
          directory: '/repo',
          destination: '/work',
          parameters: { target: 'dev', prerequisiteCommits: ['HEAD'] },
        },
        effects
      )
    ).toEqual({ ok: false, reason: 'invalid_prerequisite_commits' });
    expect(calls).toEqual([]);
  });

  test.each(['clone', 'remote', 'checkout', 'for-each-ref', 'update-ref'])(
    'a failed %s step is explicit and releases only its newly owned clone',
    async (step) => {
      const f = fixture();
      const result = await prepareCodingExecution(f.request, {
        run: async (command, cwd) => {
          if (command.includes(step) && (step !== 'remote' || command[2] === 'set-url'))
            return { code: 1, stdout: '', stderr: 'synthetic refusal' };
          return f.effects.run(command, cwd);
        },
      });
      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining('synthetic refusal'),
      });
      expect(existsSync(f.destination)).toBe(false);
      expect(readFileSync(join(f.directory, 'file'), 'utf8')).toBe('uncommitted user work');
    }
  );

  test('a real clone refusal remains a value when its destination has disappeared', async () => {
    const f = fixture();
    const result = await prepareCodingExecution(f.request, {
      run: async (command, cwd) => {
        if (command[1] !== 'clone') return f.effects.run(command, cwd);
        const failed = await f.effects.run(
          ['git', 'clone', '--no-local', '--upload-pack=false', '--', f.directory, f.destination],
          cwd
        );
        expect(failed.code).not.toBe(0);
        rmSync(f.destination, { recursive: true, force: true });
        return failed;
      },
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('clone_failed:') });
    expect(existsSync(f.destination)).toBe(false);
  });

  test('an existing empty destination is never claimed or removed', async () => {
    const f = fixture();
    mkdirSync(f.destination);
    expect(await prepareCodingExecution(f.request, f.effects)).toMatchObject({ ok: false });
    expect(statSync(f.destination).isDirectory()).toBe(true);
  });

  test('an existing destination is preserved when clone creation fails', async () => {
    const f = fixture();
    writeFileSync(f.destination, 'existing content');
    const result = await prepareCodingExecution(f.request, f.effects);
    expect(result.ok).toBe(false);
    expect(readFileSync(f.destination, 'utf8')).toBe('existing content');
  });
});

describe('requireVerifySkill', () => {
  test.each([
    ['a column-0 fence', '```md\n## Verify\n```\n', false],
    ['an indented fence', '   ~~~\n## Verify\n   ~~~\n', false],
    ['an unclosed fence', '```\n## Verify\nrun it\n', false],
    ['a heading after a closed fence', '```\nx\n```\n\n## Verify\n', true],
    ['a 4-backtick fence around a 3-backtick line', '````\n```\n## Verify\n````\n', false],
    ['a heading after a 4-backtick fence with an inner line', '````\n```\n````\n## Verify\n', true],
    ['a closer with trailing text', '```\n``` not a closer\n## Verify\n```\n', false],
    ['a bare hash before a Verify paragraph', '#\n\nVerify changes with make check.\n', false],
    ['a hash with no space', '#Verify\n', false],
    ['an indented heading', '  ## Verify\n', true],
    ['a CRLF fence', '```md\r\n## Verify\r\n```\r\n', false],
    ['a CRLF heading', '## Verify\r\nRun it.\r\n', true],
  ])('a Verify heading in %s counts only outside code', (_case, doc, passes) => {
    const listed = { code: 0, stdout: 'AGENTS.md\n', stderr: '' };
    const agents = { code: 0, stdout: `# Repo\n\n${doc}`, stderr: '' };
    expect('value' in requireVerifySkill(undefined, listed, agents)).toBe(passes);
  });
});

test.each([
  ['.claude/skills/verify/SKILL.md', true],
  ['.claude/skills/verify-ui/SKILL.md', true],
  ['.claude/skills/verify/nested/SKILL.md', false],
  ['docs/.claude/skills/verify/SKILL.md', false],
  ['.claude/skills/Verify/SKILL.md', false],
])('verify preflight recognizes tracked path %s: %s', (path, accepted) => {
  const result = requireVerifySkill(undefined, { code: 0, stdout: `${path}\n`, stderr: '' }, null);
  expect('value' in result).toBe(accepted);
});

test('verify create bypasses read failures, but every other mode requires a readable listing', () => {
  const failed = { code: 1, stdout: '', stderr: '  unavailable \n' };
  const agents = { code: 0, stdout: '## Verify\n', stderr: '' };
  expect(requireVerifySkill('create', failed, null)).toEqual({ value: true });
  for (const mode of [undefined, 'Create', 'skip', true]) {
    expect(requireVerifySkill(mode, failed, agents)).toEqual({
      reason: { ok: false, reason: 'verify_skill_unreadable: unavailable' },
    });
  }
  expect(
    requireVerifySkill(undefined, { ...failed, code: 0 }, { ...agents, code: 1 })
  ).toMatchObject({
    reason: { ok: false, reason: expect.stringContaining('verify_skill_missing:') },
  });
});
