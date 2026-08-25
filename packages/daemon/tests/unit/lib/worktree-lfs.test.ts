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

type ProbeCallback = (error: Error | null, stdout?: string, stderr?: string) => void;

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
      callback(null, 'asset.bin\0', '');
      return;
    }
    if (file === 'git' && args[0] === 'show') {
      callback(null, blobContent, '');
      return;
    }
    callback(new Error(`unexpected git invocation: ${file} ${args.join(' ')}`), '', '');
  });
}

async function expectPointer(content: string, accepted: boolean): Promise<void> {
  stubGrepCandidate(`${content}\n`);
  await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(accepted);
}

describe('indexContainsLfsPointer', () => {
  beforeEach(() => {
    childProcessMocks.execFile.mockReset();
  });

  test('accepts a canonical pointer blob', async () => {
    await expectPointer(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize 1234`, true);
  });

  test('accepts a canonical pointer blob without a trailing newline', async () => {
    stubGrepCandidate(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize 1234`);
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(true);
  });

  test('accepts extension records between version and oid', async () => {
    await expectPointer(`${LFS_SIGNATURE}\n${EXT_RECORD}\n${POINTER_OID}\nsize 1234`, true);
  });

  test('accepts multiple extension records between version and oid', async () => {
    const second = `ext-1-telemetry sha256:${'c'.repeat(64)}`;
    await expectPointer(
      `${LFS_SIGNATURE}\n${EXT_RECORD}\n${second}\n${POINTER_OID}\nsize 1234`,
      true
    );
  });

  test('rejects extension records with malformed digests', async () => {
    await expectPointer(
      `${LFS_SIGNATURE}\next-0-counter sha256:not-a-digest\n${POINTER_OID}\nsize 1234`,
      false
    );
  });

  test('rejects non-extension data between version and oid', async () => {
    await expectPointer(`${LFS_SIGNATURE}\nsome unexpected line\n${POINTER_OID}\nsize 1234`, false);
  });

  test('rejects trailing data after size', async () => {
    await expectPointer(`${LFS_SIGNATURE}\n${POINTER_OID}\nsize 1234\nextra\n`, false);
  });

  test('rejects blobs that only carry the signature line', async () => {
    await expectPointer(LFS_SIGNATURE, false);
  });

  test('returns false when no indexed candidate matches the signature', async () => {
    stubGitProbes((file, args, callback) => {
      if (file === 'git' && args[0] === 'grep') {
        callback(Object.assign(new Error('exit 1'), { code: 1 }), '', '');
        return;
      }
      callback(new Error(`unexpected git invocation: ${file} ${args.join(' ')}`), '', '');
    });
    await expect(indexContainsLfsPointer('/repo', {})).resolves.toBe(false);
  });

  test('propagates probe failures other than empty grep results', async () => {
    stubGitProbes((file, args, callback) => {
      if (file === 'git' && args[0] === 'grep') {
        callback(Object.assign(new Error('index locked'), { code: 128 }), '', '');
        return;
      }
      callback(new Error(`unexpected git invocation: ${file} ${args.join(' ')}`), '', '');
    });
    await expect(indexContainsLfsPointer('/repo', {})).rejects.toThrow('index locked');
  });
});
