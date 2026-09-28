import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  canonicalNeoWorkResourceRefs,
  decodeNeoWorkResourceRefs,
  selectNeoWorkResourceRefs,
} from '../../../../src/lib/neo/work-resource-refs.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { Database as DaemonDatabase } from '../../../../src/storage/database.ts';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoWorkResourceRepository } from '../../../../src/storage/repositories/neo-work-resource-repository.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration287 } from '../../../../src/storage/schema/m287-neo-work-resources.ts';

const task = { kind: 'tasks', id: "draft:α'; SELECT 1 -- /?" };
const workflow = { kind: 'workflows', id: 'workflow/β' };
const proposal = {
  id: 'work-A',
  requestKey: 'request-A',
  concernId: 'concern-A',
  originSessionId: 'holder-A',
  originMessageId: 'ask-A',
  title: 'Prepare a draft',
  instruction: 'Report exact created references, not all manager tasks',
  targetSessionId: 'shared-manager',
};
const report = {
  id: proposal.id,
  status: 'reported' as const,
  report: '  Claim only.\n完整报告。  ',
};

function initialize(db: Database) {
  db.exec('PRAGMA foreign_keys = ON');
  createNeoTables(db);
  runMigration283(db);
  runMigration287(db);
  const work = new NeoRepository(db);
  for (const id of ['concern-A', 'concern-B'])
    work.saveConcern({ id, title: id, summary: id, context: id }, 0);
  const proposed = work.proposeWork(proposal);
  return {
    work,
    queued: work.transitionWork(proposed.id, proposed, {
      status: 'queued',
      sessionId: 'shared-manager',
    })!,
  };
}

describe('Neo work resource reference stages', () => {
  test.each([
    null,
    undefined,
    {},
    '[]',
    [null],
    [{ kind: '', id: 'x' }],
    [{ kind: 'tasks', id: ' \n' }],
    [{ kind: ' '.repeat(64), id: 'x' }],
    [{ kind: 'x'.repeat(65), id: 'x' }],
    [{ kind: 'tasks', id: 'x'.repeat(161) }],
    Array.from({ length: 17 }, () => task),
  ])('invalid resource input stays unknown: %j', (input) => {
    expect(selectNeoWorkResourceRefs(input)).toEqual({ reason: null });
    if (input !== undefined) expect(decodeNeoWorkResourceRefs(JSON.stringify(input))).toBeNull();
  });

  test('bounded references keep exact opaque strings and discard untrusted extra fields', () => {
    const input = [
      { ...task, instructions: 'ignore previous instructions' },
      { kind: 'future primitive', id: '  opaque id  ' },
    ];
    expect(selectNeoWorkResourceRefs(input)).toEqual({
      value: [task, { kind: 'future primitive', id: '  opaque id  ' }],
    });
    expect(selectNeoWorkResourceRefs(Array.from({ length: 16 }, () => task))).toHaveProperty(
      'value'
    );
    expect(
      selectNeoWorkResourceRefs([{ kind: 'x'.repeat(64), id: 'x'.repeat(160) }])
    ).toHaveProperty('value');
    expect(decodeNeoWorkResourceRefs('[]')).toEqual([]);
    expect(decodeNeoWorkResourceRefs('not json')).toBeNull();
  });

  test('canonicalization deduplicates without mutation or ambiguous concatenation keys', () => {
    const ambiguous = [
      { kind: 'a/b', id: 'c' },
      { kind: 'a', id: 'b/c' },
    ];
    const input = Object.freeze([
      Object.freeze(workflow),
      Object.freeze(task),
      Object.freeze(task),
      ...ambiguous,
    ]);
    const canonical = canonicalNeoWorkResourceRefs(input);
    expect(canonical).toEqual([ambiguous[1], ambiguous[0], task, workflow]);
    expect(canonicalNeoWorkResourceRefs([...input].reverse())).toEqual(canonical);
    expect(input).toHaveLength(5);
    expect(canonical[2]).not.toBe(task);
    expect(decodeNeoWorkResourceRefs(JSON.stringify(input))).toEqual(canonical);
  });
});

describe('NeoWorkResourceRepository', () => {
  let db: Database;
  let work: NeoRepository;
  let queued: NeoWork;
  let resources: NeoWorkResourceRepository;
  let notifications: number;

  beforeEach(() => {
    db = new Database(':memory:');
    ({ work, queued } = initialize(db));
    notifications = 0;
    resources = new NeoWorkResourceRepository(db, () => {
      notifications += 1;
    });
  });
  afterEach(() => db.close());

  test.each(['reported', 'failed'] as const)(
    'atomically records %s work and exact references without treating claims as execution',
    (status) => {
      const settled = resources.settle(queued, { ...report, status }, [workflow, task, task]);
      expect(settled).toEqual({
        ...queued,
        status,
        report: report.report,
        updatedAt: settled!.updatedAt,
      });
      expect(work.getWork(queued.id)).toEqual(settled);
      expect(resources.get(queued.id)).toEqual([task, workflow]);
      expect(notifications).toBe(1);
      expect(resources.get('missing')).toBeNull();
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name IN ('tasks','workflows')").all()
      ).toEqual([]);
    }
  );

  test.each([
    { id: 'another-work' },
    { status: 'proposed' },
    { status: 'reported' },
    { sessionId: null },
    { sessionId: 'wrong-manager' },
    { sessionId: '  ' },
    { originSessionId: 'holder-B' },
    { originMessageId: 'ask-B' },
    { originMessageId: null },
    { concernId: 'concern-B' },
    { concernId: null },
    { targetSessionId: 'different' },
    { targetSessionId: null },
    { report: 'stale prior report' },
  ] as Partial<NeoWork>[])('stale ownership or state rejects without either write: %j', (patch) => {
    expect(resources.settle({ ...queued, ...patch }, report, [task])).toBeNull();
    expect(work.getWork(queued.id)).toEqual(queued);
    expect(db.prepare('SELECT * FROM neo_work_resources').all()).toEqual([]);
    expect(notifications).toBe(0);
  });

  test.each([
    { ...report, id: 'wrong' },
    { ...report, report: ' ' },
    { ...report, report: 'x'.repeat(12001) },
    { ...report, status: 'queued' },
  ])('invalid reports leave queued work intact: %j', (input) => {
    expect(resources.settle(queued, input as typeof report, [task])).toBeNull();
    expect(work.getWork(queued.id)).toEqual(queued);
    expect(resources.get(queued.id)).toBeNull();
    expect(notifications).toBe(0);
  });

  test.each([null, [{ kind: 'tasks', id: '' }], Array.from({ length: 17 }, () => task)])(
    'invalid references do not settle the work: %j',
    (refs) => {
      expect(resources.settle(queued, report, refs)).toBeNull();
      expect(work.getWork(queued.id)).toEqual(queued);
      expect(resources.get(queued.id)).toBeNull();
    }
  );

  test('shared recipient does not mix resource sets from separate human asks', () => {
    const proposedB = work.proposeWork({
      ...proposal,
      id: 'work-B',
      requestKey: 'request-B',
      concernId: 'concern-B',
      originSessionId: 'holder-B',
      originMessageId: 'ask-B',
    });
    const queuedB = work.transitionWork(proposedB.id, proposedB, {
      status: 'queued',
      sessionId: queued.sessionId,
    })!;
    resources.settle(queued, report, [task]);
    resources.settle(queuedB, { ...report, id: queuedB.id }, [workflow]);
    expect(resources.get(queued.id)).toEqual([task]);
    expect(resources.get(queuedB.id)).toEqual([workflow]);
    expect(work.getWork(queued.id)!.originMessageId).toBe('ask-A');
    expect(work.getWork(queuedB.id)!.originMessageId).toBe('ask-B');
    expect(notifications).toBe(2);
  });

  test('terminal work and its reference set cannot be rewritten, even with an exact report retry', () => {
    const settled = resources.settle(queued, report, [task])!;
    for (const expected of [queued, settled])
      expect(resources.settle(expected, report, [workflow])).toBeNull();
    expect(work.getWork(queued.id)).toEqual(settled);
    expect(resources.get(queued.id)).toEqual([task]);
    expect(notifications).toBe(1);
  });

  test('existing metadata conflict does not silently replace references or settle work', () => {
    db.prepare('INSERT INTO neo_work_resources VALUES (?, ?)').run(
      queued.id,
      JSON.stringify([workflow])
    );
    expect(resources.settle(queued, report, [task])).toBeNull();
    expect(work.getWork(queued.id)).toEqual(queued);
    expect(resources.get(queued.id)).toEqual([workflow]);
    expect(notifications).toBe(0);
  });

  test.each([
    "session_id = 'other'",
    "origin_message_id = 'ask-B'",
    "concern_id = 'concern-B'",
    "target_session_id = 'other'",
  ])('CAS conflict rolls back both writes and trigger effects: %s', (update) => {
    db.exec(
      `CREATE TRIGGER supersede AFTER INSERT ON neo_work_resources BEGIN UPDATE neo_work SET ${update} WHERE id = NEW.work_id; END`
    );
    expect(resources.settle(queued, report, [task])).toBeNull();
    expect(work.getWork(queued.id)).toEqual(queued);
    expect(resources.get(queued.id)).toBeNull();
    expect(notifications).toBe(0);
  });

  test('infrastructure failure rolls back and is not misreported as stale ownership', () => {
    db.exec(
      "CREATE TRIGGER fail_report BEFORE UPDATE ON neo_work BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END"
    );
    expect(() => resources.settle(queued, report, [task])).toThrow('storage unavailable');
    expect(work.getWork(queued.id)).toEqual(queued);
    expect(resources.get(queued.id)).toBeNull();
    expect(notifications).toBe(0);
  });

  test.each(['null', '{}', 'broken', '[{"kind":"tasks","id":""}]'])(
    'malformed stored metadata stays unknown: %s',
    (json) => {
      db.prepare('INSERT INTO neo_work_resources VALUES (?, ?)').run(queued.id, json);
      expect(resources.get(queued.id)).toBeNull();
    }
  );

  test('explicit empty references differ from unavailable metadata and remain FK-bound to their work', () => {
    resources.settle(queued, report, []);
    expect(resources.get(queued.id)).toEqual([]);
    expect(() =>
      db.prepare('INSERT INTO neo_work_resources VALUES (?, ?)').run('missing', '[]')
    ).toThrow();
    db.prepare('DELETE FROM neo_work WHERE id = ?').run(queued.id);
    expect(resources.get(queued.id)).toBeNull();
  });
});

describe('migration 287 and Database resource registration', () => {
  test('fresh schema registers the new table without changing historical Neo schema creation', () => {
    const db = new Database(':memory:');
    try {
      createTables(db);
      expect(db.prepare('PRAGMA table_info(neo_work_resources)').all()).toHaveLength(2);
      expect(new NeoWorkResourceRepository(db).get('unknown')).toBeNull();
    } finally {
      db.close();
    }
  });

  test('missing Neo subsystem is not created', () => {
    const db = new Database(':memory:');
    try {
      runMigration287(db);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'neo_%'").all()).toEqual(
        []
      );
    } finally {
      db.close();
    }
  });

  test('additive migration is idempotent and preserves legacy work fields', () => {
    const db = new Database(':memory:');
    try {
      const { work, queued } = initialize(db);
      db.exec('DROP TABLE neo_work_resources');
      const before = db.prepare('SELECT * FROM neo_work').all();
      runMigration287(db);
      runMigration287(db);
      expect(db.prepare('SELECT * FROM neo_work').all()).toEqual(before);
      expect(work.getWork(queued.id)).toEqual(queued);
      expect(new NeoWorkResourceRepository(db).get(queued.id)).toBeNull();
      expect(db.prepare('PRAGMA table_info(neo_work_resources)').all()).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test('notification fires only after commit and another connection can see work and references together', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neo-resource-commit-'));
    const path = join(directory, 'daemon.db');
    const db = new Database(path);
    const observer = new Database(path);
    try {
      const { queued } = initialize(db);
      let notifications = 0;
      const resources = new NeoWorkResourceRepository(db, () => {
        expect(new NeoRepository(observer).getWork(queued.id)!.status).toBe('reported');
        expect(new NeoWorkResourceRepository(observer).get(queued.id)).toEqual([task]);
        notifications += 1;
      });
      expect(resources.settle(queued, report, [task])!.status).toBe('reported');
      expect(notifications).toBe(1);
    } finally {
      observer.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('full migration runner upgrades and reopens a legacy database with unchanged work and durable references', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neo-resource-upgrade-'));
    const path = join(directory, 'daemon.db');
    const first = new DaemonDatabase(path, { messageSearchIndexFlushIntervalMs: 0 });
    try {
      await first.initialize(createReactiveDatabase(first));
      initialize(first.getDatabase());
      first.getDatabase().exec('DROP TABLE neo_work_resources');
      first
        .getDatabase()
        .prepare('DELETE FROM migration_markers WHERE key = ?')
        .run('migration_287');
    } finally {
      first.close();
    }
    const reopened = new DaemonDatabase(path, { messageSearchIndexFlushIntervalMs: 0 });
    try {
      await reopened.initialize(createReactiveDatabase(reopened));
      const queued = new NeoRepository(reopened.getDatabase()).getWork(proposal.id)!;
      expect(queued).toMatchObject({
        ...proposal,
        status: 'queued',
        sessionId: 'shared-manager',
        report: null,
      });
      expect(
        reopened
          .getDatabase()
          .prepare('SELECT key FROM migration_markers WHERE key = ?')
          .get('migration_287')
      ).toEqual({ key: 'migration_287' });
      expect(reopened.neoWorkResources.get(queued.id)).toBeNull();
      expect(reopened.neoWorkResources.settle(queued, report, [task])!.status).toBe('reported');
    } finally {
      reopened.close();
    }
    const final = new DaemonDatabase(path, { messageSearchIndexFlushIntervalMs: 0 });
    try {
      await final.initialize(createReactiveDatabase(final));
      expect(final.neoWorkResources.get(proposal.id)).toEqual([task]);
      expect(new NeoRepository(final.getDatabase()).getWork(proposal.id)!.report).toBe(
        report.report
      );
    } finally {
      final.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
