import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installClaudeNativeWrites,
  readClaudeWorkerSandbox,
} from '../../../../src/lib/drivers/claude-native-writes.ts';
import {
  codexWorkerSandbox,
  workerSandboxPaths,
} from '../../../../src/lib/drivers/worker-sandbox.ts';

let fixture: string;
let root: string;
let dataDir: string;
beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'worker-loopback-'));
  root = join(fixture, 'worker');
  mkdirSync(join(root, '.git/info'), { recursive: true });
  dataDir = mkdtempSync(join(tmpdir(), 'worker-data-'));
  process.env.HYPERNEO_DATA_DIR = dataDir;
});
afterEach(() => {
  rmSync(join(workerSandboxPaths(root).TMPDIR, '..'), { recursive: true, force: true });
  rmSync(fixture, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.HYPERNEO_DATA_DIR;
});

const settings = () => JSON.parse(readFileSync(join(root, '.claude/settings.local.json'), 'utf8'));

test('written Claude worker settings permit sandboxed local servers', async () => {
  await installClaudeNativeWrites(root, [join(root, 'source')]);
  expect(settings().sandbox.network.allowLocalBinding).toBe(true);
});

test('resuming an older worker persists local listening without replacing its network choices', async () => {
  await installClaudeNativeWrites(root, [join(root, 'source')]);
  const old = settings();
  delete old.sandbox.network.allowLocalBinding;
  old.sandbox.network.allowedDomains = ['synthetic.invalid'];
  writeFileSync(join(root, '.claude/settings.local.json'), JSON.stringify(old));
  await readClaudeWorkerSandbox(root);
  expect(settings().sandbox.network).toEqual({ ...old.sandbox.network, allowLocalBinding: true });
  expect(settings().permissions).toEqual(old.permissions);
});

test.each([false, true])(
  'resuming returns the persisted local binding choice %s',
  async (allowed) => {
    await installClaudeNativeWrites(root, [join(root, 'source')]);
    const persisted = settings();
    persisted.sandbox.network.allowLocalBinding = allowed;
    writeFileSync(join(root, '.claude/settings.local.json'), JSON.stringify(persisted));
    expect(await readClaudeWorkerSandbox(root)).toEqual(persisted);
    expect(settings()).toEqual(persisted);
  }
);

test('both Codex policy shapes enable network access for local servers', () => {
  const policy = codexWorkerSandbox(root);
  expect(policy.config.sandbox_workspace_write.network_access).toBe(true);
  expect(policy.sandboxPolicy.networkAccess).toBe(true);
});

test('installed Claude worker settings export the data-root work locations', async () => {
  await installClaudeNativeWrites(root, [join(root, 'source')]);
  const env = settings().env as Record<string, string>;
  expect(env.HYPERNEO_WORKTREES).toBe(join(dataDir, 'worktrees'));
  expect(env.HYPERNEO_EVIDENCE.startsWith(join(dataDir, 'work', 'evidence'))).toBe(true);
  expect(env.HYPERNEO_BUILDS.startsWith(join(dataDir, 'work', 'builds'))).toBe(true);
  expect(env.TMPDIR.startsWith(join(dataDir, 'work', 'scratch'))).toBe(true);
});

test('the Codex worker sandbox exports the work locations as writable roots', () => {
  const policy = codexWorkerSandbox(root);
  const set = policy.config.shell_environment_policy.set as Record<string, string>;
  expect(set.HYPERNEO_WORKTREES).toBe(join(dataDir, 'worktrees'));
  expect(set.HYPERNEO_EVIDENCE.startsWith(join(dataDir, 'work', 'evidence'))).toBe(true);
  expect(set.HYPERNEO_BUILDS.startsWith(join(dataDir, 'work', 'builds'))).toBe(true);
  expect(set.TMPDIR.startsWith(join(dataDir, 'work', 'scratch'))).toBe(true);
  for (const path of [set.HYPERNEO_WORKTREES, set.HYPERNEO_EVIDENCE, set.HYPERNEO_BUILDS, set.TMPDIR]) {
    expect(policy.sandboxPolicy.writableRoots).toContain(path);
  }
});
