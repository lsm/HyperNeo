import { describe, expect, test } from 'bun:test';
import { runMigration354 } from '../../../../src/storage/schema/m354-neo-ask-needs-you-questions';
import { Database } from '../../../../src/storage/sqlite-compat';

function askDb(): Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE neo_asks (id TEXT PRIMARY KEY, status TEXT NOT NULL, outcome TEXT,
    settled_at INTEGER, waiting_item TEXT, updated_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE neo_ask_items (ask_id TEXT NOT NULL, id TEXT NOT NULL,
    position INTEGER NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, evidence TEXT,
    met_by TEXT, removed INTEGER NOT NULL DEFAULT 0, options TEXT,
    decision INTEGER NOT NULL DEFAULT 0, action TEXT, wait_card TEXT, kind TEXT, question TEXT,
    updated_at INTEGER NOT NULL, PRIMARY KEY (ask_id, id))`);
  return db;
}

function item(
  db: Database,
  ask: string,
  id: string,
  position: number,
  fields: Record<string, string | number | null>
): void {
  const row = { text: id, state: 'needs_you', ...fields };
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO neo_ask_items (ask_id, id, position, updated_at, ${columns.join(', ')})
      VALUES (?, ?, ?, 1, ${columns.map(() => '?').join(', ')})`
  ).run(ask, id, position, ...Object.values(row));
}

const items = (db: Database) =>
  db
    .prepare(
      `SELECT ask_id AS ask, id, state, options, decision, kind, question, wait_card AS waitCard,
        evidence FROM neo_ask_items ORDER BY ask_id, position`
    )
    .all();

describe('runMigration354', () => {
  test('turns needs_you items into questions, or moves them back to pending', () => {
    const db = askDb();
    db.exec(`INSERT INTO neo_asks (id, status, outcome, settled_at, waiting_item, updated_at) VALUES
      ('a1', 'waiting', 'Pick one', 1, 'i1', 1),
      ('a2', 'waiting', 'Approve again', 1, 'i1', 1),
      ('a3', 'blocked', 'Click Start', 1, 'i1', 1),
      ('a4', 'waiting', 'Confirm: deployed', 1, 'i1', 1)`);
    item(db, 'a1', 'i1', 0, { kind: 'decision', options: '["A","B"]' });
    item(db, 'a1', 'i2', 1, { text: 'Keyboard hides', kind: 'action', question: 'Did it hide?' });
    item(db, 'a1', 'i3', 2, { text: 'Phone works', kind: 'action' });
    item(db, 'a2', 'i1', 0, { text: 'Approve again', evidence: 'stalled' });
    item(db, 'a2', 'i2', 1, { state: 'met' });
    item(db, 'a3', 'i1', 0, { kind: 'action', wait_card: 'w1' });
    item(db, 'a3', 'i2', 1, { kind: 'decision', options: '["X","Y"]', removed: 1 });
    item(db, 'a3', 'i3', 2, { kind: 'decision', text: 'Choose in chat' });
    item(db, 'a3', 'i4', 3, { options: '["Now","Later"]' });
    item(db, 'a4', 'i1', 0, { state: 'reported', text: 'deployed' });

    runMigration354(db, 7);
    runMigration354(db, 8);

    const pending = {
      state: 'pending',
      options: null,
      decision: 0,
      kind: null,
      question: null,
      waitCard: null,
      evidence: 'Moved back to pending: a decision now reaches the human only as neo.ask.question.',
    };
    expect(items(db)).toEqual([
      expect.objectContaining({
        ask: 'a1',
        id: 'i1',
        state: 'needs_you',
        options: '["A","B"]',
        decision: 1,
        kind: 'decision',
        question: 'i1',
      }),
      expect.objectContaining({
        id: 'i2',
        state: 'needs_you',
        options: '["Yes","Not yet"]',
        decision: 1,
        kind: 'action',
        question: 'Did it hide?',
      }),
      expect.objectContaining({
        id: 'i3',
        state: 'needs_you',
        options: '["Yes","Not yet"]',
        kind: 'action',
        question: 'Did it work?',
      }),
      expect.objectContaining({ ask: 'a2', id: 'i1', ...pending }),
      expect.objectContaining({ ask: 'a2', id: 'i2', state: 'met' }),
      expect.objectContaining({ ask: 'a3', id: 'i1', ...pending }),
      expect.objectContaining({ ask: 'a3', id: 'i2', ...pending }),
      expect.objectContaining({ ask: 'a3', id: 'i3', ...pending }),
      expect.objectContaining({
        ask: 'a3',
        id: 'i4',
        state: 'needs_you',
        kind: 'decision',
        question: 'i4',
        decision: 1,
      }),
      expect.objectContaining({ ask: 'a4', id: 'i1', state: 'reported' }),
    ]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM neo_ask_items WHERE state = 'needs_you' AND options IS NULL"
        )
        .get()
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          'SELECT id, status, outcome, settled_at AS settledAt, waiting_item AS waitingItem FROM neo_asks ORDER BY id'
        )
        .all()
    ).toEqual([
      { id: 'a1', status: 'waiting', outcome: 'Pick one', settledAt: 1, waitingItem: 'i1' },
      { id: 'a2', status: 'open', outcome: null, settledAt: null, waitingItem: null },
      { id: 'a3', status: 'blocked', outcome: 'Click Start', settledAt: 1, waitingItem: 'i4' },
      {
        id: 'a4',
        status: 'waiting',
        outcome: 'Confirm: deployed',
        settledAt: 1,
        waitingItem: 'i1',
      },
    ]);
  });

  test('skips a database without ask items', () => {
    const bare = new Database(':memory:');
    runMigration354(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_ask_items'").get()).toBe(
      null
    );
  });
});
