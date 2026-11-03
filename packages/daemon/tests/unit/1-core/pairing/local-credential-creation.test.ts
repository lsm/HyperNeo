import { afterEach, describe, expect, test, vi } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureLocalCredential,
  readLocalCredential,
} from '../../../../src/lib/pairing/local-credential.ts';
import type { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';

const write = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      const originalWrite = file.writeFile.bind(file);
      file.writeFile = async (...values: Parameters<typeof file.writeFile>) => {
        await write();
        return originalWrite(...values);
      };
      return file;
    },
  };
});

describe('local credential creation', () => {
  const dataDir = process.env.HYPERNEO_DATA_DIR;
  let dir: string;
  afterEach(async () => {
    if (dataDir === undefined) delete process.env.HYPERNEO_DATA_DIR;
    else process.env.HYPERNEO_DATA_DIR = dataDir;
    await rm(dir, { recursive: true, force: true });
  });
  test('interrupted writing exposes no partial credential and a later start succeeds', async () => {
    dir = await mkdtemp(join(tmpdir(), 'credential-create-'));
    process.env.HYPERNEO_DATA_DIR = dir;
    const file = join(dir, 'local-rpc.credential');
    const run = vi.fn();
    const db = { run } as unknown as DbGateway;
    write.mockImplementationOnce(async () => {
      await expect(access(file)).rejects.toThrow();
      throw new Error('interrupted write');
    });
    await expect(ensureLocalCredential(db)).rejects.toThrow('interrupted write');
    expect(run).not.toHaveBeenCalled();
    await expect(access(file)).rejects.toThrow();
    await ensureLocalCredential(db);
    expect(readLocalCredential(file)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(run).toHaveBeenCalledTimes(1);
  });
  test('concurrent starts enroll the same completed credential', async () => {
    dir = await mkdtemp(join(tmpdir(), 'credential-create-'));
    process.env.HYPERNEO_DATA_DIR = dir;
    const run = vi.fn();
    const db = { run } as unknown as DbGateway;
    await Promise.all([ensureLocalCredential(db), ensureLocalCredential(db)]);
    const credential = readLocalCredential(join(dir, 'local-rpc.credential'));
    expect(run).toHaveBeenCalledTimes(2);
    for (const call of run.mock.calls) expect(call[1].credential).toBe(credential);
  });
});
