import { readCodingTodoWorker } from '../../../../src/lib/neo/packs/coding/worker-read.ts';
import { codingProjectIdentity } from '../../../../src/lib/neo/packs/coding/project-cleanup.ts';
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
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { DatabaseCredentialStore } from '../../../../src/lib/credentials/credential-store.ts';
import { runMigration471 } from '../../../../src/storage/schema/m471-neo-peer-address.ts';
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
    createOperationRegistry(
      createNeoOperations(service, codingProjectIdentity, readCodingTodoWorker)
    ),
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

test.each(['missing', 'foreign', 'system', 'task', 'unconsumed'])(
  'cannot use %s input as consent to accept a peer invitation',
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
    const network = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Must not contact a peer without consent');
    });
    for (const [name, input] of [
      [
        'neo.peer.accept',
        { name: 'Contact B', address: 'https://peer.invalid', code: 'synthetic' },
      ],
    ] as const)
      expect(await call(name, input, invalid)).toMatchObject({
        accepted: false,
        reason: kind === 'foreign' ? 'main_neo_only' : 'human_ask_required',
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
  expect(accepted.accepted).toBe(true);
  expect(typeof accepted.id).toBe('string');
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

test('accept cannot recreate a contact removed while its remote invitation is being claimed', async () => {
  const invited = await call('neo.peer.invite', { name: 'Contact B' });
  spyOn(globalThis, 'fetch').mockImplementation(async () => {
    await call('neo.peer.remove', { id: invited.id });
    return Response.json({ credential: 'a'.repeat(64) });
  });
  expect(
    await call('neo.peer.accept', {
      name: 'Contact B',
      address: 'https://peer.invalid',
      code: 'synthetic',
    })
  ).toMatchObject({ accepted: false, reason: expect.stringMatching(/^relationship_changed:/) });
  expect(await call('neo.peer.list', {})).toMatchObject({ accepted: true, peers: [] });
  expect(
    db
      .getDatabase()
      .prepare(
        "SELECT count(*) AS n FROM provider_credentials WHERE provider_id LIKE 'hyperneo.peer.%'"
      )
      .get()
  ).toEqual({ n: 0 });
});

test('accept leaves no secret when the local contact name changes during the remote claim', async () => {
  spyOn(globalThis, 'fetch').mockImplementation(async () => {
    await call('neo.peer.invite', { name: 'Contact B' });
    return Response.json({ credential: 'a'.repeat(64) });
  });
  expect(
    await call('neo.peer.accept', {
      name: 'Contact B',
      address: 'https://peer.invalid',
      code: 'synthetic',
    })
  ).toMatchObject({ accepted: false, reason: expect.stringMatching(/^relationship_changed:/) });
  expect(await call('neo.peer.list', {})).toMatchObject({
    accepted: true,
    peers: [{ name: 'Contact B', address: null }],
  });
  expect(
    db
      .getDatabase()
      .prepare(
        "SELECT count(*) AS n FROM provider_credentials WHERE provider_id LIKE 'hyperneo.peer.%'"
      )
      .get()
  ).toEqual({ n: 0 });
});

test.each([
  'http://peer.invalid',
  'https://user:secret@peer.invalid',
  'https://peer.invalid/path',
  'https://peer.invalid/?query=value',
  'https://peer.invalid/#fragment',
])('accept refuses unsupported address %s before contacting it', async (address) => {
  const network = spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Unsupported address must not be contacted');
  });
  await expect(
    call('neo.peer.accept', { name: 'Contact B', address, code: 'synthetic' })
  ).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
  expect(await call('neo.peer.list', {})).toMatchObject({ accepted: true, peers: [] });
});

test('an oversized pairing response cannot create a contact or leak its secret', async () => {
  spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(2048)));
  expect(
    await call('neo.peer.accept', {
      name: 'Contact B',
      address: 'https://peer.invalid',
      code: 'synthetic',
    })
  ).toMatchObject({ accepted: false, reason: expect.stringMatching(/^pairing_refused:/) });
  expect(await call('neo.peer.list', {})).toMatchObject({ accepted: true, peers: [] });
});

test('deployed receiving contacts keep their identity and hash when outgoing addresses are added', () => {
  const legacy = new Database(':memory:');
  try {
    legacy.exec(
      'CREATE TABLE neo_peers(id TEXT PRIMARY KEY,name TEXT UNIQUE,credential_hash TEXT,invite_hash TEXT,expires_at INTEGER)'
    );
    legacy
      .prepare('INSERT INTO neo_peers(id,name,credential_hash) VALUES(?,?,?)')
      .run('kept', 'Contact', 'hash');
    runMigration471(legacy);
    runMigration471(legacy);
    expect(legacy.prepare('SELECT id,credential_hash,address FROM neo_peers').get()).toEqual({
      id: 'kept',
      credential_hash: 'hash',
      address: null,
    });
  } finally {
    legacy.close();
  }
});

test('failed credential deletion leaves the contact and secret available for a removal retry', async () => {
  spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ credential: 'a'.repeat(64) }));
  const accepted = await call('neo.peer.accept', {
    name: 'Contact B',
    address: 'https://peer.invalid',
    code: 'synthetic',
  });
  const deletion = spyOn(DatabaseCredentialStore.prototype, 'delete').mockRejectedValue(
    new Error('Credential vault unavailable')
  );
  await expect(call('neo.peer.remove', { id: accepted.id })).rejects.toThrow(
    'Credential vault unavailable'
  );
  expect(await call('neo.peer.list', {})).toMatchObject({
    peers: [{ id: accepted.id, address: 'https://peer.invalid' }],
  });
  expect(
    db
      .getDatabase()
      .prepare(
        "SELECT count(*) AS n FROM provider_credentials WHERE provider_id LIKE 'hyperneo.peer.%'"
      )
      .get()
  ).toEqual({ n: 1 });
  deletion.mockRestore();
  expect(await call('neo.peer.remove', { id: accepted.id })).toMatchObject({ accepted: true });
  expect(await call('neo.peer.list', {})).toMatchObject({ peers: [] });
  expect(
    db
      .getDatabase()
      .prepare(
        "SELECT count(*) AS n FROM provider_credentials WHERE provider_id LIKE 'hyperneo.peer.%'"
      )
      .get()
  ).toEqual({ n: 0 });
});
