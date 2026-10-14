import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareCodingExecution } from '../../../../src/lib/neo/packs/coding/prepare-execution';

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

describe('prepareCodingExecution', () => {
  test('prepares the fetched target and preserves dirty user checkout', async () => {
    const f = fixture();
    const result = await prepareCodingExecution(f.request, f.effects);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(git(result.value.directory, 'rev-parse', 'HEAD')).toBe(f.latest);
    expect(git(f.directory, 'rev-parse', 'HEAD')).toBe(f.before);
    expect(readFileSync(join(f.directory, 'file'), 'utf8')).toBe('uncommitted user work');
    expect(f.calls.find((call) => call[1] === 'worktree')?.at(-1)).toBe(f.latest);
    await result.value.release();
    expect(existsSync(f.destination)).toBe(false);
  });

  test('failed fetch never creates a checkout from a cached ref', async () => {
    const f = fixture();
    git(f.directory, 'remote', 'set-url', 'origin', join(f.directory, 'missing-remote'));
    const result = await prepareCodingExecution(f.request, f.effects);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected preparation');
    expect(result.reason).toContain('fetch_failed');
    expect(f.calls.some((call) => call[1] === 'worktree')).toBe(false);
    expect(existsSync(f.destination)).toBe(false);
  });

  test('a missing target refuses without a HEAD fallback', async () => {
    const f = fixture();
    const result = await prepareCodingExecution(
      { ...f.request, parameters: { target: 'missing' } },
      f.effects
    );
    expect(result.ok).toBe(false);
    expect(f.calls.some((call) => call[1] === 'worktree')).toBe(false);
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
    expect(f.calls.some((call) => call[1] === 'worktree')).toBe(false);
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

  test('an existing destination is preserved when worktree creation fails', async () => {
    const f = fixture();
    writeFileSync(f.destination, 'existing content');
    const result = await prepareCodingExecution(f.request, f.effects);
    expect(result.ok).toBe(false);
    expect(readFileSync(f.destination, 'utf8')).toBe('existing content');
  });
});
