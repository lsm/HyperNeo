import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRuntimeDescriptor } from '../../../../src/lib/runtime-descriptor';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hyperneo-runtime-descriptor-'));
  path = join(dir, 'runtime.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runtime-descriptor', () => {
  test('advertises the pid, port and a dialable url', () => {
    writeRuntimeDescriptor('127.0.0.1', 8399, dir);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      pid: number;
      host: string;
      port: number;
      url: string;
      version: string;
    };

    expect(parsed.pid).toBe(process.pid);
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.port).toBe(8399);
    expect(parsed.url).toBe('http://127.0.0.1:8399');
    expect(parsed.version.length).toBeGreaterThan(0);
  });

  test('maps a wildcard bind to loopback so clients do not dial 0.0.0.0', () => {
    writeRuntimeDescriptor('0.0.0.0', 9283, dir);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { host: string; url: string };
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.url).toBe('http://127.0.0.1:9283');
  });

  test('the returned remover deletes the advert it wrote', () => {
    const remove = writeRuntimeDescriptor('127.0.0.1', 9283, dir);
    expect(existsSync(path)).toBe(true);
    remove();
    expect(existsSync(path)).toBe(false);
  });

  test('the remover leaves an advert owned by another pid alone', () => {
    const remove = writeRuntimeDescriptor('127.0.0.1', 9283, dir);
    writeFileSync(path, JSON.stringify({ pid: process.pid + 1, port: 1 }), 'utf8');
    remove();
    expect(readFileSync(path, 'utf8')).toContain('"port":1');
  });
});
