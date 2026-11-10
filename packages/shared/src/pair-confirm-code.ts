export const PAIR_CONFIRM_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

export const normalizeConfirmCode = (value: string) => value.replace(/[\s-]/g, '').toUpperCase();

const codeShape = new RegExp(`^[${PAIR_CONFIRM_ALPHABET}]{8}$`);

export const validPairConfirmCode = (value: string) => codeShape.test(normalizeConfirmCode(value));
