import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createHumanResetCoordinator } from '../../../../src/lib/pairing/human-reset-coordinator';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import type { resetHumanDevices } from '../../../../src/storage/repositories/human-device-reset-repository';
import { humanDeviceResetReads } from '../../../../src/storage/repositories/human-device-reset-read';
import { humanDeviceResetWrites } from '../../../../src/storage/repositories/human-device-reset-write';
import { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

type Receipt = ReturnType<typeof resetHumanDevices>;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
class FaultGateway extends DbGateway {
  writes = 0;
  reads = 0;
  activeReads = 0;
  maxActiveReads = 0;
  failWrite = false;
  loseReply = false;
  failedReads = false;
  holdRead: Promise<void> | undefined;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name === humanDeviceResetWrites.name) {
      this.writes++;
      if (this.failWrite) throw new Error('synthetic admission rejected');
      const result = await super.run(op, args);
      if (this.loseReply) throw new Error('synthetic committed reply lost; outcome unknown');
      return result;
    }
    if (op.name === humanDeviceResetReads.name) {
      this.reads++;
      this.activeReads++;
      this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
      try {
        if (this.failedReads) throw new Error('synthetic reader unavailable');
        await this.holdRead;
        return await super.run(op, args);
      } finally {
        this.activeReads--;
      }
    }
    return super.run(op, args);
  }
}

describe('human reset receipt coordinator construction', () => {
  let db: Database;
  let gateway: FaultGateway;
  let repo: DevicePairingRepository;
  let notices: Receipt[];
  let release: (() => void) | undefined;
  const now = 1_000_000;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    gateway = new FaultGateway(':memory:', db);
    repo = new DevicePairingRepository(db);
    notices = [];
    release = undefined;
  });
  afterEach(async () => {
    release?.();
    await gateway.close();
    db.close();
  });
  const make = async (
    notify = (receipt: Receipt) => {
      notices.push(receipt);
    }
  ) => {
    return createHumanResetCoordinator(gateway, notify);
  };
  const pair = () => {
    const code = repo.createCode('human', 'Synthetic phone', true, now);
    return repo.redeem(code.code, 'Synthetic phone', now)!;
  };
  const wait = async (predicate: () => boolean) => {
    const until = Date.now() + 4500;
    while (!predicate()) {
      if (Date.now() > until) throw new Error('coordinator observation deadline exceeded');
      await pause(5);
    }
  };

  test('the audited reset/receipt and append dependency hashes and contracts are unchanged', () => {
    const root = new URL('../../../../../../', import.meta.url);
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const dependencies = JSON.parse(
      readFileSync(
        new URL(
          '.claude/skills/verify/evidence/lane-c-human-reset-coordinator/audited-dependencies.json',
          root
        ),
        'utf8'
      )
    ) as Record<
      string,
      {
        lines: number;
        sha256: string;
        units: {
          file: string;
          name: string;
          lines: number;
          start?: number;
          end?: number;
          sha256: string;
        }[];
      }
    >;
    for (const [name, group] of Object.entries(dependencies)) {
      expect(group.lines).toBe(name === 'resetReceipt' ? 142 : 277);
      expect(hash(JSON.stringify(group.units))).toBe(group.sha256);
      for (const unit of group.units) {
        const text = readFileSync(new URL(unit.file, root), 'utf8');
        if (!unit.start) {
          expect(hash(text)).toBe(unit.sha256);
          continue;
        }
        const source = ts.createSourceFile(unit.file, text, ts.ScriptTarget.Latest, true);
        let matched = false;
        const visit = (node: ts.Node) => {
          if (
            source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 === unit.start &&
            source.getLineAndCharacterOfPosition(node.getEnd()).line + 1 === unit.end &&
            hash(node.getText(source)) === unit.sha256
          )
            matched = true;
          ts.forEachChild(node, visit);
        };
        visit(source);
        expect(matched).toBe(true);
      }
    }
    expect(humanDeviceResetWrites.mode).toBe('write');
    expect(humanDeviceResetWrites.methods).toEqual(['reset']);
    expect(humanDeviceResetReads.mode).toBe('read');
    expect(humanDeviceResetReads.methods).toEqual(['receipt']);
  });

  test('successful construction notifies only after the exact receipt is committed', async () => {
    const phone = pair();
    const reset = await make((receipt) => {
      expect(repo.isActiveDevice(phone.device.id)).toBe(false);
      expect(db.prepare('SELECT id FROM human_device_resets WHERE id=?').get(receipt.id)).toEqual({
        id: receipt.id,
      });
      notices.push(receipt);
    });
    const receipt = await reset(now);
    expect(notices).toEqual([receipt]);
    expect(receipt.devices.map((d) => d.id)).toEqual([phone.device.id]);
    expect(gateway.writes).toBe(1);
  });

  test('lost replies retain read-only recovery beyond an outage while releasing the original caller', async () => {
    const phone = pair();
    const reset = await make();
    gateway.loseReply = true;
    gateway.failedReads = true;
    await expect(reset(now)).rejects.toThrow('outcome unknown');
    await pause(1200);
    expect(notices).toEqual([]);
    expect(repo.isActiveDevice(phone.device.id)).toBe(false);
    expect(gateway.writes).toBe(1);
    gateway.failedReads = false;
    await wait(() => notices.length === 1);
    expect(notices[0].devices.map((d) => d.id)).toEqual([phone.device.id]);
    expect(await gateway.call(humanDeviceResetReads, 'receipt', notices[0].id)).toEqual(notices[0]);
    await pause(1100);
    expect(notices).toHaveLength(1);
    expect(gateway.writes).toBe(1);
  });

  test('same-time concurrent unknown outcomes stay exact and recovery reads stay single-flight', async () => {
    const phone = pair();
    const reset = await make();
    gateway.loseReply = true;
    gateway.holdRead = new Promise<void>((done) => {
      release = done;
    });
    const results = await Promise.allSettled([reset(now), reset(now)]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    await wait(() => gateway.reads > 0);
    await pause(1100);
    expect(gateway.reads).toBe(1);
    expect(notices).toEqual([]);
    release!();
    gateway.holdRead = undefined;
    await wait(() => notices.length === 2);
    expect(new Set(notices.map((r) => r.id)).size).toBe(2);
    expect(notices.flatMap((r) => r.devices).map((d) => d.id)).toEqual([phone.device.id]);
    expect(gateway.maxActiveReads).toBe(1);
    expect(gateway.writes).toBe(2);
  });

  test('admission refusal does not invent a receipt or replay a reset', async () => {
    const phone = pair();
    const reset = await make();
    gateway.failWrite = true;
    await expect(reset(now)).rejects.toThrow('admission rejected');
    await pause(1100);
    expect(notices).toEqual([]);
    expect(repo.isActiveDevice(phone.device.id)).toBe(true);
    expect(gateway.writes).toBe(1);
    expect(gateway.reads).toBeGreaterThan(0);
  });

  test('gateway closure stops retries and suppresses a receipt already in flight', async () => {
    pair();
    const reset = await make();
    gateway.loseReply = true;
    gateway.holdRead = new Promise<void>((done) => {
      release = done;
    });
    await expect(reset(now)).rejects.toThrow('outcome unknown');
    await wait(() => gateway.reads > 0);
    await gateway.close();
    release!();
    gateway.holdRead = undefined;
    await pause(1100);
    expect(notices).toEqual([]);
    expect(gateway.reads).toBe(1);
    expect(gateway.writes).toBe(1);
    await expect(reset(now)).rejects.toThrow('closed');
    expect(gateway.writes).toBe(1);
  });

  test('a notification failure recovers the same committed receipt without a second reset', async () => {
    pair();
    let attempts = 0;
    const reset = await make((receipt) => {
      if (++attempts === 1) throw new Error('synthetic listener failure');
      notices.push(receipt);
    });
    await expect(reset(now)).rejects.toThrow('synthetic listener failure');
    await wait(() => notices.length === 1);
    expect(attempts).toBe(2);
    expect(gateway.writes).toBe(1);
    expect(await gateway.call(humanDeviceResetReads, 'receipt', notices[0].id)).toEqual(notices[0]);
  });
});
