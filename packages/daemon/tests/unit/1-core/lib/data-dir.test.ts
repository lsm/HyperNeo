import { describe, expect, test } from 'bun:test';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR_NAME, getDataDir, resolveDataDir } from '../../../../src/lib/data-dir';

describe('data-dir', () => {
  test('resolveDataDir sits under the given home', () => {
    expect(resolveDataDir('/home/testuser')).toBe('/home/testuser/.hyperneo');
  });

  test('resolveDataDir defaults to the real home', () => {
    expect(resolveDataDir()).toBe(join(homedir(), DATA_DIR_NAME));
  });

  test('DATA_DIR_NAME is .hyperneo', () => {
    expect(DATA_DIR_NAME).toBe('.hyperneo');
  });

  test('getDataDir returns ~/.hyperneo', () => {
    const prior = process.env.HYPERNEO_DATA_DIR;
    delete process.env.HYPERNEO_DATA_DIR;
    try {
      expect(getDataDir()).toBe(join(homedir(), '.hyperneo'));
    } finally {
      if (prior !== undefined) process.env.HYPERNEO_DATA_DIR = prior;
    }
  });

  test('getDataDir resolves inside the test temp directory, never the real home', () => {
    const dataDir = getDataDir();
    expect(dataDir.startsWith(tmpdir())).toBe(true);
    expect(dataDir.startsWith(join(userInfo().homedir, DATA_DIR_NAME))).toBe(false);
  });

  test('getDataDir prefers HYPERNEO_DATA_DIR when set', () => {
    const prior = process.env.HYPERNEO_DATA_DIR;
    process.env.HYPERNEO_DATA_DIR = '/var/lib/hyperneod';
    try {
      expect(getDataDir()).toBe('/var/lib/hyperneod');
    } finally {
      if (prior === undefined) {
        delete process.env.HYPERNEO_DATA_DIR;
      } else {
        process.env.HYPERNEO_DATA_DIR = prior;
      }
    }
  });

  test('getDataDir falls back to ~/.hyperneo when HYPERNEO_DATA_DIR is empty', () => {
    const prior = process.env.HYPERNEO_DATA_DIR;
    process.env.HYPERNEO_DATA_DIR = '';
    try {
      expect(getDataDir()).toBe(join(homedir(), '.hyperneo'));
    } finally {
      if (prior === undefined) {
        delete process.env.HYPERNEO_DATA_DIR;
      } else {
        process.env.HYPERNEO_DATA_DIR = prior;
      }
    }
  });
});
