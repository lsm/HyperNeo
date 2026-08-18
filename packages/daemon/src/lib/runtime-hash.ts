declare const Bun: { hash(value: string): number | bigint } | undefined;

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

export function hashString32(value: string): number {
  if (typeof Bun !== 'undefined' && typeof Bun.hash === 'function') {
    const hash = Bun.hash(value);
    return Number(BigInt(hash) & 0xffff_ffffn);
  }
  return fnv1a(value);
}
