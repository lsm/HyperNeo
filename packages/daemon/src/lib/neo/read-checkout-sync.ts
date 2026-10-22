import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { getDataDir } from '../data-dir.ts';
import { buildGitHubLookupEnv } from '../github/gh-lookup-helpers.ts';
import { getNeoReadCheckoutPath } from './read-checkout-path.ts';

type Repository = { owner: string; repo: string };
const Metadata = z.object({ default_branch: z.string().min(1) });
const Ref = z.object({ object: z.object({ sha: z.string().regex(/^[a-f\d]{40}$/i) }) });
const executeFile = promisify(execFile);

async function readDefaultHead(repository: Repository, request: typeof fetch) {
  const base = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const metadata = await request(base);
  if (!metadata.ok) throw new Error(`repository metadata HTTP ${metadata.status}`);
  const branch = Metadata.parse(await metadata.json()).default_branch;
  const ref = await request(`${base}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (!ref.ok) throw new Error(`default branch HTTP ${ref.status}`);
  return { branch, sha: Ref.parse(await ref.json()).object.sha };
}

export function createNeoReadCheckoutSync(dataDir = getDataDir()) {
  const heads = new Map<string, string>();
  const gitAt = (path: string, args: string[]) =>
    executeFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', `core.worktree=${path}`, ...args], {
      cwd: path,
      timeout: 30_000,
      env: { ...buildGitHubLookupEnv(), GIT_TERMINAL_PROMPT: '0' },
    });
  return (superpipe({})('neo-read-checkout-sync') as PipelineAPI)
    .input(['repository', 'request'])
    .pipe(
      (repository: Repository) =>
        getNeoReadCheckoutPath(repository.owner, repository.repo, dataDir),
      'repository',
      'path'
    )
    .pipe(readDefaultHead, ['repository', 'request'], 'head')
    .pipe(
      async (repository: Repository, path: string, head: { branch: string; sha: string }) => {
        const key = `${head.branch}:${head.sha}`;
        if (heads.get(path) === key && existsSync(path)) return path;
        if (!existsSync(path)) {
          await mkdir(dirname(path), { recursive: true });
          await gitAt(dirname(path), [
            'clone',
            '--no-checkout',
            '--',
            `git@github.com:${repository.owner}/${repository.repo}.git`,
            path,
          ]);
        }
        if (!(await lstat(path)).isDirectory() || !(await lstat(join(path, '.git'))).isDirectory())
          throw new Error('Neo read checkout must be a standalone directory with its own .git');
        await gitAt(path, ['fetch', 'origin']);
        await gitAt(path, ['checkout', '--detach', `origin/${head.branch}`]);
        heads.set(path, key);
        return path;
      },
      ['repository', 'path', 'head'],
      'path'
    )
    .endAsync('path') as (repository: Repository, request: typeof fetch) => Promise<string>;
}
