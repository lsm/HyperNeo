import { appendFile, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { homedir } from 'node:os';
import { secretNamePatterns } from '../neo/secret-read-rules.ts';
import { prepareWorkerSandbox, workerSandboxPaths, workerSecretPaths } from './worker-sandbox.ts';

const Marker = z.object({ roots: z.array(z.string().refine(isAbsolute)).min(1) });
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
        allowWrite: [root, join(root, '.git'), ...Object.values(workerSandboxPaths(root))],
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
        allowUnixSockets: [],
        allowAllUnixSockets: false,
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

async function writePolicy(root: string, value: ReturnType<typeof policy>) {
  const temporary = `${settingsPath(root)}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  await rename(temporary, settingsPath(root));
}

async function install(root: string, roots: string[]) {
  const siblings = (await readdir(dirname(root), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dirname(root), entry.name));
  const workers: { root: string; roots: string[] }[] = [];
  for (const sibling of siblings) {
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
  await writeFile(settingsPath(root), JSON.stringify(policy(root, roots, siblings)), {
    flag: 'wx',
    mode: 0o600,
  });
  await appendFile(join(root, '.git/info/exclude'), '\n/.claude/settings.local.json\n');
  await writeFile(markerPath(root), JSON.stringify({ roots }), { flag: 'wx', mode: 0o600 });
  for (const worker of workers) {
    if (!(await lstat(join(worker.root, '.claude'))).isDirectory())
      throw new Error('Native write policy requires an in-clone .claude directory');
    const computed = policy(worker.root, worker.roots, siblings);
    const existing = await readFile(settingsPath(worker.root), 'utf8')
      .then(JSON.parse)
      .catch(() => computed);
    await writePolicy(worker.root, withSecretDenials(computed, existing));
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
  existing: Partial<ReturnType<typeof policy>>
) {
  return {
    ...computed,
    ...existing,
    permissions: {
      ...computed.permissions,
      ...existing?.permissions,
      deny: [...new Set([...computed.permissions.deny, ...(existing?.permissions?.deny ?? [])])],
    },
    sandbox: {
      ...computed.sandbox,
      ...existing?.sandbox,
      filesystem: {
        ...computed.sandbox.filesystem,
        ...existing?.sandbox?.filesystem,
        denyRead: [
          ...new Set([
            ...computed.sandbox.filesystem.denyRead,
            ...(existing?.sandbox?.filesystem?.denyRead ?? []),
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
  const upgraded = withSecretDenials(computed, existing);
  if (before !== JSON.stringify(upgraded)) await writePolicy(directory, upgraded);
  return upgraded;
}
