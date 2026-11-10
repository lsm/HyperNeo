import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLocalCredential } from '../../../../src/lib/pairing/local-credential.ts';

const run = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: run,
}));

describe('Windows local credential ACL checks', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const systemRoot = process.env.SystemRoot;
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'credential-cache-'));
    file = join(dir, 'local-rpc.credential');
    await writeFile(file, 'a'.repeat(43), { mode: 0o600 });
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.SystemRoot = '/synthetic/system';
    run.mockReset();
  });
  afterEach(async () => {
    Object.defineProperty(process, 'platform', platform);
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
    await rm(dir, { recursive: true, force: true });
  });
  test('reconnect reads launch one ACL process until the file changes', async () => {
    expect(readLocalCredential(file)).toBe('a'.repeat(43));
    expect(readLocalCredential(file)).toBe('a'.repeat(43));
    expect(run).toHaveBeenCalledTimes(1);
    await writeFile(file, 'b'.repeat(43) + '\n');
    expect(readLocalCredential(file)).toBe('b'.repeat(43));
    expect(run).toHaveBeenCalledTimes(2);
  });
  test('a failed ACL check is never cached', () => {
    run.mockImplementationOnce(() => {
      throw new Error('unsafe ACL');
    });
    expect(() => readLocalCredential(file)).toThrow('unsafe ACL');
    expect(readLocalCredential(file)).toBe('a'.repeat(43));
    expect(readLocalCredential(file)).toBe('a'.repeat(43));
    expect(run).toHaveBeenCalledTimes(2);
  });
});
