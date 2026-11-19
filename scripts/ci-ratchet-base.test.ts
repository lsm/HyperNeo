import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function selectBase(event: string, ref: string, sha: string, before: string) {
  const result = Bun.spawnSync(['bash', join(import.meta.dir, 'ci-ratchet-base.sh')], {
    env: {
      PATH: process.env.PATH,
      GITHUB_EVENT_NAME: event,
      GITHUB_REF: ref,
      GITHUB_SHA: sha,
      GITHUB_EVENT_BEFORE: before,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode,
    value: result.stdout.toString().trim(),
    error: result.stderr.toString(),
  };
}

test('a tag uses its own baseline even when dev has since lowered it', () => {
  const root = mkdtempSync(join(tmpdir(), 'tag-ratchet-'));
  roots.push(root);
  const put = (path: string, content: string) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {
      cwd: root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git('init', '-q');
  put(
    'packages/demo/src/main.ts',
    "defineOperation({ name: 'demo.run', execute: externalHandler });\n"
  );
  put(
    'scripts/pipeline-ratchet-baseline.json',
    JSON.stringify({ missing: 0, misnamed: 0, dynamic: 0, unreadable: 1 })
  );
  git('add', '.');
  const parent = git('commit-tree', git('write-tree'), '-m', 'parent');
  const tag = git('commit-tree', git('write-tree'), '-p', parent, '-m', 'tag');
  git('update-ref', 'HEAD', tag);
  git('tag', 'v0.60.1', tag);
  put('packages/demo/src/main.ts', 'export const value = 1;\n');
  put(
    'scripts/pipeline-ratchet-baseline.json',
    JSON.stringify({ missing: 0, misnamed: 0, dynamic: 0, unreadable: 0 })
  );
  git('add', '.');
  const later = git('commit-tree', git('write-tree'), '-p', tag, '-m', 'later');
  git('update-ref', 'refs/remotes/origin/dev', later);
  git('read-tree', '--reset', '-u', tag);
  const check = (base: string) =>
    Bun.spawnSync(
      [process.execPath, join(import.meta.dir, 'check-pipeline-ratchet.ts'), root, base],
      { env, stdout: 'pipe', stderr: 'pipe' }
    );
  const againstDev = check('origin/dev');
  expect(againstDev.exitCode).toBe(1);
  expect(againstDev.stderr.toString()).toContain('baseline may only decrease');
  const selected = selectBase('push', 'refs/tags/v0.60.1', tag, '0'.repeat(40));
  expect(selected).toMatchObject({ code: 0, value: `${tag}^1` });
  expect(check(selected.value).exitCode).toBe(0);

  put(
    'scripts/pipeline-ratchet-baseline.json',
    JSON.stringify({ missing: 0, misnamed: 0, dynamic: 0, unreadable: 2 })
  );
  git('add', '.');
  const raised = git('commit-tree', git('write-tree'), '-p', tag, '-m', 'raised baseline');
  git('read-tree', '--reset', '-u', raised);
  const raisedBase = selectBase('push', 'refs/tags/v0.60.2', raised, '0'.repeat(40));
  const raisedCheck = check(raisedBase.value);
  expect(raisedCheck.exitCode).toBe(1);
  expect(raisedCheck.stderr.toString()).toContain('baseline may only decrease');
});

test('dev pushes compare with their previous tip and PRs compare with dev', () => {
  expect(selectBase('push', 'refs/heads/dev', 'head', 'previous')).toMatchObject({
    code: 0,
    value: 'previous',
  });
  expect(selectBase('pull_request', 'refs/pull/1/merge', 'head', '')).toMatchObject({
    code: 0,
    value: 'origin/dev',
  });
  expect(selectBase('workflow_dispatch', 'refs/heads/dev', 'head', '')).toMatchObject({
    code: 0,
    value: 'origin/dev',
  });
});
