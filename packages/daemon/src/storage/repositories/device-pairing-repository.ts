import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../sqlite-compat.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import {
  pairingApproveWrite,
  pairingDenyWrite,
  pairingTerminalApprovalWrites,
} from './pairing-approve-write.ts';
import type { PairApprovalRequest } from './pairing-approve-write.ts';
import { pairingRedeemWrite } from './pairing-redeem-write.ts';
import type { PairRequest, PairRequestRecord } from '../../lib/pairing/pair-request.ts';
import { pairingCodeCreateWrites, type PairingCodeDraft } from './pairing-code-create-write.ts';
import type { PairingCodeCaller } from './pairing-code-create-write.ts';
import { pairingRevokeWrites } from './pairing-revoke-write.ts';
import { pairingStateReads } from './pairing-state-read.ts';

export type DeviceKind = 'human' | 'relay' | 'daemon' | 'agent';

export interface PairedDevice {
  id: string;
  name: string;
  kind: DeviceKind;
  createdAt: number;
  owner?: boolean;
}

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CODE_LENGTH = 10;
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
export const UNPAIRED_FIELD_MAX = 255;
export const UNPAIRED_ROW_CAP = 500;

type SqlRow<T> = { [K in keyof T]: T[K] extends boolean ? number : T[K] } | null;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function insertDevice(db: Database, device: PairedDevice, credential: string, reuse = false): void {
  db.prepare(
    `INSERT ${reuse ? 'OR IGNORE ' : ''}INTO paired_devices (id, name, kind, secret_hash, created_at, owner) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    device.id,
    device.name,
    device.kind,
    hash(credential),
    device.createdAt,
    device.owner ? 1 : 0
  );
}

export const enrollLocalDevice = defineDbOp({
  name: 'pairing.enrollLocalDevice',
  mode: 'write',
  run: (
    db: Database,
    {
      credential,
      now,
      kind = 'human',
    }: { credential: string; now: number; kind?: 'human' | 'agent' }
  ): void => {
    insertDevice(
      db,
      {
        id: `${kind === 'agent' ? 'agent-read' : 'local-rpc'}:${randomUUID()}`,
        name: kind === 'agent' ? 'Local agent reader' : 'Local tools',
        kind,
        createdAt: now,
      },
      credential,
      true
    );
  },
});

export const deviceKindByCredential = defineDbOp({
  name: 'pairing.deviceKindByCredential',
  mode: 'read',
  run: (db: Database, credential: string): DeviceKind | null =>
    (
      db.prepare('SELECT kind FROM paired_devices WHERE secret_hash = ?').get(hash(credential)) as {
        kind: DeviceKind;
      } | null
    )?.kind ?? null,
});

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

  cancelFirstDeviceRequests(now: number): void {
    this.db
      .prepare(
        `UPDATE pairing_requests SET cancelled_at = ?, expires_at = ?
         WHERE first_device = 1 AND granted_at IS NULL AND denied_at IS NULL
           AND cancelled_at IS NULL AND expires_at > ?`
      )
      .run(now, now, now);
  }

  isOwnerDevice(id: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM paired_devices WHERE id = ? AND kind = 'human' AND owner = 1 AND revoked_at IS NULL"
      )
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

  firstDeviceOpen(): boolean {
    if (this.everPairedHumanCount() === 0) return true;
    return this.humanRecoveryOpen();
  }

  everPairedHumanCount(): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS humans FROM paired_devices WHERE kind = 'human' " +
            "AND id NOT LIKE 'local-rpc:%' AND id NOT LIKE 'agent-read:%'"
        )
        .get() as { humans: number }
    ).humans;
  }

  countDevices(): { all: number; humans: number } {
    return this.db
      .prepare(
        "SELECT COUNT(*) AS \"all\", COUNT(*) FILTER (WHERE kind = 'human' AND revoked_at IS NULL) AS humans FROM paired_devices WHERE id NOT LIKE 'local-rpc:%' AND id NOT LIKE 'agent-read:%'"
      )
      .get() as { all: number; humans: number };
  }

  createCodeAsync(draft: PairingCodeDraft) {
    return gatewayFor(this.db).call(pairingCodeCreateWrites, 'create', draft);
  }

  createCode(
    kind: DeviceKind,
    name: string | null,
    approved: boolean,
    now: number,
    twoWay = false
  ): { id: string; code: string; expiresAt: number } {
    const id = randomUUID();
    const code = Array.from(randomBytes(CODE_LENGTH), (byte) => CODE_ALPHABET[byte % 32]).join('');
    const expiresAt = now + PAIRING_CODE_TTL_MS;
    this.db
      .prepare(
        `INSERT INTO pairing_codes (id, code_hash, kind, name, created_at, expires_at, approved_at,
           two_way, first_device)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        hash(code),
        kind,
        name,
        now,
        expiresAt,
        approved ? now : null,
        twoWay ? 1 : 0,
        kind === 'human' && this.firstDeviceOpen() ? 1 : 0
      );
    return { id, code, expiresAt };
  }

  listPending(now: number): {
    id: string;
    kind: DeviceKind;
    name: string | null;
    requestedName: string | null;
    expiresAt: number;
    twoWay: boolean;
    phoneConfirmed: boolean;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, name, requested_name AS requestedName, expires_at AS expiresAt,
           requested_by AS requestedBy, two_way AS twoWay FROM pairing_codes
         WHERE approved_at IS NULL AND used_at IS NULL AND expires_at > ? ORDER BY created_at`
      )
      .all(now) as {
      id: string;
      kind: DeviceKind;
      name: string | null;
      requestedName: string | null;
      expiresAt: number;
      requestedBy: string | null;
      twoWay: number;
    }[];
    return rows.map(({ requestedBy, twoWay, ...row }) => ({
      ...row,
      twoWay: !!twoWay,
      phoneConfirmed: !!twoWay && !!requestedBy,
    }));
  }

  pendingCode(
    id: string,
    now: number
  ): { twoWay: boolean; codeHash: string; requestedBy: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT two_way AS twoWay, code_hash AS codeHash, requested_by AS requestedBy
         FROM pairing_codes WHERE id = ? AND approved_at IS NULL AND used_at IS NULL AND expires_at > ?`
      )
      .get(id, now) as SqlRow<{ twoWay: boolean; codeHash: string; requestedBy: string | null }>;
    return row && { ...row, twoWay: !!row.twoWay };
  }

  approveAsync(request: PairApprovalRequest) {
    return gatewayFor(this.db).run(pairingApproveWrite, request);
  }

  terminalApproval(): boolean {
    const row = this.db
      .prepare('SELECT terminal_approval AS enabled FROM pairing_policy WHERE id = 1')
      .get() as { enabled: number } | null;
    return !row || row.enabled === 1;
  }

  terminalMayApprove(): boolean {
    return this.countDevices().all === 0 || this.humanRecoveryOpen() || this.terminalApproval();
  }

  setTerminalApproval(enabled: boolean, changedBy: string, now: number): boolean {
    const stored = this.db
      .prepare(
        `INSERT INTO pairing_policy (id, terminal_approval, changed_by, changed_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET terminal_approval = excluded.terminal_approval,
           changed_by = excluded.changed_by, changed_at = excluded.changed_at
         RETURNING terminal_approval AS enabled`
      )
      .get(enabled ? 1 : 0, changedBy, now) as { enabled: number };
    return stored.enabled === 1;
  }

  setTerminalApprovalAsync(enabled: boolean, changedBy: string, now: number) {
    return gatewayFor(this.db).call(pairingTerminalApprovalWrites, 'set', enabled, changedBy, now);
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

  denyAsync(codeId: string, deviceId: string, now: number) {
    return gatewayFor(this.db).run(pairingDenyWrite, { codeId, deviceId, now });
  }

  deny(id: string, now: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE pairing_codes SET expires_at = ?, denied_at = ?
           WHERE id = ? AND approved_at IS NULL AND used_at IS NULL AND expires_at > ?`
        )
        .run(now, now, id, now).changes > 0
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

  pairRequest(code: string, now: number): PairRequestRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, approved_at IS NOT NULL AS approved, requested_name AS requestedName,
           requested_by AS requestedBy, voided_at IS NOT NULL AS voided, two_way AS twoWay,
           expires_at AS expiresAt, denied_at IS NOT NULL AS denied, expires_at <= ? AS expired
         FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL`
      )
      .get(now, hash(normalizePairingCode(code))) as SqlRow<PairRequestRecord>;
    return (
      row && {
        ...row,
        approved: !!row.approved,
        voided: !!row.voided,
        twoWay: !!row.twoWay,
        denied: !!row.denied,
        expired: !!row.expired,
      }
    );
  }

  recordRequester(id: string, name: string, requestedBy: string | null): void {
    this.db
      .prepare(
        'UPDATE pairing_codes SET requested_name = ?, requested_by = ? WHERE id = ? AND requested_name IS NULL'
      )
      .run(name, requestedBy, id);
  }

  voidCode(id: string, now: number): void {
    this.db
      .prepare('UPDATE pairing_codes SET expires_at = ?, voided_at = ? WHERE id = ?')
      .run(now, now, id);
  }

  humanRecoveryOpen(): boolean {
    return !!this.db
      .prepare(
        'SELECT 1 FROM (SELECT recovered_at FROM human_device_resets ORDER BY rowid DESC LIMIT 1) WHERE recovered_at IS NULL'
      )
      .get();
  }

  closeHumanRecovery(now: number): void {
    if (!this.humanRecoveryOpen()) return;
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

  redeemAsync(request: PairRequest, now: number) {
    return gatewayFor(this.db).call(pairingRedeemWrite, 'redeem', request, now);
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
             AND used_at IS NULL AND expires_at > ?
             AND (first_device = 0 OR NOT EXISTS (
               SELECT 1 FROM paired_devices WHERE kind = 'human'
                 AND id NOT LIKE 'local-rpc:%' AND id NOT LIKE 'agent-read:%')
               OR EXISTS (SELECT 1 FROM (
                 SELECT recovered_at FROM human_device_resets ORDER BY rowid DESC LIMIT 1
               ) WHERE recovered_at IS NULL))
             RETURNING kind, first_device`
        )
        .get(now, hash(normalizePairingCode(code)), now) as {
        kind: DeviceKind;
        first_device: number;
      } | null;
      if (!claimed) return null;
      const firstDevice = claimed.first_device === 1;
      if (firstDevice) this.cancelFirstDeviceRequests(now);
      if (claimed.kind === 'human') this.closeHumanRecovery(now);
      insertDevice(this.db, { ...device, kind: claimed.kind, owner: firstDevice }, credential);
      return { device: { ...device, kind: claimed.kind }, credential };
    })();
  }
}
