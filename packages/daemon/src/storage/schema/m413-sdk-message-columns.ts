import { gatewayFor } from '../db-gateway/db-gateway.ts';
import {
  sdkColumnBackfillChunk,
  sdkColumnBackfillComplete,
} from '../repositories/sdk-message-transactions.ts';
import type { Database } from '../sqlite-compat.ts';
import { SDK_MESSAGE_COLUMN_TYPES, deriveSdkMessageColumns } from '../sdk-message-columns.ts';

export function runMigration413(db: Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_xinfo('sdk_messages')").all() as { name: string }[]).map(
      (row) => row.name
    )
  );
  if (!columns.size) return;
  for (const [name, type] of Object.entries(SDK_MESSAGE_COLUMN_TYPES))
    if (!columns.has(name)) db.exec(`ALTER TABLE sdk_messages ADD COLUMN ${name} ${type}`);
}

export function backfillSdkMessageColumnsChunk(
  db: Database,
  { after, ceiling }: { after: number; ceiling: number }
): { through: number; rows: number; bytes: number; malformed: number } | null {
  const cursorPrefix = 'sdk_message_columns_backfill_v2:';
  const names = Object.keys(SDK_MESSAGE_COLUMN_TYPES) as (keyof typeof SDK_MESSAGE_COLUMN_TYPES)[];
  const update = db.prepare(
    `UPDATE sdk_messages SET ${names.map((name) => `${name} = ?`).join(', ')} WHERE seq = ?`
  );
  const sizes = db
    .prepare(
      'SELECT seq, octet_length(sdk_message) AS bytes FROM sdk_messages WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT 512'
    )
    .all(after, ceiling) as { seq: number; bytes: number }[];
  if (!sizes.length) return null;
  let bytes = 0;
  let through = after;
  for (const row of sizes) {
    if (through > after && bytes + row.bytes > 4 * 1024 * 1024) break;
    bytes += row.bytes;
    through = row.seq;
  }
  const rows = db
    .prepare(
      'SELECT seq, sdk_message, task_id FROM sdk_messages WHERE seq > ? AND seq <= ? ORDER BY seq'
    )
    .all(after, through) as { seq: number; sdk_message: string; task_id: string | null }[];
  let malformed = 0;
  db.transaction(() => {
    for (const row of rows) {
      let message: unknown;
      try {
        message = JSON.parse(row.sdk_message);
      } catch {
        malformed++;
        continue;
      }
      const derived = deriveSdkMessageColumns(message, row.task_id);
      update.run(...names.map((name) => derived[name]), row.seq);
    }
    db.exec("DELETE FROM migration_markers WHERE key GLOB 'sdk_message_columns_backfill_v2:*'");
    db.prepare('INSERT INTO migration_markers (key, applied_at) VALUES (?, ?)').run(
      `${cursorPrefix}${through}`,
      Date.now()
    );
  })();
  return { through, rows: rows.length, bytes, malformed };
}

export async function backfillSdkMessageColumns(
  db: Database,
  log: (progress: string) => void,
  options: { signal?: AbortSignal; ceiling?: number; onProgress?: (through: number) => void } = {}
): Promise<void> {
  const done = 'sdk_message_columns_backfilled_v2';
  const cursorPrefix = 'sdk_message_columns_backfill_v2:';
  if (db.prepare('SELECT 1 FROM migration_markers WHERE key = ?').get(done)) return;
  const cursor = db
    .prepare("SELECT key FROM migration_markers WHERE key GLOB 'sdk_message_columns_backfill_v2:*'")
    .get() as { key: string } | undefined;
  let after = cursor ? Number(cursor.key.slice(cursorPrefix.length)) : 0;
  const ceiling =
    options.ceiling ??
    (db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM sdk_messages').get() as { n: number }).n;
  for (;;) {
    if (options.signal?.aborted) return;
    const startedAt = performance.now();
    const chunk = await gatewayFor(db).run(sdkColumnBackfillChunk, { after, ceiling });
    if (!chunk) break;
    const { through, rows, bytes, malformed } = chunk;
    after = through;
    options.onProgress?.(through);
    log(
      `SDK message columns: ${JSON.stringify({ through, rows, bytes, malformed, elapsedMs: performance.now() - startedAt })}`
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (options.signal?.aborted) return;
  await gatewayFor(db).run(sdkColumnBackfillComplete, undefined);
}
