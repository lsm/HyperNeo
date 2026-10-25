import { describe, test, expect } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import {
  CodingPrLedgerRepository,
  reconcileCodingPrLedger,
} from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { CodingStageFact } from '../../../../src/lib/neo/packs/coding/stage-facts.ts';

const url = 'https://github.com/synthetic/stages/pull/7';
const reviewer = {
  kind: 'agent',
  id: 'reviewer-1',
  model: 'claude-opus-5-5',
  harness: 'Harness B',
} as const;
const fact: CodingStageFact = {
  url,
  head: 'head-a',
  stage: 'review',
  actor: reviewer,
  verdict: 'pass',
  acceptanceContract: 'artifact:acceptance-7',
  evidence: ['https://ci.example/run/7'],
};
function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  db.exec(
    "INSERT INTO neo_asks (id, session_id, title, request, created_at, updated_at) VALUES ('ask-7', 'synthetic', 'Stages', 'Stages', 1, 1)"
  );
  return { db, ledger: new CodingPrLedgerRepository(db), todos: new CodingTodoPrRepository(db) };
}
const row = (head: string) => ({
  repo: 'synthetic/stages',
  number: 7,
  title: 'Stage facts',
  branch: 'stages',
  head,
  state: 'waiting_human' as const,
  closedAt: null,
});

describe('coding stage facts', () => {
  test('shares both stage outcomes with the todo and invalidates them on a ledger push', () => {
    const { db, ledger, todos } = setup();
    try {
      db.prepare(
        "INSERT INTO neo_todos (id, ask_id, position, title, done_when, state, created_at, updated_at) VALUES ('todo-7', 'ask-7', 1, 'Stages', 'Merged', 'doing', 1, 1)"
      ).run();
      todos.claim('todo-7', [{ url, claim: 'named' }], 1);
      expect(ledger.recordStage(fact)).toBe(false);
      ledger.replace('synthetic/stages', [row('head-a')], 1);
      expect(ledger.recordStage(fact)).toBe(true);
      expect(ledger.recordStage({ ...fact, stage: 'qa', verdict: 'inconclusive' })).toBe(true);
      expect(todos.stages('todo-7')).toHaveLength(2);
      ledger.replace('synthetic/stages', [row('head-a')], 2);
      expect(ledger.stageFacts.read(url)).toHaveLength(2);
      ledger.replace('synthetic/stages', [row('head-b')], 3);
      todos.record(
        'todo-7',
        [{ url, head: 'head-a', state: 'OPEN', checks: 'passing', review: 'none' }],
        2
      );
      expect(todos.stages('todo-7')).toEqual([]);
      expect(ledger.recordStage(fact)).toBe(false);
      ledger.replace('synthetic/stages', [row('head-a')], 4);
      expect(ledger.stageFacts.read(url)).toEqual([]);
    } finally {
      db.close();
    }
  });
  test('a todo PR read also invalidates review and QA; missing evidence is refused', () => {
    const { db, ledger, todos } = setup();
    try {
      db.prepare(
        "INSERT INTO neo_todos (id, ask_id, position, title, done_when, state, created_at, updated_at) VALUES ('todo-7', 'ask-7', 1, 'Stages', 'Merged', 'doing', 1, 1)"
      ).run();
      ledger.replace('synthetic/stages', [row('head-a')], 1);
      ledger.recordStage(fact);
      ledger.recordStage({ ...fact, stage: 'qa', verdict: 'fail' });
      todos.record(
        'todo-7',
        [{ url, head: 'head-b', state: 'OPEN', checks: 'passing', review: 'none' }],
        2
      );
      expect(ledger.stageFacts.read(url)).toEqual([]);
      expect(() => ledger.recordStage({ ...fact, head: 'head-b', evidence: [] })).toThrow();
      expect(ledger.recordStage({ ...fact, head: 'head-b', verdict: 'fail' })).toBe(true);
      ledger.replace('synthetic/stages', [row('head-a')], 1);
      expect(ledger.recordStage(fact)).toBe(false);
      expect(ledger.recordStage({ ...fact, head: 'head-b', verdict: 'pass' })).toBe(false);
      expect(ledger.stageFacts.read(url)[0].verdict).toBe('fail');
      ledger.replace('synthetic/stages', [row('head-c')], 2);
      expect(ledger.stageFacts.read(url)).toEqual([]);
      expect(ledger.recordStage({ ...fact, head: 'head-b' })).toBe(false);
      expect(ledger.recordStage({ ...fact, head: 'head-c' })).toBe(false);
      ledger.replace('synthetic/stages', [row('head-c')], 3);
      expect(ledger.recordStage({ ...fact, head: 'head-c' })).toBe(true);
      ledger.dropRepo('synthetic/stages');
      expect(ledger.stageFacts.read(url)).toEqual([]);
      expect(ledger.recordStage({ ...fact, head: 'head-b' })).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('coding provenance policy', () => {
  test('requires an exact id and effort for independent review', () => {
    const { db, ledger } = setup();
    try {
      const body = 'Agent: gpt-6.1-sol (effort: high) via Codex';
      expect(ledger.reviewerPolicy('synthetic/stages', body, reviewer)).toMatchObject({
        qualifies: true,
        preferred: true,
      });
      expect(
        ledger.reviewerPolicy('synthetic/stages', body, {
          ...reviewer,
          model: 'openai/gpt-6.1',
        })
      ).toMatchObject({ qualifies: false, reason: 'same_model' });
      for (const line of [
        'Agent: GPT-6 via Codex',
        'Agent: gpt-6.1-sol via Codex',
        'Agent: GPT-6 (effort: high) via Codex',
        'Agent: gpt-6.1-sol (effort: unknown) via Codex',
      ])
        expect(ledger.reviewerPolicy('synthetic/stages', line, reviewer).reason).toContain(
          'ask the author'
        );
    } finally {
      db.close();
    }
  });
  test('defaults on without saving, requires different model, prefers different harness, allows human', () => {
    const { db, ledger } = setup();
    try {
      const body = 'Agent: gpt-6-sol (effort: high) via Harness A';
      expect(ledger.reviewerPolicy('synthetic/stages', body, reviewer)).toMatchObject({
        qualifies: true,
        preferred: true,
      });
      expect(
        ledger.reviewerPolicy(
          'synthetic/stages',
          'Author: gpt-6-sol (effort: high) via Harness A',
          reviewer
        )
      ).toMatchObject({ qualifies: true, preferred: true });
      expect(
        ledger.reviewerPolicy('synthetic/stages', body, { ...reviewer, harness: 'Harness A' })
      ).toMatchObject({ qualifies: true, preferred: false });
      expect(
        ledger.reviewerPolicy('synthetic/stages', body, { ...reviewer, model: ' GPT-6 ' })
      ).toMatchObject({ qualifies: false });
      expect(
        ledger.reviewerPolicy('synthetic/stages', body, { kind: 'human', id: 'person' })
      ).toMatchObject({ qualifies: true });
      for (const invalid of [
        '',
        'Author: gpt-6-sol (effort: high) via Harness A\n' + body,
        'Agent: <model> via <harness>',
        body + '\n' + body,
        'Agent: A via B via C',
        '```\n' + body + '\n```',
        'Agent:   via B',
      ]) {
        expect(ledger.reviewerPolicy('synthetic/stages', invalid, reviewer)).toMatchObject({
          qualifies: false,
        });
      }
      for (const [author, model] of [
        ['gpt-6-sol', 'gpt-6-2026-09'],
        ['gpt-6-sol', 'openai/gpt-6'],
        ['gpt-6-sol', 'gpt 6'],
        ['gpt-6-sol', 'gpt-6.0'],
        ['claude-opus-5-5', 'claude-opus-5-5[1m]'],
        ['claude-fable-5-1', 'claude-fable-5-1'],
        ['claude-opus-5-5', 'claude-opus-5-5'],
        ['gpt-6-sol', 'unidentified-model'],
        ['unidentified-model', 'claude-opus-5-5'],
      ])
        expect(
          ledger.reviewerPolicy('synthetic/stages', `Agent: ${author} (effort: high) via A`, {
            ...reviewer,
            model,
          })
        ).toMatchObject({ qualifies: false });
      for (const model of [
        'claude-fable-5-1',
        'Claude Fable 5.1',
        'Opus 5.5',
        'claude-opus-5-5[1m]',
      ])
        expect(
          ledger.reviewerPolicy('synthetic/stages', body, { ...reviewer, model })
        ).toMatchObject({ qualifies: true });
      expect(db.prepare('SELECT * FROM neo_pack_preferences').all()).toEqual([]);
      db.prepare(
        "INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at) VALUES ('coding', 'repo', 'synthetic/stages', 'provenance', 'false', 'human', 1)"
      ).run();
      expect(ledger.reviewerPolicy('SYNTHETIC/STAGES', '', reviewer)).toMatchObject({
        qualifies: true,
        reason: 'disabled',
      });
    } finally {
      db.close();
    }
  });
});

describe('provenance preference answers', () => {
  test.each(['button', 'chat'] as const)(
    'a human %s no leaves provenance unanswered and on',
    (by) => {
      const { db, ledger } = setup();
      try {
        const store = new NeoAskTodoRepository(db);
        const question = store.askQuestion(
          'q',
          'ask-7',
          {
            text: 'Apply these settings?',
            kind: 'yesno',
            options: null,
            multiple: false,
            noLabel: 'Keep current settings',
            yesLabel: 'Apply these settings',
            startTodos: null,
          },
          1
        );
        const values = [
          {
            pack: 'coding',
            scope: { kind: 'repo', key: 'synthetic/stages' },
            key: 'provenance',
            value: true,
          },
          {
            pack: 'coding',
            scope: { kind: 'repo', key: 'synthetic/stages' },
            key: 'mergePolicy',
            value: 'ci_only',
          },
        ];
        db.prepare(
          'INSERT INTO neo_pack_preference_proposals (question_id, request_id, values_json, question_text) VALUES (?, ?, ?, ?)'
        ).run('q', 'request', JSON.stringify(values), question.text);
        expect(store.answerQuestion(question, 'no', by, 2)?.state).toBe('answered');
        expect(db.prepare('SELECT * FROM neo_pack_preferences').all()).toEqual([]);
        expect(ledger.reviewerPolicy('synthetic/stages', '', reviewer).qualifies).toBe(false);
      } finally {
        db.close();
      }
    }
  );
});

describe('per-repository stage head observations', () => {
  test('a second repo read supersedes a todo read started during the first repo read', async () => {
    const { db, ledger } = setup();
    const originalNow = Date.now;
    let clock = 100;
    Date.now = () => clock;
    try {
      await reconcileCodingPrLedger(
        ledger,
        ['synthetic/first', 'synthetic/stages'],
        async (repo) => {
          if (repo === 'synthetic/first') {
            ledger.stageFacts.observeHead(url, 'head-a', 150);
            clock = 200;
          }
          return {
            data: {
              rateLimit: { remaining: 4000 },
              repository: {
                nameWithOwner: repo,
                open: {
                  pageInfo: { hasNextPage: false },
                  nodes:
                    repo === 'synthetic/stages'
                      ? [
                          {
                            number: 7,
                            title: 'Stages',
                            headRefName: 'stages',
                            headRefOid: 'head-b',
                            state: 'OPEN',
                            isDraft: false,
                            mergeable: 'MERGEABLE',
                            reviewDecision: null,
                            closedAt: null,
                          },
                        ]
                      : [],
                },
                done: { nodes: [] },
              },
            },
          };
        },
        100
      );
      expect(ledger.recordStage(fact)).toBe(false);
      expect(ledger.recordStage({ ...fact, head: 'head-b' })).toBe(true);
    } finally {
      Date.now = originalNow;
      db.close();
    }
  });
});
