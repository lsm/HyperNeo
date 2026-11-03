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
    {
      sessionId: root,
      requestId: messageId,
      content: 'Add Contact B using the provided address and invitation.',
    },
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

const message = () => ({ requestId: crypto.randomUUID(), content: 'The meeting is at noon.' });
async function connected() {
  spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ credential: 'a'.repeat(64) }));
  return call('neo.peer.accept', {
    name: 'Contact B',
    address: 'https://peer.invalid',
    code: 'synthetic',
  });
}

test('send uses only the selected contact address and private credential', async () => {
  const peer = await connected();
  const input = { id: peer.id, ...message() };
  const network = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ accepted: true }));
  expect(await call('neo.peer.send', input)).toMatchObject({ accepted: true });
  expect(network).toHaveBeenLastCalledWith(
    new URL('https://peer.invalid/neo-peer/message'),
    expect.objectContaining({
      redirect: 'error',
      method: 'POST',
      headers: expect.objectContaining({ authorization: `Bearer ${'a'.repeat(64)}` }),
      body: JSON.stringify({ requestId: input.requestId, content: input.content }),
    })
  );
});

test('send refuses a missing or incoming-only contact before contacting the network', async () => {
  const incoming = await call('neo.peer.invite', { name: 'Contact A' });
  const network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
  for (const id of ['missing', incoming.id])
    expect(await call('neo.peer.send', { id, ...message() })).toMatchObject({ accepted: false });
  expect(network).not.toHaveBeenCalled();
});

test('a different Neo cannot send through the owner contact', async () => {
  const peer = await connected();
  const network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
  expect(
    await call('neo.peer.send', { id: peer.id, ...message() }, { ...caller, sessionId: 'other' })
  ).toMatchObject({ accepted: false, reason: 'main_neo_only' });
  expect(network).not.toHaveBeenCalled();
});

test.each(['refused', 'malformed', 'timeout'])(
  'send reports %s without claiming delivery or retrying',
  async (kind) => {
    const peer = await connected();
    const network = spyOn(globalThis, 'fetch');
    if (kind === 'timeout') network.mockRejectedValue(new Error('timed out'));
    else
      network.mockResolvedValue(
        Response.json(kind === 'refused' ? { error: 'invalid_credential' } : { ok: true }, {
          status: kind === 'refused' ? 401 : 200,
        })
      );
    expect(await call('neo.peer.send', { id: peer.id, ...message() })).toMatchObject({
      accepted: false,
    });
    expect(network).toHaveBeenCalledTimes(1);
  }
);

test('removed contact cannot send with an old id', async () => {
  const peer = await connected();
  await call('neo.peer.remove', { id: peer.id });
  const network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
  expect(await call('neo.peer.send', { id: peer.id, ...message() })).toMatchObject({
    accepted: false,
  });
  expect(network).not.toHaveBeenCalled();
});
