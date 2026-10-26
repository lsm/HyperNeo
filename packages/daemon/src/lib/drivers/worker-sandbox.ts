import { existsSync } from 'node:fs';
import { lstat, mkdir, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkerSandboxMode } from '@hyperneo/shared';
import { spawnProcess } from '../runtime-spawn/index.ts';
import { collectWithMaxBuffer } from '../utils/script-utils.ts';
import { workerWorkLocations } from '../work-locations.ts';
import { workerRuntimeCleanupCommand } from './worker-runtime-cleanup.ts';

let readWorkerSockets = (): string[] => [];
let readWorkerSandbox = (): WorkerSandboxMode => 'off';

export function configureWorkerSandbox(read: () => WorkerSandboxMode) {
  readWorkerSandbox = read;
}

export const workerSandboxOn = () => readWorkerSandbox() === 'always';

export function configureWorkerSockets(read: () => string[]) {
  readWorkerSockets = read;
}

export const workerUnixSockets = () => readWorkerSockets();

export function workerWritableRoots(root: string) {
  const locations = workerWorkLocations(root);
  return [locations.evidence, locations.builds, locations.scratch, locations.cache];
}

export function workerSandboxPaths(root: string) {
  const locations = workerWorkLocations(root);
  return {
    HYPERNEO_WORKTREES: locations.worktrees,
    HYPERNEO_EVIDENCE: locations.evidence,
    HYPERNEO_BUILDS: locations.builds,
    TMPDIR: locations.scratch,
    TMP: locations.scratch,
    TEMP: locations.scratch,
    CLAUDE_CODE_TMPDIR: locations.scratch,
    XDG_CACHE_HOME: locations.cache,
  };
}

export async function releaseWorkerSandbox(root: string | null | undefined) {
  if (!root) return;
  const runtime = workerWorkLocations(root).scratch;
  try {
    const entry = await lstat(runtime);
    if (!entry.isDirectory()) {
      await unlink(runtime);
      return;
    }
    if (process.platform === 'win32') {
      await rm(runtime, { recursive: true, force: true, maxRetries: 3 });
      return;
    }
    const command = await workerRuntimeCleanupCommand(runtime);
    const child = spawnProcess(command, {
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const [code, diagnostic] = await Promise.all([
      child.exited,
      collectWithMaxBuffer(child.stderr, 4096),
    ]);
    if (code !== 0) {
      await lstat(runtime);
      throw new Error(
        `Worker cleanup ${command[0]} exited ${code}: ${diagnostic.text.trim() || 'no stderr received'}. Runtime retained.`
      );
    }
    await rmdir(runtime);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await lstat(runtime);
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw missing;
    }
    throw error;
  }
}

export async function prepareWorkerSandbox(root: string) {
  const env = workerSandboxPaths(root);
  const runtime = workerWorkLocations(root).scratch;
  for (const path of new Set([runtime, ...Object.values(env)])) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (path !== runtime && path !== env.XDG_CACHE_HOME) continue;
    const entry = await lstat(path);
    const owner = process.platform === 'win32' ? entry.uid : (process.getuid?.() ?? entry.uid);
    const mode = process.platform === 'win32' ? 0 : entry.mode;
    if (!entry.isDirectory() || (mode & 0o077) !== 0 || entry.uid !== owner)
      throw new Error('Worker runtime roots must be owned private directories');
  }
  await writeFile(join(root, '.git/hyperneo-worker-sandbox'), 'restricted');
  return env;
}

export function codexWorkerSandbox(root: string, sockets = workerUnixSockets()) {
  const env = workerSandboxPaths(root);
  const writableRoots = [root, join(root, '.git'), ...new Set(workerWritableRoots(root))];
  return {
    sandbox: 'workspace-write',
    config: {
      features: {
        network_proxy: {
          enabled: true,
          domains: { '*': 'allow' },
          unix_sockets: Object.fromEntries(sockets.map((path) => [path, 'allow'])),
          dangerously_allow_all_unix_sockets: true,
          allow_local_binding: true,
        },
      },
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
  if (!existsSync(join(root, '.git/hyperneo-worker-sandbox'))) return null;
  await prepareWorkerSandbox(root);
  return codexWorkerSandbox(root);
}
