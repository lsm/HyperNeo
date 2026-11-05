import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createDevicePairingOperations,
  NO_HUMAN_DEVICE,
} from '../../../../src/lib/pairing/pairing-operations';
import { createPairingLimiter } from '../../../../src/lib/pairing/pairing-limiter';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import {
  DevicePairingRepository,
  PAIRING_CODE_TTL_MS,
} from '../../../../src/storage/repositories/device-pairing-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('pairing code creation writer admission', () => {
  let main: Database;
  let writer: Database;
  let gateway: DbGateway;
  let repo: DevicePairingRepository;
  let mainSql: number;
  const now = 1_000_000;
  const local: OperationCaller = { source: 'rpc', principal: 'local' };
  const door: OperationCaller = {
    source: 'mcp',
    principal: 'session-door',
    sessionId: 'synthetic-cli',
  };

  beforeEach(() => {
    main = new Database(':memory:');
    writer = new Database(':memory:');
    runMigrations(writer, () => {});
    createTables(writer);
    repo = new DevicePairingRepository(writer);
    gateway = new DbGateway(':memory:', writer);
    bindGateway(main, gateway);
    mainSql = 0;
    main.prepare = () => {
      mainSql++;
      throw new Error('pairing code creation SQL reached main');
    };
  });
  afterEach(async () => {
    await gateway.close();
    main.close();
    writer.close();
  });

  const create = (caller = local, input: unknown = { kind: 'human', name: 'Synthetic phone' }) =>
    invokeOperation(
      createOperationRegistry(
        createDevicePairingOperations({
          repo: () => new DevicePairingRepository(main),
          limiter: createPairingLimiter(),
          now: () => now,
          revoked: () => {},
        })
      ),
      'device.pair.create',
      input,
      caller
    );
  const seedHuman = () => {
    const code = repo.createCode('human', null, true, now);
    return repo.redeem(code.code, 'Synthetic existing human', now)!.device.id;
  };
  const paired = (deviceId: string): OperationCaller => ({
    ...local,
    device: { deviceId, kind: 'human' },
  });
  const count = () =>
    (writer.prepare('SELECT COUNT(*) AS n FROM pairing_codes').get() as { n: number }).n;

  test('the first local code receipt follows committed approved code storage without main SQL', async () => {
    const outcome = await create();
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') throw new Error(outcome.message);
    const body = outcome.value as {
      ok: boolean;
      codeId: string;
      code: string;
      expiresAt: number;
      approval: string;
    };
    expect(body.ok).toBe(true);
    expect(body.approval).toBe('approved');
    expect(body.code).toMatch(/^[A-Z2-7]{10}$/);
    expect(body.expiresAt).toBe(now + PAIRING_CODE_TTL_MS);
    expect(
      writer
        .prepare('SELECT code_hash, approved_at FROM pairing_codes WHERE id = ?')
        .get(body.codeId)
    ).toEqual({
      code_hash: createHash('sha256').update(body.code).digest('hex'),
      approved_at: now,
    });
    expect(mainSql).toBe(0);
  });

  test('an active paired human creates an approved code', async () => {
    expect(await create(paired(seedHuman()))).toMatchObject({
      kind: 'completed',
      value: { ok: true, approval: 'approved' },
    });
    expect(mainSql).toBe(0);
  });

  test('an unpaired local caller creates a pending code when an active human exists', async () => {
    seedHuman();
    expect(await create()).toMatchObject({
      kind: 'completed',
      value: { ok: true, approval: 'pending' },
    });
    expect(mainSql).toBe(0);
  });

  test('a revoked approver cannot bypass the current missing-human refusal', async () => {
    const id = seedHuman();
    repo.revokeDevice(id, now);
    const before = count();
    expect(await create(paired(id))).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: NO_HUMAN_DEVICE },
    });
    expect(count()).toBe(before);
    expect(mainSql).toBe(0);
  });

  test('the session door recovery exception applies to replacement humans only', async () => {
    repo.revokeDevice(seedHuman(), now);
    writer
      .prepare('INSERT INTO human_device_resets(id, reset_at, devices_json) VALUES (?, ?, ?)')
      .run('synthetic-reset', now, '[]');
    expect(await create(door)).toMatchObject({
      kind: 'completed',
      value: { ok: true, approval: 'approved' },
    });
    const before = count();
    expect(await create(door, { kind: 'relay' })).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: NO_HUMAN_DEVICE },
    });
    expect(count()).toBe(before);
    expect(mainSql).toBe(0);
  });

  test('failed insertion rejects without a committed code or main fallback', async () => {
    writer.exec(
      "CREATE TRIGGER reject_code BEFORE INSERT ON pairing_codes BEGIN SELECT RAISE(ABORT, 'synthetic code insert failure'); END"
    );
    expect(await create()).toMatchObject({
      kind: 'failed',
      code: 'execution_failed',
      message: expect.stringContaining('synthetic code insert failure'),
    });
    expect(count()).toBe(0);
    expect(mainSql).toBe(0);
  });

  test('an authenticated relay is refused before DB admission', async () => {
    expect(
      await create({ ...local, device: { deviceId: 'synthetic-relay', kind: 'relay' } })
    ).toMatchObject({ kind: 'failed', code: 'forbidden' });
    expect(mainSql).toBe(0);
  });

  test('invalid device kind is refused before DB admission', async () => {
    expect(await create(local, { kind: 'invalid' })).toMatchObject({
      kind: 'failed',
      code: 'invalid_input',
    });
    expect(mainSql).toBe(0);
  });
});
