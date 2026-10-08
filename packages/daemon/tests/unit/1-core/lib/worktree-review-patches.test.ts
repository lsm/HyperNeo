import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitChangedFile, GitReviewSummary } from '@hyperneo/shared';
import type { SimpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { WorktreeManager } from '../../../../src/lib/worktree-manager.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('WorktreeManager review summary patches', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'review-patches-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    for (let index = 0; index < 90; index++) {
      writeFileSync(join(repo, `file-${index}.txt`), `line ${index}\n`);
    }
    writeFileSync(join(repo, 'with space.txt'), 'space\n');
    writeFileSync(join(repo, 'quote"name.txt'), 'quote\n');
    writeFileSync(join(repo, 'gone.txt'), 'gone\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function reviewSummary(files: GitChangedFile[]) {
    const manager = new WorktreeManager();
    const diffCalls: string[][] = [];
    const getGit = Reflect.get(manager, 'getGit') as (path: string) => SimpleGit;
    Reflect.set(manager, 'getGit', (path: string) => {
      const client = getGit.call(manager, path);
      const raw = client.raw.bind(client) as (args: string[]) => Promise<string>;
      return Object.assign(Object.create(client), {
        raw: (args: string[]) => {
          if (args.includes('diff') && !args.includes('--numstat')) diffCalls.push(args);
          return raw(args);
        },
      });
    });
    const getReviewSummary = Reflect.get(manager, 'getReviewSummary') as (
      ...args: unknown[]
    ) => Promise<GitReviewSummary>;
    return getReviewSummary
      .call(manager, repo, null, null, files, false)
      .then((summary) => ({ summary, diffCalls }));
  }

  it('matches per-file patches with one diff call for unquoted paths', async () => {
    writeFileSync(join(repo, 'with space.txt'), 'space changed\n');
    writeFileSync(join(repo, 'quote"name.txt'), 'quote changed\n');
    unlinkSync(join(repo, 'gone.txt'));
    writeFileSync(join(repo, 'added.txt'), 'added\n');
    git(repo, 'add', 'added.txt');
    writeFileSync(join(repo, 'untracked.txt'), 'untracked\n');
    writeFileSync(join(repo, 'file-0.txt'), 'line 0 changed\n');
    const files: GitChangedFile[] = [
      {
        path: 'with space.txt',
        status: 'modified',
        staged: false,
        unstaged: true,
      },
      {
        path: 'quote"name.txt',
        status: 'modified',
        staged: false,
        unstaged: true,
      },
      { path: 'gone.txt', status: 'deleted', staged: false, unstaged: true },
      { path: 'added.txt', status: 'added', staged: true, unstaged: false },
      {
        path: 'untracked.txt',
        status: 'untracked',
        staged: false,
        unstaged: true,
      },
      { path: 'file-0.txt', status: 'modified', staged: false, unstaged: true },
    ];

    const { summary, diffCalls } = await reviewSummary(files);

    expect(diffCalls).toHaveLength(2);
    for (const file of summary.files) {
      const expected =
        file.path === 'untracked.txt'
          ? null
          : git(repo, 'diff', '--no-ext-diff', '--no-color', 'HEAD', '--', file.path);
      expect(file.patch).toBe(expected);
    }
    expect(summary.files).toHaveLength(6);
  });

  it('keeps the review file cap with a single diff call', async () => {
    const files: GitChangedFile[] = [];
    for (let index = 0; index < 90; index++) {
      writeFileSync(join(repo, `file-${index}.txt`), `line ${index} changed\n`);
      files.push({
        path: `file-${index}.txt`,
        status: 'modified',
        staged: false,
        unstaged: true,
      });
    }

    const { summary, diffCalls } = await reviewSummary(files);

    expect(diffCalls).toHaveLength(1);
    expect(summary.files).toHaveLength(80);
    expect(summary.files.every((file) => file.patch?.includes(' changed'))).toBe(true);
  });
});
