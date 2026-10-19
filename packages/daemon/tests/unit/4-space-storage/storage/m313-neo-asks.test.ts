import { describe, expect, test } from 'bun:test';
import { runMigration313 } from '../../../../src/storage/schema/m313-neo-asks';
import { runMigration316 } from '../../../../src/storage/schema/m316-neo-ask-evidence';
import { runMigration318 } from '../../../../src/storage/schema/m318-neo-ask-items';
import { runMigration322 } from '../../../../src/storage/schema/m322-neo-ask-reminders';
import { runMigration324 } from '../../../../src/storage/schema/m324-neo-ask-pack';
import { runMigration326 } from '../../../../src/storage/schema/m326-neo-ask-approved';
import { runMigration327 } from '../../../../src/storage/schema/m327-neo-ask-approved-continues';
import { runMigration328 } from '../../../../src/storage/schema/m328-neo-ask-item-check-kinds';
import { runMigration330 } from '../../../../src/storage/schema/m330-neo-ask-waiting-item';
import { runMigration342 } from '../../../../src/storage/schema/m342-neo-ask-item-options';
import { runMigration343 } from '../../../../src/storage/schema/m343-neo-ask-item-decision';
import { runMigration348 } from '../../../../src/storage/schema/m348-neo-ask-item-action';
import { runMigration350 } from '../../../../src/storage/schema/m350-neo-ask-item-kind';
import { runMigration351 } from '../../../../src/storage/schema/m351-neo-ask-item-question';
import { runMigration352 } from '../../../../src/storage/schema/m352-neo-ask-item-watch';
import { runMigration358 } from '../../../../src/storage/schema/m358-neo-ask-revisions';
import { runMigration364 } from '../../../../src/storage/schema/m364-neo-outcome-bindings';
import { runMigration372 } from '../../../../src/storage/schema/m372-neo-ask-item-removed-reason';
import { runMigration373 } from '../../../../src/storage/schema/m373-neo-ask-item-decides';
import { runMigration374 } from '../../../../src/storage/schema/m374-neo-ask-item-because';
import { runMigration376 } from '../../../../src/storage/schema/m376-neo-ask-item-outcome-kind';
import { runMigration381 } from '../../../../src/storage/schema/m381-neo-ask-refusal';
import { runMigration387 } from '../../../../src/storage/schema/m387-neo-ask-todo-tables';
import { Database } from '../../../../src/storage/sqlite-compat';

function withWork() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE neo_work (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)');
  db.exec("INSERT INTO neo_work VALUES ('w2', 2), ('w1', 1)");
  return db;
}

function withAsks() {
  const db = withWork();
  for (const migrate of [
    runMigration313,
    runMigration316,
    runMigration318,
    runMigration322,
    runMigration324,
    runMigration326,
    runMigration327,
    runMigration328,
    runMigration330,
    runMigration342,
    runMigration343,
    runMigration348,
    runMigration350,
    runMigration351,
    runMigration352,
    runMigration358,
    runMigration364,
    runMigration372,
    runMigration373,
    runMigration374,
    runMigration376,
    runMigration381,
    runMigration387,
  ])
    migrate(db);
  return db;
}

const input = {
  id: 'a1',
  requestKey: 'root:fix',
  projectId: null,
  originSessionId: 'root',
  originMessageId: 'm1',
  title: 'Fix the login bug',
  ask: 'Fix the login bug',
  doneWhen: '- merged to dev',
  doneSource: 'human',
};

describe('runMigration313', () => {
  test('creates the ask tables once, and skips databases without Neo work', () => {
    const db = withWork();
    runMigration313(db);
    runMigration313(db);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name IN ('neo_asks', 'neo_ask_work')").all()
    ).toHaveLength(2);

    const bare = new Database(':memory:');
    runMigration313(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_asks'").get()).toBe(null);
  });
});
