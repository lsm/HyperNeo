import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageHub } from '@hyperneo/shared';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
let directory: string;
let previous: string | undefined;
const root = 'neo:10000000-0000-4000-8000-000000000003';
let caller: OperationCaller;
type PairResult = {
  accepted: boolean;
  id: string;
  code: string;
  expiresAt: number;
  reason?: string;
  peers: { id: string; name: string }[];
};
const call = async (name: string, input: unknown, as = caller) => {
  const result = await invokeOperation(
    createOperationRegistry(createNeoOperations(service)),
    name,
    input,
    as
  );
  if (result.kind !== 'completed') throw new Error(`${name}: ${result.code}: ${result.message}`);
  return result.value as PairResult;
};
beforeEach(async () => {
  previous = process.env.HYPERNEO_DATA_DIR;
  directory = mkdtempSync(join(tmpdir(), 'neo-peer-test-'));
  process.env.HYPERNEO_DATA_DIR = directory;
  db = await createTestDb();
  await db.createSession(createTestSession(root));
  service = createNeoService(
    db,
    {} as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  service.deliverForward = async () => {};
  service.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const messageId = crypto.randomUUID();
  await call(
    'neo.message.send',
    { sessionId: root, requestId: messageId, content: 'Allow Contact A to send me messages.' },
    { source: 'rpc', principal: 'local' }
  );
  db.getSDKMessageRepo().markDeliveryConsumedByUuid(root, messageId);
  caller = { source: 'mcp', role: 'neo', sessionId: root, consumedInputId: messageId };
});
afterEach(async () => {
  mock.restore();
  await service.dispose();
  db.close();
  if (previous === undefined) delete process.env.HYPERNEO_DATA_DIR;
  else process.env.HYPERNEO_DATA_DIR = previous;
  rmSync(directory, { recursive: true, force: true });
});

test('Neo invites a named peer from a consumed human request without granting a device', async () => {
  const before = db.getDatabase().prepare('SELECT count(*) AS n FROM paired_devices').get();
  const invited = await call('neo.peer.invite', { name: 'Contact A' });
  expect(invited.accepted).toBe(true);
  expect(typeof invited.id).toBe('string');
  expect(typeof invited.code).toBe('string');
  expect(invited!.expiresAt - Date.now()).toBeGreaterThan(590_000);
  expect(await call('neo.peer.list', {})).toMatchObject({
    accepted: true,
    peers: [{ id: invited!.id, name: 'Contact A' }],
  });
  const row = db.getDatabase().prepare('SELECT * FROM neo_peers').get();
  expect(JSON.stringify(row)).not.toContain(invited!.code);
  expect(db.getDatabase().prepare('SELECT count(*) AS n FROM paired_devices').get()).toEqual(
    before
  );
});

test.each(['missing', 'foreign', 'system', 'task', 'unconsumed'])(
  'cannot use %s input as consent to invite or remove',
  async (kind) => {
    const id = crypto.randomUUID();
    if (kind === 'system' || kind === 'task') {
      db.getSDKMessageRepo().saveUserMessage(root, {
        type: 'user',
        uuid: id,
        session_id: root,
        parent_tool_use_id: null,
        inputKind: kind,
        message: { role: 'user', content: 'External data' },
      } as import('@hyperneo/shared/sdk').SDKUserMessage);
      db.getSDKMessageRepo().markDeliveryConsumedByUuid(root, id);
      service.asks.append({
        conversationId: service.repo.conversationId()!,
        requestId: id,
        askOrigin: { sessionId: root, messageId: id },
        content: 'External data',
      });
    } else if (kind !== 'missing') {
      await call(
        'neo.message.send',
        { sessionId: root, requestId: id, content: 'Synthetic request' },
        { source: 'rpc', principal: 'local' }
      );
      if (kind !== 'unconsumed') db.getSDKMessageRepo().markDeliveryConsumedByUuid(root, id);
    }
    const invalid = {
      ...caller,
      consumedInputId: id,
      ...(kind === 'foreign' ? { sessionId: 'other' } : {}),
    };
    for (const [name, input] of [
      ['neo.peer.invite', { name: 'Contact A' }],
      ['neo.peer.remove', { id: 'missing' }],
    ] as const)
      expect(await call(name, input, invalid)).toMatchObject({
        accepted: false,
        reason: kind === 'foreign' ? 'main_neo_only' : 'human_ask_required',
      });
    expect(await call('neo.peer.list', {})).toMatchObject({ accepted: true, peers: [] });
  }
);

test('an invitation expiring while its claim waits for the writer is refused', async () => {
  const { createPeerPairRoute } = await import('../../../../src/routes/neo-peer.ts');
  const invited = await call('neo.peer.invite', { name: 'Contact B' });
  const clock = spyOn(Date, 'now').mockReturnValue(invited.expiresAt - 1);
  const run = db.gateway.run.bind(db.gateway);
  spyOn(db.gateway, 'run').mockImplementation((operation, args) => {
    if (operation.name === 'neo.peer.write' && (args as { method?: string }).method === 'claim')
      clock.mockReturnValue(invited.expiresAt);
    return run(operation, args);
  });
  const response = await createPeerPairRoute(db.gateway)(
    new Request('https://peer.invalid/neo-peer/pair', {
      method: 'POST',
      body: JSON.stringify({ code: invited.code }),
    })
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'invalid_invite' });
});
