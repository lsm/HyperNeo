import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDevicePairingOperations } from '../../../../src/lib/pairing/pairing-operations';
import { createPairingLimiter } from '../../../../src/lib/pairing/pairing-limiter';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

class FaultGateway extends DbGateway {
  writes = 0;
  reads = 0;
  failWrite = false;
  loseReceipt = false;
  failedReads = 0;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name === 'pairing.revokeDevice.write') {
      this.writes++;
      if (this.failWrite) {
        this.failWrite = false;
        throw new Error('synthetic admission failure');
      }
      const result = await super.run(op, args);
      if (this.loseReceipt) {
        this.loseReceipt = false;
        throw new Error('synthetic committed reply lost; outcome unknown');
      }
      return result;
    }
    if (op.name === 'pairing.state.read') {
      this.reads++;
      if (this.failedReads > 0) {
        this.failedReads--;
        throw new Error('synthetic read unavailable');
      }
    }
    return super.run(op, args);
  }
}

describe('public pairing revocation activation', () => {
  let main: Database;
  let writer: Database;
  let gateway: FaultGateway;
  let repo: DevicePairingRepository;
  let notifications: string[];
  let mainSql: number;
  const now = 1_000_000;
  const door: OperationCaller = { source: 'mcp', principal: 'session-door' };
  beforeEach(() => {
    main = new Database(':memory:');
    writer = new Database(':memory:');
    runMigrations(writer, () => {});
    createTables(writer);
    repo = new DevicePairingRepository(writer);
    gateway = new FaultGateway(':memory:', writer);
    bindGateway(main, gateway);
    notifications = [];
    mainSql = 0;
    main.prepare = () => {
      mainSql++;
      throw new Error('revocation SQL reached main');
    };
  });
  afterEach(async () => {
    await gateway.close();
    main.close();
    writer.close();
  });
  const seed = (kind: 'human' | 'relay' = 'relay') => {
    const code = repo.createCode(kind, null, true, now);
    return repo.redeem(code.code, 'Synthetic device', now)!.device.id;
  };
  const human = (id: string): OperationCaller => ({
    source: 'rpc',
    principal: 'local',
    device: { deviceId: id, kind: 'human' },
  });
  const revoke = (id: string, caller = door) =>
    invokeOperation(
      createOperationRegistry(
        createDevicePairingOperations({
          repo: () => new DevicePairingRepository(main),
          limiter: createPairingLimiter(),
          now: () => now,
          revoked: (target) => {
            expect(repo.isActiveDevice(target)).toBe(false);
            notifications.push(target);
          },
        })
      ),
      'device.revoke',
      { deviceId: id },
      caller
    );
  const waitForRead = async () => {
    const until = Date.now() + 500;
    while (!gateway.reads) {
      if (Date.now() > until) throw new Error('reconciliation did not start');
      await new Promise((done) => setTimeout(done, 2));
    }
  };
  test('the public operation notifies after committing without main SQL', async () => {
    const actor = seed('human');
    const target = seed();
    expect(await revoke(target, human(actor))).toEqual({ kind: 'completed', value: { ok: true } });
    expect(notifications).toEqual([target]);
    expect(gateway.writes).toBe(1);
    expect(mainSql).toBe(0);
  });
  test('current actor authorization refuses stale identities without notification', async () => {
    const actor = seed('human');
    const target = seed();
    repo.revokeDevice(actor, now);
    expect(await revoke(target, human(actor))).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: expect.stringContaining('not_paired:') },
    });
    expect(repo.isActiveDevice(target)).toBe(true);
    expect(notifications).toEqual([]);
    expect(mainSql).toBe(0);
  });
  test('missing targets retain not-found without notification', async () => {
    expect(await revoke('synthetic-absent')).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: expect.stringContaining('not_found:') },
    });
    expect(notifications).toEqual([]);
    expect(mainSql).toBe(0);
  });
  test('failed admission leaves an active target connected', async () => {
    const target = seed();
    gateway.failWrite = true;
    expect(await revoke(target)).toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('synthetic admission failure'),
    });
    expect(repo.isActiveDevice(target)).toBe(true);
    expect(notifications).toEqual([]);
    expect(gateway.writes).toBe(1);
    expect(gateway.reads).toBe(1);
    expect(mainSql).toBe(0);
  });
  test('a lost commit reply reconciles the target and retains the original error', async () => {
    const target = seed();
    gateway.loseReceipt = true;
    expect(await revoke(target)).toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('outcome unknown'),
    });
    expect(repo.isActiveDevice(target)).toBe(false);
    expect(notifications).toEqual([target]);
    expect(gateway.writes).toBe(1);
    expect(mainSql).toBe(0);
  });
  test('read failures retry without replaying the committed mutation or notification', async () => {
    const target = seed();
    gateway.loseReceipt = true;
    gateway.failedReads = 2;
    expect(await revoke(target)).toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('outcome unknown'),
    });
    expect(notifications).toEqual([target]);
    expect(gateway.reads).toBe(3);
    expect(gateway.writes).toBe(1);
    expect(mainSql).toBe(0);
  });
  test('rollback preserves the target and does not announce a revocation', async () => {
    const target = seed();
    writer.exec(
      "CREATE TRIGGER reject_revoke AFTER UPDATE OF revoked_at ON paired_devices BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END"
    );
    expect(await revoke(target)).toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('synthetic rollback'),
    });
    expect(repo.isActiveDevice(target)).toBe(true);
    expect(notifications).toEqual([]);
    expect(mainSql).toBe(0);
  });
  test('persistent read failure releases the caller while retaining eventual connection closure', async () => {
    const target = seed();
    gateway.loseReceipt = true;
    gateway.failedReads = Infinity;
    let settled = false;
    const pending = revoke(target).finally(() => {
      settled = true;
    });
    try {
      await new Promise((done) => setTimeout(done, 1000));
      expect(settled).toBe(true);
      expect(await pending).toMatchObject({
        kind: 'failed',
        message: expect.stringContaining('outcome unknown'),
      });
    } finally {
      gateway.failedReads = 0;
      await pending;
      const until = Date.now() + 2000;
      while (!notifications.includes(target) && Date.now() < until)
        await new Promise((done) => setTimeout(done, 5));
      expect(notifications).toEqual([target]);
      expect(gateway.writes).toBe(1);
    }
  });
  test('gateway close cancels read recovery without an unconfirmed notification', async () => {
    const target = seed();
    gateway.loseReceipt = true;
    gateway.failedReads = Infinity;
    const pending = revoke(target);
    await waitForRead();
    await gateway.close();
    expect(await pending).toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('outcome unknown'),
    });
    expect(notifications).toEqual([]);
    expect(gateway.writes).toBe(1);
    const reads = gateway.reads;
    await new Promise((done) => setTimeout(done, 40));
    expect(gateway.reads).toBe(reads);
    expect(mainSql).toBe(0);
  });
});
