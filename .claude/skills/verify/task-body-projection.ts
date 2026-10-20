import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseCore } from '../../../packages/daemon/src/storage/database-core.ts';
import { writeSdkMessageBody } from '../../../packages/daemon/src/storage/repositories/sdk-message-body-write.ts';
import { deriveSdkMessageColumns, SDK_MESSAGE_COLUMN_TYPES } from '../../../packages/daemon/src/storage/sdk-message-columns.ts';

const [runText, mode = 'body'] = process.argv.slice(2);
const run = resolve(runText);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const core = new DatabaseCore(join(run, 'data/daemon.db'));
try {
  await core.initialize();
  const db = core.getDb();
  db.exec('PRAGMA foreign_keys=OFF');
  const body = { type: 'assistant', subtype: 'before', message: { content: [{ type: 'text', text: 'complete' }] } };
  const names = Object.keys(SDK_MESSAGE_COLUMN_TYPES) as (keyof typeof SDK_MESSAGE_COLUMN_TYPES)[];
  const derived = deriveSdkMessageColumns(body, 'task');
  writeSdkMessageBody(db, () => db.prepare(`INSERT INTO sdk_messages(id,session_id,task_id,message_type,sdk_message,timestamp,replacement_metadata_normalized,${names.join(',')}) VALUES ('probe','synthetic','task','assistant',?,'2026-10-20T00:00:00Z',1,${names.map(() => '?').join(',')})`).run(JSON.stringify(body), ...names.map((key) => derived[key])), "id='probe'", []);
  const before = db.prepare("SELECT flags,json_subtype FROM task_message_rows WHERE id='probe'").get();
  if (mode === 'missing') {
    db.exec("DELETE FROM task_message_rows WHERE id='probe'");
    db.exec("UPDATE sdk_messages SET sdk_message='' WHERE id='probe'");
    db.exec("UPDATE sdk_messages SET send_status='failed' WHERE id='probe'");
  } else {
    db.prepare('UPDATE sdk_message_bodies SET sdk_message=?').run(JSON.stringify({ type: 'assistant', subtype: 'after', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } }));
  }
  const after = db.prepare("SELECT flags,json_subtype FROM task_message_rows WHERE id='probe'").get();
  const observed = { before, after, expected: mode === 'missing' ? { flags: 17, json_subtype: 'before' } : { flags: 18, json_subtype: 'after' } };
  writeFileSync(join(run, 'evidence/body-projection.json'), JSON.stringify(observed, null, 2));
  console.log(JSON.stringify(observed));
  assert.deepEqual(after, observed.expected);
} finally { await core.close(); }
