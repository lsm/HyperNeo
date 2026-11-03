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
  peers: { id: string; name: string; address: string | null }[];
};
const call = async (name: string, input: unknown, as = caller) => {
  const result = await invokeOperation(
    createOperationRegistry(createNeoOperations(service)),
    name,
    input,
    as
  );
  return (result.kind === 'completed' ? result.value : null) as PairResult | null;
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
  expect(invited).toMatchObject({
    accepted: true,
    id: expect.any(String),
    code: expect.any(String),
    expiresAt: expect.any(Number),
  });
  expect(invited!.expiresAt - Date.now()).toBeGreaterThan(590_000);
  expect(await call('neo.peer.list', {})).toMatchObject({
    accepted: true,
    peers: [{ id: invited!.id, name: 'Contact A', address: null }],
  });
  const row = db.getDatabase().prepare('SELECT * FROM neo_peers').get();
  expect(JSON.stringify(row)).not.toContain(invited!.code);
  expect(db.getDatabase().prepare('SELECT count(*) AS n FROM paired_devices').get()).toEqual(
    before
  );
});

test.each(['missing', 'foreign', 'system', 'task', 'unconsumed'])(
  'cannot use %s input as consent to invite, accept or remove',
  async (kind) => {
    const id = crypto.randomUUID();
    if (kind !== 'missing') {
      await call(
        'neo.message.send',
        { sessionId: root, requestId: id, content: 'Synthetic request' },
        { source: 'rpc', principal: 'local' }
      );
      if (kind !== 'unconsumed') db.getSDKMessageRepo().markDeliveryConsumedByUuid(root, id);
      if (kind === 'system' || kind === 'task') {
        const repo = db.getSDKMessageRepo();
        const stored = repo.getMessageByStatusAndUuid(root, 'consumed', id)!;
        repo.saveUserMessage(root, { ...stored, inputKind: kind } as Parameters<
          typeof repo.saveUserMessage
        >[1]);
      }
    }
    const invalid = {
      ...caller,
      consumedInputId: id,
      ...(kind === 'foreign' ? { sessionId: 'other' } : {}),
    };
    const network = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Must not contact a peer without consent');
    });
    for (const [name, input] of [
      ['neo.peer.invite', { name: 'Contact A' }],
      [
        'neo.peer.accept',
        { name: 'Contact B', address: 'https://peer.invalid', code: 'synthetic' },
      ],
      ['neo.peer.remove', { id: 'missing' }],
    ] as const)
      expect(await call(name, input, invalid)).toMatchObject({
        accepted: false,
        reason: 'human_input_required',
      });
    expect(network).not.toHaveBeenCalled();
  }
);

test('accept stores a peer credential privately and remove revokes the relationship', async () => {
  const credential = 'a'.repeat(64);
  const network = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ credential }));
  const accepted = await call('neo.peer.accept', {
    name: 'Contact B',
    address: 'https://peer.invalid',
    code: 'synthetic',
  });
  expect(accepted).toMatchObject({ accepted: true, id: expect.any(String) });
  expect(JSON.stringify(accepted)).not.toContain(credential);
  expect(network).toHaveBeenCalledTimes(1);
  const listed = await call('neo.peer.list', {});
  expect(listed).toMatchObject({
    accepted: true,
    peers: [{ id: accepted!.id, name: 'Contact B', address: 'https://peer.invalid' }],
  });
  expect(JSON.stringify(listed)).not.toContain(credential);
  expect(await call('neo.peer.remove', { id: accepted!.id })).toMatchObject({ accepted: true });
  expect(await call('neo.peer.list', {})).toMatchObject({ accepted: true, peers: [] });
});

test('a refused or malformed remote pairing cannot create a local connection', async () => {
  const network = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ error: 'invalid_invite' }, { status: 401 })
  );
  const input = { name: 'Contact B', address: 'https://peer.invalid', code: 'synthetic' };
  expect(await call('neo.peer.accept', input)).toMatchObject({ accepted: false });
  network.mockResolvedValue(Response.json({ credential: 'not a credential' }));
  expect(await call('neo.peer.accept', input)).toMatchObject({ accepted: false });
  expect(await call('neo.peer.list', {})).toMatchObject({ accepted: true, peers: [] });
});
