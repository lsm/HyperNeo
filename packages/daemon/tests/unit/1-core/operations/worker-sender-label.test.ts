import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createDatabaseOperationCatalog } from '../../../../src/lib/operations/database-catalog.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => {
  db = await createTestDb();
  db.createSession(createTestSession('synthetic-recipient'));
});
afterEach(() => db.close());

test('a missing native Neo sender retains its whole ID and native adapter in the queued header', async () => {
  const result = await invokeOperation(
    createDatabaseOperationCatalog(db),
    'message.send',
    {
      sessionId: 'synthetic-recipient',
      from: 'session:neo:deleted-sender',
      message: {
        type: 'user',
        message: { content: 'Synthetic missing sender report' },
        parent_tool_use_id: null,
      },
    },
    { source: 'rpc', principal: 'local' }
  );
  expect(result).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
  const queued = db
    .getDatabase()
    .prepare("SELECT payload FROM job_queue WHERE queue = 'mailbox'")
    .all() as { payload: string }[];
  const text = queued.map((row) => row.payload).join('\n');
  expect(text).toContain('HyperNeo · neo:deleted-sender');
  expect(text).not.toContain('neo · deleted-sender');
});
