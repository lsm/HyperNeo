import { createHash } from 'node:crypto';
import {
  existsSync,
  renameSync,
  rmSync,
  openSync,
  fsyncSync,
  closeSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { Database } from './sqlite-compat.ts';
import type { BodyBackupRequest, BodyBackupReply } from './sdk-message-body-backup.ts';
import { joinedSdkMessageBody } from './repositories/sdk-message-body-read.ts';

const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<BodyBackupRequest>) => void) | null;
  postMessage(reply: BodyBackupReply): void;
};
worker.onmessage = ({ data }) => {
  const started = performance.now();
  let db: Database | undefined;
  let verifying = false;
  try {
    if (data.action === 'checkpoint') {
      db = new Database(data.dbPath);
      db.exec('PRAGMA busy_timeout=0');
      db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      worker.postMessage({ id: data.id });
      return;
    }
    verifying = data.mustExist === true;
    if (!existsSync(data.backupPath)) {
      if (data.mustExist)
        throw new Error('Original SDK body migration backup is missing; refusing to resume');
      const partial = `${data.backupPath}.partial`;
      rmSync(partial, { force: true });
      db = new Database(data.dbPath, { readonly: true });
      db.prepare('VACUUM INTO ?').run(partial);
      db.close();
      db = undefined;
      chmodSync(partial, 0o600);
      const fd = openSync(partial, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(partial, data.backupPath);
    }
    verifying = true;
    db = new Database(data.backupPath, { readonly: true });
    const checks = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
    if (checks.length !== 1 || checks[0].quick_check !== 'ok')
      throw new Error('SDK body migration backup failed quick_check');
    const digest = createHash('sha256');
    let rows = 0;
    for (const row of db
      .prepare(`SELECT m.seq,${joinedSdkMessageBody('b', 'm')} AS body
      FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq ORDER BY m.seq`)
      .iterate() as Iterable<{ seq: number; body: string }>) {
      digest.update(`${row.seq}:${Buffer.byteLength(row.body)}:`);
      digest.update(row.body);
      rows++;
    }
    const hash = digest.digest('hex');
    const fileDigest = createHash('sha256'),
      fd = openSync(data.backupPath, 'r'),
      buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      for (;;) {
        const n = readSync(fd, buffer, 0, buffer.length, null);
        if (!n) break;
        fileDigest.update(buffer.subarray(0, n));
      }
    } finally {
      closeSync(fd);
    }
    const fileHash = fileDigest.digest('hex');
    const manifestPath = `${data.backupPath}.verified.json`;
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        hash: string;
        fileHash: string;
        rows: number;
      };
      if (manifest.hash !== hash || manifest.rows !== rows || manifest.fileHash !== fileHash)
        throw new Error('SDK body backup digest mismatch; refusing migration');
    } else {
      if (data.mustExist)
        throw new Error('Original SDK body backup verification manifest is missing');
      writeFileSync(
        manifestPath,
        JSON.stringify({ hash, fileHash, rows, verifiedAt: Date.now() }),
        {
          mode: 0o600,
          flush: true,
        }
      );
    }
    const directory = openSync(dirname(data.backupPath), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    worker.postMessage({
      id: data.id,
      backupPath: data.backupPath,
      hash,
      fileHash,
      backupBytes: statSync(data.backupPath).size,
      quickCheck: 'ok',
      rows,
      elapsedMs: performance.now() - started,
    });
  } catch (error) {
    worker.postMessage({
      id: data.id,
      error: String(error),
      ...(verifying ? { errorCode: 'verification_failed' as const } : {}),
    });
  } finally {
    db?.close();
  }
};
