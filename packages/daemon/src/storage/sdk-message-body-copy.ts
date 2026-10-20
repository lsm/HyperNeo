import superpipe, { type PipelineAPI } from 'superpipe';
import { createHash } from 'node:crypto';
import type { Database } from './sqlite-compat.ts';
import { SDK_MESSAGE_COLUMN_TYPES, deriveSdkMessageColumns } from './sdk-message-columns.ts';
import {
  joinedSdkMessageBody,
  joinedSdkMessageBodyBytes,
} from './repositories/sdk-message-body-read.ts';

const STATE = 'sdk_message_bodies_copy_v1:state:';
const DONE = 'sdk_message_bodies_copy_v1:complete';
const REVERSED = 'sdk_message_bodies_copy_v1:reversed';
type Progress = {
  through: number;
  ceiling: number;
  backupPath: string;
  beforeHash?: string;
  afterHash?: string;
  startedAt?: number;
};
type Options = {
  dbBytes: number;
  freeBytes: number;
  verifyBackup(mustExist: boolean, priorPath?: string): Promise<string>;
  checkpoint(): Promise<void>;
  log(progress: string): void;
  signal?: AbortSignal;
  chunkBytes?: number;
};

type Facts = { done: boolean; dbBytes: number; freeBytes: number };
const preflight = (superpipe({})('sdkBodyCopyPreflight') as PipelineAPI)
  .input(['facts'])
  .pipe(
    ({ done, dbBytes, freeBytes }: Facts) =>
      done
        ? ('complete' as const)
        : Number.isFinite(freeBytes) && freeBytes >= 2 * dbBytes
          ? ('run' as const)
          : ('refused' as const),
    ['facts'],
    'status'
  )
  .end('status') as (facts: Facts) => 'complete' | 'run' | 'refused';

export async function migrateSdkMessageBodies(db: Database, options: Options) {
  const done = Boolean(
    db.prepare('SELECT 1 FROM migration_markers WHERE key IN (?,?)').get(DONE, REVERSED)
  );
  const status = preflight({ done, dbBytes: options.dbBytes, freeBytes: options.freeBytes });
  if (status !== 'run') {
    if (status === 'refused')
      options.log(
        JSON.stringify({
          phase: 'refused',
          freeBytes: options.freeBytes,
          requiredBytes: 2 * options.dbBytes,
        })
      );
    return { status };
  }
  options.log(
    JSON.stringify({
      phase: 'disk_check_passed',
      dbBytes: options.dbBytes,
      freeBytes: options.freeBytes,
      requiredBytes: 2 * options.dbBytes,
    })
  );
  const prior = db.prepare('SELECT key FROM migration_markers WHERE key GLOB ?').get(`${STATE}*`) as
    | { key: string }
    | undefined;
  const state: Progress = prior
    ? JSON.parse(prior.key.slice(STATE.length))
    : {
        through: 0,
        ceiling: (
          db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM sdk_messages').get() as { n: number }
        ).n,
        backupPath: '',
      };
  state.startedAt ??= Date.now();
  state.beforeHash ??= '';
  state.afterHash ??= '';
  if (state.beforeHash !== state.afterHash)
    throw new Error('Stored SDK body copy audit hashes disagree');
  state.backupPath = await options.verifyBackup(Boolean(prior), state.backupPath);
  if (options.signal?.aborted) return { status: 'cancelled' as const };
  const names = Object.keys(SDK_MESSAGE_COLUMN_TYPES) as (keyof typeof SDK_MESSAGE_COLUMN_TYPES)[];
  const insert = db.prepare(`INSERT OR IGNORE INTO sdk_message_bodies(seq,sdk_message)
    SELECT m.seq,${joinedSdkMessageBody('b', 'm')} FROM sdk_messages m
    LEFT JOIN sdk_message_bodies b ON b.seq=m.seq WHERE m.seq=?`);
  const update = db.prepare(
    `UPDATE sdk_messages SET sdk_message='',${names.map((key) => `${key}=?`).join(',')} WHERE seq=?`
  );
  const cursor = db.prepare('INSERT INTO migration_markers(key,applied_at) VALUES (?,?)');
  const saveCursor = () => {
    db.prepare('DELETE FROM migration_markers WHERE key GLOB ?').run(`${STATE}*`);
    cursor.run(`${STATE}${JSON.stringify(state)}`, Date.now());
  };
  const auto = (db.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number })
    .wal_autocheckpoint;
  db.exec('PRAGMA wal_autocheckpoint=0');
  try {
    while (!options.signal?.aborted) {
      const started = performance.now();
      const sizes = db
        .prepare(`SELECT m.seq, ${joinedSdkMessageBodyBytes('b', 'm')} AS bytes
        FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq
        WHERE m.seq>? AND m.seq<=? ORDER BY m.seq LIMIT 128`)
        .all(state.through, state.ceiling) as { seq: number; bytes: number }[];
      if (!sizes.length) {
        const busy = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
        let locked = false;
        try {
          db.exec('PRAGMA busy_timeout=0');
          db.prepare('INSERT OR IGNORE INTO migration_markers(key,applied_at) VALUES (?,?)').run(
            DONE,
            Date.now()
          );
        } catch (error) {
          if (!/busy|locked/i.test(String(error))) throw error;
          locked = true;
        } finally {
          db.exec(`PRAGMA busy_timeout=${busy}`);
        }
        if (locked) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        options.log(
          JSON.stringify({
            phase: 'complete',
            through: state.through,
            backupPath: state.backupPath,
            totalRuntimeMs: Date.now() - state.startedAt!,
            beforeHash: state.beforeHash ?? '',
            afterHash: state.afterHash ?? '',
          })
        );
        return { status: 'complete' as const };
      }
      let bytes = 0;
      let through = state.through;
      for (const row of sizes) {
        if (through > state.through && bytes + row.bytes > (options.chunkBytes ?? 1024 * 1024))
          break;
        bytes += row.bytes;
        through = row.seq;
      }
      let rows = 0,
        malformed = 0,
        copiedBytes = 0;
      let locked = false;
      const previousState = { ...state };
      const busy = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
      const transactionAt = performance.now();
      try {
        db.exec('PRAGMA busy_timeout=0');
        db.transaction(() => {
          const before = createHash('sha256').update(state.beforeHash ?? '');
          const after = createHash('sha256').update(state.afterHash ?? '');
          db.exec('INSERT INTO sdk_message_body_copy_active(singleton) VALUES (1)');
          const selected = db
            .prepare(`SELECT m.seq,m.task_id,${joinedSdkMessageBody('b', 'm')} AS body
            FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq
            WHERE m.seq>? AND m.seq<=? ORDER BY m.seq`)
            .all(state.through, through) as { seq: number; task_id: string | null; body: string }[];
          for (const row of selected) {
            let derived: ReturnType<typeof deriveSdkMessageColumns> | undefined;
            try {
              derived = deriveSdkMessageColumns(JSON.parse(row.body), row.task_id);
            } catch {
              malformed++;
            }
            insert.run(row.seq);
            update.run(...names.map((name) => derived?.[name] ?? null), row.seq);
            const copied = db
              .prepare('SELECT sdk_message AS body FROM sdk_message_bodies WHERE seq=?')
              .get(row.seq) as { body: string };
            if (copied.body !== row.body)
              throw new Error(`SDK body copy byte mismatch at seq ${row.seq}`);
            const frame = `${row.seq}:${Buffer.byteLength(row.body)}:`;
            before.update(frame).update(row.body);
            after.update(frame).update(copied.body);
            state.through = row.seq;
            copiedBytes += Buffer.byteLength(row.body);
            rows++;
            if (performance.now() - transactionAt >= 20) break;
          }
          db.exec('DELETE FROM sdk_message_body_copy_active');
          state.beforeHash = before.digest('hex');
          state.afterHash = after.digest('hex');
          if (state.beforeHash !== state.afterHash)
            throw new Error('SDK body copy logical digest mismatch');
          saveCursor();
        }, 'immediate')();
      } catch (error) {
        Object.assign(state, previousState);
        if (!/busy|locked/i.test(String(error))) throw error;
        locked = true;
      } finally {
        db.exec(`PRAGMA busy_timeout=${busy}`);
      }
      if (locked) {
        options.log(JSON.stringify({ phase: 'writer_busy', through: state.through }));
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      const transactionMs = performance.now() - transactionAt;
      options.log(
        JSON.stringify({
          phase: 'chunk',
          through: state.through,
          ceiling: state.ceiling,
          rows,
          bytes: copiedBytes,
          malformed,
          transactionMs,
          elapsedMs: performance.now() - started,
        })
      );
      if (transactionMs >= 250)
        throw new Error(`SDK body copy paused after a ${transactionMs}ms transaction`);
      if (options.signal?.aborted) break;
      await options.checkpoint();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { status: 'cancelled' as const };
  } finally {
    try {
      db.exec(`PRAGMA wal_autocheckpoint=${auto}`);
    } catch {}
  }
}
