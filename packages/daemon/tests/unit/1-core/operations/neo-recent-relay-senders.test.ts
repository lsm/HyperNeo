import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import { createNeoService } from '../../helpers/neo-service.ts';
import { createNeoRelayOperations } from '../../../../src/lib/neo/relay-answer.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';

const root = 'neo:10000000-0000-4000-8000-000000000001';
const human: OperationCaller = { source: 'rpc', principal: 'local' };
let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
let conversation: string;
const call = (caller = human) =>
  invokeOperation(
    createOperationRegistry(createNeoRelayOperations(service)),
    'neo.relaySenders.recent',
    {},
    caller
  );
function record(
  sender: string,
  minute: number,
  name: string | null = sender,
  to = root,
  kind = 'session',
  id = conversation
) {
  db.getDatabase()
    .prepare(
      `INSERT INTO neo_session_messages(conversation_id,message_id,from_session,from_name,to_session,text,created_at,kind) VALUES(?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      crypto.randomUUID(),
      sender,
      name,
      to,
      'Private message body',
      new Date(1000000 + minute * 60000).toISOString(),
      kind
    );
}
beforeEach(async () => {
  db = await createTestDb();
  await db.createSession(createTestSession(root));
  service = createNeoService(
    db,
    {} as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus()
  );
  service.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  conversation = service.repo.conversationId()!;
});
afterEach(() => {
  service.dispose();
  db.close();
});

test('returns the ten most recent distinct inbound local senders with their latest recorded names', async () => {
  for (let i = 1; i <= 15; i++) record(`sender-${i}`, i, `Name ${i}`);
  record('sender-3', 50, 'Latest name');
  record('sender-3', 50, 'Latest tied name');
  record(root, 99, 'Neo', 'outbound-recipient');
  record('wrong-target', 99, 'Wrong', 'other-session');
  record('old-conversation', 99, 'Old', root, 'session', '10000000-0000-4000-8000-000000000099');
  record('system:worker-batch', 99, 'Batch', root, 'worker-batch');
  record('daemon:remote::session:worker', 99, 'Remote');
  const result = await call();
  expect(result).toMatchObject({ kind: 'completed' });
  if (result.kind !== 'completed') throw new Error(result.message);
  const rows = (
    result.value as { senders: { sender: string; name: string; lastMessageAt: string }[] }
  ).senders;
  expect(rows.map((r) => r.sender)).toEqual([
    'sender-3',
    ...Array.from({ length: 9 }, (_, i) => `sender-${15 - i}`),
  ]);
  expect(rows[0]).toEqual({
    sender: 'sender-3',
    name: 'Latest tied name',
    lastMessageAt: new Date(1000000 + 50 * 60000).toISOString(),
  });
  expect(rows.every((r) => Object.keys(r).sort().join(',') === 'lastMessageAt,name,sender')).toBe(
    true
  );
  expect(JSON.stringify(result)).not.toContain('Private message body');
});
test('uses the exact sender ref when a recorded name is missing', async () => {
  record('codex-desktop:synthetic-thread', 1, null);
  expect(await call()).toMatchObject({
    value: {
      senders: [
        { sender: 'codex-desktop:synthetic-thread', name: 'codex-desktop:synthetic-thread' },
      ],
    },
  });
});
test('reading an empty or uninitialized conversation creates no records or settings', async () => {
  db.getDatabase().exec('DELETE FROM neo_conversation');
  const changes = db.getDatabase().prepare('SELECT total_changes() AS n').get();
  const settings = db.getGlobalSettings();
  expect(await call()).toEqual({ kind: 'completed', value: { senders: [] } });
  expect(db.getDatabase().prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  expect(db.getGlobalSettings()).toEqual(settings);
});
test('MCP, session-door and remote RPC callers cannot read sender candidates', async () => {
  record('sender', 1);
  for (const caller of [
    { source: 'mcp', role: 'neo', sessionId: root },
    { source: 'mcp', principal: 'session-door', sessionId: 'worker' },
    { source: 'rpc', principal: 'remote' },
  ] as OperationCaller[]) {
    expect(await call(caller)).toMatchObject({ kind: 'failed', code: 'forbidden' });
  }
});
