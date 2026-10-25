import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
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

export async function releaseWorkerSandbox(root: string | null | undefined) {
  if (root) await rm(join(workerSandboxPaths(root).TMPDIR, '..'), { recursive: true, force: true });
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
