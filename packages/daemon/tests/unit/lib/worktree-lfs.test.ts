import { beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({ execFile: vi.fn() }));

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
  };
});

import { indexContainsLfsPointer } from '../../../src/lib/worktree-lfs';

type ProbeResult = { stdout: string; stderr: string };
type ProbeCallback = (error: Error | null, result?: ProbeResult) => void;

const LFS_SIGNATURE = 'version https://git-lfs.github.com/spec/v1';
const POINTER_OID = `oid sha256:${'a'.repeat(64)}`;
const EXT_RECORD = `ext-0-counter sha256:${'b'.repeat(64)}`;

function stubGitProbes(
  respond: (file: string, args: string[], callback: ProbeCallback) => void
): void {
  childProcessMocks.execFile.mockImplementation(
    (file: string, args: string[], _opts: unknown, callback: ProbeCallback) => {
      respond(file, args, callback);
      return undefined;
    }
  );
}

function stubGrepCandidate(blobContent: string): void {
  stubGitProbes((file, args, callback) => {
    if (file === 'git' && args[0] === 'grep') {
      callback(null, { stdout: 'asset.bin\0', stderr: '' });
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

describe('indexContainsLfsPointer', () => {
  beforeEach(() => {
    childProcessMocks.execFile.mockReset();
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

  test('accepts multiple extension records between version and oid', async () => {
    const second = `ext-1-telemetry sha256:${'c'.repeat(64)}`;
    stubGrepCandidate(`${LFS_SIGNATURE}\n${EXT_RECORD}\n${second}\n${POINTER_OID}\nsize 1234\n`);
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

  test('rejects non-numeric size records', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize twelve\n`);
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

  test('returns false when no indexed candidate matches the signature', async () => {
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
});
