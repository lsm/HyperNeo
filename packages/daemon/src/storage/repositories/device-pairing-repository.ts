import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../sqlite-compat.ts';

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

export class DevicePairingRepository {
  constructor(private readonly db: Database) {}

  touchDevice(credential: string, host: string | null, now: number): PairedDevice | null {
    return (
      (this.db
        .prepare(
          `UPDATE paired_devices SET last_seen_at = ?, last_seen_host = ?
           WHERE secret_hash = ? AND revoked_at IS NULL
           RETURNING id, name, kind, created_at AS createdAt`
        )
        .get(now, host, hash(credential)) as PairedDevice | null) ?? null
    );
  }

  recordUnpaired(
    seen: {
      client: 'browser' | 'native';
      origin: string | null;
      host: string | null;
      remoteAddress: string | null;
      credentialRejected: boolean;
    },
    now: number
  ): void {
    const key = [
      seen.client,
      seen.origin?.slice(0, UNPAIRED_FIELD_MAX) ?? null,
      seen.host?.slice(0, UNPAIRED_FIELD_MAX) ?? null,
      seen.remoteAddress?.slice(0, UNPAIRED_FIELD_MAX) ?? null,
      seen.credentialRejected ? 1 : 0,
    ];
    const seenAgain = this.db
      .prepare(
        `UPDATE unpaired_connections SET count = count + 1, last_seen_at = ?
         WHERE client = ? AND IFNULL(origin, '') = IFNULL(?, '') AND IFNULL(host, '') = IFNULL(?, '')
           AND IFNULL(remote_address, '') = IFNULL(?, '') AND credential_rejected = ?`
      )
      .run(now, ...key);
    if (seenAgain.changes > 0) return;
    this.db
      .prepare(
        `INSERT INTO unpaired_connections
           (client, origin, host, remote_address, credential_rejected, first_seen_at, last_seen_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM unpaired_connections) < ?`
      )
      .run(...key, now, now, UNPAIRED_ROW_CAP);
  }

  isActiveDevice(id: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM paired_devices WHERE id = ? AND revoked_at IS NULL')
      .get(id);
  }

  countHumanDevices(): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM paired_devices WHERE kind = 'human' AND revoked_at IS NULL"
        )
        .get() as { n: number }
    ).n;
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
      this.db
        .prepare(
          'INSERT INTO paired_devices (id, name, kind, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(device.id, name, claimed.kind, hash(credential), now);
      return { device: { ...device, kind: claimed.kind }, credential };
    })();
  }
}
