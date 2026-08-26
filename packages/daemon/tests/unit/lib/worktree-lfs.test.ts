import { beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));

const gitCalls: string[][] = [];

function passthrough<Args extends unknown[], R>(
  mockFn: ReturnType<typeof vi.fn>,
  real: (...args: Args) => R
): (...args: Args) => R {
  return (...args: Args) =>
    mockFn.getMockImplementation() ? (mockFn as (...args: Args) => R)(...args) : real(...args);
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: passthrough(childProcessMocks.execFile, actual.execFile),
    spawn: passthrough(childProcessMocks.spawn, actual.spawn),
  };
});

import { indexContainsLfsPointer } from '../../../src/lib/worktree-lfs';

type ProbeResult = { stdout: string | Buffer; stderr: string };
type ProbeCallback = (error: Error | null, result?: ProbeResult) => void;

interface FakeChild {
  stdout: { on: (event: 'data', listener: (chunk: Buffer) => void) => void };
  on: (event: 'close' | 'error', listener: (arg: never) => void) => void;
  kill: () => void;
  emitData: (chunk: Buffer) => void;
  emitClose: (code: number | null) => void;
  emitError: (error: Error) => void;
}

function createFakeChild(): FakeChild {
  const dataListeners: Array<(chunk: Buffer) => void> = [];
  const closeListeners: Array<(code: number | null) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const child: FakeChild = {
    stdout: {
      on: (_event, listener) => {
        dataListeners.push(listener);
      },
    },
    on: (event, listener) => {
      if (event === 'close') closeListeners.push(listener as (code: number | null) => void);
      if (event === 'error') errorListeners.push(listener as (error: Error) => void);
    },
    kill: () => undefined,
    emitData: (chunk) => {
      for (const listener of dataListeners) listener(chunk);
    },
    emitClose: (code) => {
      for (const listener of closeListeners) listener(code);
    },
    emitError: (error) => {
      for (const listener of errorListeners) listener(error);
    },
  };
  return child;
}

interface SpawnPlan {
  chunks?: Buffer[];
  exitCode?: number | null;
  error?: Error;
}

function planSpawn(plans: { lsFiles?: SpawnPlan; catFile?: SpawnPlan }): void {
  childProcessMocks.spawn.mockImplementation((_file: string, args: string[]) => {
    gitCalls.push([_file, ...args]);
    const plan =
      args[0] === 'ls-files' ? plans.lsFiles : args[0] === 'cat-file' ? plans.catFile : undefined;
    const child = createFakeChild();
    queueMicrotask(() => {
      if (!plan || plan.error) {
        child.emitError(plan?.error ?? new Error(`unexpected spawn: ${args.join(' ')}`));
        return;
      }
      for (const chunk of plan.chunks ?? []) child.emitData(chunk);
      child.emitClose(plan.exitCode ?? 0);
    });
    return child;
  });
}

function binaryPaths(...paths: string[]): Buffer {
  return Buffer.from(paths.map((path) => `${path}\0`).join(''), 'binary');
}

function indexListing(...entries: Array<[string | Buffer, string]>): Buffer {
  return Buffer.concat(
    entries.map(([path, oid]) =>
      Buffer.concat([
        Buffer.from(`100644 ${oid} 0\t`, 'utf8'),
        typeof path === 'string' ? Buffer.from(path, 'utf8') : path,
        Buffer.from([0]),
      ])
    )
  );
}

const LFS_SIGNATURE = 'version https://git-lfs.github.com/spec/v1';
const POINTER_OID = `oid sha256:${'a'.repeat(64)}`;
const BLOB_OID = 'a'.repeat(64);
const EXT_RECORD = `ext-0-counter sha256:${'b'.repeat(64)}`;

function stubGitProbes(
  respond: (file: string, args: string[], callback: ProbeCallback) => void
): void {
  childProcessMocks.execFile.mockImplementation(
    (file: string, args: string[], _opts: unknown, callback: ProbeCallback) => {
      gitCalls.push([file, ...args]);
      respond(file, args, callback);
      return undefined;
    }
  );
}

function stubGrepOnly(blobContent: string): void {
  stubGitProbes((file, args, callback) => {
    if (file === 'git' && args[0] === 'grep') {
      callback(null, { stdout: binaryPaths('asset.bin'), stderr: '' });
      return;
    }
    callback(new Error(`unexpected execFile invocation: ${file} ${args.join(' ')}`), {
      stdout: '',
      stderr: '',
    });
  });
}

function stubGrepCandidate(blobContent: string): void {
  planSpawn({
    lsFiles: { chunks: [indexListing(['asset.bin', BLOB_OID])] },
    catFile: { chunks: [Buffer.from(blobContent)] },
  });
  stubGrepOnly(blobContent);
}

describe('indexContainsLfsPointer', () => {
  beforeEach(() => {
    childProcessMocks.execFile.mockReset();
    childProcessMocks.spawn.mockReset();
    gitCalls.length = 0;
  });

  test('accepts a canonical pointer blob', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize 1234\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('accepts a canonical pointer blob without a trailing newline', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize 1234`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('accepts extension records between version and oid', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\n${EXT_RECORD}\n${POINTER_OID}\nsize 1234\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('accepts extension records before the version record', async () => {
    stubGrepCandidate(`${EXT_RECORD}\n${LFS_SIGNATURE}\n${POINTER_OID}\nsize 1234\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('accepts multiple extension records between version and oid', async () => {
    const second = `ext-9-telemetry sha256:${'c'.repeat(64)}`;
    stubGrepCandidate(`${LFS_SIGNATURE}\n${EXT_RECORD}\n${second}\n${POINTER_OID}\nsize 1234\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('accepts outer whitespace on pre-version extension records and the version record', async () => {
    stubGrepCandidate(`   ${EXT_RECORD}\n\t${LFS_SIGNATURE}\n${POINTER_OID}\nsize 1234\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('rejects trailing whitespace on the version record', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE} \n${POINTER_OID}\nsize 1234\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
    stubGrepCandidate(`${LFS_SIGNATURE}\t\n${POINTER_OID}\nsize 1234\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('rejects leading whitespace on records after the version line', async () => {
    stubGrepCandidate(
      `${LFS_SIGNATURE}\n   ext-1-x sha256:${'b'.repeat(64)}\n${POINTER_OID}\nsize 12\n`
    );
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
    stubGrepCandidate(
      `${LFS_SIGNATURE}\n${POINTER_OID}\n   ext-1-x sha256:${'b'.repeat(64)}\nsize 12\n`
    );
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
    stubGrepCandidate(`${LFS_SIGNATURE}\n   ${POINTER_OID}\nsize 1234\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
    stubGrepCandidate(`${LFS_SIGNATURE}\n${POINTER_OID}\n   size 1234\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('rejects multi-digit extension priorities', async () => {
    stubGrepCandidate(
      `${LFS_SIGNATURE}\next-10-counter sha256:${'b'.repeat(64)}\n${POINTER_OID}\nsize 1234\n`
    );
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('rejects punctuation-only extension names', async () => {
    stubGrepCandidate(
      `${LFS_SIGNATURE}\next-1--- sha256:${'b'.repeat(64)}\n${POINTER_OID}\nsize 1234\n`
    );
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('accepts punctuation-bearing extension names after the initial word character', async () => {
    stubGrepCandidate(
      `${LFS_SIGNATURE}\next-1-a/b sha256:${'b'.repeat(64)}\n${POINTER_OID}\nsize 12\n`
    );
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
    stubGrepCandidate(
      `${LFS_SIGNATURE}\next-1-a@b sha256:${'b'.repeat(64)}\n${POINTER_OID}\nsize 12\n`
    );
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('accepts repeated identical extension records with differing digests', async () => {
    const repeat = `ext-1-x sha256:${'c'.repeat(64)}`;
    stubGrepCandidate(
      `${LFS_SIGNATURE}\next-1-x sha256:${'b'.repeat(64)}\n${repeat}\n${POINTER_OID}\nsize 12\n`
    );
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('validates pointers whose size record is zero-padded beyond the former blob cap', async () => {
    const padded = `${LFS_SIGNATURE}\n${POINTER_OID}\nsize ${'0'.repeat(65_500)}7\n`;
    stubGrepCandidate(padded);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('accepts CRLF-delimited pointer blobs', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\r\n${POINTER_OID}\r\nsize 1234\r\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('ignores blank records around valid pointer lines', async () => {
    stubGrepCandidate(`\n${LFS_SIGNATURE}\n\n${POINTER_OID}\n\nsize 1234\n\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('ignores whitespace-only records at the pointer boundaries', async () => {
    stubGrepCandidate(`   \n${LFS_SIGNATURE}\n${POINTER_OID}\nsize 1234\n\t \n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
    stubGrepCandidate(`\t\n${LFS_SIGNATURE}\n${POINTER_OID}\nsize 1234\n   \n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('rejects whitespace-only records between pointer lines', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\n   \n${POINTER_OID}\n\t\nsize 1234\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('accepts CRLF-delimited pointer blobs containing extension records', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\r\n${EXT_RECORD}\r\n${POINTER_OID}\r\nsize 1234\r\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('rejects lone-CR line endings in pointer blobs', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\r${POINTER_OID}\rsize 1234`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('accepts non-canonical size records accepted by git lfs', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize +1\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
    stubGrepCandidate(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize 1234 \n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('rejects negative size records', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize -1\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('accepts negative zero size records', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize -0\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
    stubGrepCandidate(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize -00\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('accepts sizes within the signed 64-bit range', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize 9223372036854775807\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('rejects sizes beyond the signed 64-bit range', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize 9223372036854775808\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('rejects non-numeric size records', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize twelve\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('accepts zero-padded size records', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize 00000000000000000001\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('streams candidate blobs across chunk boundaries', async () => {
    const blob = `${LFS_SIGNATURE}\n${POINTER_OID}\nsize 1234\n`;
    const mid = Math.floor(blob.length / 2);
    planSpawn({
      lsFiles: { chunks: [indexListing(['asset.bin', BLOB_OID])] },
      catFile: { chunks: [Buffer.from(blob.slice(0, mid)), Buffer.from(blob.slice(mid))] },
    });
    stubGrepOnly(blob);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('resolves candidate paths containing non-UTF-8 bytes through the index', async () => {
    const rawOid = 'd'.repeat(64);
    planSpawn({
      lsFiles: { chunks: [indexListing([Buffer.from([0x62, 0x61, 0x64, 0xff]), rawOid])] },
      catFile: { chunks: [Buffer.from(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize 7\n`)] },
    });
    stubGitProbes((file, args, callback) => {
      if (file === 'git' && args[0] === 'grep') {
        const raw = Buffer.concat([Buffer.from([0x62, 0x61, 0x64, 0xff]), Buffer.from([0])]);
        callback(null, { stdout: raw, stderr: '' });
        return;
      }
      callback(new Error(`unexpected execFile invocation: ${file} ${args.join(' ')}`), {
        stdout: '',
        stderr: '',
      });
    });
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
    expect(gitCalls.some((call) => call.slice(1).some((arg) => arg.includes('�')))).toBe(false);
    const catFileCall = gitCalls.find((call) => call[1] === 'cat-file');
    expect(catFileCall?.[2]).toBe(rawOid);
  });

  test('accepts extension records between oid and size', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\n${POINTER_OID}\n${EXT_RECORD}\nsize 1234\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('rejects duplicate priorities across head and tail extension runs', async () => {
    const tailDup = `ext-0-other sha256:${'c'.repeat(64)}`;
    stubGrepCandidate(`${LFS_SIGNATURE}\n${EXT_RECORD}\n${POINTER_OID}\n${tailDup}\nsize 1234\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('rejects duplicate extension priorities under different names', async () => {
    const dup = `ext-0-other sha256:${'c'.repeat(64)}`;
    stubGrepCandidate(`${LFS_SIGNATURE}\n${EXT_RECORD}\n${dup}\n${POINTER_OID}\nsize 1234\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('rejects leading-zero extension priorities', async () => {
    stubGrepCandidate(
      `${LFS_SIGNATURE}\next-00-counter sha256:${'b'.repeat(64)}\n${POINTER_OID}\nsize 1234\n`
    );
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('rejects non-extension data between version and oid', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\nsome unexpected line\n${POINTER_OID}\nsize 1234\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('rejects trailing data after size', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize 1234\nextra\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('rejects blobs that only carry the signature line', async () => {
    stubGrepCandidate(LFS_SIGNATURE);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('reads index candidates by object id instead of path arguments', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize 1234\n`);
    await indexContainsLfsPointer('/repo', {});
    const catFileCall = gitCalls.find((call) => call[1] === 'cat-file');
    expect(catFileCall?.[2]).toBe(BLOB_OID);
    expect(gitCalls.some((call) => call.some((arg) => arg.startsWith(':./')))).toBe(false);
  });

  test('matches stage-prefixed index entries by their literal path bytes', async () => {
    planSpawn({
      lsFiles: { chunks: [indexListing(['2:fixture', BLOB_OID])] },
      catFile: { chunks: [Buffer.from(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize 7\n`)] },
    });
    stubGitProbes((file, args, callback) => {
      if (file === 'git' && args[0] === 'grep') {
        callback(null, { stdout: binaryPaths('2:fixture'), stderr: '' });
        return;
      }
      callback(new Error(`unexpected execFile invocation: ${file} ${args.join(' ')}`), {
        stdout: '',
        stderr: '',
      });
    });
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
    const catFileCall = gitCalls.find((call) => call[1] === 'cat-file');
    expect(catFileCall?.[2]).toBe(BLOB_OID);
  });

  test('skips candidates whose blobs cannot be read', async () => {
    planSpawn({
      lsFiles: { chunks: [indexListing(['asset.bin', BLOB_OID])] },
      catFile: { error: new Error('object unreadable') },
    });
    stubGrepOnly(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize 1234\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('returns false when no indexed candidate matches the signature', async () => {
    planSpawn({ lsFiles: { chunks: [] }, catFile: { chunks: [] } });
    stubGitProbes((file, args, callback) => {
      if (file === 'git' && args[0] === 'grep') {
        callback(Object.assign(new Error('exit 1'), { code: 1 }), { stdout: '', stderr: '' });
        return;
      }
      callback(new Error(`unexpected execFile invocation: ${file} ${args.join(' ')}`), {
        stdout: '',
        stderr: '',
      });
    });
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('propagates probe failures other than empty grep results', async () => {
    planSpawn({ lsFiles: { chunks: [] }, catFile: { chunks: [] } });
    stubGitProbes((file, args, callback) => {
      if (file === 'git' && args[0] === 'grep') {
        callback(Object.assign(new Error('index locked'), { code: 128 }), {
          stdout: '',
          stderr: '',
        });
        return;
      }
      callback(new Error(`unexpected execFile invocation: ${file} ${args.join(' ')}`), {
        stdout: '',
        stderr: '',
      });
    });
    await expect(indexContainsLfsPointer('/repo', {})).rejects.toThrow('index locked');
  });

  test('propagates index listing failures while candidates exist', async () => {
    planSpawn({
      lsFiles: { chunks: [], exitCode: 128 },
      catFile: { chunks: [] },
    });
    stubGitProbes((file, args, callback) => {
      if (file === 'git' && args[0] === 'grep') {
        callback(null, { stdout: binaryPaths('asset.bin'), stderr: '' });
        return;
      }
      callback(new Error(`unexpected execFile invocation: ${file} ${args.join(' ')}`), {
        stdout: '',
        stderr: '',
      });
    });
    await expect(indexContainsLfsPointer('/repo', {})).rejects.toThrow(/ls-files/);
  });
});
