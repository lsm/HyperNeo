import { resolve } from 'node:path';
import { Database } from '../src/storage/sqlite-compat.ts';
import { DatabaseLock } from '../src/storage/database-lock.ts';

const dbPath = process.argv[2];
if (!dbPath || process.argv[3] !== '--restore-legacy')
  throw new Error(
    'Usage: bun restore-sdk-message-bodies.ts <DB path> --restore-legacy (daemon must be stopped)'
  );
const lock = new DatabaseLock(resolve(dbPath));
lock.acquire();
let db: Database | undefined;
try {
  db = new Database(resolve(dbPath));
  db.exec('PRAGMA busy_timeout=0');
  const columns = db.prepare("PRAGMA table_xinfo('sdk_messages')").all() as { name: string }[];
  if (!columns.some((column) => column.name === 'sdk_message'))
    db.exec("ALTER TABLE sdk_messages ADD COLUMN sdk_message TEXT NOT NULL DEFAULT ''");
  let after = 0;
  for (;;) {
    const sizes = db
      .prepare(
        'SELECT seq,octet_length(sdk_message) AS bytes FROM sdk_message_bodies WHERE seq>? ORDER BY seq LIMIT 128'
      )
      .all(after) as { seq: number; bytes: number }[];
    if (!sizes.length) break;
    let bytes = 0,
      through = after;
    for (const row of sizes) {
      if (through > after && bytes + row.bytes > 1024 * 1024) break;
      bytes += row.bytes;
      through = row.seq;
    }
    const source = db;
    source.transaction(() => {
      source
        .prepare(`UPDATE sdk_messages SET sdk_message=(
        SELECT sdk_message FROM sdk_message_bodies WHERE seq=sdk_messages.seq
      ) WHERE seq>? AND seq<=? AND EXISTS (
        SELECT 1 FROM sdk_message_bodies WHERE seq=sdk_messages.seq
      )`)
        .run(after, through);
    }, 'immediate')();
    after = through;
    console.log(JSON.stringify({ phase: 'restored', through, bytes }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  db.transaction(() => {
    db!.exec("DELETE FROM migration_markers WHERE key GLOB 'sdk_message_bodies_copy_v1:*'");
    db!
      .prepare('INSERT INTO migration_markers(key,applied_at) VALUES (?,?)')
      .run('sdk_message_bodies_copy_v1:reversed', Date.now());
  })();
  console.log(
    'Legacy bodies restored in full; side bodies and pinned backup retained. Automatic copy is disabled by the reversed marker.'
  );
} finally {
  db?.close();
  lock.release();
}
