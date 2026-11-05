import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  copilotRuntimePackage,
  resolveCopilotCliPath,
  resolveCopilotRuntime,
  resolveRuntime,
} from '../../../../../src/lib/providers/anthropic-copilot/copilot-cli-resolver.ts';
import { installFakeCurl, npmTarball } from '../../../helpers/npm-tarball.ts';

describe('copilot-cli-resolver', () => {
  const originalEnv = process.env.COPILOT_CLI_PATH;
  let tmpDir = '';

  beforeEach(() => {
    delete process.env.COPILOT_CLI_PATH;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.COPILOT_CLI_PATH = originalEnv;
    } else {
      delete process.env.COPILOT_CLI_PATH;
    }
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
      tmpDir = '';
    }
  });

  it('respects COPILOT_CLI_PATH if set to a valid existing binary in process.env', () => {
    process.env.COPILOT_CLI_PATH = process.execPath;
    expect(resolveCopilotCliPath()).toBe(process.execPath);
  });

  it('prioritizes provider-scoped env override over process.env', () => {
    process.env.COPILOT_CLI_PATH = '/tmp/nonexistent-path-1';
    const customEnv = { COPILOT_CLI_PATH: process.execPath };
    expect(resolveCopilotCliPath(customEnv)).toBe(process.execPath);
  });

  it('accepts valid symlinked executable paths in COPILOT_CLI_PATH', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'copilot-symlink-test-'));
    const symlinkPath = join(tmpDir, 'copilot-link');
    symlinkSync(process.execPath, symlinkPath);

    expect(resolveCopilotCliPath({ COPILOT_CLI_PATH: symlinkPath })).toBe(symlinkPath);
  });

  it('ignores COPILOT_CLI_PATH when pointing to non-existent path', () => {
    const resolved = resolveCopilotCliPath({
      COPILOT_CLI_PATH: '/tmp/nonexistent-copilot-binary-12345',
    });
    expect(resolved).toBeUndefined();
  });

  it('returns undefined without COPILOT_CLI_PATH so the SDK uses its bundled runtime', () => {
    expect(resolveCopilotCliPath({})).toBeUndefined();
  });
});

describe('copilotRuntimePackage', () => {
  it.each([
    ['darwin', 'arm64', false, 'darwin-arm64', 'copilot-runtime'],
    ['linux', 'x64', false, 'linux-x64', 'copilot-runtime'],
    ['linux', 'arm64', true, 'linuxmusl-arm64', 'copilot-runtime'],
    ['win32', 'x64', false, 'win32-x64', 'copilot-runtime.exe'],
  ])('maps %s-%s musl=%s to its platform package', (platform, arch, musl, name, binary) => {
    const target = copilotRuntimePackage({ platform, arch, musl }, '1.2.3', '/data/sdk');

    expect(target).toEqual({
      name: `@github/copilot-sdk-${name}`,
      version: '1.2.3',
      wrapper: join('prebuilds', name, binary),
      cacheDir: join('/data/sdk', `copilot-1.2.3-${name}`),
    });
  });

  it('refuses a platform the SDK does not publish', () => {
    expect(() =>
      copilotRuntimePackage({ platform: 'freebsd', arch: 'x64', musl: false }, '1.2.3', '/data')
    ).toThrow('Unsupported Copilot platform: freebsd-x64');
  });
});

describe('resolveRuntime', () => {
  const host = { platform: 'linux', arch: 'x64', musl: false };
  const originalPath = process.env.PATH;
  const fixture = npmTarball([
    { path: 'package/prebuilds/linux-x64/copilot-runtime', body: 'wrapper', mode: 0o755 },
    { path: 'package/prebuilds/linux-x64/runtime.node', body: 'runtime' },
  ]);
  let run = '';
  const target = () => [host, '1.2.3', join(run, 'sdk'), true] as const;

  beforeEach(() => {
    run = mkdtempSync(join(tmpdir(), 'copilot-runtime-'));
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(run, { recursive: true, force: true });
  });

  it('downloads on first use and reads the cache afterwards', async () => {
    const curl = installFakeCurl(run, fixture);
    process.env.PATH = curl.path;
    const path = join(run, 'sdk/copilot-1.2.3-linux-x64/prebuilds/linux-x64/copilot-runtime');

    expect(await resolveRuntime({}, ...target())).toEqual({ path, source: 'download' });
    expect(await resolveRuntime({}, ...target())).toEqual({ path, source: 'cache' });

    expect(readFileSync(curl.log, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readdirSync(join(run, 'sdk'))).toEqual(['copilot-1.2.3-linux-x64']);
  });

  it('shares one download between concurrent callers', async () => {
    const curl = installFakeCurl(run, fixture);
    process.env.PATH = curl.path;

    const [first, second] = await Promise.all([
      resolveRuntime({}, ...target()),
      resolveRuntime({}, ...target()),
    ]);

    expect(first).toEqual(second);
    expect(readFileSync(curl.log, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('caches nothing when the integrity check fails', async () => {
    process.env.PATH = installFakeCurl(run, fixture, 'sha512-no').path;

    await expect(resolveRuntime({}, ...target())).rejects.toThrow(
      'Could not download @github/copilot-sdk-linux-x64'
    );

    expect(readdirSync(join(run, 'sdk'))).toEqual([]);
  });

  it('refuses a package without the runtime files', async () => {
    const incomplete = npmTarball([{ path: 'package/readme.txt', body: 'no runtime' }]);
    process.env.PATH = installFakeCurl(run, incomplete).path;

    await expect(resolveRuntime({}, ...target())).rejects.toThrow('Could not download');

    expect(existsSync(join(run, 'sdk/copilot-1.2.3-linux-x64'))).toBe(false);
  });

  it('prefers COPILOT_CLI_PATH without touching the network', async () => {
    const curl = installFakeCurl(run, fixture);
    process.env.PATH = curl.path;

    expect(await resolveRuntime({ COPILOT_CLI_PATH: process.execPath }, ...target())).toEqual({
      path: process.execPath,
      source: 'env',
    });

    expect(existsSync(curl.log)).toBe(false);
  });
});

describe('resolveCopilotRuntime', () => {
  it('uses the installed platform package when running from source', async () => {
    const { path, source } = await resolveCopilotRuntime({});

    expect(source).toBe('node_modules');
    expect(path).toMatch(/copilot-runtime(\.exe)?$/);
  });
});
