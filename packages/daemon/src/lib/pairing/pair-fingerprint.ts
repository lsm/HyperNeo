import { createHash } from 'node:crypto';

export const pairFingerprint = (codeHash: string, requestedBy: string): string[] =>
  createHash('sha256')
    .update(codeHash + requestedBy)
    .digest('hex')
    .slice(0, 32)
    .match(/.{4}/g) ?? [];
