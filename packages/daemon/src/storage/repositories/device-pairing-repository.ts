import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../sqlite-compat.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { pairingApproveWrite } from './pairing-approve-write.ts';
import { pairingRedeemWrite } from './pairing-redeem-write.ts';
import { pairingCodeCreateWrites, type PairingCodeCaller } from './pairing-code-create-write.ts';
import { pairingRevokeWrites } from './pairing-revoke-write.ts';
import { pairingStateReads } from './pairing-state-read.ts';

export type DeviceKind = 'human' | 'relay' | 'daemon';

export interface PairedDevice {
  id: string;
  name: string;
  kind: DeviceKind;
  createdAt: number;
}

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CODE_LENGTH = 10;
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
export const UNPAIRED_FIELD_MAX = 255;
export const UNPAIRED_ROW_CAP = 500;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function normalizePairingCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

export const touchDevice = defineDbOp({
  name: 'pairing.touchDevice',
  mode: 'write',
  run: (
    db: Database,
    { credential, host, now }: { credential: string; host: string | null; now: number }
  ): PairedDevice | null =>
    (db
      .prepare(
        `UPDATE paired_devices SET last_seen_at = ?, last_seen_host = ?
         WHERE secret_hash = ? AND revoked_at IS NULL
         RETURNING id, name, kind, created_at AS createdAt`
      )
      .get(now, host, hash(credential)) as PairedDevice | null) ?? null,
});

export const recordUnpaired = defineDbOp({
  name: 'pairing.recordUnpaired',
  mode: 'write',
  run: (
    db: Database,
    {
      seen,
      now,
    }: {
      seen: {
        client: 'browser' | 'native';
        origin: string | null;
        host: string | null;
        remoteAddress: string | null;
        credentialRejected: boolean;
      };
      now: number;
    }
  ): void => {
    const key = [
      seen.client,
      seen.origin?.slice(0, UNPAIRED_FIELD_MAX) ?? null,
      seen.host?.slice(0, UNPAIRED_FIELD_MAX) ?? null,
      seen.remoteAddress?.slice(0, UNPAIRED_FIELD_MAX) ?? null,
      seen.credentialRejected ? 1 : 0,
    ];
    const seenAgain = db
      .prepare(
        `UPDATE unpaired_connections SET count = count + 1, last_seen_at = ?
         WHERE client = ? AND IFNULL(origin, '') = IFNULL(?, '') AND IFNULL(host, '') = IFNULL(?, '')
           AND IFNULL(remote_address, '') = IFNULL(?, '') AND credential_rejected = ?`
      )
      .run(now, ...key);
    if (seenAgain.changes > 0) return;
    db.prepare(
      `INSERT INTO unpaired_connections
         (client, origin, host, remote_address, credential_rejected, first_seen_at, last_seen_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM unpaired_connections) < ?`
    ).run(...key, now, now, UNPAIRED_ROW_CAP);
  },
});

export const recordWouldRefuse = defineDbOp({
  name: 'pairing.recordWouldRefuse',
  mode: 'write',
  run: (
    db: Database,
    {
      seen,
      now,
    }: {
      seen: { reason: string; kind: string; host: string | null; origin: string | null };
      now: number;
    }
  ): void => {
    const key = [
      seen.reason,
      seen.kind,
      seen.host?.slice(0, UNPAIRED_FIELD_MAX) ?? null,
      seen.origin?.slice(0, UNPAIRED_FIELD_MAX) ?? null,
    ];
    const seenAgain = db
      .prepare(
        `UPDATE would_refuse_requests SET count = count + 1, last_seen_at = ?
         WHERE reason = ? AND kind = ? AND IFNULL(host, '') = IFNULL(?, '')
           AND IFNULL(origin, '') = IFNULL(?, '')`
      )
      .run(now, ...key);
    if (seenAgain.changes > 0) return;
    db.prepare(
      `INSERT INTO would_refuse_requests (reason, kind, host, origin, first_seen_at, last_seen_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM would_refuse_requests) < ?`
    ).run(...key, now, now, UNPAIRED_ROW_CAP);
  },
});

export class DevicePairingRepository {
  constructor(private readonly db: Database) {}

  get closeSignal(): AbortSignal {
    return gatewayFor(this.db).closeSignal;
  }

  isActiveDeviceAsync(id: string) {
    return gatewayFor(this.db).call(pairingStateReads, 'isActiveDevice', id);
  }

  revokeAsync(id: string, caller: PairingCodeCaller, now: number) {
    const { source, principal, device } = caller;
    const actor = {
      source,
      principal,
      device: device && { deviceId: device.deviceId, kind: device.kind },
    };
    return gatewayFor(this.db).call(pairingRevokeWrites, 'revoke', id, actor, now);
  }

  listWouldRefuse(): {
    reason: 'host_not_allowed' | 'origin_not_allowed';
    kind: 'http' | 'ws' | 'preflight';
    host: string | null;
    origin: string | null;
    count: number;
    firstSeenAt: number;
    lastSeenAt: number;
  }[] {
    return this.db
      .prepare(
        `SELECT reason, kind, host, origin, count, first_seen_at AS firstSeenAt,
           last_seen_at AS lastSeenAt
         FROM would_refuse_requests ORDER BY last_seen_at DESC, rowid DESC`
      )
      .all() as ReturnType<DevicePairingRepository['listWouldRefuse']>;
  }

  isActiveDevice(id: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM paired_devices WHERE id = ? AND revoked_at IS NULL')
      .get(id);
  }

  listDevices(): {
    id: string;
    name: string;
    kind: DeviceKind;
    createdAt: number;
    lastSeenAt: number | null;
    lastSeenHost: string | null;
    revokedAt: number | null;
  }[] {
    return this.db
      .prepare(
        `SELECT id, name, kind, created_at AS createdAt, last_seen_at AS lastSeenAt,
           last_seen_host AS lastSeenHost, revoked_at AS revokedAt
         FROM paired_devices ORDER BY created_at, rowid`
      )
      .all() as ReturnType<DevicePairingRepository['listDevices']>;
  }

  listUnpaired(): {
    client: 'browser' | 'native';
    origin: string | null;
    host: string | null;
    remoteAddress: string | null;
    credentialRejected: boolean;
    count: number;
    firstSeenAt: number;
    lastSeenAt: number;
  }[] {
    return (
      this.db
        .prepare(
          `SELECT client, origin, host, remote_address AS remoteAddress,
             credential_rejected AS credentialRejected, count, first_seen_at AS firstSeenAt,
             last_seen_at AS lastSeenAt
           FROM unpaired_connections ORDER BY last_seen_at DESC, rowid DESC`
        )
        .all() as (Omit<
        ReturnType<DevicePairingRepository['listUnpaired']>[number],
        'credentialRejected'
      > & {
        credentialRejected: number;
      })[]
    ).map((row) => ({ ...row, credentialRejected: row.credentialRejected === 1 }));
  }

  revokeDevice(id: string, now: number): boolean {
    return (
      this.db
        .prepare('UPDATE paired_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(now, id).changes > 0
    );
  }

  countDevices(): { all: number; humans: number } {
    return this.db
      .prepare(
        'SELECT COUNT(*) AS "all", COUNT(*) FILTER (WHERE kind = \'human\' AND revoked_at IS NULL) AS humans FROM paired_devices'
      )
      .get() as { all: number; humans: number };
  }

  createCodeAsync(kind: DeviceKind, name: string | null, caller: PairingCodeCaller, now: number) {
    return gatewayFor(this.db).call(pairingCodeCreateWrites, 'create', kind, name, caller, now);
  }

  createCode(
    kind: DeviceKind,
    name: string | null,
    approved: boolean,
    now: number
  ): { id: string; code: string; expiresAt: number } {
    const id = randomUUID();
    const code = Array.from(randomBytes(CODE_LENGTH), (byte) => CODE_ALPHABET[byte % 32]).join('');
    const expiresAt = now + PAIRING_CODE_TTL_MS;
    this.db
      .prepare(
        `INSERT INTO pairing_codes (id, code_hash, kind, name, created_at, expires_at, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, hash(code), kind, name, now, expiresAt, approved ? now : null);
    return { id, code, expiresAt };
  }

  listPending(
    now: number
  ): { id: string; kind: DeviceKind; name: string | null; expiresAt: number }[] {
    return this.db
      .prepare(
        `SELECT id, kind, name, expires_at AS expiresAt FROM pairing_codes
         WHERE approved_at IS NULL AND used_at IS NULL AND expires_at > ? ORDER BY created_at`
      )
      .all(now) as { id: string; kind: DeviceKind; name: string | null; expiresAt: number }[];
  }

  approveAsync(codeId: string, deviceId: string, now: number) {
    return gatewayFor(this.db).run(pairingApproveWrite, { codeId, deviceId, now });
  }

  approve(id: string, now: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE pairing_codes SET approved_at = ?
           WHERE id = ? AND approved_at IS NULL AND used_at IS NULL AND expires_at > ?`
        )
        .run(now, id, now).changes > 0
    );
  }

  isAwaitingApproval(code: string, now: number): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM pairing_codes WHERE code_hash = ? AND approved_at IS NULL
           AND used_at IS NULL AND expires_at > ?`
      )
      .get(hash(normalizePairingCode(code)), now);
  }

  humanRecoveryOpen(): boolean {
    return !!this.db
      .prepare(
        'SELECT 1 FROM (SELECT recovered_at FROM human_device_resets ORDER BY rowid DESC LIMIT 1) WHERE recovered_at IS NULL'
      )
      .get();
  }

  redeemAsync(code: string, name: string, now: number) {
    return gatewayFor(this.db).call(pairingRedeemWrite, 'redeem', code, name, now);
  }

  redeem(
    code: string,
    name: string,
    now: number
  ): { device: PairedDevice; credential: string } | null {
    const credential = randomBytes(32).toString('base64url');
    const device = { id: randomUUID(), name, createdAt: now };
    return this.db.transaction(() => {
      const claimed = this.db
        .prepare(
          `UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND approved_at IS NOT NULL
             AND used_at IS NULL AND expires_at > ? RETURNING kind`
        )
        .get(now, hash(normalizePairingCode(code)), now) as { kind: DeviceKind } | null;
      if (!claimed) return null;
      if (claimed.kind === 'human' && this.humanRecoveryOpen()) {
        this.db
          .prepare(
            'UPDATE human_device_resets SET recovered_at = ? WHERE rowid = (SELECT MAX(rowid) FROM human_device_resets)'
          )
          .run(now);
        this.db
          .prepare(
            "UPDATE pairing_codes SET approved_at = NULL WHERE kind = 'human' AND used_at IS NULL"
          )
          .run();
      }
      this.db
        .prepare(
          'INSERT INTO paired_devices (id, name, kind, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(device.id, name, claimed.kind, hash(credential), now);
      return { device: { ...device, kind: claimed.kind }, credential };
    })();
  }
}
