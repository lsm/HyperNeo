import { afterEach, beforeEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import * as fileOperations from 'node:fs/promises';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { execFileSync } from 'node:child_process';
import { secretHomePaths } from '../../../../src/lib/neo/secret-read-rules.ts';
import {
  codexWorkerSandbox,
  persistCodexWorkerProfile,
  requireCodexWorkerProfile,
  workerSandboxPaths,
} from '../../../../src/lib/drivers/worker-sandbox.ts';
import {
  installClaudeNativeWrites,
  readClaudeWorkerSandbox,
} from '../../../../src/lib/drivers/claude-native-writes.ts';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));

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

test('runtime preparation refuses a linked Git directory before touching host markers', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../src/lib/drivers/worker-sandbox.ts')
  >('../../../../src/lib/drivers/worker-sandbox.ts');
  const outside = join(fixture, 'synthetic-host');
  mkdirSync(outside);
  const marker = join(outside, 'hyperneo-worker-sandbox');
  writeFileSync(marker, 'synthetic host bytes');
  rmSync(join(root, '.git'), { recursive: true });
  symlinkSync(outside, join(root, '.git'));
  const runtime = join(workerSandboxPaths(root).TMPDIR, '..');
  const mkdir = fileOperations.mkdir;
  const inspect = fileOperations.lstat;
  const privateDirectory = await inspect(fixture);
  const runtimeMkdir = vi
    .spyOn(fileOperations, 'mkdir')
    .mockImplementation(async (path, options) =>
      String(path).startsWith(runtime) ? undefined : mkdir(path, options)
    );
  const runtimeInspect = vi
    .spyOn(fileOperations, 'lstat')
    .mockImplementation(async (path) =>
      String(path).startsWith(runtime) ? privateDirectory : inspect(path)
    );
  try {
    const failure = await actual.prepareWorkerSandbox(root).then(
      () => null,
      (error) => error
    );
    expect(readFileSync(marker, 'utf8')).toBe('synthetic host bytes');
    expect(failure).toBeInstanceOf(Error);
  } finally {
    runtimeMkdir.mockRestore();
    runtimeInspect.mockRestore();
  }
});

test('a config replacement cannot copy synthetic host TOML into the clone', async () => {
  await persistCodexWorkerProfile(root);
  const path = join(root, '.codex/config.toml');
  const original = parse(readFileSync(path, 'utf8'));
  writeFileSync(path, stringify({ ...original, model: 'synthetic-repo-model' }));
  const host = join(fixture, 'synthetic-host.toml');
  const hostText = stringify({ ...original, model: 'synthetic-private-host-model' });
  writeFileSync(host, hostText);
  const swap = () => {
    rmSync(path);
    symlinkSync(host, path);
  };
  const inspect = fileOperations.lstat;
  const open = fileOperations.open;
  const inspection = vi.spyOn(fileOperations, 'lstat').mockImplementation(async (candidate) => {
    const entry = await inspect(candidate);
    if (candidate === path) swap();
    return entry;
  });
  const opening = vi.spyOn(fileOperations, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === path) swap();
    return handle;
  });
  try {
    await persistCodexWorkerProfile(root);
    expect(parse(readFileSync(path, 'utf8')).model).toBe('synthetic-repo-model');
    expect(readFileSync(host, 'utf8')).toBe(hostText);
  } finally {
    inspection.mockRestore();
    opening.mockRestore();
  }
});

test('refreshing an installed profile leaves worker-controlled Git metadata alone', async () => {
  await persistCodexWorkerProfile(root);
  const outside = join(fixture, 'synthetic-host');
  mkdirSync(outside);
  const path = join(outside, 'exclude');
  const original = 'synthetic host bytes\n';
  writeFileSync(path, original);
  rmSync(join(root, '.git/info'), { recursive: true });
  symlinkSync(outside, join(root, '.git/info'));
  await persistCodexWorkerProfile(root);
  expect(readFileSync(path, 'utf8')).toBe(original);
  const profile = parse(readFileSync(join(root, '.codex/config.toml'), 'utf8'));
  expect(profile.permissions).toEqual(codexWorkerSandbox(root).config.permissions);
});

test('a Git exclude swapped after inspection cannot change host bytes', async () => {
  const path = join(root, '.git/info/exclude');
  writeFileSync(path, 'synthetic excludes\n');
  const host = join(fixture, 'synthetic-host-file');
  const original = 'synthetic host bytes\n';
  writeFileSync(host, original);
  const inspect = fileOperations.lstat;
  let swapped = false;
  const race = vi.spyOn(fileOperations, 'lstat').mockImplementation(async (candidate) => {
    const entry = await inspect(candidate);
    if (candidate === path) {
      rmSync(path);
      symlinkSync(host, path);
      swapped = true;
    }
    return entry;
  });
  try {
    const failure = await persistCodexWorkerProfile(root).then(
      () => null,
      (error) => error
    );
    expect(swapped).toBe(true);
    expect(readFileSync(host, 'utf8')).toBe(original);
    expect(failure).toBeInstanceOf(Error);
  } finally {
    race.mockRestore();
  }
});

test.each([
  ['Codex', 'git'],
  ['Codex', 'exclude'],
  ['Codex', 'info'],
  ['Claude', 'git'],
  ['Claude', 'exclude'],
  ['Claude', 'info'],
])('%s refuses a symlinked Git %s without changing host bytes', async (engine, target) => {
  const outside = join(fixture, 'synthetic-host');
  mkdirSync(join(outside, 'info'), { recursive: true });
  const path = join(outside, target === 'git' ? 'info/exclude' : 'exclude');
  const original = 'synthetic host file\n';
  writeFileSync(path, original);
  const link =
    target === 'git'
      ? join(root, '.git')
      : join(root, '.git/info', target === 'info' ? '' : 'exclude');
  rmSync(link, { recursive: true, force: true });
  symlinkSync(target === 'exclude' ? path : outside, link);
  const failure = await (engine === 'Codex'
    ? persistCodexWorkerProfile(root)
    : installClaudeNativeWrites(root, [join(fixture, 'source')])
  ).then(
    () => null,
    (error) => error
  );
  expect(readFileSync(path, 'utf8')).toBe(original);
  expect(failure).toBeInstanceOf(Error);
});

test('Codex selected profile denies synthetic credentials and permits repository reads', () => {
  const launch = codexWorkerSandbox(root) as unknown as {
    permissions: string;
    config: { permissions: Record<string, { filesystem: Record<string, unknown> }> };
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

test('profile metadata checks never execute worker-configured Git monitors', async () => {
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'README'), 'synthetic repository');
  execFileSync('git', ['-C', root, 'add', 'README']);
  const marker = join(fixture, 'monitor-executed');
  const hook = join(fixture, 'monitor.sh');
  writeFileSync(hook, `#!/bin/sh\nprintf synthetic > '${marker}'\nprintf 'token\\0'\n`, {
    mode: 0o700,
  });
  execFileSync('git', ['-C', root, 'config', 'core.fsmonitor', hook]);
  await persistCodexWorkerProfile(root);
  expect(() => readFileSync(marker)).toThrow();
});

test.each([undefined, [], [{ id: 'hyperneo-worker', allowed: false }]])(
  'Codex refuses missing or disallowed profiles (%j)',
  async (data) => {
    await expect(requireCodexWorkerProfile({ call: async () => ({ data }) }, root)).rejects.toThrow(
      'must support'
    );
  }
);

test('Codex accepts the installed allowed worker profile', async () => {
  await expect(
    requireCodexWorkerProfile(
      { call: async () => ({ data: [{ id: 'hyperneo-worker', allowed: true }] }) },
      root
    )
  ).resolves.toBeUndefined();
});

test('environment and private-key filename rules deny synthetic home secrets', async () => {
  const home = join(fixture, 'home');
  const fs = codexWorkerSandbox(root).config.permissions['hyperneo-worker'].filesystem as Record<
    string,
    unknown
  >;
  for (const path of [
    join(home, '.env'),
    join(home, '*/.env.*'),
    join(home, '*/*.pem'),
    join(home, '*/*.key'),
  ])
    expect(fs[path]).toBe('deny');
  await installClaudeNativeWrites(root, [join(fixture, 'source')]);
  expect(settings().sandbox.filesystem.denyRead).toContain(join(home, '*/*.pem'));
  expect(settings().permissions.deny).toContain(`Read(/${home}/*/*.pem)`);
});

test('reading a complete Claude policy does not rewrite its settings', async () => {
  await installClaudeNativeWrites(root, [join(fixture, 'source')]);
  utimesSync(settingsPath(), new Date(1000), new Date(1000));
  await readClaudeWorkerSandbox(root);
  expect(statSync(settingsPath()).mtimeMs).toBe(1000);
});

test('nested private clones can read repository environment examples and key fixtures', async () => {
  root = join(fixture, 'home/worktrees/coding/repo');
  mkdirSync(join(root, '.git/info'), { recursive: true });
  await installClaudeNativeWrites(root, [join(fixture, 'source')]);
  const filesystem = codexWorkerSandbox(root).config.permissions['hyperneo-worker']
    .filesystem as Record<string, unknown>;
  const denied = Object.entries(filesystem)
    .filter(([, access]) => access === 'deny')
    .map(([path]) => path);
  mkdirSync(join(root, 'fixtures'), { recursive: true });
  for (const name of ['.env.example', 'fixtures/test.pem', 'fixtures/test.key']) {
    const path = join(root, name);
    writeFileSync(path, 'synthetic repository fixture');
    expect(
      denied.some((pattern) => matchesGlob(path, pattern) || path.startsWith(`${pattern}/`))
    ).toBe(false);
    expect(
      settings().sandbox.filesystem.denyRead.some(
        (pattern: string) => matchesGlob(path, pattern) || path.startsWith(`${pattern}/`)
      )
    ).toBe(false);
  }
  expect(filesystem[root]).toBe('write');
});

test('Desktop reload can resolve the protected profile without bootstrap overrides', async () => {
  await persistCodexWorkerProfile(root);
  const path = join(root, '.codex/config.toml');
  const original = parse(readFileSync(path, 'utf8'));
  original.model = 'synthetic';
  original.permissions = {
    ...(original.permissions as object),
    other: { filesystem: { ':root': 'read' } },
  };
  writeFileSync(path, stringify(original));
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
