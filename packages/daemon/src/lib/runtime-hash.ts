/**
 * Runtime-agnostic string hashing.
 *
 * `Bun.hash()` (wyhash) is only available under Bun. Production code paths that
 * depend on its exact output (e.g. the persisted worktree directory identity in
 * `worktree-path-utils.ts`) must keep using it when present. Under Node / Vitest
 * / Deno we fall back to a deterministic 32-bit FNV-1a hash so the same code
 * runs and stays deterministic in tests.
 *
 * NOTE: the fallback is NOT byte-identical to wyhash. It is only used when
 * `Bun` is absent (tests, or a future non-Bun runtime). Any consumer whose
 * hash value is persisted across runtimes must migrate its stored keys before
 * switching runtimes for real.
 */

declare const Bun: { hash(value: string): number | bigint } | undefined;

/**
 * FNV-1a 32-bit hash — small, deterministic, dependency-free fallback.
 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in integer range.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Hash a string to an unsigned 32-bit number. Uses `Bun.hash` (wyhash) when the
 * Bun runtime is present; otherwise a deterministic FNV-1a fallback.
 */
export function hashString32(value: string): number {
  if (typeof Bun !== 'undefined' && typeof Bun.hash === 'function') {
    const hash = Bun.hash(value);
    return Number(BigInt(hash) & 0xffff_ffffn);
  }
  return fnv1a(value);
}
