import { expect, spyOn, test } from 'bun:test';
import { createNeoPublicationReadOperation } from '../../../../src/lib/neo/publication-read-operation.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration288 } from '../../../../src/storage/schema/m288-neo-publications.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const conversationId = '10000000-0000-4000-8000-000000009241';
const root = `neo:${conversationId}`;
const page = { conversationId, after: 0, limit: 50 };
const human = { source: 'rpc' as const, principal: 'local' as const };
function seed(db: Database) {
  createNeoTables(db);
  runMigration288(db);
  const repo = new NeoRepository(db);
  repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const ledger = new NeoPublicationRepository(db);
  const result = ledger.append({
    conversationId,
    publicationId: '20000000-0000-4000-8000-000000009241',
    fullText: 'Stored 甲🙂\n'.repeat(1000),
    verbatim: true,
    links: [],
  });
  if (!result.accepted) throw new Error('Synthetic publication was not stored');
  return { repo, ledger, publication: result.publication };
}

test('a corrupt publication cannot leave a partially initialized public conversation', async () => {
  const db = new Database(':memory:');
  try {
    const { ledger } = seed(db);
    db.prepare('UPDATE neo_publications SET payload_json=?').run('{}');
    await expect(createNeoPublicationReadOperation(ledger).execute(page, human)).rejects.toThrow(
      'Invalid stored Neo publication'
    );
    expect(db.prepare('SELECT id FROM neo_conversation').get()).toBeNull();
  } finally {
    db.close();
  }
});

test('public pages initialize and read from the gateway while main rejects SQL', async () => {
  const main = new Database(':memory:'),
    writer = new Database(':memory:');
  const { publication } = seed(writer);
  const gateway = new DbGateway(':memory:', writer);
  bindGateway(main, gateway);
  const prepare = spyOn(main, 'prepare').mockImplementation(((sql: string) => {
    throw new Error(`Publication SQL on main: ${sql}`);
  }) as typeof main.prepare);
  try {
    const operation = createNeoPublicationReadOperation(new NeoPublicationRepository(main));
    const replies = await Promise.all([
      operation.execute(page, human),
      operation.execute(page, human),
    ]);
    for (const reply of replies)
      expect(reply).toEqual({
        ok: true,
        conversationId,
        items: [publication],
        nextAfter: publication.sequence,
      });
    expect(writer.prepare('SELECT id FROM neo_conversation').all()).toEqual([
      { id: conversationId },
    ]);
    expect(
      await operation.execute(
        { ...page, conversationId: '30000000-0000-4000-8000-000000009241' },
        human
      )
    ).toEqual({ ok: false, reason: 'conversation_not_found' });
  } finally {
    prepare.mockRestore();
    await gateway.close();
    main.close();
    writer.close();
  }
});
