import type { NeoPack } from './types.ts';

export const NEO_DEFAULT_PACKS = ['coding'];

export function neoPacks(input: {
  builtins: readonly NeoPack[];
  filePacks: readonly NeoPack[];
  enabled: readonly string[];
}): NeoPack[] {
  const seen = new Set<string>();
  return [...input.builtins, ...input.filePacks].filter((pack) => {
    if (seen.has(pack.id) || !input.enabled.includes(pack.id)) return false;
    seen.add(pack.id);
    return true;
  });
}
