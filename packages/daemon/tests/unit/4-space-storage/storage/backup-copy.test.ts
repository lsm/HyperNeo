import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STREAM_COPY_KEEP_MAX,
  STREAM_COPY_MIN_BYTES,
  freeBytesAt,
  hasRoomForBackupCopy,
  shouldRotateStreamBackups,
  shouldStreamCopyBackup,
  streamCopyFile,
} from '../../../../src/storage/backup-copy';

const GiB = 1024 ** 3;

describe('shouldStreamCopyBackup', () => {
  it('copies instead of cloning only for large databases on macOS', () => {
    expect(shouldStreamCopyBackup('darwin', STREAM_COPY_MIN_BYTES)).toBe(true);
    expect(shouldStreamCopyBackup('darwin', STREAM_COPY_MIN_BYTES - 1)).toBe(false);
    expect(shouldStreamCopyBackup('linux', 40 * GiB)).toBe(false);
  });
});

describe('hasRoomForBackupCopy', () => {
  it('needs the database size plus a reserve of at least 1 GiB or 10%', () => {
    expect(hasRoomForBackupCopy(42 * GiB, 38 * GiB)).toBe(true);
    expect(hasRoomForBackupCopy(41 * GiB, 38 * GiB)).toBe(false);
    expect(hasRoomForBackupCopy(3 * GiB, 2 * GiB)).toBe(true);
    expect(hasRoomForBackupCopy(2.5 * GiB, 2 * GiB)).toBe(false);
  });
});

describe('shouldRotateStreamBackups', () => {
  it('keeps at most three backups', () => {
    expect(
      shouldRotateStreamBackups({
        backupCount: STREAM_COPY_KEEP_MAX + 1,
        freeBytes: 500 * GiB,
        dbBytes: 38 * GiB,
      })
    ).toBe(true);
    expect(
      shouldRotateStreamBackups({
        backupCount: STREAM_COPY_KEEP_MAX,
        freeBytes: 500 * GiB,
        dbBytes: 38 * GiB,
      })
    ).toBe(false);
  });

  it('drops older backups while free space is under twice the database size', () => {
    expect(
      shouldRotateStreamBackups({ backupCount: 2, freeBytes: 71 * GiB, dbBytes: 38 * GiB })
    ).toBe(true);
    expect(
      shouldRotateStreamBackups({ backupCount: 2, freeBytes: 80 * GiB, dbBytes: 38 * GiB })
    ).toBe(false);
  });

  it('never drops the only backup', () => {
    expect(
      shouldRotateStreamBackups({ backupCount: 1, freeBytes: 1 * GiB, dbBytes: 38 * GiB })
    ).toBe(false);
  });
});

describe('streamCopyFile', () => {
  it('copies every byte across chunk boundaries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-copy-'));
    try {
      const source = join(dir, 'source.db');
      const destination = join(dir, 'copy.db');
      const bytes = Buffer.alloc(16 * 1024 ** 2 + 4097);
      for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;
      writeFileSync(source, bytes);

      streamCopyFile(source, destination);

      expect(readFileSync(destination).equals(bytes)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('streamCopyFile permissions', () => {
  it('gives the copy the source file mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-copy-mode-'));
    try {
      const source = join(dir, 'source.db');
      const destination = join(dir, 'copy.db');
      writeFileSync(source, Buffer.alloc(4096));
      chmodSync(source, 0o600);

      streamCopyFile(source, destination);

      expect(statSync(destination).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('freeBytesAt', () => {
  it('reports available bytes on the volume', () => {
    expect(freeBytesAt(tmpdir())).toBeGreaterThan(0);
  });
});
