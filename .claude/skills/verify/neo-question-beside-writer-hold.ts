import { Database } from 'bun:sqlite';

const [path, holdMs] = process.argv.slice(2);
const db = new Database(path);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('BEGIN IMMEDIATE');
db.exec("UPDATE neo_asks SET updated_at = updated_at + 1 WHERE id = 'locked-card-ask'");
console.log('held');
await Bun.sleep(Number(holdMs));
db.exec('COMMIT');
db.close();
console.log('released');
