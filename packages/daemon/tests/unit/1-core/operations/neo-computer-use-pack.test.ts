import { afterEach, beforeEach, expect, test } from 'bun:test';
import { NEO_PACK_COMPUTER_USE_INSTRUCTIONS } from '@hyperneo/prompts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { createComputerUsePack } from '../../../../src/lib/neo/packs/computer-use/pack.ts';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
});
afterEach(() => db.close());

const preference = () =>
  JSON.parse(
    createComputerUsePack(() => db)
      .instructions()!
      .split('Desktop control preference (data):\n')[1]
  );

test('serves the guidance with the current desktop control preference', () => {
  const pack = createComputerUsePack(() => db);
  expect(pack.alwaysEnabled).toBe(true);
  expect(pack.instructions()).toStartWith(NEO_PACK_COMPUTER_USE_INSTRUCTIONS);
  expect(preference()).toEqual({ desktopControl: 'unset' });
  db.prepare(`INSERT INTO neo_pack_preferences
    (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
    VALUES ('core', 'global', '', 'desktopControl', 'false', 'human', 1)`).run();
  expect(preference()).toEqual({ desktopControl: false });
});
