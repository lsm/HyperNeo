import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

export const PAIRING_REQUEST_TTL_MS = 90_000;

const ED25519_SPKI_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const newTicket = (): string => randomBytes(32).toString('base64url');
export const newBindNonce = (): string => randomBytes(16).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const ticketHash = hash;
export const proofMessage = (requestId: string, bindNonce: string) => `${requestId}:${bindNonce}`;

export type PairingRequestState =
  | 'pending'
  | 'bound'
  | 'approved'
  | 'granted'
  | 'denied'
  | 'cancelled'
  | 'expired';

export interface PairingRequestRow {
  id: string;
  createdAt: number;
  expiresAt: number;
  boundAt: number | null;
  phoneKey: string | null;
  bindNonce: string | null;
  name: string | null;
  approvedAt: number | null;
  approvedBy: string | null;
  firstDevice: boolean;
  grantsOwner: boolean;
  grantedAt: number | null;
  deniedAt: number | null;
  cancelledAt: number | null;
}

export function pairingRequestState(row: PairingRequestRow, now: number): PairingRequestState {
  if (row.grantedAt !== null) return 'granted';
  if (row.cancelledAt !== null) return 'cancelled';
  if (row.deniedAt !== null) return 'denied';
  if (row.expiresAt <= now) return 'expired';
  if (row.approvedAt !== null) return 'approved';
  if (row.boundAt !== null) return 'bound';
  return 'pending';
}

export type PairingCompleteStep =
  | { action: 'grant'; owner: boolean }
  | { action: 'supersede' }
  | { action: 'refuse'; reason: 'expired' | 'denied' | 'cancelled' | 'not_approved' | 'wrong_key' };

export function decidePairingComplete(
  row: PairingRequestRow,
  phoneKey: string,
  ownersExist: boolean,
  now: number
): PairingCompleteStep {
  if (row.cancelledAt !== null) return { action: 'refuse', reason: 'cancelled' };
  if (row.deniedAt !== null) return { action: 'refuse', reason: 'denied' };
  if (row.expiresAt <= now) return { action: 'refuse', reason: 'expired' };
  if (row.phoneKey === null || phoneKey !== row.phoneKey) {
    return { action: 'refuse', reason: 'wrong_key' };
  }
  if (row.firstDevice)
    return ownersExist ? { action: 'supersede' } : { action: 'grant', owner: true };
  if (row.approvedAt === null) return { action: 'refuse', reason: 'not_approved' };
  if (row.grantsOwner && ownersExist) return { action: 'supersede' };
  return { action: 'grant', owner: row.grantsOwner };
}

export const cancelMessage = (requestId: string, bindNonce: string) =>
  `cancel:${requestId}:${bindNonce}`;

function verifySignature(phoneKey: string, message: string, signatureB64: string): boolean {
  try {
    const raw = Buffer.from(phoneKey, 'base64url');
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_DER_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureB64, 'base64url'));
  } catch {
    return false;
  }
}

export const verifyBoundCancel = (
  phoneKey: string,
  requestId: string,
  bindNonce: string,
  signatureB64: string
): boolean => verifySignature(phoneKey, cancelMessage(requestId, bindNonce), signatureB64);

export const verifyPhoneProof = (
  phoneKey: string,
  requestId: string,
  bindNonce: string,
  signatureB64: string
): boolean => verifySignature(phoneKey, proofMessage(requestId, bindNonce), signatureB64);
