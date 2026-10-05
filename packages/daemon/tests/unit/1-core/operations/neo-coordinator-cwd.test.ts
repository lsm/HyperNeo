import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { neoCoordinatorRuntimePath } from '../../../../src/lib/neo/session-policy.ts';

describe('neoCoordinatorRuntimePath', () => {
  let home: string;
  const saved = { sdk: process.env.TEST_SDK_SESSION_DIR, data: process.env.HYPERNEO_DATA_DIR };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'neo-home-'));
    process.env.TEST_SDK_SESSION_DIR = join(home, '.claude');
    process.env.HYPERNEO_DATA_DIR = join(home, 'data');
  });
  afterEach(() => {
    if (saved.sdk === undefined) delete process.env.TEST_SDK_SESSION_DIR;
    else process.env.TEST_SDK_SESSION_DIR = saved.sdk;
    if (saved.data === undefined) delete process.env.HYPERNEO_DATA_DIR;
    else process.env.HYPERNEO_DATA_DIR = saved.data;
    rmSync(home, { recursive: true, force: true });
  });

  test('runs a new coordinator in the Neo project folder', () => {
    expect(neoCoordinatorRuntimePath('neo:new-session')).toBe(join(home, 'data', 'Neo'));
  });

  test('keeps a coordinator whose SDK history lives under its old folder', () => {
    const legacy = join(tmpdir(), 'hyperneo-neo-context', 'neo-old-session');
    mkdirSync(legacy, { recursive: true });
    const encoded = realpathSync(legacy).replace(/[/.]/g, '-');
    mkdirSync(join(home, '.claude', 'projects', encoded), { recursive: true });
    expect(neoCoordinatorRuntimePath('neo:old-session')).toBe(legacy);
  });

  test('still finds that history after the OS removed the old temp folder', () => {
    const legacy = join(tmpdir(), 'hyperneo-neo-context', 'neo-gone-session');
    const encoded = `/private${legacy}`.replace(/[/.]/g, '-');
    mkdirSync(join(home, '.claude', 'projects', encoded), { recursive: true });
    expect(neoCoordinatorRuntimePath('neo:gone-session')).toBe(legacy);
  });
});
