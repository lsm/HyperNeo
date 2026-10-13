import { describe, expect, test } from 'bun:test';
import { runMigration358 } from '../../../../src/storage/schema/m358-neo-ask-revisions';
import { Database } from '../../../../src/storage/sqlite-compat';
import { NeoAskRepository } from '../../../../src/storage/repositories/neo-ask-repository';

describe('runMigration358', () => {
  test('backfills revisions without grandfathering approval or evidence', () => {
    const db = new Database(':memory:');
    try {
      db.exec(
        "CREATE TABLE neo_asks (id TEXT PRIMARY KEY, approved_at INTEGER); INSERT INTO neo_asks VALUES ('a', 123)"
      );
      db.exec(
        "CREATE TABLE neo_ask_items (id TEXT PRIMARY KEY, state TEXT, evidence TEXT); INSERT INTO neo_ask_items VALUES ('i', 'met', 'worker says done')"
      );
      runMigration358(db);
      runMigration358(db);
      expect(
        db.prepare('SELECT revision, approved_revision, approved_at FROM neo_asks').get()
      ).toEqual({ revision: 0, approved_revision: null, approved_at: 123 });
      expect(
        db.prepare('SELECT state, evidence, verified_definition_hash FROM neo_ask_items').get()
      ).toEqual({ state: 'met', evidence: 'worker says done', verified_definition_hash: null });
      expect(() => db.exec('UPDATE neo_asks SET revision = -1')).toThrow();
    } finally {
      db.close();
    }
  });
  test('skips absent tables', () => {
    const db = new Database(':memory:');
    try {
      expect(() => runMigration358(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('NeoAskRepository revisionPolicy', () => {
  const db = new Database(':memory:');
  const policy = new NeoAskRepository(db).revisionPolicy;
  db.close();
  const item = {
    id: 'i',
    text: 'Ship outcome',
    check: 'coding.pr_merged',
    watch: ['repo#2', 'repo#1'],
    deliveredBy: 'card',
  };
  const plan = {
    items: [item],
    cards: [{ id: 'card', scope: 'original scope', dependsOn: ['first'] }],
  };

  test('canonical hashes ignore watch order/duplicates and nondefinition fields', () => {
    expect(policy.definitionHash(item)).toBe(
      policy.definitionHash({ ...item, watch: ['repo#1', 'repo#2', 'repo#1'] })
    );
    expect(policy.definitionHash(item)).not.toBe(
      policy.definitionHash({ ...item, text: 'Other outcome' })
    );
    expect(policy.definitionHash(item)).not.toBe(policy.definitionHash({ ...item, check: null }));
    expect(policy.definitionHash(item)).not.toBe(policy.definitionHash({ ...item, watch: [] }));
  });

  test('a no-op does not invalidate approval', () => {
    expect(
      policy.planRevision(3, plan, {
        ...plan,
        items: [{ ...item, watch: [...item.watch].reverse() }],
      })
    ).toEqual({ revision: 3, invalidateApproval: false, invalidateItemIds: [] });
  });

  test('binding and definition edits invalidate that item and approval', () => {
    for (const change of [
      { deliveredBy: 'other' },
      { text: 'Changed' },
      { check: null },
      { removed: true },
    ]) {
      expect(policy.planRevision(3, plan, { ...plan, items: [{ ...item, ...change }] })).toEqual({
        revision: 4,
        invalidateApproval: true,
        invalidateItemIds: ['i'],
      });
    }
  });

  test('edge and scope edits invalidate approval while preserving unchanged evidence', () => {
    for (const change of [{ dependsOn: ['first', 'second'] }, { scope: 'new scope' }]) {
      expect(
        policy.planRevision(3, plan, { ...plan, cards: [{ ...plan.cards[0], ...change }] })
      ).toEqual({ revision: 4, invalidateApproval: true, invalidateItemIds: [] });
    }
    expect(policy.planRevision(3, plan, { ...plan, items: [] }).invalidateApproval).toBe(true);
  });

  test('missing legacy hashes and stale definitions never match evidence', () => {
    expect(policy.matchesVerifiedDefinition(item, null)).toBe(false);
    const stored = policy.definitionHash(item);
    expect(policy.matchesVerifiedDefinition(item, stored)).toBe(true);
    expect(policy.matchesVerifiedDefinition({ ...item, text: 'new contract' }, stored)).toBe(false);
  });

  test('new items require verification without invalidating unchanged items', () => {
    expect(
      policy.planRevision(2, plan, { ...plan, items: [...plan.items, { ...item, id: 'new' }] })
    ).toEqual({ revision: 3, invalidateApproval: true, invalidateItemIds: ['new'] });
    expect(() => policy.planRevision(-1, plan, plan)).toThrow('invalid_ask_revision');
  });
});
