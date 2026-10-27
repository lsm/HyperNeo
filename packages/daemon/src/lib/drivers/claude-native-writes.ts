import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { secretNamePatterns } from '../neo/secret-read-rules.ts';
import {
  excludeWorkerConfig,
  prepareWorkerSandbox,
  workerSandboxPaths,
  workerSecretPaths,
  workerWritableRoots,
} from './worker-sandbox.ts';

const Marker = z.object({ roots: z.array(z.string().refine(isAbsolute)).min(1) });
const RUNTIME_MANAGED_ENV_KEYS = [
  'TMPDIR',
  'TMP',
  'TEMP',
  'CLAUDE_CODE_TMPDIR',
  'XDG_CACHE_HOME',
  'HYPERNEO_WORKTREES',
  'HYPERNEO_EVIDENCE',
  'HYPERNEO_BUILDS',
] as const;
const managedEnv = (env: Record<string, string>) =>
  Object.fromEntries(RUNTIME_MANAGED_ENV_KEYS.map((key) => [key, env[key]]));
const markerPath = (root: string) => join(root, '.git/hyperneo-native-writes.json');
const settingsPath = (root: string) => join(root, '.claude/settings.local.json');
const editRule = (path: string, tree = false) =>
  `Edit(/${path.replace(/([*?[\]\\])/g, '\\$1')}${tree ? '/**' : ''})`;
let pending: Promise<void> = Promise.resolve();

function policy(root: string, roots: string[], siblings: string[]) {
  return {
    env: workerSandboxPaths(root),
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: {
        denyRead: [...workerSecretPaths(), ...secretNamePatterns(homedir())],
        allowWrite: [root, join(root, '.git'), ...workerWritableRoots(root)],
        denyWrite: [
          ...roots,
          ...siblings.filter((sibling) => sibling !== root),
          markerPath(root),
          settingsPath(root),
          join(root, '.git/hyperneo-worker-sandbox'),
        ],
      },
      network: {
        allowedDomains: ['*'],
        allowAllUnixSockets: true,
        allowLocalBinding: true,
      },
    },
    permissions: {
      allow: [editRule(root, true)],
      deny: [
        ...secretNamePatterns(homedir()).map((path) => `Read(/${path})`),
        ...workerSecretPaths().flatMap((path) => [
          editRule(path).replace(/^Edit\(/, 'Read('),
          editRule(path, true).replace(/^Edit\(/, 'Read('),
        ]),
        ...[...roots, ...siblings.filter((sibling) => sibling !== root)].map((path) =>
          editRule(path, true)
        ),
        editRule(settingsPath(root)),
        editRule(markerPath(root)),
      ],
      disableBypassPermissionsMode: 'disable',
    },
  };
}

async function writeAtomic(path: string, value: unknown) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function install(root: string, roots: string[]) {
  const siblings = (await readdir(dirname(root), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dirname(root), entry.name));
  const workers: { root: string; roots: string[] }[] = [];
  for (const sibling of siblings) {
    if (sibling === root) continue;
    try {
      workers.push({
        root: sibling,
        ...Marker.parse(JSON.parse(await readFile(markerPath(sibling), 'utf8'))),
      });
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  await prepareWorkerSandbox(root);
  await mkdir(join(root, '.claude'), { recursive: true });
  if (!(await lstat(join(root, '.claude'))).isDirectory())
    throw new Error('Native write policy requires an in-clone .claude directory');
  await writeAtomic(settingsPath(root), policy(root, roots, siblings));
  await excludeWorkerConfig(root, '/.claude/settings.local.json');
  await writeAtomic(markerPath(root), { roots });
  for (const worker of workers) {
    if (!(await lstat(join(worker.root, '.claude'))).isDirectory())
      throw new Error('Native write policy requires an in-clone .claude directory');
    const computed = policy(worker.root, worker.roots, siblings);
    const existing = await readFile(settingsPath(worker.root), 'utf8')
      .then(JSON.parse)
      .catch(() => computed);
    await writeAtomic(settingsPath(worker.root), withSecretDenials(computed, existing));
  }
}

export function installClaudeNativeWrites(directory: string, roots: string[]): Promise<void> {
  const next = pending
    .catch(() => {})
    .then(() => install(resolve(directory), [...new Set(roots.map((root) => resolve(root)))]));
  pending = next;
  return next;
}

function withSecretDenials(
  computed: ReturnType<typeof policy>,
  existing: Partial<ReturnType<typeof policy>>,
  resetFilesystem = false
) {
  const ghConfig = join(homedir(), '.config/gh');
  const obsoleteGhRules = [editRule(ghConfig), editRule(ghConfig, true)].map((rule) =>
    rule.replace(/^Edit\(/, 'Read(')
  );
  return {
    ...computed,
    ...existing,
    env: { ...(existing?.env ?? computed.env), ...managedEnv(computed.env) },
    permissions: {
      ...computed.permissions,
      ...existing?.permissions,
      deny: [
        ...new Set([...computed.permissions.deny, ...(existing?.permissions?.deny ?? [])]),
      ].filter((rule) => !obsoleteGhRules.includes(rule)),
    },
    sandbox: {
      ...computed.sandbox,
      ...existing?.sandbox,
      network: {
        ...computed.sandbox.network,
        ...existing?.sandbox?.network,
        allowAllUnixSockets: computed.sandbox.network.allowAllUnixSockets,
      },
      filesystem: {
        ...(resetFilesystem
          ? computed.sandbox.filesystem
          : { ...computed.sandbox.filesystem, ...existing?.sandbox?.filesystem }),
        denyRead: [
          ...new Set([
            ...computed.sandbox.filesystem.denyRead,
            ...(existing?.sandbox?.filesystem?.denyRead ?? []).filter((path) => path !== ghConfig),
          ]),
        ],
      },
    },
  };
}

export async function readClaudeWorkerSandbox(directory: string | undefined) {
  if (!directory) return null;
  const marker = await readFile(markerPath(directory), 'utf8').catch((error) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (marker === null) return null;
  const { roots } = Marker.parse(JSON.parse(marker));
  await prepareWorkerSandbox(directory);
  const computed = policy(directory, roots, []);
  const existing = await readFile(settingsPath(directory), 'utf8')
    .then(JSON.parse)
    .catch(() => ({}));
  const before = JSON.stringify(existing);
  if (!existing?.env || !existing?.sandbox) {
    Object.assign(existing ?? {}, { env: computed.env, sandbox: computed.sandbox });
  }
  if (existing?.sandbox?.network && existing.sandbox.network.allowLocalBinding === undefined) {
    existing.sandbox.network.allowLocalBinding = computed.sandbox.network.allowLocalBinding;
  }
  const upgraded = withSecretDenials(computed, existing, true);
  if (before !== JSON.stringify(upgraded)) await writeAtomic(settingsPath(directory), upgraded);
  return upgraded;
}
