import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { combineNeoEvidenceReads, type NeoEvidenceRead } from '../evidence.ts';
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

export async function readNeoPackEvidence(
  packs: readonly NeoPack[],
  work: NeoWork,
  warn: (id: string, error: unknown) => void
): Promise<NeoEvidenceRead | null> {
  return combineNeoEvidenceReads(
    await Promise.all(
      packs.map((pack) =>
        pack.readEvidence?.(work).catch((error: unknown) => {
          warn(pack.id, error);
          return null;
        })
      )
    )
  );
}
