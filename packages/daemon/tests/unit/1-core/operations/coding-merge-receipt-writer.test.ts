import { expect, spyOn, test } from 'bun:test';
import { prepareCodingMerge } from '../../../../src/lib/neo/packs/coding/merge-gates.ts';
import { CodingDeliveryFactsRepository } from '../../../../src/lib/neo/packs/coding/delivery-facts.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

for (const readOnly of [false, true]) {
  test(`manual merge receipt records and validates on the writer with ${readOnly ? 'read-only' : 'guarded'} main`, async () => {
    const main = new Database(':memory:'),
      writer = new Database(':memory:');
    for (const db of [main, writer]) {
      db.exec('CREATE TABLE neo_todos(id TEXT PRIMARY KEY)');
      db.prepare('INSERT INTO neo_todos VALUES (?)').run('todo');
      createCodingPackTables(db, 0);
    }
    const gateway = new DbGateway(':memory:', writer);
    bindGateway(main, gateway);
    const prepare = main.prepare.bind(main),
      fault = readOnly
        ? null
        : spyOn(main, 'prepare').mockImplementation(((sql: string) => {
            if (/pack_coding_delivery_facts/.test(sql))
              throw new Error('Merge receipt SQL on main');
            return prepare(sql);
          }) as typeof main.prepare);
    if (readOnly) main.exec('PRAGMA query_only=ON');
    const repo = new CodingDeliveryFactsRepository(main),
      stored = new CodingDeliveryFactsRepository(writer);
    const candidate = {
      url: 'https://github.com/synthetic/receipt/pull/7',
      head: 'head',
      open: true,
      requiredCiGreen: true,
      findingsResolved: true,
      humanSignoffSatisfied: true,
      ciEvidence: ['ci:7'],
      reviewEvidence: ['review:7'],
    };
    const write = { adapter: 'fixture', id: 'author' };
    const invoke = (id: string) => {
      const ref = { adapter: 'fixture', id };
      return prepareCodingMerge(
        repo,
        'todo',
        candidate,
        { reference: 'artifact:contract', write, qa: ref, bot: 'review-bot' },
        { kind: 'bot', head: 'head', login: 'review-bot', approved: true },
        [
          {
            url: candidate.url,
            head: candidate.head,
            stage: 'qa',
            ref,
            actor: { kind: 'agent', id, harness: 'fixture', model: 'synthetic-model' },
            verdict: 'pass',
            acceptanceContract: 'artifact:contract',
            evidence: ['artifact:qa'],
          },
        ],
        async () => candidate.head
      );
    };
    try {
      const results = await Promise.all([invoke('qa-one'), invoke('qa-two')]);
      expect(results.filter((r) => r.accepted)).toHaveLength(1);
      expect(results).toContainEqual({ accepted: false, reason: 'merge_receipt_changed' });
      const winner = stored.read('todo', candidate.url, candidate.head)!.gate.qa.id;
      expect((await invoke(winner)).accepted).toBe(true);
      expect(stored.read('todo', candidate.url, candidate.head)?.gate.qa.id).toBe(winner);
    } finally {
      fault?.mockRestore();
      await gateway.close();
      main.close();
      writer.close();
    }
  });
}
