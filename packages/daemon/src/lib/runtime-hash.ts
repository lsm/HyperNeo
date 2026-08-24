declare const Bun: { hash(value: string): number | bigint } | undefined;

const MASK64 = 0xffffffffffffffffn;
const MASK32 = 0xffffffffn;

const SECRET = [0xa0761d6478bd642fn, 0xe7037ed1a0b428dbn, 0x8ebc6af09c88c6e3n, 0x589965cc75374cc3n];

function mix(a: bigint, b: bigint): bigint {
  const x = a * b;
  return (x & MASK64) ^ (x >> 64n);
}

function read4(view: DataView, offset: number): bigint {
  return BigInt(view.getUint32(offset, true));
}

function read8(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true);
}

function final2(a: bigint, b: bigint, state0: bigint, totalLen: number): bigint {
  a ^= SECRET[1];
  b ^= state0;
  const x = a * b;
  a = x & MASK64;
  b = x >> 64n;
  return mix(a ^ SECRET[0] ^ BigInt(totalLen), b ^ SECRET[1]);
}

function smallKey(input: Uint8Array, view: DataView): [bigint, bigint] {
  const len = input.length;
  let a = 0n;
  let b = 0n;

  if (len >= 4) {
    const end = len - 4;
    const quarter = (len >> 3) << 2;
    a = (read4(view, 0) << 32n) | read4(view, quarter);
    b = (read4(view, end) << 32n) | read4(view, end - quarter);
  } else if (len > 0) {
    a = (BigInt(input[0]) << 16n) | (BigInt(input[len >> 1]) << 8n) | BigInt(input[len - 1]);
    b = 0n;
  }

  return [a, b];
}

// @public
export function wyhash(value: string): bigint {
  const input = new TextEncoder().encode(value);
  const len = input.length;
  const view = new DataView(input.buffer, 0, len);

  const seed0 = mix(SECRET[0], SECRET[1]);
  let state0 = seed0;
  let state1 = seed0;
  let state2 = seed0;
  let a = 0n;
  let b = 0n;

  if (len <= 16) {
    [a, b] = smallKey(input, view);
  } else {
    let i = 0;

    if (len >= 48) {
      while (i + 48 < len) {
        state0 = mix(read8(view, i) ^ SECRET[1], read8(view, i + 8) ^ state0);
        state1 = mix(read8(view, i + 16) ^ SECRET[2], read8(view, i + 24) ^ state1);
        state2 = mix(read8(view, i + 32) ^ SECRET[3], read8(view, i + 40) ^ state2);
        i += 48;
      }
      state0 ^= state1 ^ state2;
    }

    let j = i;
    while (j + 16 < len) {
      state0 = mix(read8(view, j) ^ SECRET[1], read8(view, j + 8) ^ state0);
      j += 16;
    }
    a = read8(view, len - 16);
    b = read8(view, len - 8);
  }

  return final2(a, b, state0, len);
}

export function hashString32(value: string): number {
  if (typeof Bun !== 'undefined' && typeof Bun.hash === 'function') {
    const hash = Bun.hash(value);
    if (typeof hash === 'bigint') {
      return Number(hash & MASK32);
    }
  }

  return Number(wyhash(value) & MASK32);
}
