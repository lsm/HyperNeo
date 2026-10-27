import assert from 'node:assert/strict';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const db = new Database(':memory:');
try {
  db.exec('CREATE TABLE sample(alias TEXT)');
  const expected = 'repo:synthetic/project\u0000a';
  db.prepare('INSERT INTO sample VALUES (?)').run(expected);
  const actual = db.prepare('SELECT alias, hex(alias) AS bytes FROM sample').get() as {
    alias: string;
    bytes: string;
  };
  console.log(JSON.stringify({ expected, actual }));
  assert.equal(actual.alias, expected, 'Workspace identity must survive SQLite text reads');
} finally {
  db.close();
}
