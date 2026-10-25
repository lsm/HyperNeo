import { appendFile, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { prepareWorkerSandbox, workerSandboxPaths } from './worker-sandbox.ts';

const Marker = z.object({ roots: z.array(z.string().refine(isAbsolute)).min(1) });
const markerPath = (root: string) => join(root, '.git/hyperneo-native-writes.json');
const settingsPath = (root: string) => join(root, '.claude/settings.local.json');
const editRule = (path: string, tree = false) =>
  `Edit(/${path.replace(/([*?[\]\\])/g, '\\$1')}${tree ? '/**' : ''})`;
let pending: Promise<void> = Promise.resolve();

function policy(root: string, roots: string[], siblings: string[]) {
  return JSON.stringify({
    env: workerSandboxPaths(root),
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: {
        allowWrite: [root, join(root, '.git'), ...Object.values(workerSandboxPaths(root))],
        denyWrite: [...roots, ...siblings.filter((sibling) => sibling !== root)],
      },
      network: { allowUnixSockets: [], allowAllUnixSockets: false },
    },
    permissions: {
      allow: [editRule(root, true)],
      deny: [
        ...[...roots, ...siblings.filter((sibling) => sibling !== root)].map((path) =>
          editRule(path, true)
        ),
        editRule(settingsPath(root)),
        editRule(markerPath(root)),
      ],
      disableBypassPermissionsMode: 'disable',
    },
  });
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
  await writeFile(settingsPath(root), policy(root, roots, siblings), { flag: 'wx', mode: 0o600 });
  await appendFile(join(root, '.git/info/exclude'), '\n/.claude/settings.local.json\n');
  await writeFile(markerPath(root), JSON.stringify({ roots }), { flag: 'wx', mode: 0o600 });
  for (const worker of workers) {
    if (!(await lstat(join(worker.root, '.claude'))).isDirectory())
      throw new Error('Native write policy requires an in-clone .claude directory');
    const temporary = `${settingsPath(worker.root)}.hyperneo-tmp`;
    await writeFile(temporary, policy(worker.root, worker.roots, siblings), { mode: 0o600 });
    await rename(temporary, settingsPath(worker.root));
  }
}

export function installClaudeNativeWrites(directory: string, roots: string[]): Promise<void> {
  const next = pending
    .catch(() => {})
    .then(() => install(resolve(directory), [...new Set(roots.map((root) => resolve(root)))]));
  pending = next;
  return next;
}
