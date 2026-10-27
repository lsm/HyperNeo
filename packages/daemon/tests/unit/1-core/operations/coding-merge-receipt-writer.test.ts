import { expect, spyOn, test } from 'bun:test';
import { prepareCodingMerge } from '../../../../src/lib/neo/packs/coding/merge-gates.ts';
import { CodingDeliveryFactsRepository } from '../../../../src/lib/neo/packs/coding/delivery-facts.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
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

for (const readOnly of [false, true]) {
  test(`a closed todo cannot receive a queued merge receipt with ${readOnly ? 'read-only' : 'guarded'} main`, async () => {
    const main = new Database(':memory:');
    const writer = new Database(':memory:');
    for (const db of [main, writer]) {
      createTables(db);
      runMigrations(db, () => {});
      createCodingPackTables(db, 0);
      db.exec(
        "INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at) VALUES('ask','fixture','Merge','Merge',1,1); INSERT INTO neo_todos(id,ask_id,position,title,done_when,state,created_at,updated_at) VALUES('todo','ask',1,'Merge','Deliver','doing',1,1)"
      );
    }
    const gateway = new DbGateway(':memory:', writer);
    bindGateway(main, gateway);
    const fault = readOnly
      ? null
      : spyOn(main, 'prepare').mockImplementation(((sql: string) => {
          throw new Error(`Local merge SQL on main: ${sql}`);
        }) as typeof main.prepare);
    if (readOnly) main.exec('PRAGMA query_only=ON');
    const repo = new CodingDeliveryFactsRepository(main);
    const stored = new CodingDeliveryFactsRepository(writer);
    const input = {
      todoId: 'todo',
      url: 'https://github.com/synthetic/receipt/pull/7',
      head: 'head',
    };
    const gate = {
      url: input.url,
      head: input.head,
      acceptanceContract: 'artifact:contract',
      write: { adapter: 'fixture', id: 'author' },
      qa: { adapter: 'fixture', id: 'qa' },
      reviewer: 'review-bot',
      evidence: ['artifact:qa', 'ci:7'],
    };
    try {
      const state = await repo.mergeLocalCurrent(input);
      expect(state.live).toBe(true);
      writer.prepare("UPDATE neo_todos SET state='done' WHERE id=?").run(input.todoId);
      expect(await repo.recordGateCurrent(input.todoId, gate, { input, state })).toBe(false);
      expect(stored.read(input.todoId, input.url, input.head)).toBeNull();
      writer.prepare("UPDATE neo_todos SET state='doing' WHERE id=?").run(input.todoId);
      expect(await repo.recordGateCurrent(input.todoId, gate, { input, state })).toBe(true);
      expect(stored.read(input.todoId, input.url, input.head)?.gate).toEqual(gate);
    } finally {
      fault?.mockRestore();
      await gateway.close();
      main.close();
      writer.close();
    }
  });
}
