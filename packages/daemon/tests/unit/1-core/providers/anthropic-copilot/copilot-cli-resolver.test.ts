import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCopilotCliPath } from '../../../../../src/lib/providers/anthropic-copilot/copilot-cli-resolver.ts';

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
