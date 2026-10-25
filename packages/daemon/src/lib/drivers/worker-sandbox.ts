import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function workerSandboxPaths(root: string) {
  const runtime = join(
    '/tmp',
    `hn-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`
  );
  return {
    TMPDIR: join(runtime, 'tmp'),
    TMP: join(runtime, 'tmp'),
    TEMP: join(runtime, 'tmp'),
    CLAUDE_CODE_TMPDIR: join(runtime, 'tmp'),
    XDG_CACHE_HOME: join(runtime, 'cache'),
  };
}

export async function releaseWorkerSandbox(root: string) {
  await rm(join(workerSandboxPaths(root).TMPDIR, '..'), { recursive: true, force: true });
}

export async function prepareWorkerSandbox(root: string) {
  const env = workerSandboxPaths(root);
  const runtime = join(env.TMPDIR, '..');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const entry = await lstat(runtime);
  if (
    !entry.isDirectory() ||
    (entry.mode & 0o077) !== 0 ||
    (process.getuid && entry.uid !== process.getuid())
  )
    throw new Error('Worker runtime must be an owned private directory');
  await Promise.all(
    [...new Set(Object.values(env))].map(async (path) => {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const entry = await lstat(path);
      if (!entry.isDirectory() || (entry.mode & 0o077) !== 0)
        throw new Error('Worker runtime roots must be private directories');
    })
  );
  await writeFile(join(root, '.git/hyperneo-worker-sandbox'), 'restricted');
  return env;
}

export function codexWorkerSandbox(root: string) {
  const env = workerSandboxPaths(root);
  const writableRoots = [root, join(root, '.git'), ...new Set(Object.values(env))];
  return {
    sandbox: 'workspace-write',
    config: {
      sandbox_workspace_write: {
        writable_roots: writableRoots,
        exclude_slash_tmp: true,
        exclude_tmpdir_env_var: true,
        network_access: true,
      },
      shell_environment_policy: { set: env },
    },
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
      networkAccess: true,
    },
  };
}

export async function resumeWorkerSandbox(root: string) {
  if (existsSync(join(root, '.git/hyperneo-worker-sandbox'))) await prepareWorkerSandbox(root);
}
