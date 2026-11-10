import { runtimeWorkerUrl } from '../lib/runtime-worker-url.ts';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Database } from './sqlite-compat.ts';

const BACKUP = 'sdk_message_bodies_copy_v1:backup:';

export async function reserveSdkBodyBackupPath(
  db: Database,
  dbPath: string,
  signal: AbortSignal
): Promise<string> {
  const directory = join(dirname(dbPath), 'backups', 'sdk-message-bodies-v1');
  while (!signal.aborted) {
    const busy = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
    try {
      db.exec('PRAGMA busy_timeout=0');
      return db.transaction(() => {
        const prior = db
          .prepare('SELECT key FROM migration_markers WHERE key GLOB ?')
          .get(`${BACKUP}*`) as { key: string } | undefined;
        const path = prior
          ? prior.key.slice(BACKUP.length)
          : join(directory, `${basename(dbPath)}-${randomUUID()}.db`);
        if (dirname(path) !== directory)
          throw new SdkBodyCopyTerminalError(
            'SDK body backup reservation location is invalid',
            path
          );
        if (!prior)
          db.prepare('INSERT INTO migration_markers(key,applied_at) VALUES (?,?)').run(
            `${BACKUP}${path}`,
            Date.now()
          );
        return path;
      }, 'immediate')();
    } catch (error) {
      if (!/busy|locked/i.test(String(error))) throw error;
    } finally {
      db.exec(`PRAGMA busy_timeout=${busy}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('SDK body backup reservation cancelled');
}

export type BodyBackupRequest = {
  id: number;
  action: 'backup' | 'checkpoint';
  dbPath: string;
  backupPath: string;
  mustExist?: boolean;
};
export type BodyBackupReply = {
  id: number;
  error?: string;
  errorCode?: 'verification_failed';
  backupPath?: string;
  hash?: string;
  rows?: number;
  elapsedMs?: number;
  backupBytes?: number;
  quickCheck?: 'ok';
  fileHash?: string;
};

export class SdkBodyCopyTerminalError extends Error {
  constructor(
    message: string,
    readonly backupPath: string
  ) {
    super(message);
  }
}

export function sdkBodyBackupChannel(dbPath: string, backupPath: string, signal: AbortSignal) {
  mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(backupPath), 0o700);
  const worker = new Worker(
    runtimeWorkerUrl(
      './sdk-message-body-backup-worker.ts',
      './daemon/src/storage/sdk-message-body-backup-worker.ts',
      import.meta.url
    ).toString(),
    {
      type: 'module',
    }
  );
  let seq = 0;
  let fault: Error | undefined;
  const pending = new Map<
    number,
    { resolve: (reply: BodyBackupReply) => void; reject: (error: Error) => void }
  >();
  const stop = () => {
    worker.terminate();
    for (const call of pending.values()) call.reject(new Error('SDK body backup cancelled'));
    pending.clear();
  };
  signal.addEventListener('abort', stop, { once: true });
  worker.onmessage = (event: MessageEvent<BodyBackupReply>) => {
    const reply = event.data;
    const call = pending.get(reply.id);
    pending.delete(reply.id);
    if (reply.error)
      call?.reject(
        reply.errorCode === 'verification_failed'
          ? new SdkBodyCopyTerminalError(reply.error, backupPath)
          : new Error(reply.error)
      );
    else call?.resolve(reply);
  };
  worker.onerror = (error) => {
    fault = new Error(error.message);
    for (const call of pending.values()) call.reject(new Error(error.message));
    pending.clear();
  };
  const request = (action: BodyBackupRequest['action'], mustExist = false) =>
    new Promise<BodyBackupReply>((resolve, reject) => {
      if (fault) {
        reject(fault);
        return;
      }
      if (signal.aborted) {
        reject(new Error('SDK body backup cancelled'));
        return;
      }
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, action, dbPath, backupPath, mustExist } satisfies BodyBackupRequest);
    });
  return {
    verify: (mustExist: boolean) => request('backup', mustExist),
    checkpoint: async () => {
      await request('checkpoint');
    },
    close: () => {
      signal.removeEventListener('abort', stop);
      stop();
    },
  };
}
