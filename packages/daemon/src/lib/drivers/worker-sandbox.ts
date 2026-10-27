import { constants, existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WorkerSandboxMode } from '@hyperneo/shared';
import { parse, stringify } from 'smol-toml';
import { getDataDir } from '../data-dir.ts';
import { secretHomePaths, secretNamePatterns } from '../neo/secret-read-rules.ts';
import { spawnProcess } from '../runtime-spawn/index.ts';
import { collectWithMaxBuffer } from '../utils/script-utils.ts';
import { workerWorkLocations } from '../work-locations.ts';
import type { CodexAppServer } from './codex-app-server.ts';
import { workerRuntimeCleanupCommand } from './worker-runtime-cleanup.ts';

let readWorkerSandbox = (): WorkerSandboxMode => 'off';

export function configureWorkerSandbox(read: () => WorkerSandboxMode) {
  readWorkerSandbox = read;
}

export function workerSandboxOn(requested?: boolean) {
  const mode = readWorkerSandbox();
  return mode === 'always' || (mode === 'on-demand' && requested === true);
}

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
    GH_CONFIG_DIR: locations.ghConfig,
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
  if (!(await lstat(join(root, '.git'))).isDirectory())
    throw new Error('Worker Git directory must be in-clone');
  const env = workerSandboxPaths(root);
  const runtime = workerWorkLocations(root).scratch;
  for (const path of new Set([runtime, ...Object.values(env)])) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (path !== runtime && path !== env.XDG_CACHE_HOME && path !== env.GH_CONFIG_DIR) continue;
    const entry = await lstat(path);
    const owner = process.platform === 'win32' ? entry.uid : (process.getuid?.() ?? entry.uid);
    if (!entry.isDirectory() || entry.uid !== owner)
      throw new Error('Worker runtime roots must be owned private directories');
    if (process.platform !== 'win32') await chmod(path, 0o700);
  }
  await copyFile(
    join(homedir(), '.config/gh/config.yml'),
    join(env.GH_CONFIG_DIR, 'config.yml'),
    constants.COPYFILE_EXCL
  ).catch((error) => {
    if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error;
  });
  await writeFile(join(root, '.git/hyperneo-worker-sandbox'), 'restricted');
  return env;
}

export function codexWorkerSandbox(root: string) {
  const env = workerSandboxPaths(root);
  const writableRoots = [root, join(root, '.git'), ...new Set(workerWritableRoots(root))];
  return {
    permissions: 'hyperneo-worker',
    config: {
      features: {
        network_proxy: {
          enabled: true,
          domains: { '*': 'allow' },
          dangerously_allow_all_unix_sockets: true,
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
            dangerously_allow_all_unix_sockets: true,
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
      ...secretHomePaths(home).filter(
        (path) => path !== join(home, 'Library') && path !== join(home, '.config/gh')
      ),
      ...[
        '.zlogin',
        '.bash_login',
        '.codex/auth.json',
        '.config/gh/hosts.yml',
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
  const entry = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  let previous = '';
  try {
    if (entry && !(await entry.stat()).isFile())
      throw new Error('Worker config must be a regular file');
    if (entry) previous = await entry.readFile('utf8');
  } finally {
    await entry?.close();
  }
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
  if (!entry) await excludeWorkerConfig(root, '/.codex/config.toml');
}

export async function excludeWorkerConfig(root: string, pattern: string) {
  if (!(await lstat(join(root, '.git'))).isDirectory())
    throw new Error('Worker Git directory must be in-clone');
  const directory = join(root, '.git/info');
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory()) throw new Error('Git info must be in-clone');
  const path = join(directory, 'exclude');
  const entry = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (entry && !entry.isFile()) throw new Error('Git exclude must be a regular file');
  if (constants.O_NOFOLLOW === undefined) throw new Error('Git exclude guard requires O_NOFOLLOW');
  const handle = await open(
    path,
    constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600
  );
  try {
    const previous = await handle.readFile('utf8');
    if (!previous.split('\n').includes(pattern)) await handle.appendFile(`\n${pattern}\n`);
  } finally {
    await handle.close();
  }
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
