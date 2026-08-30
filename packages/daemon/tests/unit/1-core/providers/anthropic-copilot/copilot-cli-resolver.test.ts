import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getCopilotCliBinaryName,
  getCopilotPlatformPackageName,
  resolveCopilotCliPath,
  _resetForTesting,
} from '../../../../../src/lib/providers/anthropic-copilot/copilot-cli-resolver.ts';

describe('copilot-cli-resolver', () => {
  const originalEnv = process.env.COPILOT_CLI_PATH;
  let tmpDir = '';

  beforeEach(() => {
    _resetForTesting();
    delete process.env.COPILOT_CLI_PATH;
  });

  afterEach(() => {
    _resetForTesting();
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

  it('returns binary name based on platform', () => {
    const binaryName = getCopilotCliBinaryName();
    if (process.platform === 'win32') {
      expect(binaryName).toBe('copilot.exe');
    } else {
      expect(binaryName).toBe('copilot');
    }
  });

  it('returns platform package name for supported platforms', () => {
    const pkg = getCopilotPlatformPackageName();
    if (process.platform === 'darwin') {
      expect(pkg).toMatch(/^@github\/copilot-darwin-(x64|arm64)$/);
    } else if (process.platform === 'linux') {
      expect(pkg).toMatch(/^@github\/copilot-linux(musl)?-(x64|arm64)$/);
    } else if (process.platform === 'win32') {
      expect(pkg).toMatch(/^@github\/copilot-win32-(x64|arm64)$/);
    }
  });

  it('respects COPILOT_CLI_PATH if set to a valid existing binary in process.env', () => {
    process.env.COPILOT_CLI_PATH = process.execPath;
    _resetForTesting();
    expect(resolveCopilotCliPath()).toBe(process.execPath);
  });

  it('prioritizes provider-scoped env override over process.env', () => {
    process.env.COPILOT_CLI_PATH = '/tmp/nonexistent-path-1';
    _resetForTesting();
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
    process.env.COPILOT_CLI_PATH = '/tmp/nonexistent-copilot-binary-12345';
    _resetForTesting();
    const resolved = resolveCopilotCliPath();
    expect(resolved).not.toBe('/tmp/nonexistent-copilot-binary-12345');
  });

  it('resolves native copilot binary in node_modules environment', () => {
    const binary = resolveCopilotCliPath();
    expect(binary).toBeDefined();
    expect(typeof binary).toBe('string');
    expect(binary!.length).toBeGreaterThan(0);
    expect(binary!.endsWith('.js')).toBe(false);
  });
});
