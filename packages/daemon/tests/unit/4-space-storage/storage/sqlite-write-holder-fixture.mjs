import { DatabaseSync } from 'node:sqlite';

const [path, holdMs] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('BEGIN IMMEDIATE');
db.exec("UPDATE neo_asks SET updated_at = updated_at + 1 WHERE id = 'ask'");
process.stdout.write('held\n');
setTimeout(() => {
  db.exec('COMMIT');
  db.close();
  process.stdout.write('released\n');
}, Number(holdMs));
