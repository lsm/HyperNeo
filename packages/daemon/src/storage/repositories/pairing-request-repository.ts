import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DevicePairingRepository } from './device-pairing-repository.ts';
import type { Database } from '../sqlite-compat.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import {
  decidePairingComplete,
  newBindNonce,
  newTicket,
  PAIRING_REQUEST_TTL_MS,
  pairingRequestState,
  ticketHash,
  verifyPhoneProof,
  type PairingRequestRow,
  type PairingRequestState,
} from '../../lib/pairing/pair-request-v2.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

type RawRow = {
  id: string;
  created_at: number;
  expires_at: number;
  bound_at: number | null;
  phone_key: string | null;
  bind_nonce: string | null;
  name: string | null;
  approved_at: number | null;
  approved_by: string | null;
  grants_owner: number;
  granted_at: number | null;
  denied_at: number | null;
  cancelled_at: number | null;
};

const toRow = (raw: RawRow): PairingRequestRow => ({
  id: raw.id,
  createdAt: raw.created_at,
  expiresAt: raw.expires_at,
  boundAt: raw.bound_at,
  phoneKey: raw.phone_key,
  bindNonce: raw.bind_nonce,
  name: raw.name,
  approvedAt: raw.approved_at,
  approvedBy: raw.approved_by,
  grantsOwner: raw.grants_owner === 1,
  grantedAt: raw.granted_at,
  deniedAt: raw.denied_at,
  cancelledAt: raw.cancelled_at,
});

export type PairingCompleteResult =
  | { ok: true; deviceId: string; credential: string; owner: boolean }
  | {
      ok: false;
      reason:
        | 'expired'
        | 'denied'
        | 'cancelled'
        | 'not_approved'
        | 'wrong_key'
        | 'bad_proof'
        | 'used'
        | 'superseded'
        | 'not_found';
    };

export class PairingRequestRepository {
  constructor(private readonly db: Database) {}

  private rowById(id: string): PairingRequestRow | null {
    const raw = this.db
      .prepare('SELECT * FROM pairing_requests WHERE id = ?')
      .get(id) as RawRow | null;
    return raw && toRow(raw);
  }

  ownerCount(): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS humans FROM paired_devices WHERE kind = 'human' " +
            'AND owner = 1 AND revoked_at IS NULL ' +
            "AND id NOT LIKE 'local-rpc:%' AND id NOT LIKE 'agent-read:%'"
        )
        .get() as { humans: number }
    ).humans;
  }

  createRequest(now: number): { requestId: string; ticket: string; expiresAt: number } {
    const id = randomUUID();
    const ticket = newTicket();
    const expiresAt = now + PAIRING_REQUEST_TTL_MS;
    this.db
      .prepare(
        `INSERT INTO pairing_requests (id, ticket_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, ticketHash(ticket), now, expiresAt);
    return { requestId: id, ticket, expiresAt };
  }

  bindTicket(
    ticket: string,
    phoneKey: string,
    name: string | null,
    now: number
  ): { ok: true; requestId: string; bindNonce: string; expiresAt: number } | { ok: false } {
    const bindNonce = newBindNonce();
    const bound = this.db
      .prepare(
        `UPDATE pairing_requests SET bound_at = ?, phone_key = ?, bind_nonce = ?, name = ?
         WHERE ticket_hash = ? AND bound_at IS NULL AND granted_at IS NULL
           AND denied_at IS NULL AND cancelled_at IS NULL AND expires_at > ?
         RETURNING id, expires_at`
      )
      .get(now, phoneKey, bindNonce, name, ticketHash(ticket), now) as {
      id: string;
      expires_at: number;
    } | null;
    return bound
      ? { ok: true, requestId: bound.id, bindNonce, expiresAt: bound.expires_at }
      : { ok: false };
  }

  approveRequest(
    requestId: string,
    approver: string,
    now: number
  ): 'approved' | 'not_pending' | 'not_allowed' {
    return this.db.transaction(() => {
      if (approver.startsWith('local-rpc:') || approver.startsWith('agent-read:'))
        return 'not_allowed';
      const ownerGrant = this.ownerCount() === 0;
      const approved = this.db
        .prepare(
          `UPDATE pairing_requests SET approved_at = ?, approved_by = ?, grants_owner = ?
           WHERE id = ? AND bound_at IS NOT NULL AND approved_at IS NULL AND granted_at IS NULL
             AND denied_at IS NULL AND cancelled_at IS NULL AND expires_at > ?`
        )
        .run(now, approver, ownerGrant ? 1 : 0, requestId, now);
      return approved.changes > 0 ? 'approved' : 'not_pending';
    })();
  }

  denyRequest(requestId: string, now: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE pairing_requests SET denied_at = ?, expires_at = ?
           WHERE id = ? AND granted_at IS NULL AND denied_at IS NULL AND cancelled_at IS NULL`
        )
        .run(now, now, requestId).changes > 0
    );
  }

  cancelRequest(requestId: string, now: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE pairing_requests SET cancelled_at = ?, expires_at = ?
           WHERE id = ? AND granted_at IS NULL AND denied_at IS NULL AND cancelled_at IS NULL`
        )
        .run(now, now, requestId).changes > 0
    );
  }

  requestStatus(
    requestId: string,
    now: number
  ): {
    state: PairingRequestState;
    expiresAt: number;
    phoneKey: string | null;
    name: string | null;
  } | null {
    const row = this.rowById(requestId);
    return (
      row && {
        state: pairingRequestState(row, now),
        expiresAt: row.expiresAt,
        phoneKey: row.phoneKey,
        name: row.name,
      }
    );
  }

  completeRequest(
    requestId: string,
    phoneKey: string,
    signature: string,
    now: number
  ): PairingCompleteResult {
    const credential = randomBytes(32).toString('base64url');
    const deviceId = randomUUID();
    return this.db.transaction(() => {
      const row = this.rowById(requestId);
      if (!row) return { ok: false as const, reason: 'not_found' as const };
      if (row.grantedAt !== null) return { ok: false as const, reason: 'used' as const };
      const step = decidePairingComplete(row, phoneKey, this.ownerCount() > 0, now);
      if (step.action === 'refuse') return { ok: false as const, reason: step.reason };
      if (step.action === 'supersede') {
        this.db
          .prepare(
            `UPDATE pairing_requests SET cancelled_at = ? WHERE id = ? AND granted_at IS NULL
             AND denied_at IS NULL AND cancelled_at IS NULL`
          )
          .run(now, requestId);
        return { ok: false as const, reason: 'superseded' as const };
      }
      if (!verifyPhoneProof(phoneKey, requestId, row.bindNonce as string, signature)) {
        return { ok: false as const, reason: 'bad_proof' as const };
      }
      const claimed = this.db
        .prepare(
          `UPDATE pairing_requests SET granted_at = ?
           WHERE id = ? AND granted_at IS NULL AND denied_at IS NULL AND cancelled_at IS NULL
             AND expires_at > ?`
        )
        .run(now, requestId, now);
      if (claimed.changes === 0) return { ok: false as const, reason: 'used' as const };
      new DevicePairingRepository(this.db).closeHumanRecovery(now);
      this.db
        .prepare(
          `INSERT INTO paired_devices (id, name, kind, secret_hash, created_at, owner)
           VALUES (?, ?, 'human', ?, ?, ?)`
        )
        .run(deviceId, row.name ?? 'Paired phone', hash(credential), now, row.grantsOwner ? 1 : 0);
      return { ok: true as const, deviceId, credential, owner: row.grantsOwner };
    })();
  }
}

export const pairingRequestReads = defineRepositoryOp(
  'pairing.request.read',
  'read',
  PairingRequestRepository,
  ['requestStatus', 'ownerCount'] as const
);

export const pairingRequestWrites = defineRepositoryOp(
  'pairing.request.write',
  'write',
  PairingRequestRepository,
  [
    'createRequest',
    'bindTicket',
    'approveRequest',
    'denyRequest',
    'cancelRequest',
    'completeRequest',
  ] as const
);
