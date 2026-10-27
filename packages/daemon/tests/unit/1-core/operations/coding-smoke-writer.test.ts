import { expect, spyOn, test } from 'bun:test';
import { CodingAssignmentsRepository } from '../../../../src/lib/neo/packs/coding/assignments.ts';
import {
  CodingDeliveryFactsRepository,
  recordCodingSmoke,
} from '../../../../src/lib/neo/packs/coding/delivery-facts.ts';
import { createCodingSmokeOperation } from '../../../../src/lib/neo/packs/coding/smoke-operation.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

for (const readOnly of [false, true]) {
  test(`smoke admission reads and records on the writer with ${readOnly ? 'read-only' : 'guarded'} main`, async () => {
    const main = new Database(':memory:'),
      writer = new Database(':memory:');
    for (const db of [main, writer]) {
      db.exec(
        `CREATE TABLE neo_todos(id TEXT PRIMARY KEY);INSERT INTO neo_todos VALUES('todo');CREATE TABLE pack_facts(todo_id TEXT,pack TEXT,key TEXT,value_json TEXT,PRIMARY KEY(todo_id,pack,key))`
      );
      createCodingPackTables(db, 0);
    }
    const url = 'https://github.com/synthetic/smoke/pull/7',
      head = 'head';
    const write = { adapter: 'fixture', id: 'author' },
      ref = { adapter: 'fixture', id: 'qa' };
    const actor = {
      kind: 'agent' as const,
      id: ref.id,
      harness: ref.adapter,
      model: 'synthetic-model',
    };
    const smoke = {
      actor,
      ref,
      verdict: 'pass' as const,
      mergeCommit: 'merge',
      build: { daemon: 'target', commit: 'build' },
      evidence: ['artifact:smoke'],
    };
    const gate = {
      url,
      head,
      acceptanceContract: 'artifact:contract',
      write,
      qa: ref,
      reviewer: 'bot',
      evidence: ['artifact:qa'],
    };
    const assignments = new CodingAssignmentsRepository(writer),
      stored = new CodingDeliveryFactsRepository(writer);
    writer.prepare('INSERT INTO pack_coding_stage_heads VALUES(?,?,?)').run(url, 1, head);
    const base = {
      url,
      head,
      acceptanceContract: gate.acceptanceContract,
      newDispatch: true as const,
      write,
    };
    expect(assignments.record('todo', 'review', { ...base, bot: 'bot' })).toBe(true);
    expect(assignments.record('todo', 'qa', { ...base, ref, actor })).toBe(true);
    stored.recordGate('todo', gate);
    const gateway = new DbGateway(':memory:', writer);
    bindGateway(main, gateway);
    const prepare = main.prepare.bind(main),
      fault = readOnly
        ? null
        : spyOn(main, 'prepare').mockImplementation(((sql: string) => {
            if (/pack_facts|pack_coding_delivery_facts/.test(sql))
              throw new Error('Smoke admission SQL on main');
            return prepare(sql);
          }) as typeof main.prepare);
    if (readOnly) main.exec('PRAGMA query_only=ON');
    const repo = new CodingDeliveryFactsRepository(main);
    const deploys = {
      prs: [{ url, head, mergeCommit: 'merge' }],
      daemons: [{ daemon: 'target', commit: 'build', contains: ['merge'] }],
    };
    let reads = 0,
      revoke = false;
    const operation = createCodingSmokeOperation(
      repo,
      new CodingAssignmentsRepository(main),
      async () => {
        reads++;
        if (revoke) writer.prepare("DELETE FROM pack_facts WHERE key LIKE '%:qa'").run();
        return deploys;
      }
    );
    const call = (value = smoke) =>
      operation.execute(
        { todoId: 'todo', url, head, smoke: value },
        { source: 'rpc', principal: 'local' }
      );
    try {
      expect(await call()).toEqual({ accepted: true });
      expect(reads).toBe(1);
      expect(stored.read('todo', url, head)?.smoke).toEqual(smoke);
      expect(
        await recordCodingSmoke(repo, 'todo', url, head, { ...smoke, verdict: 'fail' }, deploys)
      ).toEqual({ accepted: true });
      expect(stored.read('todo', url, head)?.smoke?.verdict).toBe('fail');
      revoke = true;
      expect(await call()).toEqual({ accepted: false, reason: 'stage_assignment_mismatch' });
      expect(reads).toBe(2);
      expect(stored.read('todo', url, head)?.smoke?.verdict).toBe('fail');
      expect(await call()).toEqual({ accepted: false, reason: 'stage_assignment_mismatch' });
      expect(reads).toBe(2);
    } finally {
      fault?.mockRestore();
      await gateway.close();
      main.close();
      writer.close();
    }
  });
}
