const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MASK_80 = (1n << 80n) - 1n;

let lastTime = 0n;
let lastRandom = 0n;

function encodeBits(value: bigint, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

function random80(): bigint {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value & MASK_80;
}

export function createUlid(nowMs?: number): string {
  const time = nowMs === undefined ? BigInt(Date.now()) : BigInt(nowMs);
  let random: bigint;
  if (time > lastTime) {
    lastTime = time;
    random = random80();
  } else {
    lastRandom = (lastRandom + 1n) & MASK_80;
    random = lastRandom;
  }
  return encodeBits(time, 10) + encodeBits(random, 16);
}

export function isUlid(value: string): boolean {
  if (typeof value !== 'string' || value.length !== 26) return false;
  for (let i = 0; i < value.length; i++) {
    if (ALPHABET.indexOf(value[i]) === -1) return false;
  }
  return true;
}
