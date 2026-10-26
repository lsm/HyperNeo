import { afterEach, beforeEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { execFileSync } from 'node:child_process';
import { secretHomePaths } from '../../../../src/lib/neo/secret-read-rules.ts';
import {
  codexWorkerSandbox,
  persistCodexWorkerProfile,
  workerSandboxPaths,
} from '../../../../src/lib/drivers/worker-sandbox.ts';
import {
  installClaudeNativeWrites,
  readClaudeWorkerSandbox,
} from '../../../../src/lib/drivers/claude-native-writes.ts';

vi.mock('../../../../src/lib/drivers/worker-sandbox.ts', async (original) => {
  const actual = await original<typeof import('../../../../src/lib/drivers/worker-sandbox.ts')>();
  return {
    ...actual,
    prepareWorkerSandbox: async (root: string) => actual.workerSandboxPaths(root),
  };
});

let fixture: string;
let root: string;
beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'secret-policy-'));
  root = join(fixture, 'worker');
  mkdirSync(join(root, '.git/info'), { recursive: true });
  vi.stubEnv('HOME', join(fixture, 'home'));
  vi.stubEnv('HYPERNEO_DATA_DIR', join(fixture, 'home/.hyperneo'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(join(workerSandboxPaths(root).TMPDIR, '..'), { recursive: true, force: true });
  rmSync(fixture, { recursive: true, force: true });
});
const settingsPath = () => join(root, '.claude/settings.local.json');
const settings = () => JSON.parse(readFileSync(settingsPath(), 'utf8'));

test('Codex selected profile denies synthetic credentials and permits repository reads', () => {
  const launch = codexWorkerSandbox(root) as unknown as {
    permissions: string;
    config: { permissions: Record<string, { filesystem: Record<string, string> }> };
  };
  const fs = launch.config.permissions[launch.permissions].filesystem;
  expect(fs[join(fixture, 'home/.ssh')]).toBe('deny');
  expect(fs[join(fixture, 'home/.codex/auth.json')]).toBe('deny');
  expect(fs[join(fixture, 'home/.hyperneo/.provider-credential-key')]).toBe('deny');
  expect(fs[root]).toBe('write');
  expect(fs[join(root, '.codex')]).toBe('read');
  expect(fs[join(root, '.agents')]).toBe('read');
  expect(fs[':root']).toBe('read');
});

test('configured engine homes remain denied without denying the worker repo', async () => {
  vi.stubEnv('CODEX_HOME', join(fixture, 'codex-home'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(fixture, 'claude-home'));
  vi.stubEnv('HYPERNEO_DATA_DIR', join(fixture, 'daemon-home'));
  const fs = codexWorkerSandbox(root).config.permissions['hyperneo-worker'].filesystem as Record<
    string,
    string
  >;
  expect(fs[join(fixture, 'codex-home/auth.json')]).toBe('deny');
  expect(fs[join(fixture, 'daemon-home/.provider-credential-key')]).toBe('deny');
  expect(fs[join(fixture, 'claude-home/.credentials.json')]).toBe('deny');
  await installClaudeNativeWrites(root, [join(fixture, 'source')]);
  expect(settings().sandbox.filesystem.denyRead).toContain(join(fixture, 'codex-home/auth.json'));
  expect(settings().sandbox.filesystem.denyRead).toContain(
    join(fixture, 'claude-home/.credentials.json')
  );
});

test('workers deny every established home credential path in both engines', async () => {
  const home = join(fixture, 'home');
  const fs = codexWorkerSandbox(root).config.permissions['hyperneo-worker'].filesystem as Record<
    string,
    string
  >;
  await installClaudeNativeWrites(root, [join(fixture, 'source')]);
  for (const path of secretHomePaths(home).filter((path) => path !== join(home, 'Library'))) {
    expect(fs[path], path).toBe('deny');
    expect(settings().sandbox.filesystem.denyRead, path).toContain(path);
  }
});

test('toolchain Library stays readable while Keychains stays denied', async () => {
  const fs = codexWorkerSandbox(root).config.permissions['hyperneo-worker'].filesystem as Record<
    string,
    string
  >;
  expect(fs[join(fixture, 'home/Library')]).toBeUndefined();
  expect(fs[join(fixture, 'home/Library/Keychains')]).toBe('deny');
});

test('a tracked project config is refused without changing repository bytes', async () => {
  execFileSync('git', ['init', '-q', root]);
  mkdirSync(join(root, '.codex'));
  const path = join(root, '.codex/config.toml');
  const original = 'model = "synthetic"\n';
  writeFileSync(path, original);
  execFileSync('git', ['-C', root, 'add', '.codex/config.toml']);
  await expect(persistCodexWorkerProfile(root)).rejects.toThrow('tracked');
  expect(readFileSync(path, 'utf8')).toBe(original);
});

test('Desktop reload can resolve the protected profile without bootstrap overrides', async () => {
  mkdirSync(join(root, '.codex'));
  const path = join(root, '.codex/config.toml');
  writeFileSync(path, 'model = "synthetic"\n[permissions.other.filesystem]\n":root" = "read"\n');
  await persistCodexWorkerProfile(root);
  await persistCodexWorkerProfile(root);
  const reloaded = parse(readFileSync(path, 'utf8'));
  expect(reloaded.model).toBe('synthetic');
  expect(reloaded.permissions).toEqual({
    other: { filesystem: { ':root': 'read' } },
    ...codexWorkerSandbox(root).config.permissions,
  });
});

test.each([false, true])(
  'Claude denies synthetic secrets on creation and legacy resume (%s)',
  async (legacy) => {
    await installClaudeNativeWrites(root, [join(fixture, 'source')]);
    if (legacy) {
      const previous = settings();
      delete previous.sandbox.filesystem.denyRead;
      previous.permissions.deny = previous.permissions.deny.filter(
        (rule: string) => !rule.startsWith('Read(')
      );
      writeFileSync(settingsPath(), JSON.stringify(previous));
      await readClaudeWorkerSandbox(root);
    }
    const policy = settings();
    expect(policy.sandbox.filesystem.denyRead).toContain(join(fixture, 'home/.ssh'));
    expect(policy.permissions.deny).toContain(`Read(/${fixture}/home/.ssh/**)`);
    expect(policy.sandbox.filesystem.denyRead).not.toContain(root);
    expect(policy.permissions.deny).not.toContain(`Read(/${root}/**)`);
  }
);
