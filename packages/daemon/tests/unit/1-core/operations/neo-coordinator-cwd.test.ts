import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { neoCoordinatorRuntimePath } from '../../../../src/lib/neo/session-policy.ts';

describe('neoCoordinatorRuntimePath', () => {
  let home: string;
  const saved = { home: process.env.HOME, data: process.env.HYPERNEO_DATA_DIR };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'neo-home-'));
    process.env.HOME = home;
    process.env.HYPERNEO_DATA_DIR = join(home, 'data');
  });
  afterEach(() => {
    process.env.HOME = saved.home;
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
    const encoded = realpathSync(legacy).replace(/[^a-zA-Z0-9]/g, '-');
    mkdirSync(join(home, '.claude', 'projects', encoded), { recursive: true });
    expect(neoCoordinatorRuntimePath('neo:old-session')).toBe(legacy);
  });
});
