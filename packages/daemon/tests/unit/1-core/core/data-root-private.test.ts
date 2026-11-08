import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secureDataRoot } from '../../../../src/lib/data-root-private';

const mode = (path: string) => lstatSync(path).mode & 0o777;

describe('secureDataRoot', () => {
  let home: string;
  let previousUmask: number;
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'data-root-private-'));
    previousUmask = process.umask();
    lines.length = 0;
  });

  afterEach(() => {
    process.umask(previousUmask);
    rmSync(home, { recursive: true, force: true });
  });

  test('a 0755 root becomes 0700 and says so once', () => {
    const root = join(home, '.hyperneo');
    mkdirSync(root);
    chmodSync(root, 0o755);
    secureDataRoot(root, { log });
    expect(mode(root)).toBe(0o700);
    expect(lines).toEqual([`Data directory ${root} tightened from 0755 to 0700`]);
    secureDataRoot(root, { log });
    expect(lines).toHaveLength(1);
  });

  test('a missing root is created 0700', () => {
    const root = join(home, '.hyperneo');
    secureDataRoot(root, { log });
    expect(mode(root)).toBe(0o700);
  });

  test('a symlinked root refuses and is left as it was', () => {
    const target = join(home, 'elsewhere');
    mkdirSync(target);
    chmodSync(target, 0o755);
    const root = join(home, '.hyperneo');
    symlinkSync(target, root);
    expect(() => secureDataRoot(root, { log })).toThrow('symlink');
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });

  test('a root owned by another user refuses', () => {
    const root = join(home, '.hyperneo');
    mkdirSync(root);
    chmodSync(root, 0o755);
    expect(() => secureDataRoot(root, { log, euid: process.geteuid!() + 1 })).toThrow('owned');
    expect(mode(root)).toBe(0o755);
  });

  test('a root loosened later is 0700 again on the next start', () => {
    const root = join(home, '.hyperneo');
    secureDataRoot(root, { log });
    chmodSync(root, 0o755);
    secureDataRoot(root, { log });
    expect(mode(root)).toBe(0o700);
    expect(lines).toEqual([`Data directory ${root} tightened from 0755 to 0700`]);
  });

  test('leaves the process umask as it was', () => {
    process.umask(0o022);
    secureDataRoot(join(home, '.hyperneo'), { log });
    expect(process.umask()).toBe(0o022);
  });
});
