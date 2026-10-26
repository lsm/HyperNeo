import { workerRuntimeCleanupCommand } from './worker-runtime-cleanup.ts';
import { collectWithMaxBuffer } from '../utils/script-utils.ts';
import { spawnProcess } from '../runtime-spawn/index.ts';
import { homedir, tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
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
  if (!root) return;
  const runtime = join(workerSandboxPaths(root).TMPDIR, '..');
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
    permissions: 'hyperneo-worker',
    config: {
      permissions: {
        'hyperneo-worker': {
          filesystem: {
            ':root': 'read',
            ...Object.fromEntries(writableRoots.map((path) => [path, 'write'])),
            ...Object.fromEntries(
              ['.agents', '.codex', '.aws'].map((path) => [join(root, path), 'read'])
            ),
            ...Object.fromEntries(workerSecretPaths().map((path) => [path, 'deny'])),
          },
          network: { enabled: true },
        },
      },
      shell_environment_policy: { set: env },
    },
  };
}

export function workerSecretPaths() {
  const home = homedir();
  return [
    ...new Set([
      ...[
        '.config',
        '.ssh',
        '.docker',
        '.kube',
        '.aws',
        '.npmrc',
        '.netrc',
        '.git-credentials',
        '.zshrc',
        '.zprofile',
        '.bashrc',
        '.bash_profile',
        '.profile',
        '.claude/.credentials.json',
        '.claude/settings.json',
        '.codex/auth.json',
      ].map((path) => join(home, path)),
      join(process.env.CODEX_HOME ?? join(home, '.codex'), 'auth.json'),
      ...['.credentials.json', 'settings.json'].map((path) =>
        join(process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), path)
      ),
    ]),
  ];
}

export async function resumeWorkerSandbox(root: string) {
  if (!existsSync(join(root, '.git/hyperneo-worker-sandbox'))) return null;
  await prepareWorkerSandbox(root);
  return codexWorkerSandbox(root);
}
