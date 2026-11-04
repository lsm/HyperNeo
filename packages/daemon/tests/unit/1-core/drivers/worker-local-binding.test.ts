import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  rmSync(workerSandboxPaths(root).TMPDIR, { recursive: true, force: true });
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

test('Codex named profile enables network access for local servers', () => {
  const policy = codexWorkerSandbox(root);
  expect(policy.config.permissions['hyperneo-worker'].network.enabled).toBe(true);
});

test('installed Claude worker settings export the data-root work locations', async () => {
  await installClaudeNativeWrites(root, [join(root, 'source')]);
  const env = settings().env as Record<string, string>;
  expect(env.HYPERNEO_WORKTREES).toBe(join(dataDir, 'worktrees'));
  expect(env.HYPERNEO_EVIDENCE.startsWith(join(dataDir, 'work', 'evidence'))).toBe(true);
  expect(env.HYPERNEO_BUILDS.startsWith(join(dataDir, 'work', 'builds'))).toBe(true);
  expect(env.TMPDIR.startsWith(join(dataDir, 'work', 'scratch'))).toBe(true);
});

test('the Codex worker sandbox keeps the shared worktrees root read-only', () => {
  const policy = codexWorkerSandbox(root);
  const set = policy.config.shell_environment_policy.set as Record<string, string>;
  const profile = (
    policy.config.permissions as Record<string, { filesystem: Record<string, string> }>
  )['hyperneo-worker'].filesystem;
  expect(set.HYPERNEO_WORKTREES).toBe(join(dataDir, 'worktrees'));
  expect(set.HYPERNEO_EVIDENCE.startsWith(join(dataDir, 'work', 'evidence'))).toBe(true);
  expect(set.HYPERNEO_BUILDS.startsWith(join(dataDir, 'work', 'builds'))).toBe(true);
  expect(set.TMPDIR.startsWith(join(dataDir, 'work', 'scratch'))).toBe(true);
  for (const path of [set.HYPERNEO_EVIDENCE, set.HYPERNEO_BUILDS, set.TMPDIR, set.XDG_CACHE_HOME]) {
    expect(profile[path]).toBe('write');
  }
  expect(profile[set.HYPERNEO_WORKTREES]).not.toBe('write');
});

test('resuming recomputes filesystem roots from the current policy', async () => {
  await installClaudeNativeWrites(root, [join(root, 'source')]);
  const stale = settings();
  stale.sandbox = {
    ...stale.sandbox,
    filesystem: {
      ...stale.sandbox.filesystem,
      allowWrite: ['/tmp/hn-legacy/stale-root'],
      denyRead: [...stale.sandbox.filesystem.denyRead],
    },
  };
  writeFileSync(join(root, '.claude/settings.local.json'), JSON.stringify(stale));
  const resumed = await readClaudeWorkerSandbox(root);
  expect(resumed?.sandbox.filesystem.allowWrite).toContain(root);
  expect(resumed?.sandbox.filesystem.allowWrite).not.toContain('/tmp/hn-legacy/stale-root');
  expect(settings().sandbox.filesystem.allowWrite).toEqual(resumed?.sandbox.filesystem.allowWrite);
});

test('resuming a pre-upgrade worker adopts the data-root runtime env', async () => {
  await installClaudeNativeWrites(root, [join(root, 'source')]);
  const legacy = settings();
  legacy.env = {
    SYNTHETIC_WORKER_HINT: 'keep',
    TMPDIR: '/tmp/hn-legacy/tmp',
    XDG_CACHE_HOME: '/tmp/hn-legacy/cache',
  };
  writeFileSync(join(root, '.claude/settings.local.json'), JSON.stringify(legacy));
  const resumed = await readClaudeWorkerSandbox(root);
  expect(resumed?.env.SYNTHETIC_WORKER_HINT).toBe('keep');
  expect(resumed?.env.TMPDIR.startsWith(join(dataDir, 'work', 'scratch'))).toBe(true);
  expect(resumed?.env.XDG_CACHE_HOME.startsWith(resumed!.env.TMPDIR)).toBe(true);
  expect(resumed?.env.HYPERNEO_WORKTREES).toBe(join(dataDir, 'worktrees'));
  expect(settings().env).toEqual(resumed?.env);
});

test('reinstall replaces a settings symlink without changing its target', async () => {
  const outside = join(fixture, 'outside.json');
  writeFileSync(outside, '{"sentinel":true}');
  mkdirSync(join(root, '.claude'));
  symlinkSync(outside, join(root, '.claude/settings.local.json'));
  await installClaudeNativeWrites(root, [join(root, 'source')]);
  expect(settings().sandbox.enabled).toBe(true);
  expect(readFileSync(outside, 'utf8')).toBe('{"sentinel":true}');
});

test('reinstall uses the current protected roots for policy and marker', async () => {
  await installClaudeNativeWrites(root, [join(root, 'old-source')]);
  const source = join(root, 'new-source');
  await installClaudeNativeWrites(root, [source]);
  expect(settings().permissions.deny).toContain(`Edit(/${source}/**)`);
  const persisted = JSON.parse(
    readFileSync(join(root, '.git/hyperneo-native-writes.json'), 'utf8')
  );
  expect(persisted.roots).toEqual([source]);
  expect(await readClaudeWorkerSandbox(root)).toEqual(settings());
});

test('disabled persisted sandbox does not prepare or recreate its runtime', async () => {
  const source = join(fixture, 'source');
  const settingsPath = join(root, '.claude/settings.local.json');
  await installClaudeNativeWrites(root, [source]);
  const persisted = settings();
  persisted.sandbox.enabled = false;
  writeFileSync(settingsPath, JSON.stringify(persisted));
  rmSync(persisted.env.TMPDIR, { recursive: true, force: true });
  const resumed = await readClaudeWorkerSandbox(root);
  expect(resumed?.sandbox.enabled).toBe(false);
  expect(existsSync(persisted.env.TMPDIR)).toBe(false);
  const current = workerSandboxPaths(root);
  expect(resumed?.env).toEqual({
    HYPERNEO_WORKTREES: current.HYPERNEO_WORKTREES,
    HYPERNEO_EVIDENCE: current.HYPERNEO_EVIDENCE,
    HYPERNEO_BUILDS: current.HYPERNEO_BUILDS,
  });
  expect(settings().env).toEqual(resumed?.env);
  const normalized = readFileSync(settingsPath, 'utf8');
  await readClaudeWorkerSandbox(root);
  expect(readFileSync(settingsPath, 'utf8')).toBe(normalized);
});

test('disabled sparse settings normalize SDK fields and remove obsolete runtime env', async () => {
  const settingsPath = join(root, '.claude/settings.local.json');
  mkdirSync(join(root, '.claude'));
  writeFileSync(
    join(root, '.git/hyperneo-native-writes.json'),
    JSON.stringify({ roots: [join(fixture, 'source')] })
  );
  writeFileSync(
    settingsPath,
    JSON.stringify({
      sandbox: { enabled: false },
      env: {
        TMPDIR: '/synthetic/obsolete-temp',
        TMP: '/synthetic/obsolete-temp',
        TEMP: '/synthetic/obsolete-temp',
        CLAUDE_CODE_TMPDIR: '/synthetic/obsolete-temp',
        XDG_CACHE_HOME: '/synthetic/obsolete-cache',
        HYPERNEO_WORKTREES: '/synthetic/obsolete-worktrees',
        HYPERNEO_EVIDENCE: '/synthetic/obsolete-evidence',
        HYPERNEO_BUILDS: '/synthetic/obsolete-builds',
        CUSTOM_WORKER_VALUE: 'retain',
      },
    })
  );
  const result = await readClaudeWorkerSandbox(root);
  expect(result?.sandbox.enabled).toBe(false);
  const current = workerSandboxPaths(root);
  expect(result?.env).toEqual({
    CUSTOM_WORKER_VALUE: 'retain',
    HYPERNEO_WORKTREES: current.HYPERNEO_WORKTREES,
    HYPERNEO_EVIDENCE: current.HYPERNEO_EVIDENCE,
    HYPERNEO_BUILDS: current.HYPERNEO_BUILDS,
  });
  expect(result?.permissions.disableBypassPermissionsMode).toBe('disable');
  expect(result?.sandbox.filesystem.allowWrite).toContain(root);
  expect(settings()).toEqual(result);
  expect(existsSync(workerSandboxPaths(root).TMPDIR)).toBe(false);
});
