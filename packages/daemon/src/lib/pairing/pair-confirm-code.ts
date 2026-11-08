import { createHash } from 'node:crypto';

const ALPHA = 'BCDFGHJKLMNPQRSTVWXZ';

export const normalizeConfirmCode = (value: string) => value.replace(/[\s-]/g, '').toUpperCase();

export function pairConfirmCode(codeHash: string, requestedBy: string): string {
  const digest = createHash('sha256')
    .update(codeHash + requestedBy)
    .digest('hex');
  let number = BigInt(`0x${digest.slice(0, 16)}`);
  let letters = '';
  for (let index = 0; index < 8; index++) {
    letters = ALPHA[Number(number % 20n)] + letters;
    number /= 20n;
  }
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}
