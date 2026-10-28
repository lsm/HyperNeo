import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('pairing revocation command', () => {
  let writer: Database;
  let gateway: DbGateway;
  let repo: DevicePairingRepository;
  const now = 1_000_000;
  const door: OperationCaller = { source: 'mcp', principal: 'session-door' };
  const local: OperationCaller = { source: 'rpc', principal: 'local' };
  beforeEach(() => {
    writer = new Database(':memory:');
    runMigrations(writer, () => {});
    createTables(writer);
    repo = new DevicePairingRepository(writer);
    gateway = new DbGateway(':memory:', writer);
  });
  afterEach(async () => {
    await gateway.close();
    writer.close();
  });
  const seed = (kind: 'human' | 'relay' = 'relay') => {
    const made = repo.createCode(kind, null, true, now);
    return repo.redeem(made.code, 'Synthetic device', now)!.device.id;
  };
  const human = (id: string): OperationCaller => ({
    ...local,
    device: { deviceId: id, kind: 'human' },
  });
  const revoke = async (id: string, caller = door) => {
    const command = DB_OPS.get('pairing.revokeDevice.write');
    if (!command) throw new Error('Unknown write DB op: pairing.revokeDevice.write');
    return gateway.run(command, { method: 'revoke', args: [id, caller, now] });
  };
  test('an active human receives success after target revocation commits', async () => {
    const actor = seed('human');
    const target = seed();
    expect(await revoke(target, human(actor))).toEqual({ ok: true });
    expect(repo.listDevices().find((d) => d.id === target)?.revokedAt).toBe(now);
    expect(repo.isActiveDevice(actor)).toBe(true);
  });
  test('the local session door can revoke without a paired human', async () => {
    const target = seed();
    expect(await revoke(target)).toEqual({ ok: true });
    expect(repo.isActiveDevice(target)).toBe(false);
  });
  test('unpaired local callers and relays cannot revoke a target', async () => {
    const target = seed();
    for (const caller of [
      local,
      { ...local, device: { deviceId: target, kind: 'relay' as const } },
    ]) {
      expect(await revoke(target, caller)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('not_paired:'),
      });
      expect(repo.isActiveDevice(target)).toBe(true);
    }
  });
  test('an agent cannot invoke the session door exception', async () => {
    const target = seed();
    expect(await revoke(target, { source: 'mcp', principal: 'agent' })).toEqual({
      ok: false,
      reason: 'This action needs the user.',
    });
    expect(repo.isActiveDevice(target)).toBe(true);
  });
  test('revoked actors lose authorization even if their identity says human', async () => {
    const actor = seed('human');
    const target = seed();
    repo.revokeDevice(actor, now);
    expect(await revoke(target, human(actor))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not_paired:'),
    });
    expect(repo.isActiveDevice(target)).toBe(true);
  });
  test('missing and previously revoked targets retain not-found receipts', async () => {
    const target = seed();
    expect(await revoke(target)).toEqual({ ok: true });
    for (const id of [target, 'synthetic-absent'])
      expect(await revoke(id)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('not_found:'),
      });
  });
  test('a human can revoke itself once', async () => {
    const actor = seed('human');
    expect(await revoke(actor, human(actor))).toEqual({ ok: true });
    expect(repo.isActiveDevice(actor)).toBe(false);
    expect(await revoke(actor, human(actor))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not_paired:'),
    });
  });
  test('a rejected update rolls back revocation before returning an infrastructure error', async () => {
    const target = seed();
    writer.exec(
      "CREATE TRIGGER reject_revoke AFTER UPDATE OF revoked_at ON paired_devices BEGIN SELECT RAISE(ABORT, 'synthetic rejection'); END"
    );
    await expect(revoke(target)).rejects.toThrow('synthetic rejection');
    expect(repo.isActiveDevice(target)).toBe(true);
  });
});
