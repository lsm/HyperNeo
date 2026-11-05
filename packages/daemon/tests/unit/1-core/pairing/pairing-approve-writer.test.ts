import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDevicePairingOperations } from '../../../../src/lib/pairing/pairing-operations';
import { createPairingLimiter } from '../../../../src/lib/pairing/pairing-limiter';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('pairing approval writer admission', () => {
  let main: Database;
  let writer: Database;
  let gateway: DbGateway;
  let repo: DevicePairingRepository;
  let humanId: string;
  let codeId: string;
  let mainSql: number;
  const now = 1_000_000;

  beforeEach(() => {
    main = new Database(':memory:');
    writer = new Database(':memory:');
    runMigrations(writer, () => {});
    createTables(writer);
    repo = new DevicePairingRepository(writer);
    const first = repo.createCode('human', 'Synthetic human', true, now);
    humanId = repo.redeem(first.code, 'Synthetic human', now)!.device.id;
    codeId = repo.createCode('human', 'Synthetic phone', false, now).id;
    gateway = new DbGateway(':memory:', writer);
    bindGateway(main, gateway);
    mainSql = 0;
    main.prepare = () => {
      mainSql++;
      throw new Error('pairing approval SQL reached main');
    };
  });

  afterEach(async () => {
    await gateway.close();
    main.close();
    writer.close();
  });

  const approve = (kind?: 'human' | 'relay') =>
    invokeOperation(
      createOperationRegistry(
        createDevicePairingOperations({
          repo: () => new DevicePairingRepository(main),
          limiter: createPairingLimiter(),
          now: () => now,
          revoked: () => {},
        })
      ),
      'device.pair.approve',
      { codeId },
      {
        source: 'rpc',
        principal: 'local',
        ...(kind ? { device: { deviceId: humanId, kind } } : {}),
      }
    );

  test('an active human receives success only after the code approval commits without main SQL', async () => {
    expect(await approve('human')).toMatchObject({ kind: 'completed', value: { ok: true } });
    expect(
      writer.prepare('SELECT approved_at FROM pairing_codes WHERE id = ?').get(codeId)
    ).toEqual({ approved_at: now });
    expect(mainSql).toBe(0);
  });

  test('a revoked human is refused against current writer state', async () => {
    repo.revokeDevice(humanId, now);
    expect(await approve('human')).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: expect.stringContaining('not_paired') },
    });
    expect(
      writer.prepare('SELECT approved_at FROM pairing_codes WHERE id = ?').get(codeId)
    ).toEqual({ approved_at: null });
    expect(mainSql).toBe(0);
  });

  test('an expired code is refused without main SQL', async () => {
    writer.prepare('UPDATE pairing_codes SET expires_at = ? WHERE id = ?').run(now, codeId);
    expect(await approve('human')).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: expect.stringContaining('not_pending') },
    });
    expect(mainSql).toBe(0);
  });

  test('unpaired callers cannot approve a code', async () => {
    expect(await approve()).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: expect.stringContaining('not_paired') },
    });
    expect(mainSql).toBe(0);
  });

  test('relay callers are refused by the operation policy', async () => {
    expect(await approve('relay')).toMatchObject({ kind: 'failed', code: 'forbidden' });
    expect(mainSql).toBe(0);
  });
});
