import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@hyperneo/daemon/config';
import { startProdServer } from '../src/prod-server';

describe('daemon start with a private data root', () => {
  const previous = process.env.HYPERNEO_DATA_DIR;
  const home = mkdtempSync(join(tmpdir(), 'data-root-start-'));

  afterEach(() => {
    if (previous === undefined) delete process.env.HYPERNEO_DATA_DIR;
    else process.env.HYPERNEO_DATA_DIR = previous;
    rmSync(home, { recursive: true, force: true });
  });

  test('refuses to start before writing anything when the data root is a symlink', async () => {
    const target = join(home, 'elsewhere');
    mkdirSync(target);
    const root = join(home, '.hyperneo');
    symlinkSync(target, root);
    process.env.HYPERNEO_DATA_DIR = root;
    await expect(startProdServer({} as Config)).rejects.toThrow('symlink');
    expect(new Bun.Glob('**').scanSync(target).next().done).toBe(true);
  });
});
