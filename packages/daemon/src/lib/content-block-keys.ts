const ALLOWED_KEYS = new Map<string, ReadonlySet<string>>([
  ['tool_use', new Set(['type', 'id', 'name', 'input', 'cache_control'])],
]);

export function stripDisallowedBlockKeys<T extends { type: string }>(block: T): T {
  const allowed = ALLOWED_KEYS.get(block.type);
  if (!allowed || Object.keys(block).every((key) => allowed.has(key))) return block;
  return Object.fromEntries(Object.entries(block).filter(([key]) => allowed.has(key))) as T;
}
