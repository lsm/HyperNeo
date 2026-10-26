import { workerRuntimeCleanupCommand } from './worker-runtime-cleanup.ts';
import { getDataDir } from '../data-dir.ts';
import { secretHomePaths, secretNamePatterns } from '../neo/secret-read-rules.ts';
import { parse, stringify } from 'smol-toml';
import type { CodexAppServer } from './codex-app-server.ts';
import { collectWithMaxBuffer } from '../utils/script-utils.ts';
import { spawnProcess } from '../runtime-spawn/index.ts';
import { homedir, tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

let readWorkerSockets = (): string[] => [];

export function configureWorkerSockets(read: () => string[]) {
  readWorkerSockets = read;
}

export const workerUnixSockets = () => readWorkerSockets();

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

export function codexWorkerSandbox(root: string, sockets = workerUnixSockets()) {
  const env = workerSandboxPaths(root);
  const writableRoots = [root, join(root, '.git'), ...new Set(Object.values(env))];
  return {
    permissions: 'hyperneo-worker',
    config: {
      features: {
        network_proxy: {
          enabled: true,
          domains: { '*': 'allow' },
          unix_sockets: Object.fromEntries(sockets.map((path) => [path, 'allow'])),
          dangerously_allow_all_unix_sockets: false,
          allow_local_binding: true,
        },
      },
      permissions: {
        'hyperneo-worker': {
          filesystem: {
            ':root': 'read',
            ...Object.fromEntries(writableRoots.map((path) => [path, 'write'])),
            ...Object.fromEntries(
              ['.agents', '.codex', '.aws'].map((path) => [join(root, path), 'read'])
            ),
            ...Object.fromEntries(workerSecretPaths().map((path) => [path, 'deny'])),
            ...Object.fromEntries(secretNamePatterns(homedir()).map((path) => [path, 'deny'])),
          },
          network: {
            enabled: true,
            domains: { '*': 'allow' },
            unix_sockets: Object.fromEntries(sockets.map((path) => [path, 'allow'])),
            dangerously_allow_all_unix_sockets: false,
            allow_local_binding: true,
          },
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
      ...secretHomePaths(home).filter((path) => path !== join(home, 'Library')),
      ...[
        '.zlogin',
        '.bash_login',
        '.codex/auth.json',
        'Library/Keychains',
        'Library/Application Support/1Password',
      ].map((path) => join(home, path)),
      join(process.env.CODEX_HOME ?? join(home, '.codex'), 'auth.json'),
      join(getDataDir(), '.provider-credential-key'),
      ...['.credentials.json', 'settings.json', 'settings.local.json'].map((path) =>
        join(process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), path)
      ),
    ]),
  ];
}

export async function persistCodexWorkerProfile(root: string) {
  const directory = join(root, '.codex');
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory()) throw new Error('Worker config must be in-clone');
  const path = join(directory, 'config.toml');
  const entry = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (entry && !entry.isFile()) throw new Error('Worker config must be a regular file');
  const previous = await readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const existing = parse(previous);
  const profiles = existing.permissions as
    | Record<string, { filesystem?: Record<string, unknown> }>
    | undefined;
  if (entry && profiles?.['hyperneo-worker']?.filesystem?.[root] !== 'write')
    throw new Error('Prepared worker cannot replace unmanaged or tracked .codex/config.toml');
  const config = codexWorkerSandbox(root).config;
  const profile = config.permissions['hyperneo-worker'];
  const text = stringify({
    ...existing,
    permissions: { ...(existing.permissions as object), 'hyperneo-worker': profile },
    features: { ...(existing.features as object), ...config.features },
    shell_environment_policy: {
      ...(existing.shell_environment_policy as object),
      set: config.shell_environment_policy.set,
    },
  });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
  const exclude = join(root, '.git/info/exclude');
  await mkdir(join(root, '.git/info'), { recursive: true });
  if (!(await readFile(exclude, 'utf8').catch(() => '')).includes('/.codex/config.toml'))
    await appendFile(exclude, '\n/.codex/config.toml\n');
}

export async function resumeWorkerSandbox(root: string) {
  if (!existsSync(join(root, '.git/hyperneo-worker-sandbox'))) return null;
  await prepareWorkerSandbox(root);
  await persistCodexWorkerProfile(root);
  return codexWorkerSandbox(root);
}

export async function requireCodexWorkerProfile(server: Pick<CodexAppServer, 'call'>, cwd: string) {
  const profiles = (await server.call('permissionProfile/list', { cwd })) as {
    data?: { id: string; allowed: boolean }[];
  };
  if (!profiles?.data?.some((profile) => profile.id === 'hyperneo-worker' && profile.allowed))
    throw new Error('Codex must support the prepared worker permission profile');
}
