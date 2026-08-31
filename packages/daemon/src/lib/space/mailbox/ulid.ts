const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const TIMESTAMP_MASK = 0xffffffffffffn;

const MAX_RANDOM = (1n << 80n) - 1n;

let lastObservedMs: number | undefined;
let lastTimeMs: number | undefined;
let lastRandomness = 0n;

function encodeBase32(value: bigint, length: number): string {
  let encoded = '';
  let remaining = value;
  for (let i = 0; i < length; i++) {
    encoded = CROCKFORD[Number(remaining & 31n)] + encoded;
    remaining >>= 5n;
  }
  return encoded;
}

function random80(): bigint {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

export function createUlid(nowMs?: number): string {
  const observedMs = nowMs ?? Date.now();
  let ms: number;
  let randomness: bigint;
  if (observedMs === lastObservedMs || observedMs === lastTimeMs) {
    ms = lastTimeMs ?? observedMs;
    randomness = lastRandomness + 1n;
    if (randomness > MAX_RANDOM) {
      ms += 1;
      randomness = 0n;
    }
  } else {
    ms = observedMs;
    randomness = random80();
  }
  lastObservedMs = observedMs;
  lastTimeMs = ms;
  lastRandomness = randomness;
  return encodeBase32(BigInt(ms) & TIMESTAMP_MASK, 10) + encodeBase32(randomness, 16);
}

export function isUlid(value: string): boolean {
  if (typeof value !== 'string' || value.length !== 26) return false;
  for (let i = 0; i < value.length; i++) {
    if (CROCKFORD.indexOf(value[i]) === -1 || (i === 0 && value[i] > '7')) return false;
  }
  return true;
}

export function _resetForTesting(nowMs?: number, randomness?: bigint): void {
  lastObservedMs = nowMs;
  lastTimeMs = nowMs;
  lastRandomness = randomness ?? 0n;
}
