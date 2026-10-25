import { spawnProcess } from '../runtime-spawn/index.ts';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function workerSandboxPaths(root: string) {
  const base = process.platform === 'darwin' ? '/tmp' : tmpdir();
  const runtime = join(base, `hn-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`);
  return {
    TMPDIR: join(runtime, 'tmp'),
    TMP: join(runtime, 'tmp'),
    TEMP: join(runtime, 'tmp'),
    CLAUDE_CODE_TMPDIR: join(runtime, 'tmp'),
    XDG_CACHE_HOME: join(runtime, 'cache'),
  };
}

async function clearRuntimeFlags(path: string, recursive = false) {
  const process = spawnProcess(
    ['/usr/bin/chflags', recursive ? '-RP' : '-h', 'nouchg,nouappnd', path],
    { env: {}, stdout: 'ignore', stderr: 'ignore' }
  );
  if ((await process.exited) === 0) return;
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Cannot clear worker runtime user flags; clear them before retrying archive.');
}

async function unlockRuntimeDirectories(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory()) return;
    try {
      await chmod(path, 0o700);
    } catch (error) {
      if (process.platform !== 'darwin' || (error as NodeJS.ErrnoException).code !== 'EPERM')
        throw error;
      await clearRuntimeFlags(path);
      await chmod(path, 0o700);
    }
    for (const name of await readdir(path)) await unlockRuntimeDirectories(join(path, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function releaseWorkerSandbox(root: string | null | undefined) {
  if (!root) return;
  const runtime = join(workerSandboxPaths(root).TMPDIR, '..');
  await unlockRuntimeDirectories(runtime);
  const remove = () =>
    rm(runtime, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 3 : 0 });
  try {
    await remove();
  } catch (error) {
    if (
      process.platform !== 'darwin' ||
      !['EPERM', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw error;
    await clearRuntimeFlags(runtime, true);
    await remove();
  }
}

export async function prepareWorkerSandbox(root: string) {
  const env = workerSandboxPaths(root);
  const runtime = join(env.TMPDIR, '..');
  for (const path of new Set([runtime, ...Object.values(env)])) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const entry = await lstat(path);
    const owner = process.platform === 'win32' ? entry.uid : (process.getuid?.() ?? entry.uid);
    const mode = process.platform === 'win32' ? 0 : entry.mode;
    if (!entry.isDirectory() || (mode & 0o077) !== 0 || entry.uid !== owner)
      throw new Error('Worker runtime roots must be owned private directories');
  }
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
