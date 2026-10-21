import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { Database } from '../../src/storage/sqlite-compat.ts';
import { runMessageSearchMerge } from '../../src/lib/message-search-merge.ts';
import { subscribeToStructuredLogs } from '../../src/lib/logger.ts';
const db = new Database(join(process.argv[2], 'retained.db'));
const retained = db.prepare('SELECT 219 AS value');
assert.deepEqual(retained.get(), { value: 219 });
db.close();
assert.throws(() => retained.get(), /finalized|closed/i);
db.close();

const path = join(process.argv[2], 'search.db');
const search = new Database(path);
search.exec(
  'PRAGMA journal_mode = WAL; CREATE VIRTUAL TABLE message_search_fts USING fts5(title, body)'
);
search
  .prepare('INSERT INTO message_search_fts(title, body) VALUES (?, ?)')
  .run('Marker', 'retained searchable content');
search.close();
const lifecycle: Record<string, unknown>[] = [];
const unsubscribe = subscribeToStructuredLogs((event) => {
  if (event.module === 'hyperneo:daemon:sqlite.worker' && event.metadata)
    lifecycle.push(event.metadata);
});
try {
  assert.equal(await runMessageSearchMerge(path).promise, 'merged');
  assert.equal(lifecycle.length, 1);
  const receipt = lifecycle[0];
  assert.equal(receipt.ok, true);
  assert(Number(receipt.openedAt) <= Number(receipt.closedAt));
  assert(Number(receipt.closedAt) <= Number(receipt.receivedAt));
  assert(Number(receipt.closeMs) >= 0);
  assert(Number(receipt.mergeMs) >= 0);
  const reopened = new Database(path);
  try {
    assert.deepEqual(
      reopened
        .prepare("SELECT title FROM message_search_fts WHERE message_search_fts MATCH 'searchable'")
        .all(),
      [{ title: 'Marker' }]
    );
  } finally {
    reopened.close();
  }
} finally {
  unsubscribe();
}
