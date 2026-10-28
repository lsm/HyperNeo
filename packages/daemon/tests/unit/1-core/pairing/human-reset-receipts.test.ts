import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository';
import { resetHumanDevices } from '../../../../src/storage/repositories/human-device-reset-repository';
import { humanDeviceResetReads } from '../../../../src/storage/repositories/human-device-reset-read';
import { humanDeviceResetWrites } from '../../../../src/storage/repositories/human-device-reset-write';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

type Receipt = ReturnType<typeof resetHumanDevices>;

describe('human reset receipts', () => {
  let db: Database;
  let gateway: DbGateway;
  let repo: DevicePairingRepository;
  const now = 1_000_000;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    gateway = new DbGateway(':memory:', db);
    repo = new DevicePairingRepository(db);
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });
  const read = (id: string): Promise<Receipt | null> =>
    gateway.call(humanDeviceResetReads, 'receipt', id);
  const reset = (id?: string) => gateway.call(humanDeviceResetWrites, 'reset', now, id);
  const pair = () => {
    const code = repo.createCode('human', 'Synthetic phone', true, now);
    return repo.redeem(code.code, 'Synthetic phone', now)!;
  };

  test('legacy reset retains a generated UUID and an atomic notice', async () => {
    const receipt = await gateway.call(humanDeviceResetWrites, 'reset', now);
    expect(receipt.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(receipt.resetAt).toBe(now);
    expect(new NeoPublicationRepository(db).list(receipt.conversationId)).toHaveLength(1);
  });

  test('missing receipt lookup is read-only', async () => {
    const before = db.prepare('SELECT total_changes() AS count').get();
    expect(await read(randomUUID())).toBeNull();
    expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
    expect(DB_OPS.get('pairing.humanReset.read')?.mode).toBe('read');
  });

  test('a supplied request UUID round-trips to its exact cloneable receipt', async () => {
    const human = pair();
    const id = randomUUID();
    const receipt = await reset(id);
    expect(receipt.id).toBe(id);
    expect(receipt.devices).toEqual([{ id: human.device.id, name: human.device.name }]);
    expect(await read(id)).toEqual(receipt);
    expect(structuredClone(await read(id))).toEqual(receipt);
  });

  test('concurrent resets at the same time keep separate exact receipts', async () => {
    const human = pair();
    const ids = [randomUUID(), randomUUID()];
    const receipts = await Promise.all(ids.map(reset));
    expect(receipts.map((r) => r.id)).toEqual(ids);
    expect(receipts.flatMap((r) => r.devices).map((d) => d.id)).toEqual([human.device.id]);
    expect(await Promise.all(ids.map(read))).toEqual(receipts);
  });

  test('a duplicate UUID rejects without claiming a newly paired human', async () => {
    const id = randomUUID();
    const first = await reset(id);
    const human = pair();
    await expect(reset(id)).rejects.toThrow();
    expect(repo.isActiveDevice(human.device.id)).toBe(true);
    expect(await read(id)).toEqual(first);
    expect(new NeoPublicationRepository(db).list(first.conversationId)).toHaveLength(1);
  });

  test('only a notice matching both recovery origin fields authorizes the receipt', async () => {
    const id = randomUUID();
    const conversationId = randomUUID();
    db.prepare('INSERT INTO human_device_resets (id, reset_at, devices_json) VALUES (?, ?, ?)').run(
      id,
      now,
      '[]'
    );
    expect(await read(id)).toBeNull();
    const append = (sessionId: string, messageId: string) => {
      expect(
        new NeoPublicationRepository(db).append({
          conversationId,
          publicationId: randomUUID(),
          producerInput: { sessionId, messageId },
          shortText: 'Synthetic recovery',
          fullText: 'Synthetic recovery',
          links: [],
        }).accepted
      ).toBe(true);
    };
    append('different-producer', id);
    append('daemon:device-recovery', randomUUID());
    expect(await read(id)).toBeNull();
    append('daemon:device-recovery', id);
    expect(await read(id)).toEqual({ id, resetAt: now, devices: [], conversationId });
  });

  test('the receipt retains the notice conversation when the current conversation changes', async () => {
    const id = randomUUID();
    const receipt = await reset(id);
    db.prepare('UPDATE neo_conversation SET id = ?').run(randomUUID());
    expect(await read(id)).toEqual(receipt);
  });

  test('second-notice failure leaves no exact receipt or partially revoked humans', async () => {
    const humans = Array.from({ length: 21 }, pair);
    const id = randomUUID();
    db.exec(
      "CREATE TRIGGER reject_second_notice BEFORE INSERT ON neo_publications WHEN json_extract(NEW.payload_json, '$.fullText') LIKE '%(part 2)%' BEGIN SELECT RAISE(ABORT, 'synthetic second notice failure'); END"
    );
    await expect(reset(id)).rejects.toThrow('synthetic second notice failure');
    expect(await read(id)).toBeNull();
    expect(humans.every((h) => repo.isActiveDevice(h.device.id))).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM neo_publications').get()).toEqual({
      count: 0,
    });
  });
});
