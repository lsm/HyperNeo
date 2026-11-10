import { afterEach, describe, expect, test, vi } from 'vitest';
import { access, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureLocalCredential,
  readLocalCredential,
} from '../../../../src/lib/pairing/local-credential.ts';
import type { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';

const write = vi.hoisted(() => vi.fn());
const rewrite = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await rewrite(args[0]);
      return fs.writeFile(...args);
    },
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
  test('another live runtime cannot take over the first agent origin', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-owner-'));
    process.env.HYPERNEO_DATA_DIR = dir;
    const db = { run: vi.fn() } as unknown as DbGateway;
    const origin = 'http://127.0.0.1:9311';
    const file = join(dir, 'agent-read.credential');
    await ensureLocalCredential(db, 'agent', origin);
    const credential = readLocalCredential(file, origin);
    const peer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    });
    const stopped = new Promise<void>((done) => peer.once('exit', () => done()));
    try {
      expect(peer.pid).toBeDefined();
      await writeFile(join(dir, 'runtime.json'), JSON.stringify({ pid: peer.pid, url: origin }));
      await ensureLocalCredential(db, 'agent', 'http://127.0.0.1:9312');
      expect(readLocalCredential(file, origin)).toBe(credential);
    } finally {
      peer.kill('SIGTERM');
      await stopped;
    }
    await ensureLocalCredential(db, 'agent', 'http://127.0.0.1:9312');
    expect(readLocalCredential(file, 'http://127.0.0.1:9312')).toBe(credential);
  });

  test('a fresh agent credential publishes a complete bound record', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-hardlink-'));
    process.env.HYPERNEO_DATA_DIR = dir;
    const db = { run: vi.fn() } as unknown as DbGateway;
    const origin = 'http://127.0.0.1:9311';
    const file = join(dir, 'agent-read.credential');
    let writing!: () => void;
    let release!: () => void;
    const started = new Promise<void>((done) => {
      writing = done;
    });
    const resume = new Promise<void>((done) => {
      release = done;
    });
    rewrite.mockImplementationOnce(async (path: string) => {
      const handle = await open(path, 'w');
      await handle.close();
      writing();
      await resume;
    });
    const pending = ensureLocalCredential(db, 'agent', origin);
    try {
      await Promise.race([started, pending]);
      expect(readLocalCredential(file, origin)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(rewrite).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
  });
  test('an existing agent record remains readable while its new origin is staged', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-rebind-'));
    process.env.HYPERNEO_DATA_DIR = dir;
    const db = { run: vi.fn() } as unknown as DbGateway;
    const origin = 'http://127.0.0.1:9311';
    const file = join(dir, 'agent-read.credential');
    await ensureLocalCredential(db, 'agent', origin);
    const credential = readLocalCredential(file, origin);
    const nextOrigin = 'http://127.0.0.1:9312';
    let writing!: () => void;
    let release!: () => void;
    const started = new Promise<void>((done) => {
      writing = done;
    });
    const resume = new Promise<void>((done) => {
      release = done;
    });
    rewrite.mockImplementationOnce(async (path: string) => {
      const handle = await open(path, 'w');
      await handle.close();
      writing();
      await resume;
    });
    const pending = ensureLocalCredential(db, 'agent', nextOrigin);
    try {
      await Promise.race([
        started,
        pending.then(() => {
          throw new Error('Rebinding completed before reaching the rewrite pause');
        }),
      ]);
      expect(rewrite).toHaveBeenCalledTimes(1);
      expect(readLocalCredential(file, origin)).toBe(credential);
      expect(() => readLocalCredential(file, nextOrigin)).toThrow('origin');
    } finally {
      release();
      await pending;
    }
    expect(readLocalCredential(file, nextOrigin)).toBe(credential);
    expect(() => readLocalCredential(file, origin)).toThrow('origin');
  });
  test('an agent credential without an issuer origin cannot be enrolled', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-origin-'));
    process.env.HYPERNEO_DATA_DIR = dir;
    const run = vi.fn();
    const db = { run } as unknown as DbGateway;
    await expect(ensureLocalCredential(db, 'agent')).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  test('agent startup creates a separate owner-only credential and reuses it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-credential-'));
    process.env.HYPERNEO_DATA_DIR = dir;
    const run = vi.fn();
    const db = { run } as unknown as DbGateway;
    await ensureLocalCredential(db);
    await ensureLocalCredential(db, 'agent', 'http://127.0.0.1:9311');
    const file = join(dir, 'agent-read.credential');
    const credential = readLocalCredential(file, 'http://127.0.0.1:9311');
    expect(credential).not.toBe(readLocalCredential(join(dir, 'local-rpc.credential')));
    expect((await stat(file)).mode & 0o077).toBe(0);
    await ensureLocalCredential(db, 'agent', 'http://127.0.0.1:9311');
    expect(readLocalCredential(file, 'http://127.0.0.1:9311')).toBe(credential);
    expect(() => readLocalCredential(file, 'http://other.test')).toThrow('origin');
    await ensureLocalCredential(db, 'agent', 'http://127.0.0.1:9312');
    expect(readLocalCredential(file, 'http://127.0.0.1:9312')).toBe(credential);
    expect(() => readLocalCredential(file, 'http://127.0.0.1:9311')).toThrow('origin');
    expect(run.mock.calls.at(-1)?.[1]).toMatchObject({ credential, kind: 'agent' });
  });
  afterEach(async () => {
    rewrite.mockReset();
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
