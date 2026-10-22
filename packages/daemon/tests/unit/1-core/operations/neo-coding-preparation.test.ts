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
import {
  prepareCodingExecution,
  requireVerifySkill,
} from '../../../../src/lib/neo/packs/coding/prepare-execution';

const roots: string[] = [];
function git(directory: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
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
  const before = git(directory, 'rev-parse', 'HEAD');
  writeFileSync(join(remote, 'file'), 'new');
  git(remote, 'commit', '-am', 'remote advance');
  const latest = git(remote, 'rev-parse', 'HEAD');
  writeFileSync(join(directory, 'file'), 'uncommitted user work');
  const calls: string[][] = [];
  const effects = {
    run: async (command: readonly string[], cwd: string) => {
      calls.push([...command]);
      const result = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8' });
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
              return { thread: { id: 'fresh' } };
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
    git(f.destination, 'config', 'user.name', 'Synthetic worker');
    git(f.destination, 'config', 'user.email', 'worker@example.invalid');
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
    expect(existsSync(f.destination)).toBe(false);
    expect(readFileSync(join(f.directory, 'file'), 'utf8')).toBe('uncommitted user work');
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
    const result = await prepareCodingExecution(f.request, f.effects);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(git(result.value.directory, 'rev-parse', 'HEAD')).toBe(f.latest);
    expect(git(f.directory, 'rev-parse', 'HEAD')).toBe(f.before);
    expect(readFileSync(join(f.directory, 'file'), 'utf8')).toBe('uncommitted user work');
    expect(f.calls.find((call) => call[1] === 'checkout')?.at(-1)).toBe(f.latest);
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

  test.each(['clone', 'remote', 'checkout'])(
    'a failed %s step is explicit and releases only its newly owned clone',
    async (step) => {
      const f = fixture();
      const result = await prepareCodingExecution(f.request, {
        run: async (command, cwd) => {
          if (command[1] === step && (step !== 'remote' || command[2] === 'set-url'))
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
