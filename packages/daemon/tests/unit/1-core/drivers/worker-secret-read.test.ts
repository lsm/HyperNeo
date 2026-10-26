import { afterEach, beforeEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexWorkerSandbox,
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
  expect(fs[root]).toBe('write');
  expect(fs[join(root, '.codex')]).toBe('read');
  expect(fs[join(root, '.agents')]).toBe('read');
  expect(fs[':root']).toBe('read');
});

test('configured engine homes remain denied without denying the worker repo', async () => {
  vi.stubEnv('CODEX_HOME', join(fixture, 'codex-home'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(fixture, 'claude-home'));
  const fs = codexWorkerSandbox(root).config.permissions['hyperneo-worker'].filesystem as Record<
    string,
    string
  >;
  expect(fs[join(fixture, 'codex-home/auth.json')]).toBe('deny');
  expect(fs[join(fixture, 'claude-home/.credentials.json')]).toBe('deny');
  await installClaudeNativeWrites(root, [join(fixture, 'source')]);
  expect(settings().sandbox.filesystem.denyRead).toContain(join(fixture, 'codex-home/auth.json'));
  expect(settings().sandbox.filesystem.denyRead).toContain(
    join(fixture, 'claude-home/.credentials.json')
  );
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
