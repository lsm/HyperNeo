import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { Database } from '../../src/storage/sqlite-compat.ts';
const db = new Database(join(process.argv[2], 'retained.db'));
const retained = db.prepare('SELECT 219 AS value');
assert.deepEqual(retained.get(), { value: 219 });
db.close();
assert.throws(() => retained.get(), /finalized|closed/i);
db.close();
