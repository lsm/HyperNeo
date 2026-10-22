import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { getNeoReadCheckoutPath } from '../../../../src/lib/neo/read-checkout-path.ts';

const priorDataDir = process.env.HYPERNEO_DATA_DIR;

afterEach(() => {
  if (priorDataDir === undefined) delete process.env.HYPERNEO_DATA_DIR;
  else process.env.HYPERNEO_DATA_DIR = priorDataDir;
});

describe('Neo read checkout paths', () => {
  test('names one exact per-repository leaf inside the shared worktrees folder', () => {
    expect(getNeoReadCheckoutPath('LSM', 'HyperNeo', '/synthetic/data')).toBe(
      '/synthetic/data/worktrees/lsm/hyperneo/neo-read'
    );
    expect(getNeoReadCheckoutPath('other', 'HyperNeo', '/synthetic/data')).toBe(
      '/synthetic/data/worktrees/other/hyperneo/neo-read'
    );
  });

  test('uses the configured daemon data directory by default', () => {
    process.env.HYPERNEO_DATA_DIR = '/synthetic/custom-data';
    expect(getNeoReadCheckoutPath('lsm', 'research')).toBe(
      join(process.env.HYPERNEO_DATA_DIR, 'worktrees', 'lsm', 'research', 'neo-read')
    );
  });

  test('cannot turn a repository identifier into an ancestor or sibling grant', () => {
    for (const value of ['', '.', '..', '../worker', 'owner/repo', '/absolute', 'a\\b']) {
      expect(() => getNeoReadCheckoutPath(value, 'repo', '/synthetic/data')).toThrow();
      expect(() => getNeoReadCheckoutPath('owner', value, '/synthetic/data')).toThrow();
    }
  });
});
