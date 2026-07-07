import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
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
    expect(getDataDir()).toBe(join(homedir(), '.hyperneo'));
  });
});
