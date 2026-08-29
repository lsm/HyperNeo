import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
  getCopilotCliBinaryName,
  getCopilotPlatformPackageName,
  resolveCopilotCliPath,
  _resetForTesting,
} from '../../../../../src/lib/providers/anthropic-copilot/copilot-cli-resolver.ts';

describe('copilot-cli-resolver', () => {
  const originalEnv = process.env.COPILOT_CLI_PATH;

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

  it('respects COPILOT_CLI_PATH if set to a valid existing binary', () => {
    process.env.COPILOT_CLI_PATH = process.execPath;
    _resetForTesting();
    expect(resolveCopilotCliPath()).toBe(process.execPath);
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
