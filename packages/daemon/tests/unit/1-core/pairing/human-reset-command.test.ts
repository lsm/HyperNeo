import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoPublicationAppendResult } from '@hyperneo/shared/types/neo-publication';
import { ChangeRecorder } from '../../../../src/storage/db-gateway/db-op';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { neoPublicationWrites } from '../../../../src/storage/repositories/neo-publication-repository';
import { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('atomic human-device reset command', () => {
  let writer: Database;
  let gateway: DbGateway;
  let repo: DevicePairingRepository;
  const now = 1_000_000;
  beforeEach(() => {
    writer = new Database(':memory:');
    runMigrations(writer, () => {});
    createTables(writer);
    gateway = new DbGateway(':memory:', writer);
    repo = new DevicePairingRepository(writer);
  });
  afterEach(async () => {
    await gateway.close();
    writer.close();
  });
  const pair = (name: string, kind: 'human' | 'relay' = 'human') => {
    const code = repo.createCode(kind, name, true, now);
    return repo.redeem(code.code, name, now)!;
  };
  const notices = () =>
    writer.prepare('SELECT payload_json AS payload FROM neo_publications').all() as {
      payload: string;
    }[];
  const count = (table: 'human_device_resets' | 'neo_conversation') =>
    (writer.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  const reset = (at = now + 1) => {
    const op = DB_OPS.get('pairing.humanReset.write');
    if (!op) return Promise.reject(new Error('Unknown write DB op: pairing.humanReset.write'));
    return gateway.run(op, { method: 'reset', args: [at] } as never) as Promise<{
      id: string;
      resetAt: number;
      conversationId: string;
      devices: { id: string; name: string }[];
    }>;
  };
  const input = () => ({
    conversationId: randomUUID(),
    publicationId: randomUUID(),
    shortText: 'Synthetic human recovery',
    fullText: 'Synthetic recovery details',
    links: [],
  });
  const append = (value: unknown) =>
    neoPublicationWrites.run(
      writer,
      { method: 'append', args: [value] },
      new ChangeRecorder()
    ) as NeoPublicationAppendResult;

  test('the registered core append joins an outer transaction and returns plain data', () => {
    const value = input();
    expect(neoPublicationWrites.name).toBe('neo.publications.write');
    expect(neoPublicationWrites.mode).toBe('write');
    expect(neoPublicationWrites.methods).toContain('append');
    expect(() =>
      writer.transaction(() => {
        writer
          .prepare('INSERT INTO neo_conversation VALUES (1, ?, ?)')
          .run(value.conversationId, now);
        const receipt = append(value);
        expect(receipt.accepted).toBe(true);
        expect(structuredClone(receipt)).toEqual(receipt);
        expect(notices()).toHaveLength(1);
        throw new Error('synthetic outer rollback');
      })()
    ).toThrow('synthetic outer rollback');
    expect(notices()).toHaveLength(0);
    expect(count('neo_conversation')).toBe(0);
  });

  test('core append retains idempotency, conflicts and invalid-input refusal inside a transaction', () => {
    const value = input();
    writer.transaction(() => {
      writer
        .prepare('INSERT INTO neo_conversation VALUES (1, ?, ?)')
        .run(value.conversationId, now);
      expect(append(value)).toMatchObject({ accepted: true, created: true });
      expect(append(value)).toMatchObject({ accepted: true, created: false });
      expect(append({ ...value, fullText: 'Different details' })).toMatchObject({
        accepted: false,
        reason: 'publication_conflict',
      });
      expect(append({ ...value, publicationId: randomUUID(), fullText: '' })).toEqual({
        accepted: false,
        reason: 'invalid_publication',
      });
    })();
    expect(notices()).toHaveLength(1);
  });

  test('the command returns committed revoked humans and bounded notices without deleting history', async () => {
    const humans = Array.from({ length: 21 }, (_, i) => pair(`Synthetic phone ${i}`));
    const relay = pair('Synthetic relay', 'relay');
    const code = repo.createCode('human', null, true, now);
    const receipt = await reset();
    expect(receipt.resetAt).toBe(now + 1);
    expect(receipt.devices).toHaveLength(21);
    expect(structuredClone(receipt)).toEqual(receipt);
    for (const human of humans) {
      expect(repo.isActiveDevice(human.device.id)).toBe(false);
      expect(notices().some((row) => row.payload.includes(human.device.id))).toBe(true);
      expect(JSON.stringify(notices())).not.toContain(human.credential);
    }
    expect(repo.isActiveDevice(relay.device.id)).toBe(true);
    expect(repo.listDevices()).toHaveLength(22);
    expect(notices()).toHaveLength(2);
    expect(count('human_device_resets')).toBe(1);
    expect(repo.redeem(code.code, 'Expired code', now + 1)).toBeNull();
    expect(repo.humanRecoveryOpen()).toBe(true);
  });

  test('a failure on the second notice rolls back the first notice and all reset state', async () => {
    const humans = Array.from({ length: 21 }, (_, i) => pair(`Synthetic phone ${i}`));
    const code = repo.createCode('human', null, true, now);
    writer.exec(
      "CREATE TRIGGER reject_second_notice BEFORE INSERT ON neo_publications WHEN json_extract(NEW.payload_json, '$.fullText') LIKE '%(part 2)%' BEGIN SELECT RAISE(ABORT, 'synthetic second notice failure'); END"
    );
    await expect(reset()).rejects.toThrow('synthetic second notice failure');
    for (const human of humans) expect(repo.isActiveDevice(human.device.id)).toBe(true);
    expect(notices()).toHaveLength(0);
    expect(count('human_device_resets')).toBe(0);
    expect(count('neo_conversation')).toBe(0);
    expect(repo.humanRecoveryOpen()).toBe(false);
    expect(repo.redeem(code.code, 'Still valid', now + 1)).not.toBeNull();
  });

  test('a core publication refusal aborts the reset transaction', async () => {
    const human = pair('Synthetic phone');
    writer
      .prepare('UPDATE paired_devices SET name = ? WHERE id = ?')
      .run('x'.repeat(17000), human.device.id);
    await expect(reset()).rejects.toThrow('Recovery notice was not saved: invalid_publication');
    expect(repo.isActiveDevice(human.device.id)).toBe(true);
    expect(notices()).toHaveLength(0);
    expect(count('human_device_resets')).toBe(0);
  });

  test('concurrent resets each retain a notice while only one receipt claims each human', async () => {
    const human = pair('Synthetic phone');
    const receipts = await Promise.all([reset(), reset(now + 2)]);
    expect(new Set(receipts.map((r) => r.id)).size).toBe(2);
    expect(receipts.flatMap((r) => r.devices).map((d) => d.id)).toEqual([human.device.id]);
    expect(notices()).toHaveLength(2);
    expect(count('human_device_resets')).toBe(2);
    expect(repo.listDevices()).toHaveLength(1);
  });
});
