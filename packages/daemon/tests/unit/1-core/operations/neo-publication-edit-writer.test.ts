import { expect, spyOn, test } from 'bun:test';
import { createNeoPublicationChangeOperations } from '../../../../src/lib/neo/publication-change-operation.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { createNeoPublicationTable } from '../../../../src/storage/schema/m288-neo-publications.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const conversation = '10000000-0000-4000-8000-000000009144';
const publicationId = '20000000-0000-4000-8000-000000009144';
const root = { sessionId: `neo:${conversation}`, kind: 'neo' as const, projectId: null };
const original = {
  conversationId: conversation,
  publicationId,
  shortText: 'Original.',
  fullText: 'Original detail.',
  links: [],
};
for (const readOnly of [false, true]) {
  test(`publication revision admits and commits on the bound writer with ${readOnly ? 'read-only' : 'guarded'} main`, async () => {
    const main = new Database(':memory:'),
      writer = new Database(':memory:');
    for (const db of [main, writer]) {
      createNeoPublicationTable(db);
      db.exec(
        'CREATE TABLE neo_session_bindings (session_id TEXT PRIMARY KEY, concern_id TEXT, kind TEXT)'
      );
    }
    writer
      .prepare('INSERT INTO neo_session_bindings VALUES (?, NULL, ?)')
      .run(root.sessionId, 'neo');
    const stored = new NeoPublicationRepository(writer);
    expect(stored.append(original).accepted).toBe(true);
    const gateway = new DbGateway(':memory:', writer);
    bindGateway(main, gateway);
    let queued!: () => void;
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const run = gateway.run.bind(gateway);
    let first = true;
    const pause = spyOn(gateway, 'run').mockImplementation((async (op, args) => {
      if (first && op.name === 'neo.publication.revision') {
        first = false;
        queued();
        await blocked;
      }
      return run(op, args);
    }) as typeof gateway.run);
    const prepare = main.prepare.bind(main);
    const fault = readOnly
      ? null
      : spyOn(main, 'prepare').mockImplementation(((sql: string) => {
          if (/neo_publications|neo_session_bindings/.test(sql))
            throw new Error('Publication admission SQL on main');
          return prepare(sql);
        }) as typeof main.prepare);
    if (readOnly) main.exec('PRAGMA query_only=ON');
    let notified = 0;
    const registry = createOperationRegistry(
      createNeoPublicationChangeOperations({
        getBinding: () => root,
        getRootBinding: () => root,
        publications: new NeoPublicationRepository(main),
        notify: () => {
          expect(stored.get(conversation, publicationId)?.shortText).toBe('Changed.');
          notified++;
        },
      })
    );
    const input = { publicationId, requestId: 'revision-one', shortText: 'Changed.' };
    const call = (change: unknown) =>
      invokeOperation(registry, 'neo.publication.edit', change, {
        source: 'mcp',
        sessionId: root.sessionId,
        role: 'neo',
      });
    try {
      const pending = call(input);
      await waiting;
      await new Promise((resolve) => setTimeout(resolve, 25));
      const releasedAt = Date.now();
      resume();
      const changed = await pending;
      expect(changed).toMatchObject({
        kind: 'completed',
        value: {
          accepted: true,
          publication: { publicationId, shortText: 'Changed.', fullText: original.fullText },
        },
      });
      const receipt =
        changed.kind === 'completed'
          ? (changed.value as { publication: { editedAt: string } })
          : null;
      expect(Date.parse(receipt!.publication.editedAt)).toBeGreaterThanOrEqual(releasedAt);
      expect(await call(input)).toMatchObject({ kind: 'completed', value: { accepted: true } });
      expect(await call({ ...input, shortText: 'Conflicting.' })).toMatchObject({
        kind: 'completed',
        value: { accepted: false, reason: 'publication_conflict' },
      });
      expect(stored.get(conversation, publicationId)?.revisions).toHaveLength(1);
      expect(stored.get(conversation, publicationId)?.revisions?.[0].shortText).toBe('Original.');
      expect(notified).toBe(2);
    } finally {
      resume();
      pause.mockRestore();
      fault?.mockRestore();
      await gateway.close();
      main.close();
      writer.close();
    }
  });
}
