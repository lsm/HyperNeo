import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DATA_DIR_NAME,
  LEGACY_DATA_DIR_NAME,
  migrateLegacyDataDir,
  resolveDataDir,
  resolveLegacyDataDir,
} from '../../../../src/lib/data-dir';

describe('data-dir migration (neokai → hyperneo)', () => {
  let home: string;
  let logged: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hyperneo-data-dir-'));
    logged = [];
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('resolveDataDir / resolveLegacyDataDir sit under the given home', () => {
    expect(resolveDataDir(home)).toBe(join(home, DATA_DIR_NAME));
    expect(resolveLegacyDataDir(home)).toBe(join(home, LEGACY_DATA_DIR_NAME));
    expect(DATA_DIR_NAME).toBe('.hyperneo');
    expect(LEGACY_DATA_DIR_NAME).toBe('.neokai');
  });

  test('symlinks ~/.hyperneo → ~/.neokai when only the legacy dir exists', () => {
    const legacy = resolveLegacyDataDir(home);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'daemon.db'), 'db-bytes');

    const result = migrateLegacyDataDir({ home, log: (m) => logged.push(m) });

    expect(result.migrated).toBe(true);
    expect(result.strategy).toBe('symlink');
    const target = resolveDataDir(home);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readlinkSync(target)).toBe(legacy);
    // Legacy data is reachable transparently through the new path.
    expect(readFileSync(join(target, 'daemon.db'), 'utf8')).toBe('db-bytes');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('Migrated');
  });

  test('is a no-op when ~/.hyperneo already exists (real dir)', () => {
    const target = resolveDataDir(home);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'daemon.db'), 'new-bytes');
    mkdirSync(resolveLegacyDataDir(home), { recursive: true });

    const result = migrateLegacyDataDir({ home, log: (m) => logged.push(m) });

    expect(result.migrated).toBe(false);
    expect(logged).toHaveLength(0);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(target, 'daemon.db'), 'utf8')).toBe('new-bytes');
  });

  test('is a no-op when neither dir exists', () => {
    const result = migrateLegacyDataDir({ home, log: (m) => logged.push(m) });

    expect(result.migrated).toBe(false);
    expect(existsSync(resolveDataDir(home))).toBe(false);
  });

  test('is idempotent — a second run does not re-migrate', () => {
    mkdirSync(resolveLegacyDataDir(home), { recursive: true });

    const first = migrateLegacyDataDir({ home, log: (m) => logged.push(m) });
    const second = migrateLegacyDataDir({ home, log: (m) => logged.push(m) });

    expect(first.migrated).toBe(true);
    expect(second.migrated).toBe(false);
    expect(logged).toHaveLength(1);
  });

  test('falls back to the legacy path when symlink creation fails', () => {
    const legacy = resolveLegacyDataDir(home);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'daemon.db'), 'legacy-bytes');

    const result = migrateLegacyDataDir({
      home,
      log: (m) => logged.push(m),
      symlink: () => {
        throw new Error('EPERM: operation not permitted');
      },
    });

    // Symlink unavailable (e.g. Windows without symlink privileges): keep using
    // the legacy path so existing data stays reachable.
    expect(result.migrated).toBe(false);
    expect(result.strategy).toBe('legacy-fallback');
    expect(result.legacyPath).toBe(legacy);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('legacy path');
  });
});
