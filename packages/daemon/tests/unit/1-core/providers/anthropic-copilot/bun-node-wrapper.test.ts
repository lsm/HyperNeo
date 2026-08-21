import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import * as nodefs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureBunNodeWrapper,
  buildCopilotEnv,
} from '../../../../../src/lib/providers/anthropic-copilot/bun-node-wrapper';

function probeBunSqlite(): boolean {
  try {
    execFileSync(
      process.execPath,
      ['-e', "import('node:sqlite').then(() => process.exit(0)).catch(() => process.exit(1))"],
      { stdio: 'ignore' }
    );
    return true;
  } catch {
    return false;
  }
}
const bunSqliteSupported = probeBunSqlite();

const WRAPPER_DIR = join(tmpdir(), 'hyperneo-bun-node-wrapper');
const NODE_LINK = join(WRAPPER_DIR, 'node');

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

describe.skipIf(!isBun)('ensureBunNodeWrapper (running under Bun in bun test)', () => {
  afterEach(() => {
    try {
      nodefs.unlinkSync(NODE_LINK);
    } catch {}
    try {
      nodefs.rmdirSync(WRAPPER_DIR);
    } catch {}
  });

  it('returns the wrapper directory path', () => {
    const dir = ensureBunNodeWrapper();
    expect(dir).toBe(WRAPPER_DIR);
  });

  it('creates the wrapper directory', () => {
    ensureBunNodeWrapper();
    expect(nodefs.existsSync(WRAPPER_DIR)).toBe(true);
  });

  it('creates a "node" symlink pointing to process.execPath (Bun binary)', () => {
    ensureBunNodeWrapper();
    const target = nodefs.readlinkSync(NODE_LINK);
    expect(target).toBe(process.execPath);
  });

  it('is idempotent — second call reuses the existing symlink', () => {
    ensureBunNodeWrapper();
    const first = nodefs.readlinkSync(NODE_LINK);
    ensureBunNodeWrapper();
    const second = nodefs.readlinkSync(NODE_LINK);
    expect(first).toBe(second);
  });

  it('re-creates a stale symlink pointing to a different path', () => {
    nodefs.mkdirSync(WRAPPER_DIR, { recursive: true });
    nodefs.symlinkSync('/usr/bin/node', NODE_LINK);
    expect(nodefs.readlinkSync(NODE_LINK)).toBe('/usr/bin/node');

    ensureBunNodeWrapper();
    expect(nodefs.readlinkSync(NODE_LINK)).toBe(process.execPath);
  });

  it('returns undefined when fs operations fail', () => {
    const spy = spyOn(nodefs, 'mkdirSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    try {
      const result = ensureBunNodeWrapper();
      expect(result).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

const isLinux = process.platform === 'linux';

describe.skipIf(!isBun)('buildCopilotEnv (running under Bun in bun test)', () => {
  afterEach(() => {
    try {
      nodefs.unlinkSync(NODE_LINK);
    } catch {}
    try {
      nodefs.rmdirSync(WRAPPER_DIR);
    } catch {}
  });

  it('prepends the bun-node-wrapper dir to PATH (non-Linux + sqlite only)', () => {
    if (isLinux || !bunSqliteSupported) return;
    const base = { PATH: '/usr/bin:/bin', OTHER: 'value' };
    const result = buildCopilotEnv(base);
    expect(result.PATH).toMatch(
      new RegExp(`^${WRAPPER_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`)
    );
  });

  it('returns base env unchanged on Linux (Bun lacks node:sqlite)', () => {
    if (!isLinux) return;
    const base = { PATH: '/usr/bin:/bin', OTHER: 'value' };
    const result = buildCopilotEnv(base);
    expect(result).toBe(base);
  });

  it('returns base env unchanged when Bun lacks node:sqlite (non-Linux only)', () => {
    if (isLinux || bunSqliteSupported) return;
    const base = { PATH: '/usr/bin:/bin', OTHER: 'value' };
    const result = buildCopilotEnv(base);
    expect(result).toBe(base);
  });

  it('preserves the existing PATH after the wrapper dir (non-Linux + sqlite only)', () => {
    if (isLinux || !bunSqliteSupported) return;
    const base = { PATH: '/usr/bin:/bin' };
    const result = buildCopilotEnv(base);
    expect(result.PATH).toContain('/usr/bin:/bin');
  });

  it('preserves all other env vars unchanged (non-Linux + sqlite only)', () => {
    if (isLinux || !bunSqliteSupported) return;
    const base = { PATH: '/usr/bin', FOO: 'bar', BAZ: '42' };
    const result = buildCopilotEnv(base);
    expect(result.FOO).toBe('bar');
    expect(result.BAZ).toBe('42');
  });

  it('does not mutate the base env object (non-Linux + sqlite only)', () => {
    if (isLinux || !bunSqliteSupported) return;
    const base = { PATH: '/usr/bin' };
    buildCopilotEnv(base);
    expect(base.PATH).toBe('/usr/bin');
  });

  it('uses process.env.PATH as fallback when base.PATH is absent (non-Linux + sqlite only)', () => {
    if (isLinux || !bunSqliteSupported) return;
    const base: NodeJS.ProcessEnv = { FOO: 'bar' };
    const result = buildCopilotEnv(base);
    expect(result.PATH).toMatch(
      new RegExp(`^${WRAPPER_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`)
    );
  });
});
