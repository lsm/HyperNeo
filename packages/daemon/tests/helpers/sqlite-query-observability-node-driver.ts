import { subscribeToStructuredLogs } from '../../src/lib/logger';

interface CapturedMetadata {
  event?: string;
  operation?: string;
  outcome?: string;
  normalizedSql?: string;
  rowsReturned?: number;
  queries?: Array<Record<string, unknown>>;
}

const events: CapturedMetadata[] = [];
const unsubscribe = subscribeToStructuredLogs((event) => {
  if (event.module === 'hyperneo:daemon:sqlite.query') {
    events.push(event.metadata as CapturedMetadata);
  }
});

async function main(): Promise<void> {
  let databaseModule: typeof import('../../src/storage/sqlite-node');
  try {
    databaseModule = await import('../../src/storage/sqlite-node');
  } catch {
    console.log(JSON.stringify({ nodeSqliteAvailable: false }));
    return;
  }
  const { Database } = databaseModule;
  const db = new Database(':memory:', {
    queryObservability: {
      slowThresholdMs: 0,
      summaryIntervalMs: 3_600_000,
      maxQueryGroups: 50,
      summaryQueryLimit: 10,
    },
  });
  let iteratedRows = 0;
  try {
    db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)');
    const insert = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)');
    insert.run('a', 'one');
    const select = db.prepare('SELECT v FROM kv WHERE k = ?');
    select.get('a');
    select.all('a');
    for (const row of db.prepare('SELECT v FROM kv').iterate()) {
      if (row === null || row === undefined) throw new Error('iterate produced an empty row');
      iteratedRows += 1;
    }
    db.run('SELECT v FROM kv WHERE k = ?', 'a');
    db.query('SELECT v FROM kv').all();
    db.transaction(() => {
      insert.run('b', 'two');
      select.get('b');
    })();
    db.prepare('SELECT v FROM kv WHERE v = ?').get('node-driver-bound-secret');
    try {
      insert.run('a', 'duplicate');
    } catch {}
  } finally {
    db.close();
  }
  const slow = events.filter((metadata) => metadata.event === 'slow');
  const summary = events.find((metadata) => metadata.event === 'summary');
  console.log(
    JSON.stringify({
      nodeSqliteAvailable: true,
      slowCount: slow.length,
      hasGet: slow.some((metadata) => metadata.operation === 'get'),
      hasAll: slow.some((metadata) => metadata.operation === 'all'),
      hasIterateWithRows: slow.some(
        (metadata) => metadata.operation === 'iterate' && metadata.rowsReturned === iteratedRows
      ),
      hasRun: slow.some((metadata) => metadata.operation === 'run'),
      hasExec: slow.some((metadata) => metadata.operation === 'exec'),
      hasErrorOutcome: slow.some((metadata) => metadata.outcome === 'error'),
      transactionControlsAbsent: !slow.some((metadata) =>
        /\b(begin|commit|rollback|savepoint)\b/.test(String(metadata.normalizedSql))
      ),
      summaryEmitted: summary !== undefined,
      summaryHasQueries: (summary?.queries?.length ?? 0) > 0,
      secretAbsent: !JSON.stringify(events).includes('node-driver-bound-secret'),
    })
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    unsubscribe();
  });
