const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const MAX_TIME_MS = 2 ** 48;
const RANDOM_BYTES = 10;

let lastTimeMs = -1;
let lastRandom = new Uint8Array(RANDOM_BYTES);

function encodeTimestamp(timeMs: number): string {
  let time = timeMs;
  let encoded = '';
  for (let length = 0; length < 10; length += 1) {
    encoded = ALPHABET[time % 32] + encoded;
    time = Math.floor(time / 32);
  }
  return encoded;
}

function encodeRandom(random: Uint8Array): string {
  const bytes = random.slice();
  const digits: number[] = [];
  for (let length = 0; length < 16; length += 1) {
    let carry = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      const value = carry * 256 + bytes[index];
      bytes[index] = Math.floor(value / 32);
      carry = value % 32;
    }
    digits.push(carry);
  }
  digits.reverse();
  return digits.map((digit) => ALPHABET[digit]).join('');
}

function incrementRandom(random: Uint8Array): boolean {
  for (let index = random.length - 1; index >= 0; index -= 1) {
    if (random[index] === 255) {
      random[index] = 0;
    } else {
      random[index] += 1;
      return true;
    }
  }
  return false;
}

export function createUlid(nowMs?: number): string {
  const timeMs = Math.floor(nowMs === undefined ? Date.now() : nowMs);
  if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs >= MAX_TIME_MS) {
    throw new Error(`ulid timestamp out of range: ${String(nowMs)}`);
  }
  if (timeMs !== lastTimeMs) {
    lastRandom = crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));
    lastTimeMs = timeMs;
  } else if (!incrementRandom(lastRandom)) {
    throw new Error('ulid randomness exhausted within millisecond');
  }
  return encodeTimestamp(timeMs) + encodeRandom(lastRandom);
}

export function isUlid(value: string): boolean {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}
