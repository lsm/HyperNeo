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

function stubLsFiles(
  chunks: Buffer[],
  options?: { exitCode?: number | null; error?: Error }
): void {
  childProcessMocks.spawn.mockImplementation(() => {
    const child = createFakeChild();
    queueMicrotask(() => {
      if (options?.error) {
        child.emitError(options.error);
        return;
      }
      for (const chunk of chunks) child.emitData(chunk);
      child.emitClose(options?.exitCode ?? 0);
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
    if (file === 'git' && args[0] === 'cat-file') {
      callback(null, { stdout: `${blobContent.length}\n`, stderr: '' });
      return;
    }
    if (file === 'git' && args[0] === 'show') {
      callback(null, { stdout: blobContent, stderr: '' });
      return;
    }
    callback(new Error(`unexpected git invocation: ${file} ${args.join(' ')}`), {
      stdout: '',
      stderr: '',
    });
  });
}

function stubGrepCandidate(blobContent: string): void {
  stubLsFiles([indexListing(['asset.bin', BLOB_OID])]);
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

  test('skips oversized candidates before reading them', async () => {
    const hugeOid = 'e'.repeat(64);
    stubLsFiles([indexListing(['huge.bin', hugeOid], ['asset.bin', BLOB_OID])]);
    stubGitProbes((file, args, callback) => {
      if (file === 'git' && args[0] === 'grep') {
        callback(null, { stdout: binaryPaths('huge.bin', 'asset.bin'), stderr: '' });
        return;
      }
      if (file === 'git' && args[0] === 'cat-file') {
        const size = args[2] === hugeOid ? '99999999' : '40';
        callback(null, { stdout: size, stderr: '' });
        return;
      }
      if (file === 'git' && args[0] === 'show') {
        if (args[1] === BLOB_OID) {
          callback(null, { stdout: `${LFS_SIGNATURE}\n${POINTER_OID}\nsize 7\n`, stderr: '' });
          return;
        }
        callback(new Error('oversized blob must not be read'), { stdout: '', stderr: '' });
        return;
      }
      callback(new Error(`unexpected git invocation: ${file} ${args.join(' ')}`), {
        stdout: '',
        stderr: '',
      });
    });
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
    expect(gitCalls.some((call) => call[1] === 'show' && call[2] === hugeOid)).toBe(false);
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

  test('resolves candidate paths containing non-UTF-8 bytes through the index', async () => {
    const rawOid = 'd'.repeat(64);
    stubLsFiles([indexListing([Buffer.from([0x62, 0x61, 0x64, 0xff]), rawOid])]);
    stubGitProbes((file, args, callback) => {
      if (file === 'git' && args[0] === 'grep') {
        const raw = Buffer.concat([Buffer.from([0x62, 0x61, 0x64, 0xff]), Buffer.from([0])]);
        callback(null, { stdout: raw, stderr: '' });
        return;
      }
      if (file === 'git' && args[0] === 'cat-file') {
        callback(null, { stdout: '40\n', stderr: '' });
        return;
      }
      if (file === 'git' && args[0] === 'show') {
        if (args[1] === rawOid) {
          callback(null, { stdout: `${LFS_SIGNATURE}\n${POINTER_OID}\nsize 7\n`, stderr: '' });
          return;
        }
        callback(new Error('path bytes must not reach argv'), { stdout: '', stderr: '' });
        return;
      }
      callback(new Error(`unexpected git invocation: ${file} ${args.join(' ')}`), {
        stdout: '',
        stderr: '',
      });
    });
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
    expect(gitCalls.some((call) => call.slice(1).some((arg) => arg.includes('�')))).toBe(false);
    const showCall = gitCalls.find((call) => call[0] === 'git' && call[1] === 'show');
    expect(showCall?.[2]).toBe(rawOid);
  });

  test('streams index listings across chunk boundaries without buffering them whole', async () => {
    const listing = indexListing(['asset.bin', BLOB_OID]);
    const splitAt = listing.indexOf(9) + 3;
    stubLsFiles([listing.subarray(0, splitAt), listing.subarray(splitAt)]);
    stubGrepOnly(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize 1234\n`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
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

  test('rejects duplicate extension priorities', async () => {
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
    const showCall = gitCalls.find((call) => call[0] === 'git' && call[1] === 'show');
    expect(showCall?.[2]).toBe(BLOB_OID);
    expect(gitCalls.some((call) => call.some((arg) => arg.startsWith(':./')))).toBe(false);
  });

  test('matches stage-prefixed index entries by their literal path bytes', async () => {
    stubLsFiles([indexListing(['2:fixture', BLOB_OID])]);
    stubGitProbes((file, args, callback) => {
      if (file === 'git' && args[0] === 'grep') {
        callback(null, { stdout: binaryPaths('2:fixture'), stderr: '' });
        return;
      }
      if (file === 'git' && args[0] === 'cat-file') {
        callback(null, { stdout: `${(LFS_SIGNATURE.length + 20).toString()}\n`, stderr: '' });
        return;
      }
      if (file === 'git' && args[0] === 'show') {
        callback(null, { stdout: `${LFS_SIGNATURE}\n${POINTER_OID}\nsize 7\n`, stderr: '' });
        return;
      }
      callback(new Error(`unexpected git invocation: ${file} ${args.join(' ')}`), {
        stdout: '',
        stderr: '',
      });
    });
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
    const showCall = gitCalls.find((call) => call[0] === 'git' && call[1] === 'show');
    expect(showCall?.[2]).toBe(BLOB_OID);
  });

  test('returns false when no indexed candidate matches the signature', async () => {
    stubLsFiles([]);
    stubGitProbes((file, args, callback) => {
      if (file === 'git' && args[0] === 'grep') {
        callback(Object.assign(new Error('exit 1'), { code: 1 }), { stdout: '', stderr: '' });
        return;
      }
      callback(new Error(`unexpected git invocation: ${file} ${args.join(' ')}`), {
        stdout: '',
        stderr: '',
      });
    });
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('propagates probe failures other than empty grep results', async () => {
    stubLsFiles([]);
    stubGitProbes((file, args, callback) => {
      if (file === 'git' && args[0] === 'grep') {
        callback(Object.assign(new Error('index locked'), { code: 128 }), {
          stdout: '',
          stderr: '',
        });
        return;
      }
      callback(new Error(`unexpected git invocation: ${file} ${args.join(' ')}`), {
        stdout: '',
        stderr: '',
      });
    });
    await expect(indexContainsLfsPointer('/repo', {})).rejects.toThrow('index locked');
  });

  test('propagates index listing failures while candidates exist', async () => {
    stubLsFiles([], { exitCode: 128 });
    stubGitProbes((file, args, callback) => {
      if (file === 'git' && args[0] === 'grep') {
        callback(null, { stdout: binaryPaths('asset.bin'), stderr: '' });
        return;
      }
      callback(new Error(`unexpected git invocation: ${file} ${args.join(' ')}`), {
        stdout: '',
        stderr: '',
      });
    });
    await expect(indexContainsLfsPointer('/repo', {})).rejects.toThrow(/ls-files/);
  });
});
