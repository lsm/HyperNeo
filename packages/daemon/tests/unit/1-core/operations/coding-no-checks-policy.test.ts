import { describe, expect, test } from 'bun:test';
import {
  decideCodingHumanHandoff,
  decideCodingDaemonMerge,
} from '../../../../src/lib/neo/packs/coding/daemon-merge-gates.ts';
import {
  CodingPrLedgerRepository,
  codingPrState,
  Node,
} from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';

const head = 'a'.repeat(40);
const facts = {
  ok: true as const,
  head,
  state: 'OPEN',
  draft: false,
  mergeable: 'MERGEABLE',
  passingCommitStatus: true,
  requiredCi: { head, green: true, count: 0 },
  threads: { head, unresolved: 0 },
  reviews: [],
  files: ['README.md'],
  labels: [],
};
const policy = { mergeBy: 'daemon' as const, mergePolicy: 'ci_only' as const };
const pr = Node.parse({
  number: 1,
  title: 'Ready',
  headRefName: 'work',
  headRefOid: head,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  closedAt: null,
  files: { nodes: [{ path: 'README.md' }], pageInfo: { hasNextPage: false } },
  labels: { nodes: [], pageInfo: { hasNextPage: false } },
  commits: { nodes: [{ commit: { statusCheckRollup: null, checkSuites: { totalCount: 0 } } }] },
});

describe('zero-check merge policy', () => {
  test('hands CI-only zero-check work to the human without an opt-in', () => {
    expect(decideCodingDaemonMerge(facts, policy).kind).toBe('needs_human_signoff');
    expect(codingPrState(pr, false, policy)).toBe('waiting_human');
  });
  test('unknown check counts stay unreadable even with an opt-in', () => {
    for (const count of [NaN, -1, undefined]) {
      expect(
        decideCodingDaemonMerge(
          { ...facts, requiredCi: { ...facts.requiredCi, count: count as number } },
          { ...policy, allowNoChecksMerge: true }
        ).kind
      ).toBe('read_failure');
    }
  });
  test('allows an explicit opt-in without overriding other gates', () => {
    const opted = { ...policy, allowNoChecksMerge: true };
    expect(decideCodingDaemonMerge(facts, opted).kind).toBe('merge');
    expect(codingPrState(pr, false, opted)).toBe('approved_green');
    for (const changed of [
      { ...facts, requiredCi: { ...facts.requiredCi, green: false } },
      { ...facts, threads: { head, unresolved: 1 } },
      { ...facts, labels: ['human-merge'] },
    ])
      expect(
        decideCodingDaemonMerge(changed, { ...opted, humanSignoff: ['label:human-merge'] }).kind
      ).not.toBe('merge');
    expect(decideCodingDaemonMerge(facts, { ...opted, mergePolicy: 'human' }).kind).not.toBe(
      'merge'
    );
    expect(decideCodingDaemonMerge(facts, { ...opted, mergePolicy: 'review_bot' }).kind).not.toBe(
      'merge'
    );
  });
  test('an opt-in cannot replace a missing policy or human policy', () => {
    for (const mergePolicy of [undefined, 'human', 'review_bot'] as const) {
      expect(decideCodingHumanHandoff(facts, { mergePolicy, allowNoChecksMerge: true }, head)).toBe(
        true
      );
    }
  });
  test('a configured bot must actually approve the current head', () => {
    const bot = { ...policy, mergePolicy: 'review_bot' as const, reviewBot: 'bot' };
    expect(
      decideCodingDaemonMerge(
        { ...facts, reviews: [{ login: 'bot', head, state: 'APPROVED' }] },
        bot
      ).kind
    ).toBe('merge');
    expect(
      decideCodingDaemonMerge(
        { ...facts, reviews: [{ login: 'bot', head: 'b'.repeat(40), state: 'APPROVED' }] },
        bot
      ).kind
    ).not.toBe('merge');
    expect(decideCodingDaemonMerge(facts, { ...policy, reviewBot: 'bot' }).kind).toBe(
      'needs_human_signoff'
    );
  });
  test('only an exact repository opt-in counts; global defaults do not authorize it', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, () => {});
      createTables(db);
      createCodingPackTables(db);
      const save = (scope: string, key: string, value: boolean) =>
        db
          .prepare(
            "INSERT INTO neo_pack_preferences VALUES ('coding', ?, ?, 'allowNoChecksMerge', ?, 'human', 1)"
          )
          .run(scope, key, JSON.stringify(value));
      const ledger = new CodingPrLedgerRepository(db);
      expect(ledger.policy('synthetic/project')).toMatchObject({ allowNoChecksMerge: false });
      save('global', '', true);
      expect(ledger.policy('synthetic/project')).toMatchObject({ allowNoChecksMerge: false });
      save('repo', 'Synthetic/Project', true);
      expect(ledger.policy('synthetic/project')).toMatchObject({ allowNoChecksMerge: true });
      expect(ledger.policy('synthetic/other')).toMatchObject({ allowNoChecksMerge: false });
    } finally {
      db.close();
    }
  });
});
