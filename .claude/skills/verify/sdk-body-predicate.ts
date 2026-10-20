import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { selectSdkBodyWriteMode } from '../../../packages/daemon/src/storage/sdk-message-body-admission.ts';
import { writeSdkMessageBody } from '../../../packages/daemon/src/storage/repositories/sdk-message-body-write.ts';
import { SDKMessageRepository } from '../../../packages/daemon/src/storage/repositories/sdk-message-repository.ts';

const [expectation, directory] = process.argv.slice(2);
const run = resolve(directory);
assert(['reproduce', 'verify'].includes(expectation));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const outcomes: unknown[] = [];
for (const mode of ['dual-write', 'side-only']) {
  const db = new Database(':memory:');
  try {
    runMigrations(db, () => {}); createTables(db); db.exec('PRAGMA foreign_keys=OFF');
    if (mode === 'side-only') db.exec("INSERT INTO migration_markers VALUES ('sdk_message_bodies_copy_v1:complete',1)");
    assert.equal((await selectSdkBodyWriteMode(db)).mode, mode);
    const repo = new SDKMessageRepository(db);
    const result = '完整合成工具结果'.repeat(10000);
    const message = { type: 'result', uuid: 'qualified', subtype: 'success', result };
    repo.saveSDKMessage('synthetic', message);
    const body = JSON.stringify(message);
    const { seq } = db.prepare('SELECT rowid AS seq FROM sdk_messages').get() as { seq: number };
    for (const predicate of ['m.rowid=?', "m.sdk_message<>''"]) {
      db.prepare('UPDATE sdk_messages SET sdk_message=?').run(body);
      const before = db.prepare('SELECT sdk_message FROM sdk_message_bodies').get();
      let error = '';
      try {
        writeSdkMessageBody(db, () => {}, predicate, predicate.includes('?') ? [seq] : [], 'm.sdk_message', []);
      } catch (value) { error = String(value); }
      assert.deepEqual(db.prepare('SELECT sdk_message FROM sdk_message_bodies').get(), before);
      assert.equal((repo.getMessageByUuid('synthetic', 'qualified') as { result: string }).result, result);
      if (expectation === 'reproduce' && mode === 'dual-write') assert(error.includes('no such column: m.'));
      else assert.equal(error, '');
      outcomes.push({ mode, predicate, error, fullBodySha256: createHash('sha256').update(body).digest('hex') });
    }
  } finally { db.close(); }
}
writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ expectation, outcomes }, null, 2));
console.log(JSON.stringify({ expectation, outcomes }));
