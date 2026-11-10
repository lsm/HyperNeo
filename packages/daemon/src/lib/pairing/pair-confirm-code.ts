import { createHash } from 'node:crypto';

import { PAIR_CONFIRM_ALPHABET } from '@hyperneo/shared/pair-confirm-code';

export function pairConfirmCode(codeHash: string, requestedBy: string): string {
  const digest = createHash('sha256')
    .update(codeHash + requestedBy)
    .digest('hex');
  let number = BigInt(`0x${digest.slice(0, 16)}`);
  let letters = '';
  for (let index = 0; index < 8; index++) {
    letters = PAIR_CONFIRM_ALPHABET[Number(number % 20n)] + letters;
    number /= 20n;
  }
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}
