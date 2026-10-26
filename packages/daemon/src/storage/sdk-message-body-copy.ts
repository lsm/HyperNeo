import superpipe, { type PipelineAPI } from 'superpipe';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SdkBodyCopyTerminalError } from './sdk-message-body-backup.ts';
import type { Database } from './sqlite-compat.ts';
import { SDK_MESSAGE_COLUMN_TYPES, deriveSdkMessageColumns } from './sdk-message-columns.ts';
import {
  joinedSdkMessageBody,
  joinedSdkMessageBodyBytes,
} from './repositories/sdk-message-body-read.ts';

const STATE = 'sdk_message_bodies_copy_v1:state:';
const DONE = 'sdk_message_bodies_copy_v1:complete';
const REVERSED = 'sdk_message_bodies_copy_v1:reversed';
const progressSchema = z
  .object({
    through: z.number().int().nonnegative(),
    ceiling: z.number().int().nonnegative(),
    backupPath: z.string(),
    beforeHash: z
      .string()
      .regex(/^(?:[a-f0-9]{64})?$/)
      .optional(),
    afterHash: z
      .string()
      .regex(/^(?:[a-f0-9]{64})?$/)
      .optional(),
    startedAt: z.number().nonnegative().optional(),
  })
  .refine((state) => state.through <= state.ceiling);
type Progress = z.infer<typeof progressSchema>;
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

function markSdkBodyCopyDone(db: Database): 'done' | 'locked' {
  const busy = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
  try {
    db.exec('PRAGMA busy_timeout=0');
    db.prepare('INSERT OR IGNORE INTO migration_markers(key,applied_at) VALUES (?,?)').run(
      DONE,
      Date.now()
    );
    return 'done';
  } catch (error) {
    if (!/busy|locked/i.test(String(error))) throw error;
    return 'locked';
  } finally {
    db.exec(`PRAGMA busy_timeout=${busy}`);
  }
}

type BodyChunk = { state: Progress; rows: number; malformed: number; copiedBytes: number };

function copySdkBodyChunk(
  db: Database,
  { state: previousState, through }: { state: Progress; through: number }
): BodyChunk | 'locked' {
  const state = { ...previousState };
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
  let rows = 0,
    malformed = 0,
    copiedBytes = 0;
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
          throw new SdkBodyCopyTerminalError(
            `SDK body copy byte mismatch at seq ${row.seq}`,
            state.backupPath
          );
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
        throw new SdkBodyCopyTerminalError(
          'SDK body copy logical digest mismatch',
          state.backupPath
        );
      saveCursor();
    }, 'immediate')();
    return { state, rows, malformed, copiedBytes };
  } catch (error) {
    if (!/busy|locked/i.test(String(error))) throw error;
    return 'locked';
  } finally {
    db.exec(`PRAGMA busy_timeout=${busy}`);
  }
}

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
  let state: Progress;
  if (prior) {
    try {
      state = progressSchema.parse(JSON.parse(prior.key.slice(STATE.length)));
    } catch (error) {
      throw new SdkBodyCopyTerminalError(
        `Invalid stored SDK body copy state: ${String(error)}`,
        '<unknown>'
      );
    }
  } else
    state = {
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
    throw new SdkBodyCopyTerminalError(
      'Stored SDK body copy audit hashes disagree',
      state.backupPath
    );
  state.backupPath = await options.verifyBackup(Boolean(prior), state.backupPath);
  if (options.signal?.aborted) return { status: 'cancelled' as const };
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
        if (markSdkBodyCopyDone(db) === 'locked') {
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
      const transactionAt = performance.now();
      const chunk = copySdkBodyChunk(db, { state, through });
      if (chunk === 'locked') {
        options.log(JSON.stringify({ phase: 'writer_busy', through: state.through }));
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      state = chunk.state;
      const transactionMs = performance.now() - transactionAt;
      options.log(
        JSON.stringify({
          phase: 'chunk',
          through: state.through,
          ceiling: state.ceiling,
          rows: chunk.rows,
          bytes: chunk.copiedBytes,
          malformed: chunk.malformed,
          transactionMs,
          elapsedMs: performance.now() - started,
        })
      );
      const pauseMs = transactionMs >= 250 ? 1000 : 0;
      if (pauseMs)
        options.log(
          JSON.stringify({
            phase: 'slow_chunk_pause',
            through: state.through,
            transactionMs,
            resumeAfterMs: pauseMs,
          })
        );
      if (options.signal?.aborted) break;
      await options.checkpoint();
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, pauseMs);
        if (options.signal?.aborted) finish();
        else options.signal?.addEventListener('abort', finish, { once: true });
      });
    }
    return { status: 'cancelled' as const };
  } finally {
    try {
      db.exec(`PRAGMA wal_autocheckpoint=${auto}`);
    } catch {}
  }
}
